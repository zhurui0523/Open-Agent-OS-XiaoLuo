/**
 * 第 4 项：子 Agent 可写 / 并行（Codex 的 spawn_agent）
 *
 * 原来 dispatch_subagent 只读、单任务、写入口直接抛错。现在：
 *  - tasks 一次派 2–3 个只读任务并行跑，结论合并回流；
 *  - canWrite=true 且宿主开了写权限才允许子 Agent 写文件，且改动登记回主线程；
 *  - 写任务一律串行，避免多个子 Agent 同时落盘互相踩。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createChatAgent } from "../app/xiaoluo-brain/lib/brain/agent-host.ts";

const usage = { promptTokens: 10, completionTokens: 5 };

function reply(content, extra = {}) {
  return { content, usage, ...extra };
}

/** 桩：父线程按脚本走；子 Agent 由系统提示词里的「子 Agent」识别，返回各自结论 */
function harness(opts) {
  const events = [];
  const fsWrites = [];
  const childStart = [];
  const childEnd = [];
  let parentStep = 0;
  const childCounters = new Map();

  const ports = {
    callLLM: async (req) => {
      const sys = String(req.messages[0]?.content ?? "");
      if (sys.includes("子 Agent")) {
        const marker = sys.includes("可以小范围改文件") ? "writable-child" : "readonly-child";
        // 每个子 Agent 是独立实例，用「它拿到的任务文本」当身份，别按 marker 混在一起
        const taskText = String(req.messages.find((m) => m.role === "user")?.content ?? "");
        const key = marker + "|" + taskText;
        const n = childCounters.get(key) ?? 0;
        childCounters.set(key, n + 1);
        if (n === 0) childStart.push(Date.now());
        const seq = req.messages.filter((m) => m.role === "user").length;
        if (opts.childScript) {
          // callIndex = 这个子 Agent 的第几次模型回合（seq 在单轮里永远是 1，不能用来分步）
          const step = opts.childScript({ marker, seq, callIndex: n, taskText, req });
          if (step) {
            // 子脚本可能挂一会儿：挂完再记完成时间，用来量"并行"而不是"谁先跑完"
            if (opts.childDelayMs && n === 0) await new Promise((r) => setTimeout(r, opts.childDelayMs));
            childEnd.push(Date.now());
            return step;
          }
        }
        if (opts.childDelayMs && n === 0) await new Promise((r) => setTimeout(r, opts.childDelayMs));
        childEnd.push(Date.now());
        return reply("结论：" + taskText.slice(0, 30));
      }
      const step = opts.parentScript[Math.min(parentStep, opts.parentScript.length - 1)];
      parentStep += 1;
      if (step.toolCall) {
        return reply(step.content ?? "", {
          toolCalls: [{ id: "c" + parentStep, name: step.toolCall.name, arguments: step.toolCall.arguments }],
          finishReason: "tool_calls",
        });
      }
      return reply(step.content ?? "好的。");
    },
    postUI: (kind, content, meta) => events.push({ kind, content, meta }),
    fs: {
      listDir: async () => [],
      readFile: async (path) => ({ content: "line1\nline2\n", path }),
      writeFile: async (path, content) => {
        fsWrites.push({ path, content });
      },
      grep: async () => [],
      find: async () => [],
    },
  };
  Object.assign(ports, opts.extraPorts ?? {});
  const agent = createChatAgent({ ports, model: "stub-model", conversationId: "cid-subagent" });
  return { agent, events, fsWrites, childStart, childEnd };
}

test("并行：tasks 一次派两个只读任务，两个子 Agent 真的同时在跑", async () => {
  const { agent, childStart, childEnd } = harness({
    parentScript: [
      { toolCall: { name: "dispatch_subagent", arguments: { tasks: ["查 A 模块", "查 B 模块"] } } },
      { content: "两个都查清了。" },
    ],
    extraPorts: { subagent: { maxDepth: 1, write: true } },
    // 每个子 Agent 第一回合挂 120ms：若串行，第二个的 start 必然晚于第一个的 end
    childDelayMs: 120,
  });
  const out = await agent.reply("同时查两件事");
  assert.equal(out.steps, 2);
  const toolText = String(agent.serialize().messages.find((m) => m.role === "tool")?.content ?? "");
  assert.match(toolText, /子 Agent 结论（2 个任务）/);
  assert.match(toolText, /查 A 模块/);
  assert.match(toolText, /查 B 模块/);
  assert.equal(childStart.length >= 2, true, "两个子 Agent 都要起来");
  // 并行证据：第二个子 Agent 在第一个收口之前就已开始
  assert.ok(childStart[1] < childEnd[0], "第二个子任务应当在第一个收口前就开始（真并行）");
});

test("写权限：宿主没开 write 时 canWrite=true 直接拒绝，不偷偷降级成写", async () => {
  const { agent, fsWrites } = harness({
    parentScript: [
      { toolCall: { name: "dispatch_subagent", arguments: { task: "改个文件名", canWrite: true } } },
      { content: "明白，那我自己改。" },
    ],
    extraPorts: { subagent: { maxDepth: 1 } },
  });
  await agent.reply("派个子 Agent 改文件");
  const toolText = String(agent.serialize().messages.find((m) => m.role === "tool")?.content ?? "");
  assert.match(toolText, /宿主没开子 Agent 写权限/);
  assert.equal(fsWrites.length, 0);
});

test("可写：宿主开权限后子 Agent 能写，且改动登记回主线程结果", async () => {
  const { agent, fsWrites } = harness({
    parentScript: [
      { toolCall: { name: "dispatch_subagent", arguments: { task: "把说明补上", canWrite: true } } },
      { content: "收到。" },
    ],
    extraPorts: { subagent: { maxDepth: 1, write: true } },
    // 子 Agent 先 read_file（子 Agent 也守 read-before-write），再 write_file，最后给结论
    childScript: ({ callIndex }) => {
      if (callIndex === 0) {
        return reply("", {
          toolCalls: [{ id: "r1", name: "read_file", arguments: { path: "docs/a.md" } }],
          finishReason: "tool_calls",
        });
      }
      if (callIndex === 1) {
        return reply("", {
          toolCalls: [{ id: "w1", name: "write_file", arguments: { path: "docs/a.md", content: "补好了" } }],
          finishReason: "tool_calls",
        });
      }
      return null;
    },
  });
  await agent.reply("让子 Agent 补说明");
  const dbg = agent.serialize().messages.filter((m) => m.role === "tool").map((m) => String(m.content).slice(0, 300)).join("\n---\n");
  assert.equal(fsWrites.length, 1, dbg);
  assert.equal(fsWrites[0].path, "docs/a.md");
  const toolText = String(agent.serialize().messages.find((m) => m.role === "tool")?.content ?? "");
  assert.match(toolText, /【子 Agent 改过的文件】docs\/a\.md/);
});

test("只读子 Agent 不许写：write_file 被挡，不会落盘", async () => {
  const { agent, fsWrites } = harness({
    parentScript: [
      { toolCall: { name: "dispatch_subagent", arguments: { task: "查一下顺便改", canWrite: false } } },
      { content: "好。" },
    ],
    extraPorts: { subagent: { maxDepth: 1, write: true } },
    childScript: ({ callIndex }) =>
      callIndex === 0
        ? reply("", {
            toolCalls: [{ id: "w1", name: "write_file", arguments: { path: "docs/b.md", content: "x" } }],
            finishReason: "tool_calls",
          })
        : null,
  });
  await agent.reply("只读查一下");
  assert.equal(fsWrites.length, 0, "只读档下写请求必须被挡在 fs 口外面");
});
