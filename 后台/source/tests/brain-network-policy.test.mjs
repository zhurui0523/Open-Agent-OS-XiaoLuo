/**
 * 命令沙箱网络维度测试（P1：把「其实没禁网」变成一份可配策略）
 *
 * 策略只有 shared/command-policy.mjs 一份（服务端与桌面端共用），所以这里直接 import 真策略跑，
 * 不做源码正则复述；只有「接在哪、怎么注入 env」这类接线事实按仓库惯例做源码断言。
 */
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { brainWorkspaceRoot } from "../app/lib/brain-sandbox.ts";
import { gateCommand, gateSessionInput } from "../app/lib/brain-command-gate.ts";
import {
  evaluateNetworkPolicy,
  extractNetworkTargets,
  isLoopbackHost,
  networkPolicyEnv,
  selfTestPolicy,
} from "../shared/command-policy.mjs";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("共享策略自带用例全绿（风险分级 + 网络分级）", () => {
  assert.deepEqual(selfTestPolicy(), []);
});

test("默认 open 不改任何既有行为", () => {
  for (const cmd of ["curl https://api.example.com/x", "npm install", "wget http://169.254.169.254/"]) {
    assert.equal(evaluateNetworkPolicy(cmd, "open").level, "allow", cmd);
  }
  assert.equal(networkPolicyEnv("open").HTTP_PROXY, undefined);
});

test("策略写错取值退回 open，不静默全拦", () => {
  assert.equal(evaluateNetworkPolicy("curl https://api.example.com", "lantern").level, "allow");
});

test("回环目标始终放行：小逻自查自己的预览服务不能被策略挡死", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("LOCALHOST"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("api.example.com"), false);
  for (const mode of ["loopback", "block"]) {
    assert.equal(evaluateNetworkPolicy("curl -s http://127.0.0.1:3000/api/health", mode).level, "allow", mode);
  }
});

test("外部主机在紧张策略下要走批准", () => {
  const r = evaluateNetworkPolicy("curl https://api.example.com/v1/items", "loopback");
  assert.equal(r.level, "ask");
  assert.match(r.reasons.join(""), /外部主机 api\.example\.com/);
  assert.deepEqual(extractNetworkTargets("git clone https://github.com/a/b.git"), ["github.com"]);
});

test("云元数据地址：批准也不放行", () => {
  const r = evaluateNetworkPolicy("curl http://169.254.169.254/latest/meta-data/iam/", "block");
  assert.equal(r.level, "deny");
  assert.match(r.reasons.join(""), /机器凭据/);
});

test("block 下装包类即使 argv 没 URL 也要批准（防绕过）", () => {
  assert.equal(evaluateNetworkPolicy("pip install requests", "block").level, "ask");
  assert.equal(evaluateNetworkPolicy("npm install", "block").level, "ask");
  assert.equal(evaluateNetworkPolicy("npm install", "loopback").level, "allow");
  assert.equal(evaluateNetworkPolicy("node build.js", "block").level, "allow");
});

test("注入的 env 只堵外联不堵回环；批准即撤除", () => {
  const lb = networkPolicyEnv("loopback");
  assert.equal(lb.HTTPS_PROXY, "http://127.0.0.1:9");
  assert.match(lb.NO_PROXY, /127\.0\.0\.1/);
  assert.match(lb.no_proxy, /localhost/);
  assert.equal(networkPolicyEnv("block").npm_config_offline, "1");
  assert.equal(networkPolicyEnv("block").PIP_NO_INDEX, "1");
  assert.deepEqual(networkPolicyEnv("loopback", true), {});
});

test("接线事实：策略从工作区 hooks.toml 读，mtime 缓存，批准撤除注入", async () => {
  const sandbox = await source("app/lib/brain-sandbox.ts");
  assert.match(sandbox, /\[sandbox\]/);
  assert.match(sandbox, /VALID_NETWORK_MODES\.has\(value\) \? \(value as NetworkMode\) : "open"/);
  assert.match(sandbox, /cached && cached\.mtimeMs === stat\.mtimeMs/);
  assert.match(sandbox, /minimalEnv\(cwd, isWindows, networkEnvFor\(networkMode\)\)/);
  // 受限档下临时/缓存目录要重定向进工作区，否则低完整性进程写不了 npm 缓存
  assert.match(sandbox, /restrictedHomeEnv\(minimalEnv\(cwd, isWindows, networkEnvFor\(networkMode\)\), root\)/);
  // 老板批准后本次不注入黑洞，否则批准形同虚设
  assert.match(sandbox, /effective: lift \? "open" : config\.mode/);
  // 服务与 git 同一条策略，别只管 run_command
  assert.match(sandbox, /networkEnvFor\(await readSandboxNetworkPolicy\(userId\)\)/);

  const route = await source("app/api/v2/brain/command/route.ts");
  // 路由只剩接线：判定与执行都搬进闸门模块，语义不再有两份
  assert.match(route, /runGatedCommand\(\{[\s\S]{0,120}userId: user\.id/);
  assert.match(route, /openGatedSession\(\{[\s\S]{0,120}userId: user\.id/);
  assert.match(route, /writeGatedSession\(\{[\s\S]{0,120}userId: user\.id/);
  assert.doesNotMatch(route, /classifyCommandRisk/, "路由里不该再自己分级一次：门只有一道");

  const chatAgent = await source("app/xiaoluo-brain/lib/brain/chat-agent.ts");
  // 被黑洞挡掉的下载看着像命令自己的错，必须把策略原因回流给小逻
  assert.match(chatAgent, /result\.networkNote \? "\\n" \+ result\.networkNote : ""/);
});

test("真策略往返：hooks.toml 一改，闸门的裁决就跟着变", async () => {
  const uid = "test-network-policy-wiring";
  const workspace = brainWorkspaceRoot(uid);
  const hooks = path.join(workspace, "hooks.toml");
  // 干净工作区（整个目录删掉，模拟「新建用户第一次跑命令」）
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  const curl = "curl https://api.example.com/v1/items";

  // 新工作区首次读策略即播种：network=loopback + 常用源白名单。老工作区有 marker，不会被动到。
  const seeded = await gateCommand({ userId: uid, text: curl, approved: false, withNetwork: true });
  assert.equal(seeded.ok, false, "播种后外部主机默认要走批准");
  assert.equal(seeded.denial.code, "approval_required");
  const seededToml = await readFile(hooks, "utf8");
  assert.match(seededToml, /network = "loopback"/);
  assert.match(seededToml, /network_allow = \[[\s\S]*github\.com/, "播种要带常用源白名单，否则第一条命令就被拦");

  // 白名单命中的不用问
  const whitelisted = await gateCommand({ userId: uid, text: "curl https://api.github.com/repos/x/y", approved: false, withNetwork: true });
  assert.equal(whitelisted.ok, true, "播种白名单里的域名应直接放行");

  await writeFile(hooks, '[sandbox]\nnetwork = "loopback"\n', "utf8");
  const asked = await gateCommand({ userId: uid, text: curl, approved: false, withNetwork: true });
  assert.equal(asked.ok, false);
  assert.equal(asked.denial.code, "approval_required");
  assert.match(asked.denial.error, /需要老板批准后才能外联/);
  assert.match(asked.denial.reasons.join(""), /外部主机 api\.example\.com/);
  // 批准 = 本次撤除注入（effective 回到 open），批准不能只是换个文案继续被黑洞挡着
  const granted = await gateCommand({ userId: uid, text: curl, approved: true, withNetwork: true });
  assert.equal(granted.ok, true);
  assert.equal(granted.network.effective, "open");

  // 隔 5ms 再改：策略读有 mtime 缓存，同一毫秒内两次写入会让新值被旧缓存盖住
  await new Promise((resolve) => setTimeout(resolve, 5));
  await writeFile(hooks, '[sandbox]\nnetwork = "block"\n', "utf8");
  const meta = await gateCommand({ userId: uid, text: "curl http://169.254.169.254/latest/meta-data/", approved: true, withNetwork: true });
  assert.equal(meta.ok, false);
  assert.equal(meta.denial.code, "network_blocked");
  assert.match(meta.denial.error, /机器凭据/, "云元数据地址批准也不放行");

  // 会话续写不重复扫网络：策略在开席那刻定下，续写只扫命令签名与围栏
  const sessionInput = await gateSessionInput({ userId: uid, input: curl, approved: false });
  assert.equal(sessionInput, null, "loopback/block 下的外联由开席那次决定");

  // 老板删掉 hooks.toml（marker 留着）= 明确表示不要策略，尊重删除，不再重播
  await new Promise((resolve) => setTimeout(resolve, 5));
  await rm(hooks, { force: true });
  const afterDelete = await gateCommand({ userId: uid, text: curl, approved: false, withNetwork: true });
  assert.equal(afterDelete.ok, true, "删了策略文件就回到全局默认档，不再自动重播");
});

