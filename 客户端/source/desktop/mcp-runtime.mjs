// ---------- MCP 客户端（轻量 stdio 版）：连接外部 MCP 服务器，工具以 mcp__<server>__<tool> 暴露给模型 ----------
// 配置文件：工作区根 mcp.json，格式 { "mcpServers": { "<name>": { "command": "...", "args": [...], "env": {...}, "cwd": "..." } } }
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as OAUTH from "./mcp-oauth.mjs";

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

const conns = new Map(); // name -> McpConn | HttpMcpConn

/** 按配置判断传输：有 url 且没 command → streamable HTTP；否则走既有 stdio */
function isHttpServer(cfg) {
  if (!cfg) return false;
  const type = String(cfg.type || cfg.transport || "");
  if (type === "http" || type === "streamable-http" || type === "streamableHttp") return true;
  return Boolean(cfg.url) && !cfg.command;
}

/**
 * 解析 Streamable HTTP 响应体：可能是单个 JSON，也可能是 SSE（data: {...} 多行）。
 * 返回消息数组，调用方按 id 取自己那条。
 */
export function parseMcpHttpBody(contentType, bodyText) {
  const text = String(bodyText || "");
  if (!text.trim()) return [];
  if (String(contentType || "").includes("text/event-stream")) {
    const out = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try { out.push(JSON.parse(payload)); } catch { /* 心跳/坏行跳过 */ }
    }
    return out;
  }
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/** MCP streamable HTTP 连接（带 OAuth 凭据：先用缓存/刷新，401 再换一次） */
class HttpMcpConn {
  constructor(name, cfg) {
    this.name = name;
    this.cfg = cfg;
    this.sessionId = "";
    this.nextId = 1;
    this.tools = [];
    this.error = "";
    this.token = "";
    this.oauthCfg = null;
    this.lastWwwAuth = "";
  }
  /** 配置补全：显式 oauth 直接用；只给了 url 就走自动发现 + 动态注册；401 给了 resource_metadata 时用它重试 */
  async resolvedOauth(resourceMetadataUrl) {
    if (this.oauthCfg) return this.oauthCfg;
    const hasExplicit = Boolean(this.cfg.oauth && (this.cfg.oauth.tokenEndpoint || this.cfg.oauth.token_endpoint));
    if (!hasExplicit && !this.cfg.url) return null;
    try {
      this.oauthCfg = await OAUTH.resolveOAuthConfig(this.name, this.cfg, { resourceMetadataUrl });
      this.error = "";
      return this.oauthCfg;
    } catch (error) {
      this.error =
        "MCP OAuth 配置补全失败（" +
        (error instanceof Error ? error.message : String(error)) +
        "）：可在 mcp.json 里显式写 oauth.authorizationEndpoint / tokenEndpoint / clientId 绕过自动发现";
      return null;
    }
  }
  /** 从 401 的 WWW-Authenticate 里捞出 resource_metadata 和 scope */
  wwwAuthHints() {
    if (!this.lastWwwAuth) return {};
    const parsed = OAUTH.parseWwwAuthenticate(this.lastWwwAuth);
    const resourceMetadataUrl = parsed.params.resource_metadata || parsed.params.resourceMetadataUri || "";
    const scope = parsed.params.scope || "";
    return { resourceMetadataUrl, scope, ...parsed.params };
  }
  async auth(retried = false) {
    const hints = retried ? this.wwwAuthHints() : {};
    let resolved = await this.resolvedOauth(hints.resourceMetadataUrl);
    if (!resolved && hints.resourceMetadataUrl) {
      // 先发现失败、401 才给出元数据：清掉缓存再按 hints 试一次
      this.oauthCfg = null;
      resolved = await this.resolvedOauth(hints.resourceMetadataUrl);
    }
    if (!resolved) return { ok: this.error ? false : true, token: "" };
    const cfg = {
      ...this.cfg,
      oauth: { ...resolved, ...(hints.scope && !resolved.scope ? { scope: hints.scope } : {}) },
    };
    const result = retried ? await OAUTH.refreshRejected(this.name, cfg) : await OAUTH.ensureToken(this.name, cfg);
    if (!result.ok) {
      this.error =
        "MCP 服务器需要 OAuth 授权（" +
        (result.error ? result.error : "没有可用凭据") +
        "）：调用 oauth/login 完成一次授权即可";
      return { ok: false };
    }
    this.token = result.token || "";
    return { ok: true, token: this.token };
  }
  headers() {
    const h = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
    };
    if (this.token) h.authorization = "Bearer " + this.token;
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    const extra = this.cfg.headers && typeof this.cfg.headers === "object" ? this.cfg.headers : null;
    if (extra) Object.assign(h, extra);
    return h;
  }
  async post(message) {
    const res = await fetch(this.cfg.url, { method: "POST", headers: this.headers(), body: JSON.stringify(message) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    const wwwAuth = res.headers.get("www-authenticate");
    if (wwwAuth) this.lastWwwAuth = wwwAuth;
    if (res.status === 401) return { unauthorized: true, status: res.status, wwwAuth: wwwAuth || "" };
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error("MCP HTTP " + res.status + (body ? "：" + body.slice(0, 200) : ""));
    }
    const body = await res.text().catch(() => "");
    return { messages: parseMcpHttpBody(res.headers.get("content-type"), body) };
  }
  async rpc(method, params, timeoutMs) {
    if (!this.cfg.url) throw new Error("MCP 服务器缺少 url");
    const id = this.nextId++;
    const run = async (retried) => {
      const auth = await this.auth(retried);
      if (!auth.ok) throw new Error(this.error || "MCP 授权失败");
      const r = await this.post({ jsonrpc: "2.0", id, method, params });
      if (r.unauthorized) {
        if (retried) throw new Error("MCP 授权被拒（401），需要重新授权");
        return { retry: true };
      }
      const found = (r.messages || []).find((m) => m && m.id === id);
      if (!found) throw new Error("MCP 响应里没有对应 id 的结果（" + method + "）");
      if (found.error) throw new Error(found.error.message || JSON.stringify(found.error));
      return { result: found.result };
    };
    const withTimeout = (promise, ms) =>
      Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error("MCP 请求超时（" + method + "，" + ms + "ms）")), ms)),
      ]);
    const first = await withTimeout(run(false), timeoutMs);
    if (first.retry) return (await withTimeout(run(true), timeoutMs)).result;
    return first.result;
  }
  async notify(method, params) {
    try {
      await this.post({ jsonrpc: "2.0", method, params });
    } catch { /* 通知失败不影响主流程 */ }
  }
  async start() {
    try {
      await this.rpc("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "xiaoluo-brain", version: "1.0.0" },
      }, HANDSHAKE_TIMEOUT_MS);
      await this.notify("notifications/initialized", {});
      const res = await this.rpc("tools/list", {}, HANDSHAKE_TIMEOUT_MS);
      this.tools = Array.isArray(res && res.tools) ? res.tools : [];
      this.error = "";
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    }
  }
  alive() { return !this.error; }
  stop() { this.sessionId = ""; }
}

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
        const http = isHttpServer(serverCfg);
        const kindOk = conn && (http ? conn instanceof HttpMcpConn : conn instanceof McpConn);
        if (!conn || !kindOk || !conn.alive()) {
          if (conn) conn.stop();
          conn = http ? new HttpMcpConn(name, serverCfg) : new McpConn(name, serverCfg);
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
    if (action === "oauth/status") {
      const cfg = loadConfig();
      const out = [];
      for (const [name, serverCfg] of Object.entries(cfg)) {
        if (!isHttpServer(serverCfg)) continue;
        const tokens = await OAUTH.readTokens(name);
        out.push({
          name,
          hasCredentials: Boolean(tokens && tokens.access_token),
          expiresAt: (tokens && tokens.expires_at) || null,
          needsRefresh: OAUTH.needsRefresh(tokens),
        });
      }
      return { servers: out };
    }
    if (action === "oauth/login") {
      const cfg = loadConfig();
      const server = String(payload.server ?? "");
      const serverCfg = cfg[server];
      if (!serverCfg) return { error: "没有这个 MCP 服务器：" + server };
      if (!isHttpServer(serverCfg)) return { error: "只有 HTTP 类型的 MCP 服务器需要授权：" + server };
      const session = await OAUTH.beginLogin(server, serverCfg);
      // 交给宿主打开浏览器；授权完成后连接会在下次 servers 同步时带着新 token 重建
      try { if (payload.openUrl !== false && typeof payload.opener === "function") await payload.opener(session.url); } catch { /* 打不开也不影响回调监听 */ }
      session.done.catch(() => { /* 失败由下面的 await 接住 */ });
      try {
        await session.done;
        return { ok: true, url: session.url };
      } catch (err) {
        return { ok: false, url: session.url, error: err instanceof Error ? err.message : String(err) };
      }
    }
    if (action === "oauth/logout") {
      const server = String(payload.server ?? "");
      if (!server) return { error: "需要指定 server" };
      await OAUTH.clearTokens(server);
      const conn = conns.get(server);
      if (conn) { conn.stop(); conns.delete(server); }
      return { ok: true };
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
