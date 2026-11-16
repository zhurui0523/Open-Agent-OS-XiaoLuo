/**
 * P0-1 安全隔离测试：硬禁区 + 审批四档 + 主机白名单 + 系统级隔离档
 *
 * 与 brain-network-policy.test.mjs 的分工：那个测网络策略接线，这个测「批了也不放行」的硬边界。
 * 策略本体只有 shared/command-policy.mjs 一份，这里直接 import 真策略跑，不做正则复述。
 */
import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { brainWorkspaceRoot } from "../app/lib/brain-sandbox.ts";
import { gateCommand, gateSessionInput } from "../app/lib/brain-command-gate.ts";
import {
  APPROVAL_MODES,
  DEFAULT_APPROVAL_MODE,
  decideApproval,
  resolveApprovalMode,
  selfTestPolicy,
} from "../shared/command-policy.mjs";
import { describeIsolation, getSandboxLauncher, winMicSetting } from "../app/lib/brain-sandbox-win.mjs";

test("策略用例全绿（风险 + 网络 + 禁区 + 审批四组）", () => {
  assert.deepEqual(selfTestPolicy(), []);
});

test("审批档位只有四档，取值写错退回默认 on-request", () => {
  assert.deepEqual(APPROVAL_MODES, ["never", "on-request", "unless-trusted", "granular"]);
  assert.equal(DEFAULT_APPROVAL_MODE, "on-request");
  assert.equal(resolveApprovalMode("YOLO"), "on-request");
  assert.equal(resolveApprovalMode(""), "on-request");
  assert.equal(resolveApprovalMode("never"), "never");
  assert.equal(resolveApprovalMode("Granular"), "granular");
});

test("hard blocked 在任何档位都不放行：不问不等于批准", () => {
  for (const mode of APPROVAL_MODES) {
    assert.equal(decideApproval({ level: "blocked", reasons: [] }, mode).action, "deny", mode);
  }
});

test("unless-trusted 把本该 safe 的命令也升级为请示，显式信任后才放行", () => {
  assert.equal(decideApproval({ level: "safe" }, "unless-trusted").action, "ask");
  assert.equal(decideApproval({ level: "safe" }, "unless-trusted", { trusted: true }).action, "allow");
});

test("硬禁区：系统目录与凭据目录即便 approved 也拒绝", async () => {
  const uid = "test-sandbox-forbidden";
  const cases = [
    String.raw`Set-Content -LiteralPath "C:\Windows\System32\drivers\etc\hosts" -Value x`,
    String.raw`Out-File -FilePath "C:\Program Files\x.txt"`,
    String.raw`Remove-Item C:\Windows\Temp -Recurse`,
    "echo x > /etc/passwd",
  ];
  for (const text of cases) {
    const out = await gateCommand({ userId: uid, text, approved: true, withNetwork: false });
    assert.equal(out.ok, false, text);
    assert.equal(out.denial.code, "blocked", text);
    assert.match(out.denial.error, /硬禁区/);
  }
});

test("硬禁区不误伤：工作区内同名片段照常放行", async () => {
  const uid = "test-sandbox-forbidden-ok";
  for (const text of ["echo x > ./out/etc-list.txt", "Set-Content ./notes/windows.md -Value hi"]) {
    const out = await gateCommand({ userId: uid, text, approved: false, withNetwork: false });
    assert.equal(out.ok, true, text);
  }
});

test("审批档位从环境切：never 下需请示的命令直接拒，不被静默执行", async () => {
  const uid = "test-sandbox-approval-mode";
  const risky = "pip install requests";
  const prev = process.env.XIAOLUO_APPROVAL_MODE;

  process.env.XIAOLUO_APPROVAL_MODE = "never";
  const denied = await gateCommand({ userId: uid, text: risky, approved: true, withNetwork: false });
  assert.equal(denied.ok, false, "never 档下即便是 approved 也不该执行需要请示的命令");
  assert.equal(denied.denial.code, "blocked");

  process.env.XIAOLUO_APPROVAL_MODE = "on-request";
  const asked = await gateCommand({ userId: uid, text: risky, approved: false, withNetwork: false });
  assert.equal(asked.denial.code, "approval_required");

  if (prev === undefined) delete process.env.XIAOLUO_APPROVAL_MODE;
  else process.env.XIAOLUO_APPROVAL_MODE = prev;
});

test("主机白名单：hooks.toml 里 network_allow 命中的放行，未命中的仍要走批准", async () => {
  const uid = "test-sandbox-allowlist";
  const workspace = brainWorkspaceRoot(uid);
  await mkdir(workspace, { recursive: true });
  await writeFile(
    path.join(workspace, "hooks.toml"),
    '[sandbox]\nnetwork = "loopback"\nnetwork_allow = ["api.corp.com", "*.trusted.io"]\n',
    "utf8",
  );

  const allowed = await gateCommand({ userId: uid, text: "curl https://api.corp.com/v1", approved: false, withNetwork: true });
  assert.equal(allowed.ok, true, "白名单精确命中应放行");

  const wildcard = await gateCommand({ userId: uid, text: "curl https://sub.trusted.io/x", approved: false, withNetwork: true });
  assert.equal(wildcard.ok, true, "白名单通配命中应放行");

  const other = await gateCommand({ userId: uid, text: "curl https://evil.example.com/x", approved: false, withNetwork: true });
  assert.equal(other.ok, false);
  assert.equal(other.denial.code, "approval_required");

  // 元数据地址即便写进白名单也不放行
  await writeFile(
    path.join(workspace, "hooks.toml"),
    '[sandbox]\nnetwork = "loopback"\nnetwork_allow = ["169.254.169.254"]\n',
    "utf8",
  );
  const meta = await gateCommand({ userId: uid, text: "curl http://169.254.169.254/latest/meta-data/", approved: true, withNetwork: true });
  assert.equal(meta.ok, false);
  assert.equal(meta.denial.code, "network_blocked");

  await rm(path.join(workspace, "hooks.toml"), { force: true });
});

test("会话续写也过硬禁区：把禁区命令敲进已开 shell 不算绕过", async () => {
  const uid = "test-sandbox-session-forbidden";
  const denial = await gateSessionInput({ userId: uid, input: String.raw`cp key.txt "C:\Windows\x.txt"`, approved: true });
  assert.notEqual(denial, null);
  assert.equal(denial.code, "blocked");
});

test("新工作区播种：空目录首次读策略就写 hooks.toml（loopback + 白名单）", async () => {
  const uid = "test-sandbox-seed-fresh";
  const workspace = brainWorkspaceRoot(uid);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  const out = await gateCommand({ userId: uid, text: "curl https://api.example.com/v1", approved: false, withNetwork: true });
  assert.equal(out.ok, false, "播种后默认要求外联批准");
  assert.equal(out.denial.code, "approval_required");
  await access(path.join(workspace, "hooks.toml"));
  await access(path.join(workspace, ".policy-seeded"));
});

test("老工作区不播种：已有内容且没配过策略，不会被悄悄改成 loopback", async () => {
  const uid = "test-sandbox-seed-legacy";
  const workspace = brainWorkspaceRoot(uid);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "notes.md"), "老项目", "utf8");
  const out = await gateCommand({ userId: uid, text: "curl https://api.example.com/v1", approved: false, withNetwork: true });
  assert.equal(out.ok, true, "老工作区仍按全局默认档 open，行为不变");
  await assert.rejects(access(path.join(workspace, "hooks.toml")));
});

test("系统级隔离档默认 auto：落点打不了标就如实降级，不假装有防护", async () => {
  const prev = process.env.XIAOLUO_SANDBOX_WIN_MIC;
  delete process.env.XIAOLUO_SANDBOX_WIN_MIC;
  assert.equal(winMicSetting(), "auto", "默认档应是 auto 而不是永久关闭");

  // 代码仓里这种继承系统 ACL 的目录打不了 Low 标签：必须返回 null + 给出原因
  const repoRoot = brainWorkspaceRoot("test-sandbox-mic-probe");
  await mkdir(repoRoot, { recursive: true });
  const info = describeIsolation(repoRoot);
  assert.equal(info.setting, "auto");
  assert.equal(info.level, "none", "打不了标就不该报 mic-low");
  assert.match(info.note, /命令策略/, "降级时必须说清实际还有什么防护");

  // 显式关闭：说清是被关掉，不是能力缺失
  process.env.XIAOLUO_SANDBOX_WIN_MIC = "0";
  assert.equal(winMicSetting(), "off");
  // 措辞跟着平台走：Windows 才说"显式关闭"，其他平台本来就没接内核级沙箱
  if (process.platform === "win32") {
    assert.equal(describeIsolation(repoRoot).note.includes("显式关闭"), true);
  } else {
    assert.match(describeIsolation(repoRoot).note, /未接入内核级沙箱/);
  }

  if (prev === undefined) delete process.env.XIAOLUO_SANDBOX_WIN_MIC;
  else process.env.XIAOLUO_SANDBOX_WIN_MIC = prev;
});

test("工作区落点可覆盖：代码仓目录打不了 Low 标签，必须能指到用户自有目录", async () => {
  const sandbox = await readFile(new URL("../app/lib/brain-sandbox.ts", import.meta.url), "utf8");
  assert.match(sandbox, /process\.env\.XIAOLUO_WORKSPACE_ROOT/, "没有 env 覆盖，MIC 档在代码仓里永远是降级");
});
