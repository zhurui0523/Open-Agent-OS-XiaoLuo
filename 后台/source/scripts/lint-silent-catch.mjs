// 静默 catch 护栏：把"吞掉异常且不留任何痕迹"的地方按文件+代码片段钉住。
// 规则：catch 体里只有空白/注释 = 静默；一旦出现在白名单之外就失败。
// 白名单只许缩不许涨：修掉一处就把对应条目删掉；新增静默 catch 必须写明理由并登记。
//
//   node scripts/lint-silent-catch.mjs            检查（发现新增即失败）
//   node scripts/lint-silent-catch.mjs --update   把当前存量写进白名单（仅用于冻结存量）
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(ROOT, "..", "..");
const ALLOW = join(ROOT, "scripts", "silent-catch-allowlist.json");

const SCAN_ROOTS = [
  join(ROOT, "app"),
  join(ROOT, "shared"),
  join(ROOT, "scripts"),
  join(REPO, "客户端", "source", "desktop"),
  join(REPO, "客户端", "source", "shared"),
];

const SKIP = /node_modules|\.next|\.vinext|\\dist\\|dist2|electron-dist|release-|current-package|\.data/;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (SKIP.test(full)) continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(full);
  }
  return out;
}

/** 找出"catch 体为空（只允许空白或注释）"的位置 */
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
      const line = text.slice(0, match.index).split("\n").length;
      hits.push({ line, snippet: match[0].trim(), body: body.trim().split("\n")[0] ?? "" });
    }
  }
  return hits;
}

function loadAllowlist() {
  if (!existsSync(ALLOW)) return { entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(ALLOW, "utf8").replace(/^\uFEFF/, ""));
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch {
    return { entries: [], broken: true };
  }
}

const files = SCAN_ROOTS.flatMap((dir) => walk(dir));
const found = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const hit of findSilentCatches(text)) {
    found.push({
      file: relative(REPO, file).replace(/\\/g, "/"),
      line: hit.line,
      snippet: hit.snippet,
      body: hit.body,
    });
  }
}

const key = (entry) => entry.file + "||" + entry.snippet;

if (process.argv.includes("--update")) {
  const existing = loadAllowlist().entries;
  const seen = new Set(existing.map(key));
  const merged = [...existing];
  for (const item of found) {
    if (seen.has(key(item))) continue;
    merged.push({
      file: item.file,
      snippet: item.snippet,
      reason: "既有静默兜底：冻结存量，新增一律拦下（要吞就在 reason 里写清为什么安全）",
    });
  }
  const stillThere = merged.filter((entry) => found.some((item) => key(item) === key(entry)));
  writeFileSync(
    ALLOW,
    JSON.stringify({ _comment: "只许缩不许涨：修掉一处就删一条；新增静默 catch 必须写明理由", entries: stillThere }, null, 2) + "\n",
    "utf8",
  );
  console.log(`白名单已更新：${stillThere.length} 条（扫描到 ${found.length} 处静默 catch，文件 ${files.length} 个）`);
  process.exit(0);
}

const allowed = loadAllowlist().entries;
const allowedKeys = new Set(allowed.map(key));
const foundKeys = new Set(found.map(key));

const added = found.filter((item) => !allowedKeys.has(key(item)));
const stale = allowed.filter((entry) => !foundKeys.has(key(entry)));

if (added.length) {
  console.error(`✗ 新增静默 catch ${added.length} 处（catch 体里没有任何记录/处理）：`);
  for (const item of added) {
    console.error(`  ${item.file}:${item.line}  ${item.snippet}   ${item.body}`);
  }
  console.error("处理方式二选一：");
  console.error("  1) 真处理：记录日志 / 转成返回值 / 抛出带上下文的错误；");
  console.error("  2) 确认安全可吞：在 scripts/silent-catch-allowlist.json 里加一条并在 reason 写清为什么安全。");
  process.exit(1);
}

if (stale.length) {
  console.error(`✗ 白名单有 ${stale.length} 条已失效（对应代码已改），请删掉免得白名单变废纸：`);
  for (const entry of stale.slice(0, 20)) console.error(`  ${entry.file}  ${entry.snippet}`);
  process.exit(1);
}

console.log(`静默 catch 护栏通过：扫描 ${files.length} 个文件，命中 ${found.length} 处，全部在白名单内（${allowed.length} 条）`);
