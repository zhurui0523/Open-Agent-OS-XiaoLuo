// 命令策略回归冒烟：改过 shared/command-policy.mjs 后跑一遍（node scripts/smoke-command-policy.mjs）
// 用例清单即 POLICY_TEST_CASES（含套娃绕过/硬拦截/需批准/不误伤四类）；加载期双侧（桌面/服务端）也各自自测。
import { selfTestPolicy, POLICY_TEST_CASES } from "../shared/command-policy.mjs";
const failures = selfTestPolicy();
console.log("策略用例：" + POLICY_TEST_CASES.length + " 条，失败 " + failures.length + " 条");
for (const f of failures) console.log("  FAIL " + f);
process.exit(failures.length ? 1 : 0);
