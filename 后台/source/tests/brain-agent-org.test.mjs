/**
 * 第 7.10 项 A 档：多 Agent 组织（角色 + 协作板）
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = new URL("../", import.meta.url);
const appPath = (p) => fileURLToPath(new URL("app/" + p, ROOT));
const app = (p) => pathToFileURL(appPath(p)).href;

const O = await import(app("xiaoluo-brain/lib/brain/agent-organization.ts"));
const { createChatAgent } = await import(app("xiaoluo-brain/lib/brain/agent-host.ts"));

test("角色解析：显式优先；审查/实现/调研按措辞落位", () => {
  assert.equal(O.resolveAgentRole("reviewer", "随便").id, "reviewer");
  assert.equal(O.resolveAgentRole("不存在的角色", "列一遍").id, "researcher");
  assert.equal(O.resolveAgentRole(undefined, "审查这段改动的风险").id, "reviewer");
  assert.equal(O.resolveAgentRole(undefined, "实现一下导出按钮").id, "coder");
  assert.equal(O.resolveAgentRole(undefined, "调查登录流程为什么慢").id, "researcher");
  assert.equal(O.resolveAgentRole(undefined, "拆任务并排优先级").id, "coordinator");
  assert.equal(O.resolveAgentRole(undefined, "只读调研，不要改文件").id, "researcher");
});

test("协作板：派任务/回结果/视图有界，节点状态可查", () => {
  const board = new O.AgentBoard();
  const id = board.assign("researcher", "  查一下   登录链路  ");
  assert.equal(board.snapshot().nodes[0].status, "running");
  board.complete(id, "结论：鉴权在 middleware，行号已附");
  const snap = board.snapshot();
  assert.equal(snap.nodes[0].status, "done");
  assert.ok(snap.nodes[0].endedAt);
  assert.match(board.view(), /研究员 领任务：查一下 登录链路/);
  assert.match(board.view(), /研究员 回结果：结论：鉴权在 middleware/);

  for (let i = 0; i < 80; i += 1) board.assign("researcher", "任务" + i);
  assert.equal(board.snapshot().messages.length, 60, "消息上限");
  assert.equal(board.snapshot().nodes.length, 30, "节点上限");
  assert.ok(board.view(8).split("\n").length <= 8);
});

test("真跑：dispatch_subagent 带角色 → 子 Agent 用角色提示词，协作板留下分工", async () => {
  let parentCalls = 0;
  let sawResearcherPrompt = false;
  const ports = {
    postUI: () => {},
    subagent: { maxDepth: 1, write: false },
    callLLM: async (req) => {
      const sys = String(req.messages.find((m) => m.role === "system")?.content ?? "");
      if (sys.includes("你是研究员")) {
        sawResearcherPrompt = true;
        return { content: "结论：入口在 app/page.tsx:12", usage: { promptTokens: 8, completionTokens: 5 } };
      }
      parentCalls += 1;
      if (parentCalls === 1) {
        return {
          content: "",
          toolCalls: [{ id: "c1", name: "dispatch_subagent", arguments: { task: "调查入口文件在哪", role: "researcher" } }],
          usage: { promptTokens: 20, completionTokens: 4 },
        };
      }
      return { content: "已收到子 Agent 结论。", usage: { promptTokens: 12, completionTokens: 3 } };
    },
  };
  const agent = createChatAgent({ ports, model: "stub", conversationId: "org" });
  const outcome = await agent.reply("查一下入口在哪");
  assert.ok(outcome.steps > 0);
  assert.equal(sawResearcherPrompt, true, "子 Agent 系统提示词要带角色约束");

  // private 只在 TS 层，运行时可直接读协作板
  const snap = agent.orgBoard.snapshot();
  assert.equal(snap.nodes.length, 1);
  assert.equal(snap.nodes[0].role, "researcher");
  assert.equal(snap.nodes[0].status, "done");
  assert.ok(snap.messages.some((m) => m.kind === "assign" && m.text.includes("调查入口文件")));
  assert.ok(snap.messages.some((m) => m.kind === "result" && m.text.includes("入口在 app/page.tsx")));
});

test("接线：chat-agent 用 AgentBoard、schema 有 role 字段", async () => {
  const fs = await import("node:fs/promises");
  const agentSrc = await fs.readFile(appPath("xiaoluo-brain/lib/brain/chat-agent.ts"), "utf8");
  assert.match(agentSrc, /new AgentBoard\(\)/);
  assert.match(agentSrc, /resolveAgentRole\(args\?\.role/);
  const toolsSrc = await fs.readFile(appPath("xiaoluo-brain/lib/brain/chat-tools.ts"), "utf8");
  assert.match(toolsSrc, /role: \{/);
  assert.match(toolsSrc, /"researcher"[\s\S]*"reviewer"/);
});
