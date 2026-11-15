/**
 * 进程边界测试（P3：内核跑在服务进程里，宿主只隔着协议说话）
 *
 * 这里不开 HTTP：把 transport 直接接到 handleAgentRpc + attachThreadListener 上，
 * 让「宿主」和「内核」在同一台机器的同一进程里用同一份线协议对话。这样测的是协议本身，
 * 而不是某个端口实现——HTTP 路由那层只剩鉴权/限流/状态码（有独立回归）。
 *
 * 唯一被换掉的是模型调用（server-ports 的 callModel）：闸门、沙箱、审批记忆全部还是服务端那份实现。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  attachThreadListener,
  handleAgentRpc,
  openThreadForHost,
  resetAgentThreads,
} from "../app/xiaoluo-brain/lib/brain/agent-server.ts";
import { AgentClient, httpTransport } from "../app/xiaoluo-brain/lib/brain/agent-client.ts";
import { clearApprovalGrants } from "../app/xiaoluo-brain/lib/brain/server-ports.ts";
import { startGatedService } from "../app/lib/brain-command-gate.ts";
import { readMemoryEntries, writeMemoryEntries } from "../app/lib/brain-memory.ts";
import { getProgram, listPrograms, removeProgram } from "../app/lib/brain-programs.ts";
import {
  HOST_TOOL_PORTS,
  RPC,
  createSseParser,
  encodeSseFrame,
} from "../app/xiaoluo-brain/lib/brain/agent-wire.ts";
import {
  mapCompletionResponse,
  parseModelSSE,
  replyFromStreamAccum,
  salvageStreamInterruption,
} from "../app/xiaoluo-brain/lib/brain/llm-wire.ts";

const USER = "test-app-server";

/** 事件流收集器：宿主看到什么，全凭事件 */
function collector() {
  const events = [];
  const waiters = [];
  const self = {
    events,
    onEvent(event) {
      events.push(event);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        const waiter = waiters[i];
        if (!waiter.match(event)) continue;
        waiters.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(event);
      }
    },
    /** 等到第一个满足条件的事件（超时就把当前列表里能找到的交回去，让断言报出实际收到了什么） */
    waitFor(match, timeoutMs = 5_000) {
      const hit = events.find(match);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => {
        const waiter = {
          match,
          resolve,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) waiters.splice(index, 1);
            resolve(events.find(match) ?? null);
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    untilIdle(timeoutMs = 5_000) {
      return self.waitFor((event) => event.method === "event/turn" && event.phase === "ended", timeoutMs);
    },
  };
  return self;
}

/** 同进程 transport：请求走 handleAgentRpc，事件走 attachThreadListener（含补发） */
function inProcessTransport(userId) {
  return {
    request: (body) => handleAgentRpc(userId, body),
    subscribe(conversationId, since, onEvent) {
      const sub = attachThreadListener(userId, conversationId, onEvent);
      if (!sub) return () => {};
      for (const event of sub.replay) {
        if (event.seq > since) onEvent(event);
      }
      return sub.detach;
    },
  };
}

/**
 * 桩模型：按脚本依次返回内容或 tool_call。
 * 记录每次收到的 messages，便于断言「插话/应答真的进了下一轮上下文」。
 */
function scriptedModel(script) {
  const calls = [];
  const callModel = async ({ messages, signal }) => {
    // 轮末的「交付物核对」是引擎自己另起的一问，不占脚本步子、也不记进 calls：
    // 记了会把回合上下文挤后一位，脚本与回合就对不上了
    if (messages[0]?.role === "system" && String(messages[0].content).includes("交付物核对员")) {
      return reply({ content: '{"ok": true, "gaps": []}' });
    }
    calls.push(messages.slice());
    const step = script.shift();
    if (!step) return reply({ content: "收尾。" });
    if (step.awaitAbort) {
      // 挂住这一轮，直到宿主把回合中止（signal 被 abort）才回话
      await new Promise((resolve) => {
        if (signal?.aborted) return resolve();
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, 6_000);
        signal?.addEventListener("abort", done, { once: true });
      });
      return reply({ content: "（被中止）" });
    }
    if (step.toolCall) {
      return reply({
        content: step.content ?? "",
        tool_calls: [{ id: "call-" + calls.length, type: "function", function: { name: step.toolCall.name, arguments: JSON.stringify(step.toolCall.arguments) } }],
        finish_reason: "tool_calls",
      });
    }
    return reply({ content: step.content ?? "好的。" });
  };
  const toolReplyText = () => calls.at(-1)?.find((m) => m.role === "tool")?.content ?? "";
  return { callModel, calls, toolReplyText };
}

function reply(message, finishReason) {
  return {
    status: 200,
    body: JSON.stringify({
      choices: [{ message, finish_reason: finishReason ?? (message.tool_calls ? "tool_calls" : "stop") }],
      usage: { prompt_tokens: 20, completion_tokens: 8 },
    }),
  };
}

/** 手搓上游 SSE：一行一帧；gapMs>0 时故意隔很久再发下一帧，用来验宿主的合并窗口 */
function sseStream(frames, gapMs = 0) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (const frame of frames) {
        if (gapMs) await new Promise((resolve) => setTimeout(resolve, gapMs));
        controller.enqueue(encoder.encode(frame + "\n\n"));
      }
      controller.close();
    },
  });
}

const openaiDelta = (text) => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] });
const openaiStop = (reason = "stop") => 'data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const openaiUsage = (prompt, completion) => 'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: prompt, completion_tokens: completion } });
const SSE_DONE = "data: [DONE]";

async function rpc(userId, method, params) {
  const resp = await handleAgentRpc(userId, { jsonrpc: "2.0", id: "t-" + method, method, params });
  return resp;
}

/** 取 result 或直接把 error 抖出来（失败信息比断言本身有用） */
async function ok(userId, method, params) {
  const resp = await rpc(userId, method, params);
  assert.ok(!("error" in resp), method + " 失败：" + JSON.stringify(resp.error));
  return resp.result;
}

test.afterEach(() => {
  resetAgentThreads();
  clearApprovalGrants();
});

test("信封纪律：坏请求用协议错误码回，绝不抛出去", async () => {
  const bad = await handleAgentRpc(USER, { jsonrpc: "1.0", id: "a", method: "thread/start" });
  assert.equal(bad.error.code, RPC.INVALID_REQUEST);
  const noId = await handleAgentRpc(USER, { jsonrpc: "2.0", method: "thread/start" });
  assert.equal(noId.error.code, RPC.INVALID_REQUEST);
  const notObject = await handleAgentRpc(USER, "不是对象");
  assert.equal(notObject.error.code, RPC.INVALID_REQUEST);
  const unknown = await rpc(USER, "thread/nope", {});
  assert.equal(unknown.error.code, RPC.METHOD_NOT_FOUND);
  // 参数缺失：报出具体字段，别让宿主猜
  const missing = await rpc(USER, "thread/start", { conversationId: "brain-x" });
  assert.equal(missing.error.code, RPC.INVALID_PARAMS);
  assert.match(missing.error.message, /params\.canvasId/);
});

test("线程生命周期：start/read/capabilities 都是真往返，工具面只有已接闸门的那些", async () => {
  const started = await ok(USER, "thread/start", { conversationId: "brain-c1", canvasId: "c1", model: "m1" });
  assert.deepEqual(started, { conversationId: "brain-c1", existed: false, seq: 0 });
  const again = await ok(USER, "thread/start", { conversationId: "brain-c1", canvasId: "c1", model: "m2" });
  assert.equal(again.existed, true, "同 cid 复用同一条线程");

  const read = await ok(USER, "thread/read", { conversationId: "brain-c1" });
  assert.equal(read.running, false);
  assert.deepEqual(read.snapshot.dirtyCodeFiles, []);

  const caps = await ok(USER, "thread/capabilities", { conversationId: "brain-c1" });
  assert.ok(caps.toolNames.includes("read_file"), caps.toolNames.join(","));
  assert.ok(caps.toolNames.includes("run_command"), "命令口是服务端端口，注册得上");
  assert.ok(caps.toolNames.includes("write_stdin"), "会话口同样注册");
  // 服务/检索/抓取与 HTTP 路由共用同一份核心与同一道门，第二宿主同样注册得上
  for (const present of ["start_service", "web_search", "browse_page"]) {
    assert.ok(caps.toolNames.includes(present), present + " 该出现在服务端宿主的工具面里");
  }
  // generate_media 是常注册的「派给画布」口，服务端没有画布通道，由引擎那侧的未接入挡回兜住
  // 能力说明段与注册面同源：说有的口必须真注册，没实现的一律报 false
  assert.equal(caps.caps.command, true);
  assert.equal(caps.caps.git, true);
  assert.equal(caps.caps.service, true);
  assert.equal(caps.caps.webSearch, true);
  assert.equal(caps.caps.browser, true);
  assert.equal(caps.caps.memory, true, "记忆档在服务端，第二宿主同样有");
  assert.ok(caps.toolNames.includes("add_memory"), "add_memory 该注册上");
  for (const [name, on] of [
    ["vision", false], // 视觉/整桌/CDP/UIA/SSH 只在桌面运行时里有实现
    ["desktop", false],
    ["web", false],
    ["ssh", false],
    ["deploy", false],
  ]) {
    assert.equal(caps.caps[name], on, name + " 在服务端宿主还没接线，能力说明不能报 true");
  }

  const gone = await rpc(USER, "thread/read", { conversationId: "brain-nope" });
  assert.equal(gone.error.code, RPC.THREAD_NOT_FOUND);
});

test("一轮真跑完：事件带 seq 单调递增，宿主拿得到正文与结束回执", async () => {
  const model = scriptedModel([{ content: "这是小逻的回答。" }]);
  openThreadForHost({ userId: USER, conversationId: "brain-run", canvasId: "c-run", model: "m-run", callModel: model.callModel });
  const seen = collector();
  const sub = attachThreadListener(USER, "brain-run", seen.onEvent);
  assert.ok(sub, "线程活着才连得上事件流");

  const started = await ok(USER, "turn/start", { conversationId: "brain-run", text: "打个招呼" });
  assert.equal(started.started, true);
  const ended = await seen.untilIdle();
  assert.ok(ended, "回合没有收尾：" + JSON.stringify(seen.events.map((e) => e.method)));
  assert.equal(ended.outcome.usedTokens > 0, true);

  const seqs = seen.events.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "seq 必须单调递增，宿主才能按它续传");
  assert.equal(new Set(seqs).size, seqs.length, "seq 不能重复");
  const assistant = seen.events.find((e) => e.method === "event/ui" && e.kind === "assistant");
  assert.match(assistant?.content ?? "", /这是小逻的回答/);

  const read = await ok(USER, "thread/read", { conversationId: "brain-run" });
  assert.ok(read.snapshot.messages.some((m) => m.role === "user" && m.content.includes("打个招呼")));
  assert.equal(read.running, false);
  sub.detach();
});

test("审批走线：event/approval → approval/decide，批准与拒绝都回到模型的上下文里", async () => {
  // 批准分支：git push 需要老板点头（沙箱里没有仓库，批准后按失败回话，不产生真实外发）
  const approved = scriptedModel([
    { toolCall: { name: "git", arguments: { op: "push" } } },
    { content: "知道了，先不推。" },
  ]);
  const host = collector();
  openThreadForHost({ userId: USER, conversationId: "brain-appr-yes", canvasId: "c1", model: "m1", callModel: approved.callModel });
  attachThreadListener(USER, "brain-appr-yes", host.onEvent);
  await ok(USER, "turn/start", { conversationId: "brain-appr-yes", text: "把提交推上去" });

  const asked = await host.waitFor((e) => e.method === "event/approval");
  assert.ok(asked, "危险操作没先问老板：" + JSON.stringify(host.events.map((e) => e.method)));
  assert.equal(asked.scope, "git");
  assert.match(asked.subject, /git push/);
  assert.ok(asked.expiresAt > Date.now(), "审批要带超时，不能让回合永远挂着");

  const decided = await ok(USER, "approval/decide", { conversationId: "brain-appr-yes", approvalId: asked.approvalId, approved: true });
  assert.equal(decided.decided, true);
  await host.untilIdle();
  assert.match(approved.toolReplyText(), /工作区尚未初始化 git 仓库/, "批准后确实去跑了，失败理由回流给模型");
  // 同一份审批再答一次：过期，不重复生效
  const stale = await ok(USER, "approval/decide", { conversationId: "brain-appr-yes", approvalId: asked.approvalId, approved: true });
  assert.equal(stale.decided, false);

  // 拒绝分支：没批准就中止，模型看到的必须是「老板未批准」这句原话（与浏览器宿主逐字一致）
  clearApprovalGrants();
  const denied = scriptedModel([
    { toolCall: { name: "git", arguments: { op: "push" } } },
    { content: "那我先不推。" },
  ]);
  const host2 = collector();
  openThreadForHost({ userId: USER, conversationId: "brain-appr-no", canvasId: "c1", model: "m1", callModel: denied.callModel });
  attachThreadListener(USER, "brain-appr-no", host2.onEvent);
  await ok(USER, "turn/start", { conversationId: "brain-appr-no", text: "推一下" });
  const asked2 = await host2.waitFor((e) => e.method === "event/approval");
  assert.ok(asked2);
  await ok(USER, "approval/decide", { conversationId: "brain-appr-no", approvalId: asked2.approvalId, approved: false });
  await host2.untilIdle();
  assert.match(denied.toolReplyText(), /老板未批准/, "拒绝文案要回流，小逻才知道要换保守做法");
});

test("插话与应答：steer 进下一轮上下文，answer 只在有挂起反问时生效", async () => {
  let releaseFirst = null;
  const gate = new Promise((resolve) => (releaseFirst = resolve));
  const calls = [];
  const callModel = async ({ messages }) => {
    calls.push(messages.slice());
    if (calls.length === 1) {
      await gate; // 第一轮挂在模型调用上，模拟「回合正在跑」
      return reply({ content: "收到插话了。" });
    }
    return reply({ content: "再来一句。" });
  };
  openThreadForHost({ userId: USER, conversationId: "brain-steer", canvasId: "c1", model: "m1", callModel });
  const host = collector();
  attachThreadListener(USER, "brain-steer", host.onEvent);
  await ok(USER, "turn/start", { conversationId: "brain-steer", text: "先做 A" });

  const steer = await ok(USER, "turn/steer", { conversationId: "brain-steer", text: "顺便看看 B" });
  assert.equal(steer.running, true, "回合确实还在跑");
  releaseFirst();
  await host.untilIdle();

  const journal = await ok(USER, "thread/journal", { conversationId: "brain-steer", limit: 50 });
  assert.ok(journal.entries.some((e) => e.kind === "steer" && e.note.includes("顺便看看 B")), "插话必须留痕");

  // 第二轮：上一轮排队的插话要出现在送给模型的上下文里
  await ok(USER, "turn/start", { conversationId: "brain-steer", text: "继续" });
  await host.untilIdle();
  const last = calls.at(-1) ?? [];
  assert.ok(last.some((m) => JSON.stringify(m).includes("顺便看看 B")), "插话没进上下文：" + JSON.stringify(last.map((m) => m.role)));

  // 没挂起的反问时应答：报 NO_PENDING_ASK，别让宿主以为答对了
  const stray = await rpc(USER, "turn/answer", { conversationId: "brain-steer", answer: { text: "没人问过我" } });
  assert.equal(stray.error.code, RPC.NO_PENDING_ASK);

  // 真挂起一次：ask_user 之后事件流里有反问卡，应答后本轮才继续
  const askScript = scriptedModel([
    { toolCall: { name: "ask_user", arguments: { question: "要哪种配色？", options: ["A", "B"] } } },
    { content: "那就 A。" },
  ]);
  const host2 = collector();
  openThreadForHost({ userId: USER, conversationId: "brain-ask", canvasId: "c1", model: "m1", callModel: askScript.callModel });
  attachThreadListener(USER, "brain-ask", host2.onEvent);
  await ok(USER, "turn/start", { conversationId: "brain-ask", text: "帮我选个配色" });
  const card = await host2.waitFor((e) => e.method === "event/ui" && e.kind === "ask-card");
  assert.ok(card, "反问卡没发出来：" + JSON.stringify(host2.events.map((e) => e.kind ?? e.method)));
  const answered = await ok(USER, "turn/answer", { conversationId: "brain-ask", answer: { text: "A" } });
  assert.equal(answered.answered, true);
  await host2.untilIdle();
  assert.ok((askScript.calls.at(-1) ?? []).some((m) => JSON.stringify(m).includes("A")));
});

test("中止：turn/interrupt 掐断在途模型调用，线程回到空闲还能再跑", async () => {
  const model = scriptedModel([{ awaitAbort: true }, { content: "重开一轮。" }]);
  openThreadForHost({ userId: USER, conversationId: "brain-stop", canvasId: "c1", model: "m1", callModel: model.callModel });
  const host = collector();
  attachThreadListener(USER, "brain-stop", host.onEvent);
  await ok(USER, "turn/start", { conversationId: "brain-stop", text: "跑个久的" });
  await new Promise((resolve) => setTimeout(resolve, 60));

  const interrupted = await ok(USER, "turn/interrupt", { conversationId: "brain-stop" });
  assert.equal(interrupted.wasRunning, true);
  const ended = await host.untilIdle();
  assert.ok(ended, "中止后回合没有收尾");
  const after = await ok(USER, "thread/read", { conversationId: "brain-stop" });
  assert.equal(after.running, false, "running 必须落回 false，否则这条线程再也起不了回合");

  const again = await ok(USER, "turn/start", { conversationId: "brain-stop", text: "接着来" });
  assert.equal(again.started, true);
  await host.untilIdle();
});

test("分叉：服务端生成分支 id，还给宿主快照，主干不受影响", async () => {
  const model = scriptedModel([{ content: "主干的回答。" }, { content: "分支的回答。" }]);
  openThreadForHost({ userId: USER, conversationId: "brain-trunk", canvasId: "c1", model: "m1", callModel: model.callModel });
  const host = collector();
  attachThreadListener(USER, "brain-trunk", host.onEvent);
  await ok(USER, "turn/start", { conversationId: "brain-trunk", text: "先聊这个" });
  await host.untilIdle();

  const forked = await ok(USER, "thread/fork", { fromConversationId: "brain-trunk", canvasId: "c1", model: "m1" });
  assert.equal(forked.forkedFrom, "brain-trunk");
  assert.match(forked.conversationId, /^brain-trunk-fork-/);
  assert.notEqual(forked.conversationId, "brain-trunk");
  assert.ok(forked.snapshot.messages.some((m) => JSON.stringify(m).includes("先聊这个")), "分支得带上主干历史");

  const branchHost = collector();
  attachThreadListener(USER, forked.conversationId, branchHost.onEvent);
  await ok(USER, "turn/start", { conversationId: forked.conversationId, text: "换个方向" });
  await branchHost.untilIdle();

  const trunk = await ok(USER, "thread/read", { conversationId: "brain-trunk" });
  assert.ok(!trunk.snapshot.messages.some((m) => JSON.stringify(m).includes("换个方向")), "分支里说的话不该出现在主干上");
});

test("回合占用：同一条线程第二轮要撞车，宿主才知道该插话", async () => {
  let release = null;
  const gate = new Promise((resolve) => (release = resolve));
  const callModel = async () => {
    await gate;
    return reply({ content: "终于跑完了。" });
  };
  openThreadForHost({ userId: USER, conversationId: "brain-busy", canvasId: "c1", model: "m1", callModel });
  const host = collector();
  attachThreadListener(USER, "brain-busy", host.onEvent);
  await ok(USER, "turn/start", { conversationId: "brain-busy", text: "第一轮" });
  const busy = await rpc(USER, "turn/start", { conversationId: "brain-busy", text: "第二轮" });
  assert.equal(busy.error.code, RPC.TURN_RUNNING);
  assert.match(busy.error.message, /steer/);
  release();
  await host.untilIdle();
});

test("断线补发：新订阅者能拿到缓冲区里的事件，SSE 帧编解码无损往返", async () => {
  const model = scriptedModel([{ content: "第一条回答。" }]);
  openThreadForHost({ userId: USER, conversationId: "brain-replay", canvasId: "c1", model: "m1", callModel: model.callModel });
  const live = collector();
  attachThreadListener(USER, "brain-replay", live.onEvent);
  await ok(USER, "turn/start", { conversationId: "brain-replay", text: "说一句话" });
  await live.untilIdle();

  const late = collector();
  const sub = attachThreadListener(USER, "brain-replay", late.onEvent);
  for (const event of sub.replay) late.onEvent(event);
  assert.ok(late.events.length >= 2, "迟到者至少该看到回合边界事件");
  assert.equal(late.events.at(-1).method, "event/turn");

  // 帧编解码：客户端不用 EventSource 也能还原通知
  const original = late.events.at(0);
  const parse = createSseParser();
  const wire = encodeSseFrame(original) + ": ping\n\n";
  const notes = parseSseFramesForTest(wire, parse);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].method, original.method);
  assert.equal(notes[0].params.seq, original.seq);
  assert.equal(notes[0].params.conversationId, "brain-replay");
});

/** 把整段 SSE 文本喂进增量解析器（切两半喂，顺带验证半截帧不会被吞） */
function parseSseFramesForTest(text, parser) {
  const half = Math.floor(text.length / 2);
  return [...parser(text.slice(0, half)), ...parser(text.slice(half)), ...parser("")];
}

test("宿主侧客户端：AgentClient 用同一份协议跑通整轮（含审批回调）", async () => {
  const model = scriptedModel([
    { toolCall: { name: "git", arguments: { op: "status" } } },
    { content: "仓库干净。" },
  ]);
  openThreadForHost({ userId: USER, conversationId: "brain-client", canvasId: "c1", model: "m1", callModel: model.callModel });
  const approvals = [];
  const client = new AgentClient({
    transport: inProcessTransport(USER),
    onApproval: async (event) => {
      approvals.push(event.subject);
      return true;
    },
  });
  const outcome = await client.runTurn({ conversationId: "brain-client", text: "看下仓库状态" });
  assert.ok(outcome, "runTurn 没等到回合结束事件");
  assert.equal(outcome.steps >= 1, true);
  // git status 不需要批准：审批回调一次都不该被触发
  assert.deepEqual(approvals, []);
  const read = await client.threadRead("brain-client");
  assert.ok(JSON.stringify(read.snapshot.messages).includes("仓库干净"));

  // HTTP 传输的形状也要钉住：URL / 方法 / 事件流 query，别哪天改了路由两侧不同步
  const seenRequests = [];
  const fakeFetch = async (url, init) => {
    seenRequests.push({ url, method: init?.method });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "r1", result: { ok: true } }), { headers: { "content-type": "application/json" } });
  };
  const transport = httpTransport({ baseUrl: "http://127.0.0.1:4321", headers: { cookie: "xiaoluo_access=t" }, fetchImpl: fakeFetch });
  await transport.request({ jsonrpc: "2.0", id: "r1", method: "thread/read", params: { conversationId: "brain-x" } });
  assert.equal(seenRequests[0].url, "http://127.0.0.1:4321/api/v2/brain/agent");
  assert.equal(seenRequests[0].method, "POST");
});

// ---------- 流式：逐字显形能不能跨过这道进程边界 ----------

test("线格式解析：流式拼出来的形状与非流式整包逐字一致（两种方言）", async () => {
  const deltas = [];
  const acc = await parseModelSSE(
    sseStream([openaiDelta("你好"), openaiDelta("，老板"), openaiStop(), openaiUsage(11, 5), SSE_DONE]),
    "openai",
    (t) => deltas.push(t),
  );
  const streamed = replyFromStreamAccum(acc);
  assert.equal(streamed.content, "你好，老板");
  assert.equal(streamed.finishReason, "stop");
  assert.deepEqual(streamed.usage, { promptTokens: 11, completionTokens: 5 });
  assert.deepEqual(deltas, ["你好", "，老板"], "onDelta 只喂正文增量，工具碎片不算逐字显形");

  // 同样一份内容走非流式整包：两种解析必须交出同一个形状，宿主才不会因为传输方式看到不同的小逻
  const batched = mapCompletionResponse({
    choices: [{ message: { content: "你好，老板" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 5 },
  });
  assert.deepEqual(streamed, batched);

  // Anthropic 方言：event:/data: 双行，stop_reason 与 output usage 都挂在 message_delta 上
  const anth = await parseModelSSE(
    sseStream([
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":7}}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"分段"}}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":3}}',
    ]),
    "anthropic",
  );
  const anthReply = replyFromStreamAccum(anth);
  assert.equal(anthReply.content, "分段");
  assert.equal(anthReply.finishReason, "max_tokens", "TRUNC-GATE 看不见 max_tokens 就会把半截 write_code 当成自愿收尾");
  assert.deepEqual(anthReply.usage, { promptTokens: 7, completionTokens: 3 });

  // 参数 JSON 断在流里：__truncated 必须还在，工具层才回流「被截断请拆分」而不是建个空文件
  const broken = replyFromStreamAccum(
    await parseModelSSE(
      sseStream([
        'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "write_code", arguments: '{"path":"a' } }] } }] }),
        openaiStop("length"),
      ]),
      "openai",
    ),
  );
  assert.equal(broken.toolCalls[0].arguments.__truncated, true);
  assert.equal(broken.finishReason, "length");

  // 断流抢救：正文够长且没有半截工具 → 部分定稿；太短就抛可重试错，别拿一句残词糊弄老板
  const longAcc = { content: "这一段已经足够长了，可以当作部分定稿交给老板。".repeat(2), tools: [], usage: { prompt: 3, completion: 4 } };
  assert.match(salvageStreamInterruption(longAcc).content, /流式响应中途断开/);
  assert.throws(() => salvageStreamInterruption({ content: "太短", tools: [], usage: { prompt: 0, completion: 0 } }), /正在重试/);
});

test("逐字显形走线：宿主收到 begin/delta*/end，定稿事件带 fromStream", async () => {
  const asked = [];
  const callModel = async (input) => {
    asked.push(input.stream);
    return {
      status: 200,
      contentType: "text/event-stream",
      // 隔 120ms 发一帧：比 80ms 合并窗口长，两段就该是两条 delta
      streamBody: sseStream([openaiDelta("你好"), openaiDelta("，老板"), openaiStop(), SSE_DONE], 120),
    };
  };
  const cid = "brain-stream";
  openThreadForHost({ userId: USER, conversationId: cid, canvasId: "c-stream", model: "m-stream", callModel });
  const host = collector();
  attachThreadListener(USER, cid, host.onEvent);
  await ok(USER, "turn/start", { conversationId: cid, text: "打个招呼" });
  const ended = await host.untilIdle();
  assert.ok(ended, "流式回合没收尾");

  assert.equal(asked[0], true, "宿主接了逐字通道就该向网关要流式，否则逐字显形无从谈起");
  const streamEvents = host.events.filter((e) => e.method === "event/stream");
  assert.equal(streamEvents[0].phase, "begin", "begin 得先于任何 delta");
  assert.equal(streamEvents.at(-1).phase, "end");
  const deltas = streamEvents.filter((e) => e.phase === "delta");
  assert.equal(deltas.length, 2, JSON.stringify(streamEvents.map((e) => e.phase)));
  assert.equal(deltas.map((e) => e.text).join(""), "你好，老板", "合并只能改分帧，不能改正文");
  assert.equal(new Set(streamEvents.map((e) => e.seq)).size, streamEvents.length, "delta 也要占 seq，宿主才能按序续传");

  const final = host.events.find((e) => e.method === "event/ui" && e.kind === "assistant");
  assert.match(final?.content ?? "", /你好，老板/);
  assert.equal(final?.meta?.fromStream, true, "定稿要带 fromStream，宿主才知道是原地收口那条气泡而不是再贴一条");
});

test("重放缓冲不被碎帧挤掉：delta 只走直播，补发交还边界与卡片", async () => {
  const callModel = async () => ({
    status: 200,
    contentType: "text/event-stream",
    streamBody: sseStream([openaiDelta("补发看不到我"), openaiStop(), SSE_DONE]),
  });
  const cid = "brain-stream-buffer";
  openThreadForHost({ userId: USER, conversationId: cid, canvasId: "c-buffer", model: "m-buffer", callModel });
  const live = collector();
  attachThreadListener(USER, cid, live.onEvent);
  await ok(USER, "turn/start", { conversationId: cid, text: "说一句" });
  await live.untilIdle();
  assert.ok(live.events.some((e) => e.method === "event/stream" && e.phase === "delta"), "直播侧必须收到 delta");

  const late = collector();
  const sub = attachThreadListener(USER, cid, late.onEvent);
  const phases = sub.replay.filter((e) => e.method === "event/stream").map((e) => e.phase);
  assert.ok(!phases.includes("delta"), "几千条碎帧不该挤占重放缓冲区，否则卡片与审批会被顶掉");
  assert.deepEqual(phases, ["begin", "end"]);
  assert.ok(sub.replay.some((e) => e.method === "event/ui" && e.kind === "assistant"), "迟到者补发要能看到正文定稿");
  assert.equal(sub.replay.at(-1).method, "event/turn");
});

/**
 * seq 只在一根线程活着期间递增：服务重启或闲置回收后重建的那一根，又从 1 重新数。
 * 宿主如果还拿存档里那个旧水位去过滤事件，每一条新事件都会被当成「上一轮就贴过的卡片」丢掉——
 * 表现是最坏的一种：回合照跑、存档照写、界面上一个字都不出，老板只看到一个永不结束的「进行中」。
 * 所以句柄必须把内核当前读数交回宿主对表。
 */
test("seq 纪元：活着只报读数，内核重开一世必然回退", async () => {
  const cid = "brain-seq-epoch";
  const model = scriptedModel([{ content: "这一世说一句。" }]);
  openThreadForHost({ userId: USER, conversationId: cid, canvasId: "c-seq", model: "m-seq", callModel: model.callModel });

  const attached = await ok(USER, "thread/start", { conversationId: cid, canvasId: "c-seq", model: "m-seq" });
  assert.equal(attached.existed, true, "宿主桥建好的那条线程该被复用");
  assert.equal(attached.seq, 0, "还没发过事件的一线线程从 0 数起");

  const host = collector();
  attachThreadListener(USER, cid, host.onEvent);
  await ok(USER, "turn/start", { conversationId: cid, text: "说一句" });
  await host.untilIdle();
  const liveSeq = host.events.at(-1).seq;
  assert.ok(liveSeq > 0, JSON.stringify(host.events.map((e) => e.seq)));

  const reused = await ok(USER, "thread/start", { conversationId: cid, canvasId: "c-seq", model: "m-seq" });
  assert.equal(reused.seq, liveSeq, "还活着的那根只报当前读数，绝不能凭空重置");

  // 服务重启：注册表清空后按存档重建（thread/resume 就是宿主那条恢复路径）
  resetAgentThreads();
  const reborn = await ok(USER, "thread/resume", {
    conversationId: cid,
    canvasId: "c-seq",
    model: "m-seq",
    snapshot: { messages: [{ role: "user", content: "说一句" }, { role: "assistant", content: "这一世说一句。" }], usedTokens: 0 },
  });
  assert.equal(reborn.existed, false);
  assert.ok(reborn.seq < liveSeq, `新那世必须从更小的 seq 数起，宿主才有依据把旧水位对下去：${reborn.seq} vs ${liveSeq}`);
});

test("接线事实：宿主按句柄交回的 seq 重定水位，事件流不会在新那世聋掉", async () => {
  const [serverSource, clientSource, hookSource] = await Promise.all([
    readFile(new URL("../app/xiaoluo-brain/lib/brain/agent-server.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/xiaoluo-brain/lib/brain/agent-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/xiaoluo-brain/hooks/use-chat-agent.ts", import.meta.url), "utf8"),
  ]);
  // 三个入口都得把读数交回来：漏一个，那条路上重建的线程就永远收不到事件
  for (const method of ["thread/start", "thread/resume", "thread/fork"]) {
    const index = serverSource.indexOf('case "' + method + '"');
    assert.ok(index >= 0, method + " 分发段找不到");
    const block = serverSource.slice(index, index + 2600);
    assert.match(block, /seq: (?:existing|created|resumed|thread)\.seq/, method + " 句柄没交 seq 读数");
  }
  assert.match(clientSource, /rebaseSeq\(conversationId: string, seq: number\)/, "客户端没有重定水位的入口");
  assert.match(hookSource, /if \(handle\.seq < lastSeqRef\.current\)/, "起线程后没对表：旧水位会把新那世每条事件都当重复");
  assert.match(hookSource, /client\.rebaseSeq\(/, "水位没同步给客户端，重连的 since 还是按旧纪元要补发");
});

test("接线事实：SSE 解析只有一份，两种宿主共用", async () => {
  const [panelSource, serverPorts, wire] = await Promise.all([
    readFile(new URL("../app/components/xiaoluo-brain-panel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/xiaoluo-brain/lib/brain/server-ports.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/xiaoluo-brain/lib/brain/llm-wire.ts", import.meta.url), "utf8"),
  ]);
  // 面板不再自带解析器：抄第二份就会漂，尤其是 __truncated 与 usage 回填这两处
  assert.match(panelSource, /acc = await parseModelSSE\(/);
  assert.doesNotMatch(panelSource, /function parseBrainSSE|interface StreamAccum \{/);
  assert.match(serverPorts, /acc = await parseModelSSE\(call\.streamBody/);
  assert.match(wire, /args\.__truncated = true/);
  // 服务端要流式与否由「宿主有没有逐字通道」决定，不是写死 false
  assert.match(serverPorts, /stream: Boolean\(req\.onDelta\)/);
});

/**
 * 服务启动的门必须和 run_command 一样深：start_service 从前只在路由里判风险分级，
 * 路径围栏与网络策略都没走——换个入口就该换个门深，是审批语义上最容易被绕开的洞。
 */
test("第二宿主的服务口：路径围栏拦得住，拒绝文案与浏览器宿主逐字一致", async () => {
  clearApprovalGrants();
  const model = scriptedModel([
    { toolCall: { name: "start_service", arguments: { command: "node server.js > ../../escape.log" } } },
    { content: "那我换个做法。" },
  ]);
  const host = collector();
  openThreadForHost({ userId: USER, conversationId: "brain-svc-fence", canvasId: "c-svc", model: "m1", callModel: model.callModel });
  attachThreadListener(USER, "brain-svc-fence", host.onEvent);
  await ok(USER, "turn/start", { conversationId: "brain-svc-fence", text: "把服务起起来" });

  const asked = await host.waitFor((e) => e.method === "event/approval");
  assert.ok(asked, "写工作区外的服务命令没先问老板：" + JSON.stringify(host.events.map((e) => e.method)));
  assert.equal(asked.scope, "service");
  assert.match(asked.reasons.join("；"), /路径围栏/, "越界落点要作为理由送到宿主，不能只回一句「需要批准」");

  await ok(USER, "approval/decide", { conversationId: "brain-svc-fence", approvalId: asked.approvalId, approved: false });
  await host.untilIdle();
  assert.match(model.toolReplyText(), /老板未批准启动服务/, "拒绝文案与浏览器宿主同一句，小逻换做法的依据不能变");
});

/**
 * 文件档位是宿主报上来的一份口径（控制台那个权限钮选的就是它）。
 * P7-3 把内核搬进服务进程后，围栏若还按写死的 default 建，老板在界面上切到「全部访问」也读不到
 * 工作区外的文件 —— 同一个动作换个入口就换个门深，正是审批语义最容易被绕开的那种洞。
 * 这三条钉住：档位由宿主交出、default 仍然拦、中途放宽只在下轮落地且不动历史。
 */
const OUTSIDE_FILE = () => path.resolve(process.cwd(), "package.json");

/** 模型这一回合实际看到的工具结果（按线程序号取最后一条 tool 轮） */
async function lastToolText(cid) {
  const read = await ok(USER, "thread/read", { conversationId: cid });
  const tools = read.snapshot.messages.filter((m) => m.role === "tool");
  return String(tools.at(-1)?.content ?? "（没有工具结果）");
}

test("第二宿主的文件口按 default 建：工作区外的绝对路径拦下，拒绝文案留下台阶", async () => {
  const model = scriptedModel([
    { toolCall: { name: "read_file", arguments: { path: OUTSIDE_FILE() } } },
    { content: "那我请你把权限切一下。" },
  ]);
  const cid = "brain-fence-default";
  const host = collector();
  openThreadForHost({ userId: USER, conversationId: cid, canvasId: "c-fence", model: "m1", callModel: model.callModel });
  attachThreadListener(USER, cid, host.onEvent);
  await ok(USER, "turn/start", { conversationId: cid, text: "读一下 " + OUTSIDE_FILE() });
  await host.untilIdle();
  const text = await lastToolText(cid);
  assert.match(text, /路径在工作区之外/, "宿主没交档位就是 default：内核只能碰工作区");
  assert.match(text, /全部访问/, "拒绝要给出台阶（与浏览器宿主同一句），否则小逻只会原地重试");
});

test("文件档位跟着宿主报的那份走：auto 档读得到工作区外的文件", async () => {
  const model = scriptedModel([
    { toolCall: { name: "read_file", arguments: { path: OUTSIDE_FILE() } } },
    { content: "读到了。" },
  ]);
  const cid = "brain-fence-auto";
  const host = collector();
  openThreadForHost({
    userId: USER,
    conversationId: cid,
    canvasId: "c-fence",
    model: "m1",
    callModel: model.callModel,
    permissionMode: "auto",
  });
  attachThreadListener(USER, cid, host.onEvent);
  await ok(USER, "turn/start", { conversationId: cid, text: "读一下 " + OUTSIDE_FILE() });
  await host.untilIdle();
  const text = await lastToolText(cid);
  assert.ok(!/路径在工作区之外/.test(text), "auto 档的只读越界应当放行：" + text.slice(0, 160));
  assert.match(text, /xiaoluo-agent-os/, "放行的读要拿到真内容，不能只回一句成功");
});

test("老板中途把权限切到「全部访问」：下一轮按新档位建围栏，历史一条不丢", async () => {
  const model = scriptedModel([
    { toolCall: { name: "read_file", arguments: { path: OUTSIDE_FILE() } } },
    { content: "被拦了，我说一下怎么放开。" },
    { toolCall: { name: "read_file", arguments: { path: OUTSIDE_FILE() } } },
    { content: "这次读到了。" },
  ]);
  const cid = "brain-fence-switch";
  const host = collector();
  openThreadForHost({ userId: USER, conversationId: cid, canvasId: "c-fence", model: "m1", callModel: model.callModel });
  attachThreadListener(USER, cid, host.onEvent);
  await ok(USER, "turn/start", { conversationId: cid, text: "先读一次" });
  await host.untilIdle();
  assert.match(await lastToolText(cid), /路径在工作区之外/);

  const before = await ok(USER, "thread/read", { conversationId: cid });
  // 宿主换了档位，重发 thread/start：服务端认出是同一条线程，只重谈档位，不重建、不灌档
  const resent = await ok(USER, "thread/start", {
    conversationId: cid,
    canvasId: "c-fence",
    model: "m1",
    permissionMode: "full",
  });
  assert.equal(resent.existed, true, "同一条线程换了档位也不该被当成新线程");
  await ok(USER, "turn/start", { conversationId: cid, text: "再读一次" });
  // 事件收集器里已经有第一轮的 ended，再等它只会立刻返回 —— 第二轮改问线程本身
  await waitThreadIdle(USER, cid);
  assert.match(await lastToolText(cid), /xiaoluo-agent-os/, "放宽的档位没在下一轮落地");

  const after = await ok(USER, "thread/read", { conversationId: cid });
  assert.ok(
    after.snapshot.messages.some((m) => m.role === "user" && String(m.content).includes("先读一次")),
    "重谈档位不该把第一轮的历史换掉",
  );
  assert.ok(after.snapshot.messages.length > before.snapshot.messages.length);
});

/** 批准后门会放行——这里只验「blocked 连批准都拦不住」那一支，不真起长驻进程 */
test("服务启动与一次性命令共用同一份判定：blocked 批准后照样拒", async () => {
  const gated = await startGatedService({ userId: USER, command: "rm -rf ..", approved: true });
  assert.equal(gated.ok, false);
  assert.equal(gated.denial.code, "blocked", "无论批不批都不能执行的命令，换个入口也不能跑");
});

test("第二宿主的抓取口绕不开 SSRF 闸门：内网地址直接拒，不去问老板", async () => {
  const model = scriptedModel([
    { toolCall: { name: "browse_page", arguments: { url: "http://127.0.0.1:8080/admin" } } },
    { content: "那我不看内网。" },
  ]);
  const host = collector();
  openThreadForHost({ userId: USER, conversationId: "brain-ssrf", canvasId: "c-ssrf", model: "m1", callModel: model.callModel });
  attachThreadListener(USER, "brain-ssrf", host.onEvent);
  await ok(USER, "turn/start", { conversationId: "brain-ssrf", text: "看看 127.0.0.1 那个页面" });
  await host.untilIdle();
  assert.match(model.toolReplyText(), /禁止访问本机或内网地址/, "闸门在抓取核心里，不在某条 HTTP 路由里");
  assert.ok(!host.events.some((e) => e.method === "event/approval"), "策略拒绝不该被降级成「问一下老板」");
});

test("接线事实：检索、抓取、服务门各只有一份，路由与端口都从那里取", async () => {
  const [searchRoute, browseRoute, servicesRoute, serverPorts] = await Promise.all([
    readFile(new URL("../app/api/v2/brain/search/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/v2/brain/browse/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/v2/brain/services/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/xiaoluo-brain/lib/brain/server-ports.ts", import.meta.url), "utf8"),
  ]);
  // 路由里不该再留供应商/闸门实现：抄第二份就会漂，而且第二宿主根本走不到路由
  assert.match(searchRoute, /await runWebSearch\(query\)/);
  assert.doesNotMatch(searchRoute, /cn\.bing\.com|searchTavily|function renderHits/);
  assert.match(browseRoute, /await fetchPageDigest\(/);
  assert.doesNotMatch(browseRoute, /isBlockedHost|function htmlToText/);
  assert.match(servicesRoute, /startGatedService\(/);
  assert.doesNotMatch(servicesRoute, /classifyCommandRisk|checkPathFence/, "服务路由自己不再判一遍门");
  assert.match(serverPorts, /startGatedService\(\{ userId: opts\.userId/);
  assert.match(serverPorts, /runWebSearch\(/);
  assert.match(serverPorts, /fetchPageDigest\(url\)/);
});

/**
 * 记忆档搬到服务端之后，第二宿主的首轮注入与 add_memory 写入都必须真的走那份文件——
 * 注入只在 messages 为空时装一次（引擎口径），所以这里用「先落档、再开线程」来验。
 */
test("第二宿主的长期记忆：首轮注入读得到服务端档，add_memory 真写进文件", async () => {
  const memUser = "test-app-server-memory";
  await writeMemoryEntries(memUser, [
    { id: "mem-seed", text: "老板偏好深色界面", source: "user", updatedAt: Date.now() },
  ]);
  try {
    const reader = scriptedModel([{ content: "知道了，深色。" }]);
    openThreadForHost({ userId: memUser, conversationId: "brain-mem-read", canvasId: "c-mem", model: "m1", callModel: reader.callModel });
    const host = collector();
    attachThreadListener(memUser, "brain-mem-read", host.onEvent);
    await ok(memUser, "turn/start", { conversationId: "brain-mem-read", text: "帮我改下主题" });
    await host.untilIdle();
    const firstCall = reader.calls[0] ?? [];
    const section = firstCall.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    assert.match(section, /\[长期记忆\]/, "服务端记忆档要进系统提示词");
    assert.match(section, /老板偏好深色界面/);

    // 写入侧：add_memory 之后档里真有一条，且走的是引擎那套 sanitize（不是存储层自己发明）
    clearApprovalGrants();
    const writer = scriptedModel([
      { toolCall: { name: "add_memory", arguments: { text: "老板的部署机是阿里云 ECS，改动要手工同步" } } },
      { content: "记下了。" },
    ]);
    openThreadForHost({ userId: memUser, conversationId: "brain-mem-write", canvasId: "c-mem", model: "m1", callModel: writer.callModel });
    const host2 = collector();
    attachThreadListener(memUser, "brain-mem-write", host2.onEvent);
    await ok(memUser, "turn/start", { conversationId: "brain-mem-write", text: "记住这件事" });
    await host2.untilIdle();
    const saved = await readMemoryEntries(memUser);
    assert.ok(
      saved.some((e) => e.text.includes("阿里云 ECS") && e.source === "agent"),
      "add_memory 要落到服务端档：\n" + JSON.stringify(saved),
    );
    assert.ok(host2.events.some((e) => e.method === "event/ui" && e.kind === "status" && /记住了/.test(e.content)), "记住了那条状态行要给宿主");
  } finally {
    await writeMemoryEntries(memUser, []);
  }
});

test("接线事实：记忆读写只有一份，路由与端口都从 lib/brain-memory 取", async () => {
  const [memoryRoute, serverPorts, store] = await Promise.all([
    readFile(new URL("../app/api/v2/memory/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/xiaoluo-brain/lib/brain/server-ports.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/brain-memory.ts", import.meta.url), "utf8"),
  ]);
  assert.match(memoryRoute, /readMemoryText\(|writeMemoryEntries\(/);
  assert.doesNotMatch(memoryRoute, /fs\.readFile|fs\.writeFile|brain-memory"\)/, "路由不该再自己碰盘");
  assert.match(serverPorts, /memory: new FileMemoryStore\(opts\.userId\)/);
  // 存储层不自己发明去重：那是引擎 execAddMemory 的口径，两处都判就会记出两本账
  assert.doesNotMatch(store, /isDuplicateMemory|sanitizeMemoryText/);
});

/**
 * P6 反向工具通道：内核把「只有宿主这台机器才跑得动的一跳」搬到线上，等宿主回执。
 * 断言重点放在三件事上——声明与注册同源、没人应答时不挂等、宿主的原话回流给模型。
 */

/** 只有宿主才有的口 → 它注册出来的工具名（服务端没有这些口时，工具面里就该一个都不见） */
const HOST_ONLY_TOOLS = {
  vision: ["inspect_screen", "operate_ui", "read_browser_dom", "navigate_browser"],
  desktop: ["desktop_screenshot", "desktop_operate"],
  uia: ["desktop_inspect"],
  webdriver: ["web_navigate", "web_dom", "web_screenshot", "web_operate", "web_eval"],
  ssh: ["ssh_exec"],
};

/** 没有事件流可等时（宿主压根没连上），只能反复问线程本身跑完了没 */
async function waitThreadIdle(userId, conversationId, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const read = await ok(userId, "thread/read", { conversationId });
    if (!read.running) return read;
    if (Date.now() > deadline) throw new Error("回合没有收尾：" + conversationId);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * 最近一次带工具回话的那轮上下文。
 * 不能直接用 model.toolReplyText()：轮末的记忆抽取会另起一份「system+user」的干净上下文，
 * 那是最后一次调用，里面没有工具结果。
 */
function lastToolReplies(model) {
  const msgs = [...model.calls].reverse().find((m) => m.some((x) => x.role === "tool"));
  return msgs ? msgs.filter((x) => x.role === "tool").map((x) => String(x.content)).join("\n") : "";
}

test("能力面谈判：宿主没声明的代跑口不注册，声明了才搬到线上", async () => {
  const cid = "brain-hostdecl";
  await ok(USER, "thread/start", { conversationId: cid, canvasId: "c1", model: "m1" });

  const narrow = await ok(USER, "thread/capabilities", { conversationId: cid });
  for (const [port, names] of Object.entries(HOST_ONLY_TOOLS)) {
    for (const name of names) {
      assert.ok(!narrow.toolNames.includes(name), port + " 没声明，" + name + " 不该出现在工具面里");
    }
    assert.equal(narrow.caps[port === "webdriver" ? "web" : port], false, port + " 没声明，能力说明不能报 true");
  }
  // generate_media 是常注册的（引擎那侧有「未接入画布通道」兜底），不因宿主没声明而从面上消失
  assert.ok(narrow.toolNames.includes("generate_media"));

  // 宿主报上全六口：同一条线程复用，能力面当场按新声明重谈
  await ok(USER, "thread/start", { conversationId: cid, canvasId: "c1", model: "m1", hostTools: [...HOST_TOOL_PORTS] });
  const wide = await ok(USER, "thread/capabilities", { conversationId: cid });
  for (const [port, names] of Object.entries(HOST_ONLY_TOOLS)) {
    for (const name of names) {
      assert.ok(wide.toolNames.includes(name), port + " 声明了，" + name + " 该注册上");
    }
  }
  assert.equal(wide.caps.vision, true);
  assert.equal(wide.caps.desktop, true);
  assert.equal(wide.caps.uia, true);
  assert.equal(wide.caps.web, true);
  assert.equal(wide.caps.ssh, true);

  // 拼错的口名不算声明：不给一个跑不动的假口开工具面
  await ok(USER, "thread/start", { conversationId: cid, canvasId: "c1", model: "m1", hostTools: ["visionn"] });
  const typo = await ok(USER, "thread/capabilities", { conversationId: cid });
  assert.ok(!typo.toolNames.includes("read_browser_dom"), "不认识的端口名不该换来一个视觉口");
});

/**
 * 老板那句「截一张当前屏幕，看看我桌面上开着什么窗口」撞上的是客户端那个「允许小逻控制本机」开关。
 * 开关关着时，面板就不该把整桌截屏/键鼠报给内核 —— 宿主一律回绝的口，报上去等于承诺一个跑不通的能力；
 * 但枚举窗口走的是 UIA 只读路，主进程不拦，这一口要留着：那句问题本来不用开开关也答得出。
 */
test("闸门关着的声明：整桌截屏从面上下来，只读枚举留着，能力段把两者分开说", async () => {
  const model = scriptedModel([{ content: "桌面上开着这些窗口……" }]);
  const cid = "brain-gate-off";
  openThreadForHost({
    userId: USER, conversationId: cid, canvasId: "c1", model: "m1",
    callModel: model.callModel, hostTools: ["vision", "uia"],
  });

  const caps = await ok(USER, "thread/capabilities", { conversationId: cid });
  assert.ok(!caps.toolNames.includes("desktop_screenshot"), "开关关着，宿主必定回绝的截屏口不该留在工具面上");
  assert.ok(!caps.toolNames.includes("desktop_operate"), "整桌键鼠与截屏同一段闸门，一起下来");
  assert.ok(caps.toolNames.includes("desktop_inspect"), "只读枚举窗口不过闸门，关了开关也该留着");
  assert.equal(caps.caps.desktop, false, "跑不通的口在能力说明里不能报 true");
  assert.equal(caps.caps.uia, true);

  await ok(USER, "turn/start", { conversationId: cid, text: "截一张当前屏幕，看看我桌面上开着什么窗口" });
  await waitThreadIdle(USER, cid);
  const section = String(
    (model.calls[0].find((m) => m.role === "system" && String(m.content).startsWith("[运行时能力]")) ?? {}).content ?? "",
  );
  assert.ok(section.length > 0, "轮首要有能力段，模型才知道自己手里到底有什么");
  const yes = section.slice(section.indexOf("[可用]"), section.indexOf("[不可用]"));
  const no = section.slice(section.indexOf("[不可用]"));
  assert.match(yes, /desktop_inspect/, "跑得动的只读枚举不能被一起收进不可用");
  assert.doesNotMatch(yes, /desktop_screenshot/, "开关关着时截屏不能出现在可用清单里");
  assert.match(no, /desktop_screenshot/, "哪一口不可用要说清楚，小逻才知道该怎么回老板");
  assert.match(no, /允许小逻控制本机/, "不可用的理由要带着台阶：老板一句话说得清的那个开关名");
});

test("反向工具走线：event/tool-request 交端口与方法，tool/decide 的返回值就是模型看到的工具结果", async () => {
  const model = scriptedModel([
    { toolCall: { name: "read_browser_dom", arguments: { urlMatch: "console" } } },
    { content: "看到了。" },
  ]);
  const host = collector();
  openThreadForHost({
    userId: USER, conversationId: "brain-reverse", canvasId: "c-r", model: "m1",
    callModel: model.callModel, hostTools: ["vision"],
  });
  attachThreadListener(USER, "brain-reverse", host.onEvent);
  await ok(USER, "turn/start", { conversationId: "brain-reverse", text: "页签里有什么" });

  const asked = await host.waitFor((e) => e.method === "event/tool-request");
  assert.ok(asked, "视觉口没交给宿主代跑：" + JSON.stringify(host.events.map((e) => e.method)));
  assert.equal(asked.port, "vision");
  assert.equal(asked.call, "dom");
  assert.deepEqual(asked.args, ["console"], "端口方法的位置参数原样搬到线上，宿主照同名方法展开");
  assert.ok(asked.expiresAt > Date.now(), "代跑要带超时，不能让回合永远挂着");

  const decided = await ok(USER, "tool/decide", {
    conversationId: "brain-reverse", requestId: asked.requestId, ok: true,
    result: "标题：小逻控制台｜可交互元素 3 个",
  });
  assert.equal(decided.settled, true);
  await host.untilIdle();
  assert.match(model.toolReplyText(), /小逻控制台/, "宿主给的快照要原样进模型上下文");

  // 同一条请求再答一次：已经结算过了，不重复生效
  const stale = await ok(USER, "tool/decide", { conversationId: "brain-reverse", requestId: asked.requestId, ok: true, result: "重复应答" });
  assert.equal(stale.settled, false);

  const { entries } = await ok(USER, "thread/journal", { conversationId: "brain-reverse", limit: 40 });
  assert.ok(
    entries.some((e) => e.kind === "tool_result" && /宿主代跑 vision\.dom：成功/.test(e.note)),
    "代跑要留痕：" + JSON.stringify(entries.map((e) => e.note)),
  );
});

test("宿主答「跑不了」：把宿主给的理由原样回流，内核不替它编一句", async () => {
  const model = scriptedModel([
    { toolCall: { name: "ssh_exec", arguments: { host: "10.0.0.8", op: "test" } } },
    { content: "那我先不连远端。" },
  ]);
  const host = collector();
  openThreadForHost({
    userId: USER, conversationId: "brain-reverse-deny", canvasId: "c1", model: "m1",
    callModel: model.callModel, hostTools: ["ssh"],
  });
  attachThreadListener(USER, "brain-reverse-deny", host.onEvent);
  await ok(USER, "turn/start", { conversationId: "brain-reverse-deny", text: "探一下远端连通性" });

  const asked = await host.waitFor((e) => e.method === "event/tool-request");
  assert.equal(asked.port, "ssh");
  assert.equal(asked.call, "exec");
  assert.deepEqual(asked.args[0], { host: "10.0.0.8", op: "test" });

  await ok(USER, "tool/decide", { conversationId: "brain-reverse-deny", requestId: asked.requestId, ok: false, error: "本机没配 SSH 密钥，登不上 10.0.0.8" });
  await host.untilIdle();
  assert.match(model.toolReplyText(), /本机没配 SSH 密钥/, "只有看见失败，模型才不会把这一跳当成已完成");
});

test("没人应答不挂等：宿主没连着事件流时当场回绝，不把模型吊在 60 秒超时上", async () => {
  const model = scriptedModel([
    { toolCall: { name: "read_browser_dom", arguments: {} } },
    { content: "那我换个做法。" },
  ]);
  openThreadForHost({
    userId: USER, conversationId: "brain-nolistener", canvasId: "c1", model: "m1",
    callModel: model.callModel, hostTools: ["vision"],
  });
  const startedAt = Date.now();
  await ok(USER, "turn/start", { conversationId: "brain-nolistener", text: "看下页面" });
  await waitThreadIdle(USER, "brain-nolistener");
  assert.ok(Date.now() - startedAt < 5_000, "一个订阅者都没有还挂到超时，是白等");
  assert.match(model.toolReplyText(), /宿主没连着事件流/);
});

test("换宿主就收回能力面：回合跑一半不抽正在等的口，收尾后才落地", async () => {
  let release = null;
  const gate = new Promise((resolve) => (release = resolve));
  const callModel = async () => {
    await gate; // 第一轮挂在模型调用上，模拟「回合正在跑」
    return reply({ content: "这轮跑完了。" });
  };
  const cid = "brain-hostswap";
  openThreadForHost({ userId: USER, conversationId: cid, canvasId: "c1", model: "m1", callModel, hostTools: ["vision"] });
  const host = collector();
  attachThreadListener(USER, cid, host.onEvent);

  await ok(USER, "turn/start", { conversationId: cid, text: "先别急着换宿主" });
  const mid = await ok(USER, "thread/capabilities", { conversationId: cid });
  assert.ok(mid.toolNames.includes("read_browser_dom"), "跑到一半换宿主，正在等的口不能被抽走");

  await ok(USER, "thread/start", { conversationId: cid, canvasId: "c1", model: "m1", hostTools: [] });
  const deferred = await ok(USER, "thread/capabilities", { conversationId: cid });
  assert.ok(deferred.toolNames.includes("read_browser_dom"), "重谈要等回合收尾");

  release();
  await host.untilIdle();
  const after = await ok(USER, "thread/capabilities", { conversationId: cid });
  assert.ok(!after.toolNames.includes("read_browser_dom"), "收尾后新宿主（没有视觉口）的能力面要生效");

  const { entries } = await ok(USER, "thread/journal", { conversationId: cid, limit: 40 });
  const notes = entries.filter((e) => e.kind === "host").map((e) => e.note);
  assert.match(notes.join("\n"), /待切换/, "先记账：这一轮还在跑，重谈挂起");
  assert.match(notes.join("\n"), /已切换/, "后落地：换成了哪几个口要说得出来");

  // 空闲时换：当场生效，不用等下一轮
  await ok(USER, "thread/start", { conversationId: cid, canvasId: "c1", model: "m1", hostTools: ["vision"] });
  const back = await ok(USER, "thread/capabilities", { conversationId: cid });
  assert.ok(back.toolNames.includes("read_browser_dom"), "空闲时的重谈不该拖到下一轮");
});

test("补发不含反向工具请求：机器应答的动作重放一次，就是白跑一遍副作用", async () => {
  const model = scriptedModel([
    { toolCall: { name: "read_browser_dom", arguments: { urlMatch: "board" } } },
    { content: "看到看板了。" },
  ]);
  const cid = "brain-reverse-buffer";
  openThreadForHost({
    userId: USER, conversationId: cid, canvasId: "c1", model: "m1",
    callModel: model.callModel, hostTools: ["vision"],
  });
  const live = collector();
  attachThreadListener(USER, cid, live.onEvent);
  await ok(USER, "turn/start", { conversationId: cid, text: "看下看板" });
  const asked = await live.waitFor((e) => e.method === "event/tool-request");
  await ok(USER, "tool/decide", { conversationId: cid, requestId: asked.requestId, ok: true, result: "看板：3 张卡" });
  await live.untilIdle();
  assert.ok(live.events.some((e) => e.method === "event/tool-request"), "直播侧要收得到代跑请求");

  const late = collector();
  const sub = attachThreadListener(USER, cid, late.onEvent);
  assert.ok(!sub.replay.some((e) => e.method === "event/tool-request"), "代跑请求不进重放缓冲：审批重放是再问老板一次，工具重放是再截一次屏");
  assert.ok(sub.replay.some((e) => e.method === "event/ui" && e.kind === "assistant"), "迟到者仍要补到正文定稿");
  sub.detach();
});

test("客户端纪律：没接 onHostTool 的宿主一个口也不声明，接了才自动回执", async () => {
  const cid = "brain-client-decl";
  const model = scriptedModel([
    { toolCall: { name: "read_browser_dom", arguments: { urlMatch: "board" } } },
    { content: "看到看板了。" },
  ]);
  openThreadForHost({ userId: USER, conversationId: cid, canvasId: "c1", model: "m1", callModel: model.callModel });

  // 只有声明没有回调 = 没人会应答：客户端直接把声明收掉，内核那侧就不会注册出一个跑不动的口
  const silent = new AgentClient({ transport: inProcessTransport(USER), hostTools: ["vision"] });
  const reuse = await silent.threadStart({ conversationId: cid, canvasId: "c1", model: "m1" });
  assert.equal(reuse.existed, true, "同 cid 复用，能力面按新宿主重谈");
  const narrow = await silent.threadCapabilities(cid);
  assert.ok(!narrow.toolNames.includes("read_browser_dom"), "没接 onHostTool 就等于跑不了，声明也不该生效");

  const ran = [];
  const worker = new AgentClient({
    transport: inProcessTransport(USER),
    hostTools: ["vision"],
    hostModelVision: true,
    onHostTool: (event) => {
      ran.push(event.port + "." + event.call);
      return "看板：3 张卡";
    },
  });
  await worker.threadStart({ conversationId: cid, canvasId: "c1", model: "m1" });
  const wide = await worker.threadCapabilities(cid);
  assert.ok(wide.toolNames.includes("read_browser_dom"), "接了回调的宿主才有资格声明口");

  const outcome = await worker.runTurn({ conversationId: cid, text: "看下看板" });
  assert.ok(outcome, "回合要有回执，宿主不该挂在事件流上");
  assert.deepEqual(ran, ["vision.dom"], "代跑回调只会被问到声明过的口");
  assert.match(model.toolReplyText(), /看板：3 张卡/, "宿主返回的值要经客户端自动回执进到模型上下文");
});

/**
 * P7-1 反向通道补的两口：deploy（本机程序落盘）与 mcp（外部工具）。
 * 这两口比截图更特殊——落盘写的是宿主这台机器的目录，MCP 的连接与凭据也在宿主手里，
 * 所以内核连「有哪些工具」都得听宿主报，报上来的名字还要过一道前缀闸。
 */

test("deploy 与 mcp 的能力面同源：宿主报清单才有工具，非 mcp__ 前缀一律丢掉", async () => {
  const cid = "brain-decl-mcp";
  await ok(USER, "thread/start", { conversationId: cid, canvasId: "c1", model: "m1" });
  const narrow = await ok(USER, "thread/capabilities", { conversationId: cid });
  assert.ok(!narrow.toolNames.includes("deploy_program"), "deploy 没声明，本机落盘工具不该出现在面上");
  assert.equal(narrow.caps.deploy, false);
  assert.equal(narrow.caps.mcpTools, 0);

  // 声明了 mcp 却没报清单 = 一个外部工具也没有：口在，工具面不能凭空长出来
  await ok(USER, "thread/start", { conversationId: cid, canvasId: "c1", model: "m1", hostTools: ["mcp"] });
  const empty = await ok(USER, "thread/capabilities", { conversationId: cid });
  assert.equal(empty.caps.mcpTools, 0, "没清单的 mcp 口不该被当成有工具");

  await ok(USER, "thread/start", {
    conversationId: cid, canvasId: "c1", model: "m1",
    hostTools: ["deploy", "mcp"],
    mcpTools: [
      { name: "mcp__tickets__list", description: "列工单" },
      { name: "write_file", description: "不是 mcp__ 前缀：会撞内置工具，必须丢掉" },
      { name: "mcp__tickets__list", description: "重复上报" },
    ],
  });
  const wide = await ok(USER, "thread/capabilities", { conversationId: cid });
  assert.ok(wide.toolNames.includes("deploy_program"), "deploy 声明了就该注册");
  assert.equal(wide.caps.deploy, true);
  assert.deepEqual(wide.toolNames.filter((n) => n.startsWith("mcp__")), ["mcp__tickets__list"], "重名只留一个，非 mcp__ 前缀的一个不要");
  assert.ok(wide.toolNames.includes("write_file") && wide.toolNames.filter((n) => n === "write_file").length === 1, "宿主报的假名字不能把内置工具顶掉或翻倍");
  assert.equal(wide.caps.mcpTools, 1);
});

test("MCP 调用搬到线上：port=mcp call=callTool 带公开名与参数，宿主回执原样进上下文", async () => {
  const model = scriptedModel([
    { toolCall: { name: "mcp__tickets__list", arguments: { status: "open" } } },
    { content: "有两张没关。" },
  ]);
  const cid = "brain-mcp-reverse";
  const host = collector();
  openThreadForHost({
    userId: USER, conversationId: cid, canvasId: "c1", model: "m1",
    callModel: model.callModel, hostTools: ["mcp"],
    mcpTools: [{ name: "mcp__tickets__list", description: "列工单", inputSchema: { type: "object", properties: { status: { type: "string" } } } }],
  });
  attachThreadListener(USER, cid, host.onEvent);
  await ok(USER, "turn/start", { conversationId: cid, text: "看下未关闭的工单" });

  const asked = await host.waitFor((e) => e.method === "event/tool-request");
  assert.ok(asked, "MCP 没走反向通道：" + JSON.stringify(host.events.map((e) => e.method)));
  assert.equal(asked.port, "mcp");
  assert.equal(asked.call, "callTool");
  assert.deepEqual(asked.args, ["mcp__tickets__list", { status: "open" }], "宿主按公开名反查 (server, tool) 再 tools/call");

  await ok(USER, "tool/decide", { conversationId: cid, requestId: asked.requestId, ok: true, result: "T-1 登录页白屏｜T-2 导出超时" });
  await host.untilIdle();
  assert.match(model.toolReplyText(), /T-1 登录页白屏/, "外部工具的结果要原样回流，内核不替它摘要");

  const { entries } = await ok(USER, "thread/journal", { conversationId: cid, limit: 40 });
  assert.ok(
    entries.some((e) => e.kind === "tool_result" && /宿主代跑 mcp\.callTool：成功/.test(e.note)),
    "代跑要留痕：" + JSON.stringify(entries.map((e) => e.note)),
  );
});

test("本机落盘搬到线上：产物整包交宿主，宿主给的目录名就是模型看到的交付凭据", async () => {
  const model = scriptedModel([
    { toolCall: { name: "write_code", arguments: { files: [{ path: "worker.py", language: "python", content: "import sys\n\n\ndef main():\n    print('worker ok', sys.version_info[:2])\n\n\nif __name__ == '__main__':\n    main()\n" }], notes: "跑一下打个招呼" } } },
    { toolCall: { name: "deploy_program", arguments: { name: "worker" } } },
    { content: "落到本机了。" },
  ]);
  const cid = "brain-deploy-reverse";
  const host = collector();
  openThreadForHost({
    userId: USER, conversationId: cid, canvasId: "c1", model: "m1",
    callModel: model.callModel, hostTools: ["deploy"],
  });
  attachThreadListener(USER, cid, host.onEvent);
  await ok(USER, "turn/start", { conversationId: cid, text: "把这个小脚本落到我机器上" });

  const asked = await host.waitFor((e) => e.method === "event/tool-request" && e.call === "deployProgram");
  assert.ok(asked, "deploy 没走反向通道：" + JSON.stringify(host.events.map((e) => e.method)));
  assert.equal(asked.port, "deploy");
  assert.equal(asked.args[0].files[0].path, "worker.py", "写的是宿主这台机器的目录，产物得整包搬过去");
  assert.equal(asked.args[1], "worker");

  await ok(USER, "tool/decide", { conversationId: cid, requestId: asked.requestId, ok: true, result: { dir: "deploy/worker", fileCount: 1 } });
  await host.untilIdle();
  assert.match(lastToolReplies(model), /deploy\/worker/, "宿主落盘出来的目录名要回流，模型后面 run_command/start_service 的 cwd 靠它");
  const delivery = host.events.find((e) => e.kind === "delivery-card");
  assert.equal(delivery?.meta?.delivery?.dir, "deploy/worker", "交付卡的去向得写宿主给的那个目录");
});

test("MCP 清单跟着宿主重谈：换服务器才换工具，描述改了不重搭端口面", async () => {
  const cid = "brain-mcp-swap";
  openThreadForHost({
    userId: USER, conversationId: cid, canvasId: "c1", model: "m1",
    hostTools: ["mcp"], mcpTools: [{ name: "mcp__tickets__list", description: "列工单" }],
  });
  const hostNotes = async () => {
    const { entries } = await ok(USER, "thread/journal", { conversationId: cid, limit: 60 });
    return entries.filter((e) => e.kind === "host").map((e) => e.note);
  };
  const mcpNames = async () => {
    const caps = await ok(USER, "thread/capabilities", { conversationId: cid });
    return caps.toolNames.filter((n) => n.startsWith("mcp__"));
  };
  assert.deepEqual(await mcpNames(), ["mcp__tickets__list"]);
  assert.equal((await hostNotes()).length, 0, "刚建的线程没有重谈记录");

  // 同一份工具名集合再报一次（只改了描述）：能力面没变，不该记「已切换」，也不该把在途状态重搭掉
  await ok(USER, "thread/start", {
    conversationId: cid, canvasId: "c1", model: "m1",
    hostTools: ["mcp"], mcpTools: [{ name: "mcp__tickets__list", description: "换个说法而已" }],
  });
  assert.equal((await hostNotes()).length, 0, "清单等价就不算换宿主");

  // 真换了服务器：清单变了，工具面当场跟着换
  await ok(USER, "thread/start", {
    conversationId: cid, canvasId: "c1", model: "m1",
    hostTools: ["mcp"], mcpTools: [{ name: "mcp__maps__geocode", description: "地址转坐标" }],
  });
  assert.deepEqual(await mcpNames(), ["mcp__maps__geocode"]);
  assert.match((await hostNotes()).join("\n"), /已切换.*MCP 工具=1 把/, "换了哪几口要说得出来");
});

/**
 * P7-2：程序库自动落盘（策略 A）搬到服务端。
 * 引擎里 saveProgram 是 fire-and-forget（写档失败不该打断对话），所以断言一律轮询等落盘。
 */
async function waitForPrograms(owner, conversationId, expect = (mine) => mine.length > 0, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const mine = (await listPrograms(owner)).filter((m) => m.source?.conversationId === conversationId);
    if (expect(mine)) return mine;
    if (Date.now() > deadline) throw new Error("程序库没等到期望的那份：" + owner + " / " + conversationId + "\n" + JSON.stringify(mine));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("第二宿主的程序库：write_code 成功即落一份，同对话再写是覆盖 + version+1", async () => {
  const owner = "test-app-server-programs";
  const cid = "brain-prog-upsert";
  try {
    const model = scriptedModel([
      { toolCall: { name: "write_code", arguments: { files: [{ path: "app.py", language: "python", content: "import sys\nprint('hello', sys.version)\n" }], entryFile: "app.py" } } },
      { content: "第一段写好了。" },
      { toolCall: { name: "write_code", arguments: { files: [{ path: "util.py", language: "python", content: "def greet(name):\n    return 'hi ' + name\n" }] } } },
      { content: "补齐了。" },
    ]);
    openThreadForHost({ userId: owner, conversationId: cid, canvasId: "c1", model: "m1", callModel: model.callModel });
    const host = collector();
    attachThreadListener(owner, cid, host.onEvent);

    await ok(owner, "turn/start", { conversationId: cid, text: "做一个打印版本号的 Python 脚本" });
    await host.untilIdle();
    const mine = await waitForPrograms(owner, cid);
    assert.equal(mine.length, 1, "一次对话一份程序，不该堆一堆文件夹");
    assert.equal(mine[0].name, "做一个打印版本号的 Python 脚本", "程序名取老板第一句原话（与面板宿主同口径）");
    assert.equal(mine[0].version, 1);
    assert.equal(mine[0].entry, "app.py");
    const v1 = await getProgram(owner, mine[0].id);
    assert.match(v1.contents[0].content, /print\('hello'/);

    // 同对话第二轮：产物是按路径合并的，程序库该覆盖同一份并把版本 +1（结果去向：旧版本由 version 记录，不另开文件夹）
    await ok(owner, "turn/start", { conversationId: cid, text: "再补一个问候函数" });
    await host.untilIdle();
    const again = await waitForPrograms(owner, cid, (mine) => mine.length === 1 && mine[0].version >= 2);
    assert.equal(again.length, 1, "同一条对话不该分出第二份程序");
    assert.equal(again[0].id, mine[0].id, "upsert 认的是对话，id 要稳住");
    assert.equal(again[0].version, 2);
    assert.deepEqual(again[0].files.map((f) => f.path), ["app.py", "util.py"]);

    // 另一条对话写程序：按对话分开记，不会把上一条覆盖掉
    const otherCid = "brain-prog-other";
    const other = scriptedModel([
      { toolCall: { name: "write_code", arguments: { files: [{ path: "tool.py", language: "python", content: "print('another program here')\n" }] } } },
      { content: "好了。" },
    ]);
    openThreadForHost({ userId: owner, conversationId: otherCid, canvasId: "c1", model: "m1", callModel: other.callModel });
    const host2 = collector();
    attachThreadListener(owner, otherCid, host2.onEvent);
    await ok(owner, "turn/start", { conversationId: otherCid, text: "另起一个命令行小工具" });
    await host2.untilIdle();
    await waitForPrograms(owner, otherCid);
    const all = await listPrograms(owner);
    assert.deepEqual(
      all.map((m) => m.source?.conversationId).sort(),
      [cid, otherCid].sort(),
      "两条对话各记一份，程序库不会互相覆盖",
    );
  } finally {
    for (const meta of await listPrograms(owner)) await removeProgram(owner, meta.id);
  }
});

test("接线事实：程序库读写只有一份，路由与端口都从 lib/brain-programs 取", async () => {
  const [programsRoute, serverPorts] = await Promise.all([
    readFile(new URL("../app/api/v2/brain/programs/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/xiaoluo-brain/lib/brain/server-ports.ts", import.meta.url), "utf8"),
  ]);
  assert.match(programsRoute, /from "\.\.\/\.\.\/\.\.\/\.\.\/lib\/brain-programs"/);
  assert.match(serverPorts, /from "\.\.\/\.\.\/\.\.\/lib\/brain-programs"/);
  // 目录结构与上限只在存储层里写一份：端口自己碰盘就会跟路由记出两本账
  assert.doesNotMatch(serverPorts, /from "node:fs/, "服务端端口不该自己碰盘，程序库目录只由 lib/brain-programs 管");
});
