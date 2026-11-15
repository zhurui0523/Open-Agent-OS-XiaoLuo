// 安装本地 git 门禁钩子：把 scripts/gate.mjs --fast 挂到 pre-commit。
// 仓库根可能在本目录之上（后台/source 只是子目录），所以向上找 .git，而不是死认本目录。
import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function findRepoRoot(start) {
  let dir = start;
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const REPO_ROOT = findRepoRoot(ROOT);
if (!REPO_ROOT) {
  console.error("找不到 .git：从 " + ROOT + " 一路向上都没有仓库。门禁钩子装不上。");
  console.error("下一步二选一：");
  console.error("  1) 在仓库根（通常是本项目的上级目录）git init，然后重跑本脚本；");
  console.error("  2) 直接用 CI（仓库根 .github/workflows/gate.yml）或手动 node scripts/gate.mjs --fast。");
  process.exit(1);
}

const GIT_DIR = join(REPO_ROOT, ".git");
const HOOK = join(GIT_DIR, "hooks", "pre-commit");
// 钩子从仓库根触发，但门禁要在 后台/source 里跑（gate.mjs 依赖 cwd）
const REL = relative(REPO_ROOT, ROOT).replace(/\\/g, "/") || ".";


const body = `#!/bin/sh
# 由 scripts/install-git-hooks.mjs 生成；跳过用 git commit --no-verify
# 仓库根在上级目录，门禁要在 ${REL} 里跑
cd "$(git rev-parse --show-toplevel)/${REL}" || exit 1
node scripts/gate.mjs --fast || {
  echo "门禁未通过：修复后重试，或临时跳过（git commit --no-verify）";
  exit 1
}
`;
mkdirSync(join(GIT_DIR, "hooks"), { recursive: true });
writeFileSync(HOOK, body, "utf8");
try {
  chmodSync(HOOK, 0o755);
} catch {
  // Windows 上 chmod 无实际意义，git 走 sh 执行
}
console.log(`仓库根：${REPO_ROOT}`);
console.log(`已安装 pre-commit 钩子：${HOOK}`);
console.log(`钩子内容：进入 ${REL} 后跑 node scripts/gate.mjs --fast（策略自测 + tsc + 全量测试 + 清单漂移 + 快照）`);
