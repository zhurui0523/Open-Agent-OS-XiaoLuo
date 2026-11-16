/**
 * 第 7.12 项：可观测性（本地 JSONL trace，span 只记元信息）
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = new URL("../", import.meta.url);
const appPath = (p) => fileURLToPath(new URL("app/" + p, ROOT));
const app = (p) => pathToFileURL(appPath(p)).href;

const T = await import(app("xiaoluo-brain/lib/brain/trace.ts"));
const { createChatAgent } = await import(app("xiaoluo-brain/lib/brain/agent-host.ts"));

function todayFile(dir) {
  return join(dir, "trace-" + new Date().toISOString().slice(0, 10) + ".jsonl");
}

async function readSpans(dir) {
  const raw = await fs.readFile(todayFile(dir), "utf8").catch(() => "");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("默认关闭：没设 XIAOLUO_TRACE_DIR 时不落盘、不建目录", async () => {
  delete process.env.XIAOLUO_TRACE_DIR;
  T.resetTraceStateForTests();
  assert.equal(T.tracesEnabled(), false);
  const span = T.startSpan("noop");
  span.end("ok");
  await T.flushTracesForTests();
  assert.equal(T.traceStats().written, 0);
});

test("落盘：span 带 traceId/父 span/耗时/状态，长属性截断，不写正文", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xiaoluo-trace-"));
  process.env.XIAOLUO_TRACE_DIR = dir;
  T.resetTraceStateForTests();
  assert.equal(T.tracesEnabled(), true);

  const root = T.startSpan("turn", { attributes: { userChars: 12 } });
  const child = T.startSpan("tool.read_file", { traceId: root.traceId, parentId: root.spanId, attributes: { argsChars: 5, long: "x".repeat(400) } });
  child.end("ok", { resultChars: 30 });
  root.end("ok");

  await T.flushTracesForTests();
  const spans = await readSpans(dir);
  assert.equal(spans.length, 2);
  const tool = spans.find((s) => s.name === "tool.read_file");
  assert.equal(tool.traceId, root.traceId);
  assert.equal(tool.parentId, root.spanId);
  assert.equal(tool.status, "ok");
  assert.ok(tool.durationMs >= 0);
  assert.equal(tool.attributes.argsChars, 5);
  assert.equal(tool.attributes.long.length, 200, "长属性要截断");
  assert.equal(tool.attributes.resultChars, 30);
  assert.ok(!JSON.stringify(tool).includes("x".repeat(300)));
  assert.equal(T.traceStats().written, 2);

  delete process.env.XIAOLUO_TRACE_DIR;
  T.resetTraceStateForTests();
});

test("真跑一轮：模型调用与工具调用同 traceId，span 里没有消息正文", async () => {
  const dir = mkdtempSync(join(tmpdir(), "xiaoluo-trace-agent-"));
  process.env.XIAOLUO_TRACE_DIR = dir;
  T.resetTraceStateForTests();

  const secretText = "老板的原话：帮我看下机密项目";
  let step = 0;
  const ports = {
    callLLM: async () => {
      step += 1;
      if (step === 1) {
        return {
          content: "",
          toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "docs/a.md" } }],
          usage: { promptTokens: 11, completionTokens: 6 },
          finishReason: "tool_calls",
        };
      }
      return { content: "看完了。", usage: { promptTokens: 9, completionTokens: 4 } };
    },
    postUI: () => {},
    fs: { readFile: async () => ({ content: "正文内容不该进 trace", totalLines: 1, truncated: false }) },
  };
  const agent = createChatAgent({ ports, model: "stub-model", conversationId: "cid-trace" });
  await agent.reply(secretText);

  await T.flushTracesForTests();
  const spans = await readSpans(dir);
  const llm = spans.filter((s) => s.name === "llm.call");
  const tools = spans.filter((s) => s.name === "tool.read_file");
  assert.equal(llm.length, 2);
  assert.equal(tools.length, 1);
  const traceIds = new Set(spans.map((s) => s.traceId));
  assert.equal(traceIds.size, 1, "一轮内应同一个 traceId");
  assert.equal(llm[0].attributes.promptTokens, 11);
  assert.equal(llm[0].attributes.toolCalls, 1);
  assert.equal(llm[1].attributes.finishReason, "unknown");

  const dump = JSON.stringify(spans);
  assert.ok(!dump.includes(secretText), "trace 不能记用户原话");
  assert.ok(!dump.includes("正文内容不该进 trace"), "trace 不能记工具输出");

  delete process.env.XIAOLUO_TRACE_DIR;
  T.resetTraceStateForTests();
});

test("接线：chat-agent 开 span、agent-host 包 llm.call", async () => {
  const agentSrc = await (await import("node:fs/promises")).readFile(appPath("xiaoluo-brain/lib/brain/chat-agent.ts"), "utf8");
  assert.match(agentSrc, /startSpan\("tool\./);
  assert.match(agentSrc, /tracesEnabled\(\)/);
  const hostSrc = await (await import("node:fs/promises")).readFile(appPath("xiaoluo-brain/lib/brain/agent-host.ts"), "utf8");
  assert.match(hostSrc, /startSpan\("llm\.call"/);
});
