// 门禁：一条命令跑完「策略自测 → 类型检查 → 构建 → 全量测试 → 基线清单未漂移 → 快照回归 → 覆盖率门槛」。
// 用法：node scripts/gate.mjs          全量（含构建，约 20s）
//       node scripts/gate.mjs --fast   跳过构建（提交前用，约 8s）
// 任何一步失败立即退出非零，并在日志里写明是哪一步、输出落在哪。
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);
const FAST = process.argv.includes("--fast");
const stamp = (() => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  // 用本机本地日期：UTC 会把 16 日的提交记成 15 日，日志文件名对不上当天
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
})();
const LOG = join(ROOT, `gate-${stamp}.log`);
const lines = [];
const t0 = Date.now();

function say(text) {
  lines.push(text);
  console.log(text);
}

/** 子进程统一走 node 绝对路径 + 绝对脚本路径：这台机器的 PATH 不可靠 */
function runNode(args, extraEnv = {}) {
  const res = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    windowsHide: true,
    timeout: 10 * 60 * 1000,
  });
  return {
    ok: res.status === 0,
    status: res.status ?? -1,
    out: ((res.stdout ?? "") + (res.stderr ?? "")).trim(),
  };
}

function step(name, fn) {
  const started = Date.now();
  say(`\n▶ ${name}`);
  const result = fn();
  const cost = ((Date.now() - started) / 1000).toFixed(1);
  if (!result.ok) {
    // 失败细节不能只截尾：测试框架的 `not ok` 行常常在中段，截尾会把原因吃掉
    const notOk = result.out
      .split("\n")
      .filter((line) => /^\s*not ok|error:|failureType:|AssertionError/.test(line))
      .slice(0, 20);
    say(`✗ ${name} 失败（${cost}s）`);
    if (notOk.length) say(notOk.join("\n"));
    say("--- 输出尾部 ---");
    say(result.out.split("\n").slice(-30).join("\n"));
    say(`--- 完整输出已写入日志 ${LOG} ---`);
    say(`\n门禁未通过：${name}`);
    writeFileSync(LOG, lines.join("\n") + "\n" + "=== 原始输出 ===\n" + result.out + "\n", "utf8");
    console.log(`\n日志：${LOG}`);
    process.exit(1);
  }
  say(`✓ ${name}（${cost}s）`);
  if (result.out) say(result.out.split("\n").slice(-3).join("\n"));
  return result;
}

// 1) 策略自测（69 条用例，不依赖测试框架，最快能发现问题）
step("策略自测（command-policy 69 条）", () => {
  const mod = pathToFileURL(join(ROOT, "shared", "command-policy.mjs")).href;
  const res = runNode([
    "-e",
    `import('${mod}').then((m)=>{const f=m.selfTestPolicy();console.log('selfTest failures='+f.length);if(f.length){console.error(JSON.stringify(f,null,2));process.exit(1);}}).catch((e)=>{console.error(e);process.exit(1);})`,
  ]);
  return res;
});

// 2) 类型检查
step("类型检查 tsc --noEmit", () =>
  runNode([join(ROOT, "node_modules", "typescript", "bin", "tsc"), "--noEmit"]));

// 3) 构建
if (!FAST) {
  step("构建 vinext build", () => runNode([join(ROOT, "node_modules", "vinext", "dist", "cli.js"), "build"]));
} else {
  say("\n⏭ 构建（--fast 跳过）");
}

// 4) 全量测试
step("全量测试 tests/*.test.mjs", () => {
  const files = readdirSync(join(ROOT, "tests"))
    .filter((f) => f.endsWith(".test.mjs"))
    .map((f) => join("tests", f));
  if (!files.length) return { ok: false, out: "tests 目录下没有 *.test.mjs" };
  return runNode([join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), "--test", ...files]);
});

// 5) 基线清单未漂移：重算一遍，和仓库里已提交的清单比字节
step("基线清单未漂移（docs/baseline 与代码一致）", () => {
  const baseDir = join(ROOT, "docs", "baseline");
  if (!existsSync(baseDir)) return { ok: false, out: "docs/baseline 不存在，先跑 node scripts/gen-baseline-inventory.mjs" };
  const tmp = mkdtempSync(join(tmpdir(), "xiaoluo-baseline-"));
  try {
    const gen = runNode([join(ROOT, "scripts", "gen-baseline-inventory.mjs")], { XIAOLUO_BASELINE_OUT: tmp });
    if (!gen.ok) return gen;
    const drift = [];
    for (const file of readdirSync(baseDir).filter((f) => f.endsWith(".csv"))) {
      const fresh = join(tmp, file);
      if (!existsSync(fresh)) {
        drift.push(`${file}: 生成器不再产出该文件`);
        continue;
      }
      if (readFileSync(join(baseDir, file), "utf8") !== readFileSync(fresh, "utf8")) {
        drift.push(`${file}: 内容与代码不一致`);
      }
    }
    if (drift.length) {
      return { ok: false, out: drift.join("\n") + "\n修复：node scripts/gen-baseline-inventory.mjs（然后 review diff）" };
    }
    return { ok: true, out: "8 份清单与代码一致" };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// 6) 快照回归：变更必须显式 approve
step("快照回归（XIAOLUO_SNAPSHOT_UPDATE=1 才允许改写）", () => {
  const dir = join(ROOT, "tests");
  const file = join(dir, "brain-snapshot.test.mjs");
  if (!existsSync(file)) return { ok: true, out: "未启用（无 tests/brain-snapshot.test.mjs）" };
  return runNode([join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), "--test", join("tests", "brain-snapshot.test.mjs")]);
});

// 7) 覆盖率门槛：Node 内置覆盖率，阈值写在 scripts/coverage-thresholds.json
// 只卡"整体不低于基线"——不做花哨的 per-file 门槛，否则每加一个文件都要调阈值
// --fast（提交前）跳过：覆盖率要跑 60s 上下，别拖住每次提交
if (!FAST) {
  step("覆盖率门槛（scripts/coverage-thresholds.json）", () => {
  const thresholdFile = join(ROOT, "scripts", "coverage-thresholds.json");
  if (!existsSync(thresholdFile)) return { ok: false, out: "缺少 scripts/coverage-thresholds.json" };
  const thresholds = JSON.parse(readFileSync(thresholdFile, "utf8").replace(/^\uFEFF/, ""));
  const files = readdirSync(join(ROOT, "tests"))
    .filter((f) => f.endsWith(".test.mjs"))
    .map((f) => join("tests", f));
  const res = runNode([
    "--experimental-test-coverage",
    "--import",
    "tsx/esm",
    "--test",
    ...files,
  ]);
  const summary = (res.out || "").split("\n").find((line) => line.includes("# all files"));
  if (!summary) {
    return { ok: false, out: (res.out || "") + "\n没读到 `# all files` 覆盖率汇总行" };
  }
  const nums = summary.match(/[\d.]+/g) || [];
  const [line, branch, funcs] = nums.slice(0, 3).map((n) => Number(n));
  const checks = [
    ["line", line, thresholds.line],
    ["branch", branch, thresholds.branch],
    ["funcs", funcs, thresholds.funcs],
  ];
  const failed = checks.filter(([name, actual, min]) => Number.isFinite(actual) && actual < Number(min));
  const detail = checks.map(([name, actual, min]) => `${name} ${actual}%（下限 ${min}%）`).join("，");
  if (failed.length) {
    return { ok: false, out: `${res.out}\n覆盖率低于门槛：${detail}` };
  }
  return { ok: true, out: `覆盖率 ${detail}` };
  });
} else {
  say("\n⏭ 覆盖率门槛（--fast 跳过）");
}

say(`\n门禁通过（总耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）${FAST ? "（--fast 未跑构建）" : ""}`);
mkdirSync(dirname(LOG), { recursive: true });
writeFileSync(LOG, lines.join("\n") + "\n", "utf8");
console.log(`日志：${LOG}`);
