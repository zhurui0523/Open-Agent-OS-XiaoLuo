/**
 * ChatAgent 端口协议行为测试（P2-1 / P2-3）
 *
 * 这一档不读源码正则：它把 ChatAgent 装进一个纯 Node 进程（没有 DOM、没有 React、
 * 没有沙箱），只交一份 agent-ports.ts 形态的桩端口，然后看引擎真的注册了什么工具、
 * 真的往宿主发了什么事件、真的在截断后续跑。
 *
 * 这同时就是「app-server 化」的验收：CLI 或桌面主进程照这个桩的样子实现端口，
 * 拿到的内核与面板里那个是同一条代码路径。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createChatAgent } from "../app/xiaoluo-brain/lib/brain/agent-host.ts";
import { chatToolCapabilities } from "../app/xiaoluo-brain/lib/brain/agent-ports.ts";

// 引擎全程没碰过浏览器对象：这条断言是"宿主无关"的硬证据，别在测试里补 DOM
assert.equal(typeof document, "undefined");
assert.equal(typeof window, "undefined");

const usage = { promptTokens: 900, completionTokens: 40 };

function reply(content, extra = {}) {
  return { content, usage, ...extra };
}

/** 桩端口：记录每次 LLM 请求（含工具面）与每次 UI 事件；responses 用完就重复最后一条 */
function harness(responses) {
  const requests = [];
  const events = [];
  let n = 0;
  const ports = {
    callLLM: async (req) => {
      requests.push(req);
      const r = responses[Math.min(n, responses.length - 1)];
      n += 1;
      return typeof r === "function" ? r(req) : r;
    },
    postUI: (kind, content, meta) => events.push({ kind, content, meta }),
  };
  return { ports, requests, events };
}

function agentFor(ports, extraPorts = {}) {
  Object.assign(ports, extraPorts);
  return createChatAgent({ ports, model: "stub-model", conversationId: "cid-protocol-test" });
}

/** 第一条请求的 tools 就是本轮注册面 */
function toolNames(requests) {
  return (requests[0]?.tools ?? []).map((t) => t?.function?.name);
}

test("空宿主也能跑通一轮：内核只靠 ports 契约", async () => {
  const { ports, requests, events } = harness([reply("收到，我在。")]);
  const agent = agentFor(ports);
  const outcome = await agent.reply("你好");

  assert.equal(outcome.steps, 1, "一次 LLM 回合 = 一步");
  assert.equal(requests.length, 1);
  const assistant = events.find((e) => e.kind === "assistant");
  assert.ok(assistant, JSON.stringify(events));
  assert.equal(assistant.content, "收到，我在。");

  const system = agent.serialize().messages.filter((m) => m.role === "system");
  assert.ok(system[0].content.includes("小逻"), "系统提示词由宿主工厂拼好");
  assert.ok(
    system.some((m) => m.content.startsWith("[运行时能力]")),
    "能力段按实际接入注入",
  );
});

test("工具面严格跟着端口注册：没接的口就不出现在 schema 里", async () => {
  const bare = harness([reply("好")]);
  await agentFor(bare.ports).reply("你好");
  const bareNames = toolNames(bare.requests);
  assert.ok(bareNames.includes("write_code") && bareNames.includes("ask_user"), "基础五件常注册");
  for (const name of ["run_command", "write_stdin", "read_file", "web_search", "git", "browse_page"]) {
    assert.ok(!bareNames.includes(name), `${name} 不该在没有对应端口时注册`);
  }

  const commandOnly = harness([reply("好")]);
  await agentFor(commandOnly.ports, {
    command: { run: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }) },
  }).reply("你好");
  const commandNames = toolNames(commandOnly.requests);
  assert.ok(commandNames.includes("run_command"), "接了 command 就有 run_command");
  assert.ok(
    !commandNames.includes("write_stdin"),
    "只有 run、没有 startSession/writeSession 时不得注册 write_stdin",
  );

  const full = harness([reply("好")]);
  await agentFor(full.ports, {
    command: {
      run: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
      startSession: async () => ({ sessionId: "sess-1", status: "running", output: "" }),
      writeSession: async () => ({ sessionId: "sess-1", status: "running", output: "" }),
    },
    fs: {
      listDir: async () => [],
      readFile: async () => ({ content: "" }),
      writeFile: async () => {},
    },
    git: { exec: async () => "" },
    webSearch: async () => "结果",
    browser: { fetchPage: async () => ({ title: "t", text: "" }) },
  }).reply("你好");
  const fullNames = toolNames(full.requests);
  for (const name of ["run_command", "write_stdin", "read_file", "git", "web_search", "browse_page"]) {
    assert.ok(fullNames.includes(name), `${name} 应随对应端口注册`);
  }
});

test("能力说明段与注册同源：说有的就是注册的", async () => {
  const { ports, requests } = harness([reply("好")]);
  const agent = agentFor(ports, {
    command: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
  });
  await agent.reply("你好");

  const capsSection = agent
    .serialize()
    .messages.find((m) => m.role === "system" && m.content.startsWith("[运行时能力]"));
  assert.ok(capsSection);
  const registered = toolNames(requests);
  // 同一份 ports 推导：run_command 在可用侧列出，未接入的文件口列在不可用侧
  assert.match(capsSection.content, /\[可用\][\s\S]*run_command/);
  assert.ok(registered.includes("run_command"));
  assert.match(capsSection.content, /\[不可用\][\s\S]*read_file/);
  assert.ok(!registered.includes("read_file"));

  // 协议函数本身就是这张表：宿主（CLI/桌面）不必跑一轮对话也能报出同样能力
  const caps = chatToolCapabilities(ports);
  assert.equal(caps.commandEnabled, true);
  assert.equal(caps.interactiveEnabled, false);
  assert.equal(caps.fsEnabled, false);
});

test("输出被长度上限掐断时真续跑，且换的是拆分策略不是原样重试", async () => {
  const { ports, requests, events } = harness([
    reply("前半段写完了，后半段还没写", { finishReason: "length" }),
    reply("补齐了"),
  ]);
  const agent = agentFor(ports);
  await agent.reply("把三个文件都写完");

  assert.ok(requests.length >= 2, `截断后应继续下一请求，实际 ${requests.length} 次`);
  assert.ok(
    events.some((e) => e.content.includes("上一条输出被长度上限截断")),
    JSON.stringify(events),
  );
  const guidance = requests[1].messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  assert.match(guidance, /\[系统提示·输出截断\]/);
  assert.match(guidance, /一次 write_code 只给一个文件的全文/);
  assert.match(guidance, /length/);
});

test("模型硬调用未接入的会话工具：回流明确出口而不是挂死", async () => {
  const { ports, requests } = harness([
    reply("", {
      toolCalls: [{ id: "c1", name: "write_stdin", arguments: { session: "sess-nope", input: "y" } }],
    }),
    reply("明白了"),
  ]);
  const agent = agentFor(ports, {
    command: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
  });
  await agent.reply("给那个进程打字");

  assert.ok(requests.length >= 2, "工具结果必须回流给模型");
  const toolMsg = requests[1].messages.find((m) => m.role === "tool");
  assert.match(toolMsg.content, /当前环境未接入交互会话口/);
});
