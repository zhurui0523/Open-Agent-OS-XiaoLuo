/**
 * edit_file 的定位与替换（学 Codex apply_patch 的 `seek_sequence` 三级容错）
 *
 * 以前只做「逐字符 + 全文唯一」，只要小逻传的 oldText 缩进或行尾差一个空格就整批失败，
 * 它只能重读文件再试一轮。现在按严格度递进取三道：
 *   1. exact    —— 逐字符（还能命中不在行首的片段）
 *   2. trailing —— 按行对齐，忽略每行行尾空白（顺带吃掉 CRLF 的 \r）
 *   3. trimmed  —— 按行对齐，忽略每行首尾空白（小逻少写/多写缩进也能落）
 * 三级都只在「唯一命中」时才动手，多命中一律判不唯一，绝不猜。
 *
 * 一次调用可传多个 hunk：逐个套用，全部命中才返回新内容（全成或全不成），
 * 避免改到第 3 处失败留下改了一半的文件。
 */

export interface EditHunk {
  oldText: string;
  newText: string;
}

export type MatchLevel = "exact" | "trailing" | "trimmed";

export interface HunkOutcome {
  ok: boolean;
  level?: MatchLevel;
  /** 命中处所在行（1 起） */
  line?: number;
  error?: string;
}

export interface PatchResult {
  /** 所有 hunk 都命中时才有新内容；有一处没落地即为 null（整批不写盘） */
  content: string | null;
  outcomes: HunkOutcome[];
}

const LEVEL_LABEL: Record<MatchLevel, string> = {
  exact: "逐字符",
  trailing: "忽略行尾空白",
  trimmed: "忽略行首尾空白",
};

function normalizeLine(line: string, level: MatchLevel): string {
  return level === "trimmed" ? line.trim() : line.replace(/\s+$/, "");
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/** 非重叠计数 + 首个位置 */
function scanExact(text: string, needle: string): { count: number; index: number } {
  let count = 0;
  let index = -1;
  let from = 0;
  for (;;) {
    const at = text.indexOf(needle, from);
    if (at === -1) break;
    if (index === -1) index = at;
    count += 1;
    from = at + needle.length;
  }
  return { count, index };
}

/** 按行对齐的容错搜索：返回所有起始行下标（0 起） */
function scanLines(lines: string[], want: string[], level: MatchLevel): number[] {
  const target = want.map((line) => normalizeLine(line, level));
  const starts: number[] = [];
  for (let i = 0; i + want.length <= lines.length; i += 1) {
    let hit = true;
    for (let j = 0; j < want.length; j += 1) {
      if (normalizeLine(lines[i + j], level) !== target[j]) {
        hit = false;
        break;
      }
    }
    if (hit) starts.push(i);
  }
  return starts;
}

function applyOne(text: string, hunk: EditHunk): { text: string; outcome: HunkOutcome } {
  const oldText = hunk.oldText ?? "";
  const newText = hunk.newText ?? "";
  if (!oldText) return { text, outcome: { ok: false, error: "oldText 不能是空串。" } };
  if (!oldText.trim()) return { text, outcome: { ok: false, error: "oldText 全是空白：无法唯一定位，请带上实际代码行。" } };

  const exact = scanExact(text, oldText);
  if (exact.count === 1) {
    return {
      text: text.slice(0, exact.index) + newText + text.slice(exact.index + oldText.length),
      outcome: { ok: true, level: "exact", line: lineOf(text, exact.index) },
    };
  }
  if (exact.count > 1) {
    return {
      text,
      outcome: {
        ok: false,
        error: `oldText 在文件中出现 ${exact.count} 次（不唯一）：把前后上下文带进 oldText 扩长到唯一再试。`,
      },
    };
  }

  const lines = text.split("\n");
  const want = (oldText.endsWith("\n") ? oldText.slice(0, -1) : oldText).split("\n");
  const fuzzy: MatchLevel[] = ["trailing", "trimmed"];
  let ambiguous = "";
  for (const level of fuzzy) {
    const starts = scanLines(lines, want, level);
    if (starts.length > 1) {
      // 更松的一级可能反而只剩一处（宽松命中集是严格命中集的子集），所以不立刻放弃
      ambiguous = `oldText 按${LEVEL_LABEL[level]}匹配到 ${starts.length} 处（不唯一）：把前后上下文带进 oldText 扩长到唯一再试。`;
      continue;
    }
    if (starts.length === 1) {
      const replacement = (newText.endsWith("\n") ? newText.slice(0, -1) : newText).split("\n");
      const next = [...lines.slice(0, starts[0]), ...replacement, ...lines.slice(starts[0] + want.length)];
      return { text: next.join("\n"), outcome: { ok: true, level, line: starts[0] + 1 } };
    }
  }
  if (ambiguous) return { text, outcome: { ok: false, error: ambiguous } };

  return {
    text,
    outcome: {
      ok: false,
      error:
        "oldText 三级都没匹配到（逐字符 / 忽略行尾空白 / 忽略行首尾空白）：先 read_file 看实际内容再传，别凭记忆写原文。",
    },
  };
}

export function applyEditHunks(source: string, hunks: EditHunk[]): PatchResult {
  const outcomes: HunkOutcome[] = [];
  let text = source;
  for (const hunk of hunks) {
    const applied = applyOne(text, hunk);
    outcomes.push(applied.outcome);
    if (applied.outcome.ok) text = applied.text;
  }
  return { content: outcomes.some((o) => !o.ok) ? null : text, outcomes };
}

// ---------- 结构化补丁（学 Codex apply_patch：@@ 上下文锚点 + 一次多文件） ----------
//
// 与 edit_file 的分工：edit_file 传 oldText/newText 整串，短文本、单点替换更省；
// apply_patch 只传「上下文行 + 增删行」，改大文件不用抄回原文，一调用可 update/add/delete 多文件。
// 格式（缩进外的 ' ' / '+' / '-' 前缀是语义，不是装饰）：
//   *** Begin Patch
//   *** Update File: src/a.ts
//   @@ 可选锚点文本（如函数名）
//    上下文行
//   -删掉的行
//   +新增的行
//   *** Add File: src/b.ts
//   +新文件内容
//   *** Delete File: src/c.ts
//   *** End Patch
// 规矩不变：一处锚不上就整批不落地，绝不留改了一半的文件。

type PatchLineKind = "context" | "add" | "remove";

export interface PatchLine {
  kind: PatchLineKind;
  text: string;
}

export interface ContextHunk {
  /** @@ 后面的锚点文本（可选）：命中多处时用它缩小范围 */
  anchor?: string;
  lines: PatchLine[];
}

export interface PatchOp {
  type: "update" | "add" | "delete";
  path: string;
  /** *** Move to: 目标路径（仅 update 支持） */
  moveTo?: string;
  hunks: ContextHunk[];
}

export interface PatchParseResult {
  ops: PatchOp[];
  error?: string;
}

export interface ContextHunkOutcome {
  ok: boolean;
  /** 落地处起始行（1 起） */
  line?: number;
  /** 这一 hunk 增删了多少行 */
  added?: number;
  removed?: number;
  /** 用哪一级匹配落的地（逐字符 / 忽略行尾 / 忽略首尾） */
  level?: MatchLevel;
  error?: string;
}

export interface ContextPatchResult {
  /** 全部 hunk 命中才有新内容 */
  content: string | null;
  outcomes: ContextHunkOutcome[];
}

/** 解析补丁文本；任何格式问题都带行号报出来，不猜 */
export function parsePatch(text: string): PatchParseResult {
  const raw = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = raw.split("\n");
  const ops: PatchOp[] = [];
  let current: PatchOp | null = null;
  let hunk: ContextHunk | null = null;
  let sawBegin = false;
  let sawEnd = false;

  const closeHunk = () => {
    if (!hunk) return;
    if (current && hunk.lines.length) current.hunks.push(hunk);
    hunk = null;
  };
  const closeOp = () => {
    closeHunk();
    if (!current) return;
    if (current.type === "update" && !current.hunks.length) {
      const path = current.path;
      current = null;
      throw new Error(`*** Update File: ${path} 下面没有任何 @@ hunk`);
    }
    ops.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed && !current && !sawBegin) continue; // 前后的空行不算内容
    if (trimmed === "*** Begin Patch") {
      if (sawBegin) throw new Error(`第 ${i + 1} 行：*** Begin Patch 重复了`);
      sawBegin = true;
      continue;
    }
    if (trimmed === "*** End Patch") {
      closeOp();
      sawEnd = true;
      continue;
    }
    if (/^\*\*\*\s*Update File:/.test(trimmed)) {
      closeOp();
      const path = trimmed.replace(/^\*\*\*\s*Update File:\s*/, "").trim();
      if (!path) throw new Error(`第 ${i + 1} 行：*** Update File 少写了路径`);
      current = { type: "update", path, hunks: [] };
      continue;
    }
    if (/^\*\*\*\s*Add File:/.test(trimmed)) {
      closeOp();
      const path = trimmed.replace(/^\*\*\*\s*Add File:\s*/, "").trim();
      if (!path) throw new Error(`第 ${i + 1} 行：*** Add File 少写了路径`);
      current = { type: "add", path, hunks: [] };
      hunk = { lines: [] };
      continue;
    }
    if (/^\*\*\*\s*Delete File:/.test(trimmed)) {
      closeOp();
      const path = trimmed.replace(/^\*\*\*\s*Delete File:\s*/, "").trim();
      if (!path) throw new Error(`第 ${i + 1} 行：*** Delete File 少写了路径`);
      current = { type: "delete", path, hunks: [] };
      continue;
    }
    if (/^\*\*\*\s*Move to:/.test(trimmed)) {
      const target = trimmed.replace(/^\*\*\*\s*Move to:\s*/, "").trim();
      if (!target) throw new Error(`第 ${i + 1} 行：*** Move to 少写了目标路径`);
      if (!current || current.type !== "update") {
        throw new Error(`第 ${i + 1} 行：*** Move to 只能跟在 *** Update File 后面（改名 + 改内容一次做完）`);
      }
      if (current.moveTo) throw new Error(`第 ${i + 1} 行：*** Move to 重复了`);
      current.moveTo = target;
      continue;
    }
    if (!current) throw new Error(`第 ${i + 1} 行：${trimmed.slice(0, 40)} 不在任何 File 段落内`);

    if (current.type === "delete") {
      throw new Error(`第 ${i + 1} 行：*** Delete File 后面不应有内容`);
    }
    if (current.type === "update" && trimmed.startsWith("@@")) {
      closeHunk();
      hunk = { anchor: trimmed.replace(/^@@\s*/, ""), lines: [] };
      continue;
    }
    if (current.type === "add") {
      if (!line.startsWith("+")) throw new Error(`第 ${i + 1} 行：Add File 的内容行必须以 + 开头`);
      hunk!.lines.push({ kind: "add", text: line.slice(1) });
      continue;
    }
    // update 段落里的三种前缀；空行按上下文空行处理（Codex 允许）
    if (!hunk) hunk = { lines: [] };
    if (line.startsWith("+")) hunk.lines.push({ kind: "add", text: line.slice(1) });
    else if (line.startsWith("-")) hunk.lines.push({ kind: "remove", text: line.slice(1) });
    else if (line.startsWith(" ")) hunk.lines.push({ kind: "context", text: line.slice(1) });
    else if (trimmed === "") hunk.lines.push({ kind: "context", text: "" });
    else {
      throw new Error(`第 ${i + 1} 行：update 段落里的行必须以 ' ' / '+' / '-' 开头（原文：${trimmed.slice(0, 40)}）`);
    }
  }

  if (!sawBegin) throw new Error("补丁缺少 *** Begin Patch 开头");
  if (!sawEnd) throw new Error("补丁缺少 *** End Patch 结尾");
  if (!ops.length) throw new Error("补丁里没有任何 File 段落");
  for (const op of ops) {
    if (op.type === "update" && !op.hunks.length) throw new Error(`*** Update File: ${op.path} 下面没有任何 hunk`);
  }
  return { ops };
}

/**
 * 按行匹配，三级严格度（与 Codex seek_sequence 的前三级对齐）：
 *   1. exact   —— 逐行逐字符（只吃掉 CRLF 的 \r）
 *   2. trailing —— 忽略行尾空白/缩进尾巴
 *   3. trimmed  —— 忽略行首尾空白（上下文抄错缩进也能落）
 * 顺序试，先命中先返回；同一级命中多处仍判不唯一，不往更松一级继续找。
 */
function normalizeForLevel(line: string, level: MatchLevel): string {
  const noCr = line.replace(/\r$/, "");
  if (level === "trimmed") return noCr.trim();
  if (level === "trailing") return noCr.replace(/[ \t]+$/, "");
  return noCr;
}

function matchBlockAtLevel(lines: string[], want: string[], level: MatchLevel, from = 0): number[] {
  const starts: number[] = [];
  for (let i = from; i + want.length <= lines.length; i += 1) {
    let hit = true;
    for (let j = 0; j < want.length; j += 1) {
      if (normalizeForLevel(lines[i + j], level) !== normalizeForLevel(want[j], level)) {
        hit = false;
        break;
      }
    }
    if (hit) starts.push(i);
  }
  return starts;
}

/** 找唯一命中：返回 {starts, level}；三级都没中返回空 */
function seekContext(working: string[], want: string[]): { starts: number[]; level: MatchLevel } {
  const levels: MatchLevel[] = ["exact", "trailing", "trimmed"];
  for (const level of levels) {
    const starts = matchBlockAtLevel(working, want, level);
    if (starts.length) return { starts, level };
  }
  return { starts: [], level: "exact" };
}

/** 把 @@ 结构 hunk 落到源码上；全部命中才有 content */
export function applyContextHunks(source: string, hunks: ContextHunk[]): ContextPatchResult {
  const lines = source === "" ? [] : source.split("\n");
  const outcomes: ContextHunkOutcome[] = [];
  let working = lines.slice();
  let failed = false;

  for (const hunk of hunks) {
    if (!hunk.lines.some((l) => l.kind !== "context")) {
      outcomes.push({ ok: false, error: "这个 hunk 只有上下文行，没有 + / - 改动" });
      failed = true;
      continue;
    }
    const oldLines = hunk.lines.filter((l) => l.kind !== "add").map((l) => l.text);
    const newLines = hunk.lines.filter((l) => l.kind !== "remove").map((l) => l.text);
    const added = hunk.lines.filter((l) => l.kind === "add").length;
    const removed = hunk.lines.filter((l) => l.kind === "remove").length;

    let { starts, level } = oldLines.length ? seekContext(working, oldLines) : { starts: [], level: "exact" as MatchLevel };
    if (hunk.anchor) {
      // 锚点只用来"缩小范围"，不参与匹配本身：命中多处时，取锚点在前面 40 行内出现过的那处
      const anchor = hunk.anchor.trim();
      if (anchor && starts.length > 1) {
        const narrowed = starts.filter((start) => {
          const from = Math.max(0, start - 40);
          for (let i = from; i < start; i += 1) {
            if (working[i].includes(anchor)) return true;
          }
          return working[start]?.includes(anchor) ?? false;
        });
        starts = narrowed;
      }
    }

    if (!starts.length) {
      outcomes.push({
        ok: false,
        error:
          "上下文对不上（逐字符 / 忽略行尾空白 / 忽略行首尾空白 三级都试过）：先 read_file 看实际内容，再把要改的那几行原样带成上下文行。",
      });
      failed = true;
      continue;
    }
    if (starts.length > 1) {
      outcomes.push({
        ok: false,
        error: `这段上下文命中 ${starts.length} 处（不唯一）：多带几行上下文，或在 @@ 后面写锚点（如函数名/类名）。`,
      });
      failed = true;
      continue;
    }
    const at = starts[0];
    working = [...working.slice(0, at), ...newLines, ...working.slice(at + oldLines.length)];
    outcomes.push({ ok: true, line: at + 1, added, removed, level });
  }

  if (failed) return { content: null, outcomes };
  return { content: working.join("\n"), outcomes };
}

