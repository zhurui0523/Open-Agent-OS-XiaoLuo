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
