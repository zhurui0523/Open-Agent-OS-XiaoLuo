/**
 * 交互 stdin 会话（write_stdin）测试 —— 小逻终于能给进程打字了。
 *
 * 一次性 run_command 遇到「等输入」就只能干等到超时：REPL、y/n 确认、交互式调试全跑不通。
 * 现在沙箱里有会话注册表，路由把三道闸门（风险/网络/路径围栏）复用到会话上，
 * 工具面多出 write_stdin。这里覆盖：真实往返（含首屏 banner、退出码、静默提前返回）、
 * 归属校验、围栏拒绝越界 cwd，以及整条接线的源码断言。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  brainWorkspaceRoot,
  checkPathFence,
  runSandboxedCommand,
  startBrainStdinSession,
  writeBrainStdinSession,
} from "../app/lib/brain-sandbox.ts";
import { gateSessionInput, openGatedSession, writeGatedSession } from "../app/lib/brain-command-gate.ts";
import { chatToolCapabilities } from "../app/xiaoluo-brain/lib/brain/agent-ports.ts";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

/** 一个自己吐 banner、把每行输入回显、收到 bye 就退的常驻进程（跨平台，只要有 node） */
const ECHO_SCRIPT =
  "require('readline').createInterface({input:process.stdin}).on('line',(l)=>{console.log('ECHO:'+l);if(l==='bye'){process.exit(0);}});console.log('READY');";
const ECHO_COMMAND = 'node -e "' + ECHO_SCRIPT + '"';

test("真实往返：首屏拿得到 banner，写一行拿回显，退出后带 exitCode", async () => {
  const uid = "test-stdin-session";
  const started = await startBrainStdinSession(uid, ECHO_COMMAND, { ttlMs: 120_000 });
  assert.ok(started.sessionId.startsWith("sess-"), started.sessionId);
  assert.equal(started.status, "running");
  // 首屏必须等得到 READY：早先版本静默窗一到期就返回，把 banner 判成「没输出」
  assert.ok(started.output.includes("READY"), JSON.stringify(started.output));

  const wrote = await writeBrainStdinSession(uid, started.sessionId, "ping");
  assert.equal(wrote.status, "running");
  assert.ok(wrote.output.includes("ECHO:ping"), JSON.stringify(wrote.output));
  // 只回流新增输出，不重播历史
  assert.ok(!wrote.output.includes("READY"), wrote.output);

  const bye = await writeBrainStdinSession(uid, started.sessionId, "bye");
  assert.equal(bye.status, "exited");
  assert.equal(bye.exitCode, 0);
  assert.ok(bye.output.includes("ECHO:bye"), bye.output);

  // 进程退出后记录仍留着（否则退出前最后几行输出就丢了），但状态必须如实说"已结束"
  const after = await writeBrainStdinSession(uid, started.sessionId, "again");
  assert.equal(after.status, "exited");
  assert.equal(after.exitCode, 0);
  // 真正查不到的 id 要直接报错，别让会话 id 被当成"还在跑但没输出"
  await assert.rejects(
    () => writeBrainStdinSession(uid, "sess-not-a-real-session", "x"),
    /不存在或已被回收/,
  );
});

test("省略 input 就是轮询：没有新输出时返回空串而不是报错", async () => {
  const uid = "test-stdin-poll";
  const started = await startBrainStdinSession(uid, ECHO_COMMAND, { ttlMs: 120_000 });
  const polled = await writeBrainStdinSession(uid, started.sessionId, undefined, { waitMs: 400 });
  assert.equal(polled.status, "running");
  assert.equal(polled.output, "");
  await writeBrainStdinSession(uid, started.sessionId, "bye", { close: true });
});

test("老板按停止时会话一并回收，不留孤儿进程", async () => {
  const uid = "test-stdin-close";
  const started = await startBrainStdinSession(uid, ECHO_COMMAND, { ttlMs: 120_000 });
  const closed = await writeBrainStdinSession(uid, started.sessionId, "bye", { close: true });
  assert.equal(closed.status, "exited");
  await assert.rejects(() => writeBrainStdinSession(uid, started.sessionId), /不存在或已被回收/);
});

test("cwd 越出工作区围栏直接拒绝，不静默回落到根目录", async () => {
  await assert.rejects(
    () => runSandboxedCommand("test-stdin-fence", "echo hi", { cwd: "../escape" }),
    /越出工作区围栏/,
  );
  await assert.rejects(
    () => startBrainStdinSession("test-stdin-fence", "node", { cwd: "a/../../escape" }),
    /越出工作区围栏/,
  );
});

// ---------- 接线断言：闸门复用与端口形态（改动没接上时这里先红） ----------

test("闸门：开席与续写共用同一道门，越界输入照样拦", async () => {
  const uid = "test-gate-session";

  // 需要批准的命令未批准 → approval_required；批准后 → 会话真起、能打字、能收尾
  const risky = await openGatedSession({ userId: uid, command: "pip install requests", approved: false });
  assert.equal(risky.ok, false);
  assert.equal(risky.denial.code, "approval_required");
  const opened = await openGatedSession({ userId: uid, command: ECHO_COMMAND, approved: false, ttlMs: 120_000 });
  assert.equal(opened.ok, true, JSON.stringify(opened));

  // 会话续写也过门：把越界删除敲进 shell 不能再绕过围栏
  const blocked = await writeGatedSession({ userId: uid, sessionId: opened.data.sessionId, input: "rm -rf /", approved: false });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.denial.code, "blocked");
  const fenced = await writeGatedSession({ userId: uid, sessionId: opened.data.sessionId, input: "echo x > ../../escape.txt", approved: false });
  assert.equal(fenced.ok, false);
  assert.equal(fenced.denial.code, "approval_required");
  assert.match(fenced.denial.error, /这条输入/, "会话续写的拒绝文案要说清是输入越界");
  // 批准后闸门放行；但真跑给会话看的是一行无害输入 —— 越界那行没必要真写到沙箱外面去
  const approved = await gateSessionInput({ userId: uid, input: "echo x > ../../escape.txt", approved: true });
  assert.equal(approved, null, "老板批准就等于确认边界，闸门不该再拦");
  const passed = await writeGatedSession({ userId: uid, sessionId: opened.data.sessionId, input: "echo ok", approved: true });
  assert.equal(passed.ok, true, JSON.stringify(passed));
  assert.match(passed.data.output, /ECHO:echo ok/, "会话里的进程真收到了这一行");
  await writeGatedSession({ userId: uid, sessionId: opened.data.sessionId, input: "bye", close: true });

  // 只轮询（省略 input）不必过命令门
  const pollOnly = await gateSessionInput({ userId: uid, input: "   ", approved: false });
  assert.equal(pollOnly, null);
});

test("路径围栏：相对 ../../ 落点同样算越界，cwd 监狱兜不住它", () => {
  const root = brainWorkspaceRoot("test-fence-relative");
  // 交互式会话让「连着敲几行」变成最顺手的绕过手法，../../ 必须和绝对路径同罪
  assert.deepEqual(checkPathFence("echo x > ../../escape.txt", root), ["../../escape.txt"]);
  assert.deepEqual(checkPathFence("mkdir ../outside_dir", root), ["../outside_dir"]);
  assert.deepEqual(checkPathFence("node ../../bin/tool.js", root), [], "只读地跑工作区外的程序不算写入越界");
  assert.deepEqual(checkPathFence("echo x > out.log", root), [], "留在工作区内的相对写入不该麻烦老板");
  assert.deepEqual(checkPathFence("echo x > ./sub/../out.log", root), [], "爬出去又爬回来的落点仍在区内");
});

test("接线事实：路由把三道门交给闸门模块，自己不再判一遍", async () => {
  const route = await source("app/api/v2/brain/command/route.ts");
  // 三种形态各自调一个执行器：判定与执行都只有一份
  assert.match(route, /runGatedCommand\(\{[\s\S]{0,120}userId: user\.id/);
  assert.match(route, /openGatedSession\(\{[\s\S]{0,120}userId: user\.id/);
  assert.match(route, /writeGatedSession\(\{[\s\S]{0,120}userId: user\.id/);
  assert.match(route, /if \(!wrote\.ok\) return gateDenied\(wrote\.denial\)/);
  // 路由里再出现分级/围栏/网络裁决，就说明门被抄成了两份
  assert.doesNotMatch(route, /classifyCommandRisk|checkPathFence|decideCommandNetwork/);
  // 老板按停止要把会话一起收场：长驻进程留在原地会继续吃 CPU/占端口
  assert.match(route, /closeBrainStdinSessions\(user\.id\)/);
  // 会话轮询比一次性命令频繁得多，单独放宽限流否则一打就是 429
  assert.match(route, /route: "brain:stdin", max: 90/);
});

test("沙箱：会话三管道全开，且退出时一并杀进程树", async () => {
  const sandbox = await source("app/lib/brain-sandbox.ts");
  // 会话不能加 -NonInteractive：加了 Read-Host 直接报错，交互就没了意义
  assert.match(sandbox, /\["-NoProfile", "-EncodedCommand", toPsEncoded\(sanitizeCommandForPs51\(command\)\)\]/);
  assert.match(sandbox, /stdio: \["pipe", "pipe", "pipe"\]/);
  // 进程退出清场要把会话一起带走：真 PTY 先 kill 句柄，管道会话照旧杀进程树
  assert.match(sandbox, /for \(const rec of sessionRegistry\(\)\.values\(\)\) \{[\s\S]{0,80}killTree\(rec\.pid\);/);
  // 丢弃必须如实计数：环形缓冲挤掉的 + 保尾切掉的都算，别让残缺输出看着像完整
  assert.match(sandbox, /dropped: dropped \+ trimmed/);
  assert.match(sandbox, /ttlMs,\n    expiresAt: Date\.now\(\) \+ ttlMs/);
});

test("工具面：write_stdin 只在宿主真有会话口时注册", async () => {
  const tools = await source("app/xiaoluo-brain/lib/brain/chat-tools.ts");
  const agent = await source("app/xiaoluo-brain/lib/brain/chat-agent.ts");
  const panel = await source("app/components/xiaoluo-brain-panel.tsx");

  assert.match(tools, /name: "write_stdin"/);
  assert.match(tools, /required: \["session"\]/);
  assert.match(tools, /if \(caps\.interactiveEnabled\) schemas\.push\(WRITE_STDIN_SCHEMA\)/);
  assert.match(tools, /interactive: \{ type: "boolean"/);

  assert.match(agent, /case "write_stdin":/);
  // 注册开关由端口推导（直接调协议函数，不再抄源码）；整轮行为覆盖见 brain-agent-protocol.test.mjs
  const stub = { callLLM: async () => ({}), postUI: () => {} };
  assert.equal(chatToolCapabilities(stub).interactiveEnabled, false, "没接命令口就没有交互会话");
  assert.equal(
    chatToolCapabilities({ ...stub, command: { run: async () => ({}) } }).interactiveEnabled,
    false,
    "只有 run 不够，必须真有会话口",
  );
  assert.equal(
    chatToolCapabilities({
      ...stub,
      command: { run: async () => ({}), startSession: async () => ({}), writeSession: async () => ({}) },
    }).interactiveEnabled,
    true,
  );
  // 桌面桥没有会话通道：没有 startSession 时给出口址，而不是让它挂着一个必然失败的调用
  assert.match(agent, /当前环境未接入交互会话口/);

  assert.match(panel, /\.\.\.\(desktopRuntime\(\)\n?\s*\?\s*\{\}\s*:\s*\{/);
  assert.match(panel, /startSession: async \(command: string/);
  assert.match(panel, /writeSession: async \(sessionId: string/);
  // 审批门只有一份：三条路（一次性/开席/续写）都走 postBrainCommand
  assert.equal((panel.match(/await postBrainCommand\(/g) ?? []).length, 3);
  assert.match(panel, /\{ command, cwd: opts\?\.cwd, timeoutMs: opts\?\.timeoutMs \}/);
});

test("提示词：教了什么时候该开会话、什么时候不该", async () => {
  const prompts = await source("app/xiaoluo-brain/lib/brain/prompts.ts");
  assert.match(prompts, /interactive:true 开会话拿 sessionId/);
  assert.match(prompts, /用完必须 close:true 收尾/);
  // 网络策略那条也在这儿：不让它自己把 hooks.toml 的闸口调宽绕过限制
  assert.match(prompts, /严禁自己改 hooks\.toml 把闸口调宽来绕过限制/);
});
