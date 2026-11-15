// CI 预检：不联网、不推远端，也能确认"推到 GitHub 后这一步跑得过"。
// 查的不是门禁本身（那个 gate.mjs 已经在跑），而是"干净检出"这一层最容易翻车的地方：
//   1) 工作流是否在仓库根（GitHub 只读根 .github/workflows）；
//   2) 工作流里引用的路径/命令是否真的存在；
//   3) 门禁需要的东西（tests / docs/baseline / 锁文件 / shared）有没有被 .gitignore 挡住而没入库；
//   4) 当前仓库是否干净（有未提交改动说明这次"检出"和本地不一致）。
//
//   node scripts/preflight-ci.mjs
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(ROOT, "..", "..");
const WORKFLOW = join(REPO, ".github", "workflows", "gate.yml");

const problems = [];
const notes = [];
const ok = (msg) => notes.push("✓ " + msg);
const bad = (msg) => problems.push("✗ " + msg);

// 1) 工作流在仓库根
if (!existsSync(WORKFLOW)) {
  bad(`工作流不在仓库根：${WORKFLOW} 不存在（GitHub Actions 只读这里的文件）`);
} else {
  const text = readFileSync(WORKFLOW, "utf8");
  ok("工作流位于仓库根 .github/workflows/gate.yml");
  if (!/working-directory:\s*后台\/source/.test(text)) bad("工作流缺少 working-directory: 后台/source");
  else ok("工作流工作目录指向 后台/source");
  if (!/node scripts\/gate\.mjs/.test(text)) bad("工作流没有调用 node scripts/gate.mjs");
  else ok("工作流调用 gate.mjs（全量九步）");
  if (!/node-version:\s*22/.test(text)) bad("工作流没用 Node 22（node:sqlite 需要它）");
  else ok("工作流用 Node 22（node:sqlite 可用）");
  if (!/pnpm-lock\.yaml/.test(text)) bad("工作流没有缓存/依赖 pnpm-lock.yaml");
  else ok("工作流绑定 pnpm-lock.yaml");
}

// 2) 锁文件
for (const lock of ["pnpm-lock.yaml", "package.json"]) {
  if (existsSync(join(ROOT, lock))) ok(`${lock} 存在`);
  else bad(`${lock} 缺失（CI 的 pnpm install --frozen-lockfile 会失败）`);
}

// 3) "干净检出"必须有：CI 只拿到 git 里的文件，被 ignore 的东西在 Actions 上就是不存在
const required = [
  "tests",
  "docs/baseline",
  "shared",
  "scripts/gate.mjs",
  "scripts/gen-baseline-inventory.mjs",
  "scripts/coverage-thresholds.json",
  "scripts/silent-catch-allowlist.json",
];
const git = spawnSync("git", ["-c", "core.quotepath=false", "ls-files"], { cwd: REPO, encoding: "utf8" });
if (git.status !== 0) {
  bad("读不到 git 索引（可能不是 git 仓库或 git 不可用）");
} else {
  const tracked = git.stdout.split("\n").filter(Boolean);
  const isIgnored = (abs) => spawnSync("git", ["check-ignore", "-q", abs], { cwd: REPO }).status === 0;
  for (const rel of required) {
    const abs = join(ROOT, ...rel.split("/"));
    const hit = tracked.some((path) => path === `后台/source/${rel}` || path.startsWith(`后台/source/${rel}/`));
    if (hit) ok(`已入库：${rel}`);
    else if (!existsSync(abs)) bad(`不存在：${rel}`);
    else if (isIgnored(abs)) bad(`被 .gitignore 挡住：${rel}（CI 检出后不会有它，本地却能跑，最坑）`);
    else notes.push(`！未入库但存在于本地：${rel}（提交前记得 git add）`);
  }
  // 快照单独点名：漏了最难排查（快照回归会退化成空跑）
  if (tracked.some((path) => path.startsWith("后台/source/tests/__snapshots__/"))) {
    ok("已入库：tests/__snapshots__");
  } else if (isIgnored(join(ROOT, "tests", "__snapshots__"))) {
    bad("被 .gitignore 挡住：tests/__snapshots__（快照回归在 CI 会退化成空跑）");
  } else {
    notes.push("！未入库但存在于本地：tests/__snapshots__（提交前记得 git add）");
  }
}

// 4) 检出是否干净（脏工作区说明本地与"CI 看到的那一份"不一致）
const status = spawnSync("git", ["status", "--porcelain"], { cwd: REPO, encoding: "utf8" });
if (status.status === 0) {
  const dirty = status.stdout.split("\n").filter(Boolean);
  if (dirty.length) {
    notes.push(`！工作区有 ${dirty.length} 项未提交：本地能过不代表 CI 那边的提交能过`);
  } else {
    ok("工作区干净（与提交内容一致）");
  }
}

// 5) 远端是否已配置（只提示，不算失败）
const remotes = spawnSync("git", ["remote", "-v"], { cwd: REPO, encoding: "utf8" });
if (remotes.status === 0 && !remotes.stdout.trim()) {
  notes.push("！尚未配置 git remote：工作流已就绪，但还没在 GitHub Actions 上真跑过");
}

for (const line of notes) console.log(line);
if (problems.length) {
  for (const line of problems) console.error(line);
  console.error(`\nCI 预检未通过：${problems.length} 项`);
  process.exit(1);
}
console.log("\nCI 预检通过：推到 GitHub 后这一套能跑（本脚本不联网，只验证干净检出这一层）");
