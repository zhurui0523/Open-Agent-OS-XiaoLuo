/**
 * 第 7.4 项：MCP elicitation / resources / 连接池（学 Codex `codex-mcp`）
 *
 * 原来只有 tools/list + tools/call + OAuth。这里补三件事：
 *  1. 服务器反向请求（elicitation/create）——客户端必须能应答，否则服务器只能超时失败；
 *  2. resources/list + resources/read（含模板容错）；
 *  3. 连接空闲回收（10 分钟 TTL），别让 MCP 子进程常驻。
 *
 * 验收用假 stdio 服务器真跑协议；真实企业 MCP 服务器仍需一次真机接入。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const RT = await import("../../../客户端/source/desktop/mcp-runtime.mjs");

const TMP = mkdtempSync(join(tmpdir(), "xiaoluo-mcp-elicitation-"));
test.after(async () => {
  RT.shutdownMcp();
  // Windows 上子进程退出后句柄可能还挂在 cwd 上：等一拍再删，删不掉也不判失败（临时目录交给系统清）
  await new Promise((resolve) => setTimeout(resolve, 800));
  try {
    rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败不影响测试结论 */
  }
});

const FAKE_SERVER = `
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
let pendingElicit = null;

rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  // elicitation 的应答：回包给正在等的 tools/call
  if (pendingElicit && msg.id === pendingElicit.id) {
    const action = msg.result && msg.result.action;
    const qty = msg.result && msg.result.content ? msg.result.content.quantity : "none";
    pendingElicit.resolve({ content: [{ type: "text", text: "action=" + action + " qty=" + qty }] });
    pendingElicit = null;
    return;
  }
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {}, resources: { listChanged: false } },
      serverInfo: { name: "fake-corp", version: "1.0.0" },
    } });
    return;
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "confirm_purchase", description: "下单前确认", inputSchema: { type: "object", properties: {} } },
    ] } });
    return;
  }
  if (msg.method === "resources/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { resources: [
      { uri: "file:///handbook.md", name: "员工手册", description: "内部制度", mimeType: "text/markdown" },
    ] } });
    return;
  }
  if (msg.method === "resources/templates/list") {
    // 故意不支持模板：客户端要容错，不能因此丢掉已列出的资源
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
    return;
  }
  if (msg.method === "resources/read") {
    send({ jsonrpc: "2.0", id: msg.id, result: { contents: [
      { uri: msg.params.uri, mimeType: "text/markdown", text: "# 员工手册\\n\\n第一条：进门先敲门。" },
    ] } });
    return;
  }
  if (msg.method === "tools/call") {
    const id = msg.id;
    const elicitId = 9001;
    pendingElicit = { id: elicitId, resolve: (result) => send({ jsonrpc: "2.0", id, result }) };
    send({ jsonrpc: "2.0", id: elicitId, method: "elicitation/create", params: {
      message: "确认要下单几件？",
      requestedSchema: { type: "object", properties: { quantity: { type: "integer" } }, required: ["quantity"] },
    } });
    return;
  }
  if (typeof msg.id !== "undefined") {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown method " + msg.method } });
  }
});
`;

function setupWorkspace() {
  const servers = join(TMP, "fake-elicitation-server.mjs");
  writeFileSync(servers, FAKE_SERVER, "utf8");
  const ws = join(TMP, "ws");
  mkdirSync(ws, { recursive: true });
  writeFileSync(
    join(ws, "mcp.json"),
    JSON.stringify({ mcpServers: { "corp-tools": { command: process.execPath, args: [servers], cwd: TMP } } }),
    "utf8",
  );
  return ws;
}

test("同步服务器：声明 elicitation 支持、列出资源；模板失败不影响主列表", async () => {
  const ws = setupWorkspace();
  RT.initMcpRuntime(ws);
  const res = await RT.handleMcpPayload({ action: "servers" });
  assert.equal(res.servers.length, 1);
  const server = res.servers[0];
  assert.equal(server.ok, true, server.error);
  assert.equal(server.supportsElicitation, true);
  assert.equal(server.resources.length, 1);
  assert.equal(server.resources[0].uri, "file:///handbook.md");
  assert.match(server.resourceError, /模板列表不可用/, "模板不支持要留痕但不影响资源");
  assert.equal(server.tools[0].rawName, "confirm_purchase");
});

test("elicitation：宿主同意则 accept 并把内容回给服务器，类型不对则 decline", async () => {
  RT.setElicitationHandler(async (ctx) => {
    assert.equal(ctx.server, "corp-tools");
    assert.match(ctx.message, /确认要下单/);
    return { action: "accept", content: { quantity: 2 } };
  });
  const ok = await RT.handleMcpPayload({ action: "call", server: "corp-tools", tool: "confirm_purchase", arguments: {} });
  assert.equal(ok.ok, true, ok.error);
  assert.match(ok.text, /action=accept qty=2/);

  RT.setElicitationHandler(async () => ({ action: "accept", content: { quantity: "2" } }));
  const bad = await RT.handleMcpPayload({ action: "call", server: "corp-tools", tool: "confirm_purchase", arguments: {} });
  assert.match(bad.text, /action=decline qty=none/, "类型不符要拒绝，不能把错数据塞给服务器");
});

test("elicitation：没有交互通道一律 decline（有副作用的确认不能默认放行）", async () => {
  RT.setElicitationHandler(null);
  const res = await RT.handleMcpPayload({ action: "call", server: "corp-tools", tool: "confirm_purchase", arguments: {} });
  assert.match(res.text, /action=decline qty=none/);
});

test("resources：列举跨服务器聚合，按 uri 读回正文", async () => {
  const list = await RT.handleMcpPayload({ action: "resources" });
  assert.equal(list.resources.length, 1);
  assert.equal(list.resources[0].server, "corp-tools");

  const read = await RT.handleMcpPayload({ action: "resource-read", uri: "file:///handbook.md" });
  assert.equal(read.ok, true, read.error);
  assert.match(read.text, /进门先敲门/);

  const missing = await RT.handleMcpPayload({ action: "resource-read", uri: "file:///nope.md" });
  assert.match(missing.error, /没有连接能读取该资源/);
});

test("Schema 校验：必填、integer、enum 三条规则各自能挡住", () => {
  const schema = {
    type: "object",
    properties: { quantity: { type: "integer" }, note: { type: "string" }, mode: { type: "string", enum: ["fast", "safe"] } },
    required: ["quantity"],
  };
  assert.equal(RT.validateElicitContent(schema, { quantity: 1, note: "x", mode: "fast" }).ok, true);
  assert.match(RT.validateElicitContent(schema, {}).errors.join(), /缺少必填字段/);
  assert.match(RT.validateElicitContent(schema, { quantity: 1.5 }).errors.join(), /integer/);
  assert.match(RT.validateElicitContent(schema, { quantity: 1, mode: "turbo" }).errors.join(), /不在允许取值/);
  assert.equal(RT.validateElicitContent(null, {}).ok, true, "没 schema 时不做校验");
});

test("内核工具面：资源口在才注册两件套，并走内置分发（不进 mcp__ 命名空间）", async () => {
  const { buildChatToolSchemas } = await import("../app/xiaoluo-brain/lib/brain/chat-tools.ts");
  const names = (schemas) => schemas.map((s) => String(s?.function?.name ?? ""));
  const on = names(buildChatToolSchemas({ fsEnabled: false, webSearchEnabled: false, mcpResourcesEnabled: true }));
  assert.ok(on.includes("list_mcp_resources"), on.join(","));
  assert.ok(on.includes("read_mcp_resource"), on.join(","));
  const off = names(buildChatToolSchemas({ fsEnabled: false, webSearchEnabled: false }));
  assert.ok(!off.includes("list_mcp_resources"), "宿主没实现资源口就不该冒充能力");

  const { readFile } = await import("node:fs/promises");
  const agent = await readFile(new URL("../app/xiaoluo-brain/lib/brain/chat-agent.ts", import.meta.url), "utf8");
  assert.match(agent, /call\.name === "list_mcp_resources"/);
  assert.match(agent, /call\.name === "read_mcp_resource"/);
  assert.match(agent, /ports\.mcp\.listResources\(\)/);
});
