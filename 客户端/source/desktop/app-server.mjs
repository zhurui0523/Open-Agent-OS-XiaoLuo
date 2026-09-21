/**
 * 小逻 App Server（P2-1，参考 Codex app-server 的最小协议面）。
 * JSON-RPC 2.0 over stdio（每行一条报文）；Thread / Turn / Item 三原语：
 *   initialize     握手
 *   thread/start   建会话（持久化 .app-server/threads/<id>.json）
 *   thread/list    列会话
 *   turn/start     跑一轮：mode=command 直执行；mode=chat 走 LLM 工具循环
 *   turn/interrupt 中断在跑轮次
 *   command/exec   无 LLM 直接执行面（供 CLI/CI 驱动与协议自测）
 * 执行面复用 local-runtime（风险分级 + 路径围栏 + 受限沙箱档）。
 * LLM 经环境变量配置：XIAOLUO_LLM_URL / XIAOLUO_LLM_KEY / XIAOLUO_LLM_MODEL；未配置时 chat 模式报 llm_not_configured。
 */
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DESKTOP_DIR = import.meta.dirname;
const RT = await import(pathToFileURL(join(DESKTOP_DIR, "local-runtime.mjs")).href);
RT.initLocalRuntime(process.env.XIAOLUO_DATA_DIR || join(process.env.APPDATA || ".", "xiaoluo-appserver"));

const PROTOCOL = "xiaoluo-app-server/0.1";
const THREAD_DIR = join(process.env.XIAOLUO_DATA_DIR || join(process.env.APPDATA || ".", "xiaoluo-appserver"), ".app-server", "threads");
const aborts = new Map();

function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function fail(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }
function notify(method, params) { send({ jsonrpc: "2.0", method, params }); }
function logErr(msg) { try { process.stderr.write(String(msg) + "\n"); } catch { /* 忽略 */ } }
function uid(p) { return p + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

// ---------- Thread 持久化 ----------
function loadThread(id) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null;
  try { return JSON.parse(readFileSync(join(THREAD_DIR, id + ".json"), "utf8")); } catch { return null; }
}
function saveThread(t) {
  mkdirSync(THREAD_DIR, { recursive: true });
  writeFileSync(join(THREAD_DIR, t.id + ".json"), JSON.stringify(t, null, 1), "utf8");
}
function listThreads() {
  try {
    return readdirSync(THREAD_DIR).filter((n) => n.endsWith(".json")).map((n) => {
      try { const t = JSON.parse(readFileSync(join(THREAD_DIR, n), "utf8")); return { id: t.id, title: t.title || "", updatedAt: t.updatedAt || 0, turns: (t.items || []).filter((i) => i.type === "turn").length }; } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
  } catch { return []; }
}

// ---------- 工具面（chat 模式） ----------
const SYSTEM_PROMPT = "你是小逻Agent OS（Xiaoluo）的无头执行代理，由 App Server 协议驱动。你只能通过给定工具操作本地工作区：run_command 执行命令、read_file / write_file / list_dir 操作文件。工作区之外一律不碰；拿不准就先 list_dir / read_file 看清楚再动手；完成后用简短文本总结。";
const CHAT_TOOLS = [
  { type: "function", function: { name: "run_command", description: "在工作区执行命令（风险分级自动把关，危险命令会被拒）", parameters: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "read_file", description: "读工作区文件（按行窗口）", parameters: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "写工作区文件", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "list_dir", description: "列工作区目录", parameters: { type: "object", properties: { path: { type: "string" } } } } },
];

async function dispatchTool(name, args) {
  if (name === "run_command") return await RT.handleCommandPayload({ command: args.command, cwd: args.cwd, approved: false });
  if (name === "read_file") return await RT.handleFsPayload({ action: "read", path: args.path, opts: { offset: args.offset, limit: args.limit } });
  if (name === "write_file") return await RT.handleFsPayload({ action: "write", path: args.path, content: args.content });
  if (name === "list_dir") return await RT.handleFsPayload({ action: "list", path: args.path || "." });
  return { error: "未知工具：" + name };
}

async function callLLM(messages, tools, signal) {
  const url = process.env.XIAOLUO_LLM_URL || "";
  const model = process.env.XIAOLUO_LLM_MODEL || "";
  if (!url || !model) return { error: "llm_not_configured" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...(process.env.XIAOLUO_LLM_KEY ? { authorization: "Bearer " + process.env.XIAOLUO_LLM_KEY } : {}) },
      body: JSON.stringify({ model, messages, tools, stream: false }),
      signal,
    });
    if (!res.ok) return { error: "llm_http_" + res.status };
    const j = await res.json();
    const msg = j?.choices?.[0]?.message;
    if (!msg) return { error: "llm_bad_response" };
    return { msg };
  } catch (e) {
    return { error: "llm_fetch_failed: " + (e instanceof Error ? e.message : String(e)) };
  }
}

/** chat 轮：LLM 工具循环（至多 15 步、整轮 5 分钟墙钟）；每步产出 item 事件，返回 { items, text, status } */
async function runChatLoop(thread, prompt, msgs, turnId, signal) {
  const items = [];
  const t0 = Date.now();
  const push = (item) => { items.push(item); notify("item/created", { threadId: thread.id, turnId, item }); };
  for (let step = 0; step < 15; step++) {
    if (signal.aborted) return { items, text: "", status: "interrupted" };
    if (Date.now() - t0 > 300_000) return { items, text: "", status: "timeout" };
    const r = await callLLM(msgs, CHAT_TOOLS, signal);
    if (r.error) { push({ id: uid("item"), type: "error", text: r.error, createdAt: Date.now() }); return { items, text: "", status: "failed" }; }
    const msg = r.msg;
    msgs.push(msg);
    const tc = Array.isArray(msg.tool_calls) ? msg.tool_calls[0] : null;
    if (!tc) {
      const text = String(msg.content || "");
      push({ id: uid("item"), type: "message", role: "assistant", text, createdAt: Date.now() });
      return { items, text, status: "completed" };
    }
    const fnName = tc.function?.name || "";
    let fnArgs = {};
    try { fnArgs = JSON.parse(tc.function?.arguments || "{}"); } catch { fnArgs = {}; }
    const itemId = uid("item");
    push({ id: itemId, type: "tool_call", name: fnName, args: fnArgs, createdAt: Date.now() });
    const result = await dispatchTool(fnName, fnArgs);
    const resultStr = JSON.stringify(result).slice(0, 20_000);
    msgs.push({ role: "tool", tool_call_id: tc.id || "", content: resultStr });
    push({ id: itemId + "-result", type: "tool_result", callId: itemId, ok: !result?.error, text: resultStr, createdAt: Date.now() });
  }
  return { items, text: "", status: "step_limit" };
}

// ---------- 请求分发 ----------
async function handleRequest(msg) {
  const id = msg.id === undefined ? null : msg.id;
  const method = String(msg.method || "");
  const params = msg.params || {};
  try {
    if (method === "initialize") {
      reply(id, { protocol: PROTOCOL, server: "xiaoluo-app-server", capabilities: ["thread/start", "thread/list", "turn/start", "turn/interrupt", "command/exec"], llm: Boolean(process.env.XIAOLUO_LLM_URL && process.env.XIAOLUO_LLM_MODEL) });
      return;
    }
    if (method === "thread/start") {
      const t = { id: uid("thread"), title: String(params.title || "").slice(0, 200), createdAt: Date.now(), updatedAt: Date.now(), items: [], messages: [{ role: "system", content: SYSTEM_PROMPT }] };
      saveThread(t);
      reply(id, { threadId: t.id });
      return;
    }
    if (method === "thread/list") { reply(id, { threads: listThreads() }); return; }
    if (method === "turn/start") {
      const t = loadThread(String(params.threadId || ""));
      if (!t) { fail(id, -32004, "thread_not_found"); return; }
      const mode = params.mode === "command" ? "command" : "chat";
      const prompt = String(params.prompt || "");
      const turnId = uid("turn");
      const ac = new AbortController();
      aborts.set(turnId, ac);
      t.items.push({ id: turnId, type: "turn", mode, prompt, createdAt: Date.now() });
      notify("item/created", { threadId: t.id, turnId, item: { id: turnId, type: "turn", mode, prompt, createdAt: Date.now() } });
      let status = "completed";
      try {
        if (mode === "command") {
          if (!prompt) { fail(id, -32602, "prompt(command) required"); aborts.delete(turnId); return; }
          const res = await RT.handleCommandPayload({ command: prompt, cwd: params.cwd, approved: params.approved === true, timeoutMs: params.timeoutMs });
          const item = { id: uid("item"), type: "command_result", ok: Boolean(!res.error && (res.exitCode === 0 || res.exitCode === undefined)), result: res, createdAt: Date.now() };
          t.items.push(item);
          notify("item/created", { threadId: t.id, turnId, item });
          if (res.error) status = "failed";
        } else {
          if (!process.env.XIAOLUO_LLM_URL || !process.env.XIAOLUO_LLM_MODEL) { fail(id, -32010, "llm_not_configured"); aborts.delete(turnId); return; }
          t.messages.push({ role: "user", content: prompt });
          const r = await runChatLoop(t, prompt, t.messages, turnId, ac.signal);
          for (const it of r.items) t.items.push(it);
          status = r.status;
        }
      } catch (e) {
        status = "failed";
        t.items.push({ id: uid("item"), type: "error", text: String(e instanceof Error ? e.message : e), createdAt: Date.now() });
      }
      aborts.delete(turnId);
      t.updatedAt = Date.now();
      saveThread(t);
      notify("turn/complete", { threadId: t.id, turnId, status });
      reply(id, { turnId, status });
      return;
    }
    if (method === "turn/interrupt") {
      const ac = aborts.get(String(params.turnId || ""));
      if (ac) ac.abort();
      reply(id, { ok: Boolean(ac) });
      return;
    }
    if (method === "command/exec") {
      const command = String(params.command || "").trim();
      if (!command) { fail(id, -32602, "command required"); return; }
      const res = await RT.handleCommandPayload({ command, cwd: params.cwd, approved: params.approved === true, timeoutMs: params.timeoutMs });
      reply(id, res);
      return;
    }
    if (id !== null) fail(id, -32601, "method_not_found: " + method);
  } catch (e) {
    if (id !== null) fail(id, -32603, String(e instanceof Error ? e.message : e));
  }
}

// ---------- stdio 主循环 ----------
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { logErr("[app-server] bad json line"); return; }
  Promise.resolve(handleRequest(msg)).catch((e) => logErr("[app-server] " + String(e)));
});
rl.on("close", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
logErr("[app-server] ready " + PROTOCOL);
