// 静默 catch 逐条复核：把白名单里每一条的真实上下文抓出来，供人工判定
//   node scripts/review-silent-catch.mjs            打印复核清单（markdown）
//   node scripts/review-silent-catch.mjs --write    写到 docs/silent-catch-review.md
// 只读，不改代码、不改白名单。
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(ROOT, "..", "..");
const ALLOW = join(ROOT, "scripts", "silent-catch-allowlist.json");
const OUT = join(ROOT, "docs", "silent-catch-review.md");

/** 与 lint-silent-catch.mjs 完全一致的判定：catch 体去注释后为空 */
function findSilentCatches(text) {
  const hits = [];
  const re = /catch\s*(?:\([^)]*\))?\s*\{/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const open = match.index + match[0].length;
    let depth = 1;
    let i = open;
    while (i < text.length && depth > 0) {
      const ch = text[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      i += 1;
    }
    const body = text.slice(open, i - 1);
    const stripped = body
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      .trim();
    if (!stripped) {
      const startLine = text.slice(0, match.index).split("\n").length;
      hits.push({ line: startLine, start: match.index, end: i, body: body.trim() });
    }
  }
  return hits;
}

const parsed = JSON.parse(readFileSync(ALLOW, "utf8").replace(/^\uFEFF/, ""));
const entries = parsed.entries ?? [];

const groups = new Map();
for (const entry of entries) {
  const abs = join(REPO, entry.file);
  if (!existsSync(abs)) {
    groups.set(entry.file, { missing: true, hits: [] });
    continue;
    }
  const text = readFileSync(abs, "utf8");
  const hits = findSilentCatches(text).map((hit) => {
    const lines = text.split("\n");
    // 往上找最多 6 行非空上下文，用来判断"这里在干什么"
    const ctx = [];
    for (let n = hit.line - 2; n >= Math.max(0, hit.line - 8); n -= 1) {
      const raw = lines[n] ?? "";
      if (raw.trim()) ctx.unshift(`${n + 1}: ${raw.trim()}`);
      if (ctx.length >= 5) break;
    }
    const catchLine = lines[hit.line - 1]?.trim() ?? "";
    const after = (lines[hit.line] ?? "").trim();
    return { line: hit.line, ctx, catchLine, after, body: hit.body };
  });
  groups.set(entry.file, { missing: false, hits, reason: entry.reason });
}

const out = [];
out.push("# 静默 catch 逐条复核（自动抓上下文）", "");
out.push(`生成器：\`scripts/review-silent-catch.mjs\`；白名单条目 **${entries.length}** 条，涉及 **${groups.size}** 个文件。`, "");
out.push("判定口径：catch 体去注释后为空即「静默」。下列每处都给出 try 侧最近 5 行上下文，用来判断吞掉的是否可接受。", "");
out.push("---", "");

let idx = 0;
for (const [file, g] of groups) {
  idx += 1;
  out.push(`## ${idx}. ${file}`, "");
  if (g.missing) {
    out.push("- 文件已不存在（白名单该删）", "");
    continue;
  }
  out.push(`静默处 ${g.hits.length} 个：`, "");
  for (const hit of g.hits) {
    out.push("```text");
    for (const line of hit.ctx) out.push(line);
    out.push(`${hit.line}: ${hit.catchLine}   // ← 静默`);
    if (hit.after) out.push(`${hit.line + 1}: ${hit.after}`);
    out.push("```");
  }
  out.push("");
}

const text = out.join("\n");
if (process.argv.includes("--write")) {
  writeFileSync(OUT, text, "utf8");
  console.log(`已写入 ${OUT}（${entries.length} 条 / ${groups.size} 文件）`);
} else {
  console.log(text);
}
