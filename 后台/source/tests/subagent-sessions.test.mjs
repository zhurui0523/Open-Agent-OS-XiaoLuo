// P1-5 剩余项验收：子 Agent 最小闭环 + PTY 会话清单
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildChatToolSchemas } from "../app/xiaoluo-brain/lib/brain/chat-tools.ts";

const HOST_CAPS = {
  webSearchEnabled: true,
  fsEnabled: true,
  fsOpsEnabled: true,
  subagentEnabled: true,
  commandEnabled: true,
  interactiveEnabled: true,
  sessionListEnabled: true,
  gitEnabled: true,
  browserEnabled: true,
};

function names(schemas) {
  return schemas.map((schema) => schema.function.name);
}

test("注册面：宿主给了子 Agent 口才注册 dispatch_subagent；不给就不注册", () => {
  assert.ok(names(buildChatToolSchemas(HOST_CAPS)).includes("dispatch_subagent"));
  assert.ok(
    !names(buildChatToolSchemas({ ...HOST_CAPS, subagentEnabled: false })).includes("dispatch_subagent"),
    "子 Agent 自身（不带 subagent 口）不该能再派子 Agent，否则无限递归",
  );
});

test("注册面：list_sessions 只在宿主实现 listSessions 时出现", () => {
  assert.ok(names(buildChatToolSchemas(HOST_CAPS)).includes("list_sessions"));
  assert.ok(!names(buildChatToolSchemas({ ...HOST_CAPS, sessionListEnabled: false })).includes("list_sessions"));
});

test("子 Agent 只读：子线程的 fs 写入口直接抛错，且不带命令/子 Agent 口", () => {
  const agent = readFileSync(new URL("../app/xiaoluo-brain/lib/brain/chat-agent.ts", import.meta.url), "utf8");
  assert.match(agent, /private async execDispatchSubagent/);
  assert.match(agent, /子 Agent 只读：要改文件请回到主线程用 edit_file。/);
  assert.match(agent, /const childPorts: ChatAgentPorts = \{[\s\S]{0,400}callLLM: ports\.callLLM/);
  const childBlock = agent.slice(agent.indexOf("const childPorts: ChatAgentPorts"), agent.indexOf("const child = new ChatAgent"));
  assert.ok(!/command:/.test(childBlock), "子 Agent 不该拿到命令口");
  assert.ok(!/subagent:/.test(childBlock), "子 Agent 不该拿到 subagent 口");
  assert.match(agent, /6 \* 60_000/, "子 Agent 要有超时上限");
  assert.match(agent, /this\.usedTokens \+= outcome\.usedTokens/, "子 Agent 的 token 要计回父线程");
  assert.match(agent, /case "dispatch_subagent":/);
});

test("会话清单：无会话时给下一步动作，有会话时带退出码与剩余 TTL", async () => {
  const agent = readFileSync(new URL("../app/xiaoluo-brain/lib/brain/chat-agent.ts", import.meta.url), "utf8");
  assert.match(agent, /private async execListSessions/);
  assert.match(agent, /当前没有存活的交互会话/);
  assert.match(agent, /已退出（exit /);
  assert.match(agent, /剩余 \$\{row\.expiresInSeconds\}s/);

  const sandbox = await import("../app/lib/brain-sandbox.ts");
  assert.deepEqual(sandbox.listBrainStdinSessions("nobody-here"), [], "别人的会话一个都不能透出来");

  const server = readFileSync(new URL("../app/xiaoluo-brain/lib/brain/server-ports.ts", import.meta.url), "utf8");
  assert.match(server, /async listSessions\(\)/);
  assert.match(server, /listBrainStdinSessions\(opts\.userId\)/);
});
