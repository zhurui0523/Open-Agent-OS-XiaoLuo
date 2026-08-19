// ---------- MCP 客户端（轻量 stdio 版）：连接外部 MCP 服务器，工具以 mcp__<server>__<tool> 暴露给模型 ----------
// 配置文件：工作区根 mcp.json，格式 { "mcpServers": { "<name>": { "command": "...", "args": [...], "env": {...}, "cwd": "..." } } }
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

let workspaceRoot = "";
export function initMcpRuntime(root) { workspaceRoot = root; }

const PROTOCOL_VERSION = "2024-11-05";
const CALL_TIMEOUT_MS = 60_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;

function sanitizeName(s) {
  return String(s ?? "").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 32).replace(/^_+|_+$/g, "");
}

class McpConn {
  constructor(name, cfg) {
    this.name = name;
    this.cfg = cfg;
    this.proc = null;
    this.buf = "";
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.tools = [];
    this.error = "";
  }
  start() {
    return new Promise((resolve) => {
      try {
        this.proc = spawn(this.cfg.command, this.cfg.args ?? [], {
          cwd: this.cfg.cwd || workspaceRoot || undefined,
          env: { ...process.env, ...(this.cfg.env ?? {}) },
          stdio: ["pipe", "pipe", "pipe"],
          shell: process.platform === "win32", // Windows 上 npx/uvx 是 .cmd，需要 shell 解析
          windowsHide: true,
        });
      } catch (err) {
        this.error = "启动失败：" + (err && err.message ? err.message : String(err));
        resolve();
        return;
      }
      let stderrTail = "";
      this.proc.stderr.on("data", (d) => { stderrTail = (stderrTail + d.toString("utf8")).slice(-2000); });
      this.proc.stdout.on("data", (d) => this.onData(d));
      this.proc.on("error", (err) => {
        this.error = "启动失败：" + (err && err.message ? err.message : String(err));
        this.failAll(new Error(this.error));
        resolve();
      });
      this.proc.on("exit", (code) => {
        this.failAll(new Error("MCP 服务器进程已退出（code=" + code + "）" + (stderrTail ? "：" + stderrTail.slice(-300) : "")));
      });
      this.handshake().then((err) => {
        if (err) this.error = err.message + (stderrTail ? "\n服务器 stderr：" + stderrTail.slice(-300) : "");
        resolve();
      });
    });
  }
  async handshake() {
    try {
      await this.rpc("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "xiaoluo-brain", version: "1.0.0" },
      }, HANDSHAKE_TIMEOUT_MS);
      this.notify("notifications/initialized", {});
      const res = await this.rpc("tools/list", {}, HANDSHAKE_TIMEOUT_MS);
      this.tools = Array.isArray(res && res.tools) ? res.tools : [];
      return null;
    } catch (err) {
      this.stop();
      return err instanceof Error ? err : new Error(String(err));
    }
  }
  onData(chunk) {
    this.buf += chunk.toString("utf8");
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // 非 JSON 行（服务器日志）忽略
      if (msg && typeof msg.id !== "undefined" && this.pending.has(msg.id)) {
        const slot = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(slot.timer);
        if (msg.error) slot.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else slot.resolve(msg.result);
      }
    }
  }
  rpc(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.proc || !this.proc.stdin.writable) { reject(new Error("MCP 服务器未连接：" + this.name)); return; }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("MCP 请求超时（" + method + "，" + timeoutMs + "ms）"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  notify(method, params) {
    if (this.proc && this.proc.stdin.writable) {
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    }
  }
  failAll(err) {
    for (const slot of this.pending.values()) { clearTimeout(slot.timer); slot.reject(err); }
    this.pending.clear();
  }
  stop() {
    this.failAll(new Error("MCP 服务器已停止"));
    if (this.proc) { try { this.proc.kill(); } catch { /* 忽略 */ } this.proc = null; }
  }
  alive() { return Boolean(this.proc) && this.pending !== null && !this.error; }
}

const conns = new Map(); // name -> McpConn

function loadConfig() {
  let servers = {};
  try {
    const raw = readFileSync(join(workspaceRoot, "mcp.json"), "utf8");
    const data = JSON.parse(raw.replace(/^\uFEFF/, ""));
    servers = data && typeof data.mcpServers === "object" ? data.mcpServers : {};
  } catch { /* 文件不存在/坏格式按空配置起步 */ }
  // 插件包合并（学 kimi-code kimi.plugin.json）：plugins/<插件>/plugin.json 声明的 mcp.mcpServers 一并纳入
  try {
    for (const name of readdirSync(workspaceRoot)) {
      try {
        const manifest = JSON.parse(readFileSync(join(workspaceRoot, "plugins", name, "plugin.json"), "utf8").replace(/^\uFEFF/, ""));
        const mcp = manifest && typeof manifest.mcp === "object" ? manifest.mcp : null;
        if (mcp && typeof mcp.mcpServers === "object") Object.assign(servers, mcp.mcpServers);
      } catch { /* 坏/无 plugin.json 跳过 */ }
    }
  } catch { /* plugins 目录不存在跳过 */ }
  return servers;
}

function renderMcpContent(result) {
  const parts = [];
  for (const block of (result && Array.isArray(result.content)) ? result.content : []) {
    if (block && block.type === "text") parts.push(String(block.text ?? ""));
    else if (block && block.type === "resource_link") parts.push("[资源] " + (block.name ?? "") + " " + (block.uri ?? ""));
    else if (block && block.type === "image") parts.push("[图片块：轻量版不渲染为文本]");
    else parts.push("[" + ((block && block.type) || "未知") + " 块]");
  }
  return parts.join("\n") || "(空结果)";
}

/** brain:mcp IPC 入口：action = servers（按 mcp.json 增量同步）| call（调用工具） */
export async function handleMcpPayload(payload) {
  try {
    const action = String((payload && payload.action) || "");
    if (action === "servers") {
      const cfg = loadConfig();
      const want = new Set(Object.keys(cfg));
      for (const name of [...conns.keys()]) {
        if (!want.has(name)) { conns.get(name).stop(); conns.delete(name); }
      }
      const out = [];
      for (const [name, serverCfg] of Object.entries(cfg)) {
        let conn = conns.get(name);
        if (!conn || !conn.alive()) {
          if (conn) conn.stop();
          conn = new McpConn(name, serverCfg);
          conns.set(name, conn);
          await conn.start();
        }
        out.push({
          name,
          ok: !conn.error,
          error: conn.error || undefined,
          tools: conn.tools.map((t) => ({
            rawName: String(t.name ?? ""),
            description: String(t.description ?? ""),
            inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} },
          })),
        });
      }
      return { servers: out };
    }
    if (action === "call") {
      const server = String(payload.server ?? "");
      const tool = String(payload.tool ?? "");
      const conn = conns.get(server);
      if (!conn) return { error: "MCP 服务器未连接：" + server + "（先同步 servers）" };
      const result = await conn.rpc("tools/call", { name: tool, arguments: payload.arguments ?? {} }, CALL_TIMEOUT_MS);
      const text = renderMcpContent(result);
      if (result && result.isError) return { ok: false, text: "MCP 工具返回错误：" + text };
      return { ok: true, text };
    }
    return { error: "未知 action：" + action };
  } catch (err) {
    return { error: "MCP 调用失败：" + (err instanceof Error ? err.message : String(err)) };
  }
}

export function shutdownMcp() {
  for (const conn of conns.values()) conn.stop();
  conns.clear();
}
