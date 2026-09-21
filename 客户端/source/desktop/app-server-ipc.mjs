/**
 * App Server IPC：托管 app-server.mjs 常驻子进程（JSON-RPC over stdio，懒启动）。
 * 主进程首次调用时拉起守护进程；按行分帧，id 匹配请求/响应，method 报文作为事件转发给渲染进程。
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

let userDataDir = "";
let desktopDir = "";
let onEvent = () => {};
let child = null;
let buffer = "";
let seq = 0;
const pending = new Map();

export function initAppServerIpc(dir, deskDir, eventSink) {
  userDataDir = dir;
  desktopDir = deskDir;
  onEvent = eventSink || (() => {});
}

function rejectAll(message) {
  for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(message)); }
  pending.clear();
}

function ensureDaemon() {
  if (child && child.exitCode === null) return child;
  buffer = "";
  child = spawn(process.execPath, [join(desktopDir, "app-server.mjs")], {
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1", XIAOLUO_DATA_DIR: userDataDir }),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(Object.assign(new Error(String(msg.error.message || "rpc_error")), { code: msg.error.code }));
        else p.resolve(msg.result);
      } else if (msg.method) {
        try { onEvent(msg); } catch { /* 忽略 */ }
      }
    }
  });
  child.stderr.on("data", (chunk) => { try { process.stderr.write(chunk); } catch { /* 忽略 */ } });
  child.on("exit", () => { child = null; rejectAll("app-server exited"); });
  child.on("error", (e) => { child = null; rejectAll("app-server spawn failed: " + (e instanceof Error ? e.message : String(e))); });
  return child;
}

/** renderer 侧调用面：{ method, params, timeoutMs } -> result 或 { error } */
export async function handleAppServerPayload(payload) {
  const method = String((payload && payload.method) || "");
  if (!method) return { error: "method required" };
  const id = ++seq;
  const daemon = ensureDaemon();
  const timeoutMs = Math.min(Math.max(Number(payload.timeoutMs) || 600_000, 5_000), 600_000);
  return await new Promise((resolveP) => {
    const timer = setTimeout(() => { pending.delete(id); resolveP({ error: "app-server timeout" }); }, timeoutMs);
    pending.set(id, { resolve: resolveP, reject: (e) => resolveP({ error: e instanceof Error ? e.message : String(e) }), timer });
    const line = JSON.stringify({ jsonrpc: "2.0", id, method, params: (payload && payload.params) || {} }) + "\n";
    daemon.stdin.write(line, (err) => {
      if (err) { clearTimeout(timer); pending.delete(id); resolveP({ error: "app-server stdin write failed: " + err.message }); }
    });
  });
}

export function shutdownAppServer() {
  rejectAll("app-server shutting down");
  if (child) { try { child.stdin.end(); child.kill(); } catch { /* 忽略 */ } child = null; }
}
