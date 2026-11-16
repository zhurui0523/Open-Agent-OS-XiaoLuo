// MCP OAuth 真实第三方端到端（Linear MCP）—— 只读探针，不进构建
//   node scripts/mcp-oauth-live.mjs
// 会起 loopback 回调、打印授权地址（同时写到 <tmp>/mcp-oauth-live-url.txt），
// 用户在浏览器里登录授权后，脚本完成换 token → 刷新 token → 带 token 调 MCP tools/list。
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initMcpOAuth,
  beginLogin,
  ensureToken,
  refreshToken,
  readTokens,
} from "../../../客户端/source/desktop/mcp-oauth.mjs";

const SERVER = "linear";
const CFG = { url: "https://mcp.linear.app/mcp" };
const STATE_DIR = join(tmpdir(), "xiaoluo-mcp-oauth-live");
mkdirSync(STATE_DIR, { recursive: true });
initMcpOAuth(STATE_DIR);

function mask(v) {
  if (!v) return "(空)";
  const s = String(v);
  return s.length <= 10 ? s : `${s.slice(0, 6)}…(${s.length} 字符)`;
}

/** 非 JSON 响应保留原文，供人工看 */
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** MCP streamable HTTP：先 initialize 拿 session，再 tools/list */
async function mcpCall(token, body, sessionId) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${token}`,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(CFG.url, { method: "POST", headers, body: JSON.stringify(body) });
  const sid = res.headers.get("mcp-session-id") || sessionId;
  const text = await res.text();
  // 可能是 SSE 流，取最后一条 data:
  const dataLines = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
  const payload = dataLines.length ? dataLines[dataLines.length - 1] : text;
  return { status: res.status, sid, json: safeJson(payload), raw: text.slice(0, 300) };
}

async function main() {
  const login = await beginLogin(SERVER, CFG, { timeoutMs: 15 * 60 * 1000 });
  const urlFile = join(STATE_DIR, "url.txt");
  writeFileSync(urlFile, login.url, "utf8");
  console.log("AUTHORIZE_URL=" + login.url);
  console.log("（授权地址已写入 " + urlFile + "）");

  await login.done;
  console.log("① 授权完成，token 已落盘");

  const t0 = await ensureToken(SERVER, CFG);
  console.log("② ensureToken：" + (t0.ok ? "有 token " + mask(t0.token) : "needsAuth"));

  const tokens = await readTokens(SERVER);
  console.log("③ 落盘字段：" + Object.keys(tokens || {}).join(","));

  const init = await mcpCall(tokens.access_token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "xiaoluo-live-probe", version: "0.0.1" } },
  });
  console.log("④ initialize：" + init.status + "，session=" + (init.sid ? init.sid.slice(0, 8) + "…" : "无"));
  if (init.status !== 200) console.log("   响应片段：" + init.raw);

  const list = await mcpCall(
    tokens.access_token,
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    init.sid,
  );
  const tools = list.json?.result?.tools ?? [];
  console.log("⑤ tools/list：" + list.status + "，工具数 " + tools.length);
  if (tools.length) console.log("   前几个：" + tools.slice(0, 6).map((t) => t.name).join("、"));
  if (!tools.length) console.log("   响应片段：" + list.raw);

  const fresh = await refreshToken({
    tokenEndpoint: tokens.token_endpoint || "https://mcp.linear.app/token",
    refreshTokenValue: tokens.refresh_token,
    clientId: tokens.client_id || "",
  }).catch((e) => ({ error: e.message }));
  console.log("⑥ 刷新 token：" + (fresh.access_token ? "成功，" + mask(fresh.access_token) : "失败：" + fresh.error));

  if (fresh.access_token) {
    const after = await mcpCall(
      fresh.access_token,
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
      init.sid,
    );
    console.log("⑦ 用刷新后的 token 再调 tools/list：" + after.status + "，工具数 " + ((after.json?.result?.tools ?? []).length));
  }
}

main().catch((e) => {
  console.error("探针失败：" + (e instanceof Error ? e.message : String(e)));
  process.exitCode = 1;
});
