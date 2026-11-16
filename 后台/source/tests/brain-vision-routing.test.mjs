/**
 * 截图入上下文修复：视觉能力按登记处约束判定；对话模型列表排除生成端点
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = new URL("../", import.meta.url);
const appPath = (p) => fileURLToPath(new URL("app/" + p, ROOT));
const app = (p) => pathToFileURL(appPath(p)).href;

const V = await import(app("lib/model-vision.ts"));
const E = await import(app("lib/model-endpoints.ts"));

test("视觉判定：登记处 image 上限优先于名字（0 = 明确否定，>0 = 明确肯定）", () => {
  const zero = { maxTotal: 5, maxByType: { image: 0, video: 0, audio: 0, document: 1 } };
  const two = { maxTotal: 5, maxByType: { image: 2, video: 0, audio: 0, document: 1 } };
  assert.equal(V.modelSupportsVision({ modelId: "doubao-vision", inputConstraints: zero }), false);
  assert.equal(V.modelSupportsVision({ modelId: "plain-text-model", inputConstraints: two }), true);
  assert.equal(V.modelSupportsVision({ modelId: "plain-text-model", inputConstraints: {"maxTotal":5,"maxByType":{image:0, video:0, audio:0, document:1} } }), false);
});

test("视觉判定：没有约束时按 modalities 与模型族名兜底", () => {
  assert.equal(V.modelSupportsVision({ modelId: "whatever", modalities: ["text", "image"] }), true);
  assert.equal(V.modelSupportsVision({ modelId: "doubao-seed-1.6" }), true);
  assert.equal(V.modelSupportsVision({ modelId: "gpt-4o-mini" }), true);
  assert.equal(V.modelSupportsVision({ modelId: "claude-sonnet-4" }), true);
  assert.equal(V.modelSupportsVision({ modelId: "deepseek-chat" }), false);
  assert.equal(V.modelSupportsVision({ modelId: "" }), false);
});

test("端点判定：聊天只认 chat/completions 与 messages，图片/视频生成端点被挡", () => {
  assert.equal(E.isChatEndpointKind("https://api.openai.com/v1/chat/completions"), true);
  assert.equal(E.isChatEndpointKind("https://api.anthropic.com/v1/messages"), true);
  assert.equal(E.isChatEndpointKind("https://ark.cn-beijing.volces.com/api/v3/images/generations"), false);
  assert.equal(E.isChatEndpointKind("https://ark.cn-beijing.volces.com/api/v3/videos"), false);
  assert.equal(E.isChatEndpointKind(""), true);
});

test("接线：面板过滤生成端点、用统一视觉判定；网关错误文案不再甩「智能创作」", async () => {
  const panel = await fs.readFile(appPath("components/xiaoluo-brain-panel.tsx"), "utf8");
  assert.match(panel, /isChatEndpointKind\(model\.baseUrl/);
  assert.match(panel, /modelSupportsVision\(\{/);
  assert.ok(!panel.includes("智能创作暂不支持该类型模型连接"));
  const gateway = await fs.readFile(appPath("lib/brain-llm-gateway.ts"), "utf8");
  assert.match(gateway, /这个模型连接不是对话模型/);
});
