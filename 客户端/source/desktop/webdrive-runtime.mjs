// ---------- WEB-DRIVE：外部浏览器 DOM 级控制（CDP 接管系统 Edge/Chrome） ----------
// 目标：补齐小逻"独立驱动外部浏览器"的缺口（对齐 DSH dsh-browser / Codex Browser Use）。
// 设计纪律：
//  1) 零第三方依赖——用 Node 22 / Electron 43 内置全局 WebSocket 直接说 CDP，不引 playwright/chromium。
//  2) 登录态复用——持久化 user-data-dir（webdrive-profile），老板登录过一次的站点后续直接带会话。
//  3) 选择器优先——点击/输入以 CSS 选择器定位（DOM 路线，抗布局变化），坐标仅作兜底。
//  4) 安全闸——整条通道受主进程 desktopControlEnabled() 门控（复用"允许小逻控制本机"开关）。
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

let userDataDir = "";
/** 由 main.mjs 在 app ready 后注入 userData 路径 */
export function initWebDriver(dir) {
  userDataDir = String(dir || "");
}

// 系统浏览器候选路径（可用 XIAOLUO_BROWSER 环境变量覆盖）
function candidateBrowserPaths() {
  const list = [
    process.env.XIAOLUO_BROWSER || "",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  const local = process.env.LOCALAPPDATA || "";
  if (local) list.push(join(local, "Google\\Chrome\\Application\\chrome.exe"));
  return list.filter(Boolean);
}

function findBrowser() {
  for (const p of candidateBrowserPaths()) {
    if (p && existsSync(p)) return p;
  }
  return "";
}

function profileDir() {
  return join(userDataDir, "webdrive-profile");
}

let browserProc = null;
let debugPort = 0;
let pageWs = null; // 连到 page target 的 WebSocket
let cdpId = 1;
const pending = new Map(); // id -> { resolve, reject, timer }

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  return await res.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForPort(portFile, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (existsSync(portFile)) {
        const first = readFileSync(portFile, "utf8").split(/\r?\n/)[0].trim();
        const port = Number.parseInt(first, 10);
        if (port > 0) return port;
      }
    } catch {
      /* 文件还没写完，继续等 */
    }
    await sleep(250);
  }
  return 0;
}

function closeWs() {
  if (pageWs) {
    try {
      pageWs.close();
    } catch {
      /* 忽略 */
    }
    pageWs = null;
  }
  for (const slot of pending.values()) {
    clearTimeout(slot.timer);
    slot.reject(new Error("浏览器调试通道已关闭"));
  }
  pending.clear();
}

function connectWs(wsUrl) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocket === "undefined") {
      reject(new Error("当前运行时缺少全局 WebSocket（需 Node 22+/Electron 43+）"));
      return;
    }
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      reject(new Error("WebSocket 构造失败：" + (e && e.message ? e.message : String(e))));
      return;
    }
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* 忽略 */
      }
      reject(new Error("WebSocket 连接超时"));
    }, 12000);
    ws.onopen = () => {
      clearTimeout(timer);
      pageWs = ws;
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("WebSocket 连接错误"));
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
      } catch {
        return;
      }
      if (msg && typeof msg.id !== "undefined" && pending.has(msg.id)) {
        const slot = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(slot.timer);
        if (msg.error) slot.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else slot.resolve(msg.result);
      }
    };
    ws.onclose = () => {
      if (pageWs === ws) closeWs();
    };
  });
}

/** 启动（或复用）系统浏览器并连上调试通道；返回 null 表示就绪，否则返回错误串 */
async function ensureBrowser() {
  if (pageWs && browserProc) return null;
  const exe = findBrowser();
  if (!exe) {
    return "未找到系统浏览器（Edge/Chrome）。可设环境变量 XIAOLUO_BROWSER 指定可执行文件路径。";
  }
  if (!userDataDir) return "WEB-DRIVE 未初始化（缺 userData 路径）";
  const prof = profileDir();
  if (!browserProc) {
    const args = [
      "--remote-debugging-port=0",
      "--user-data-dir=" + prof,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-session-crashed-bubble",
      "--restore-last-session=false",
    ];
    // 无头开关：后台自动化/冒烟测试用（XIAOLUO_WEBDRIVE_HEADLESS=1），默认可见让老板看着它操作
    if (process.env.XIAOLUO_WEBDRIVE_HEADLESS === "1") args.push("--headless=new");
    args.push("about:blank");
    try {
      browserProc = spawn(exe, args, { windowsHide: false });
    } catch (e) {
      return "启动浏览器失败：" + (e && e.message ? e.message : String(e));
    }
    browserProc.on("exit", () => {
      browserProc = null;
      debugPort = 0;
      closeWs();
    });
    const port = await waitForPort(join(prof, "DevToolsActivePort"));
    if (!port) return "浏览器启动后未能读取调试端口（DevToolsActivePort 超时）";
    debugPort = port;
  }
  // 连到一个 page target（优先复用已有页面，否则新开一个）
  try {
    const list = await fetchJson("http://127.0.0.1:" + debugPort + "/json/list");
    let target = Array.isArray(list) ? list.find((t) => t && t.type === "page" && t.webSocketDebuggerUrl) : null;
    if (!target) {
      target = await fetchJson("http://127.0.0.1:" + debugPort + "/json/new?about:blank");
    }
    if (!target || !target.webSocketDebuggerUrl) return "未取得可调试的浏览器标签页";
    await connectWs(target.webSocketDebuggerUrl);
    await cdp("Page.enable");
    await cdp("Runtime.enable");
    return null;
  } catch (e) {
    return "连接浏览器调试通道失败：" + (e && e.message ? e.message : String(e));
  }
}

function cdp(method, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!pageWs) {
      reject(new Error("浏览器未连接"));
      return;
    }
    const id = cdpId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("CDP 请求超时：" + method));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    try {
      pageWs.send(JSON.stringify({ id, method, params }));
    } catch (e) {
      pending.delete(id);
      clearTimeout(timer);
      reject(new Error("CDP 发送失败：" + (e && e.message ? e.message : String(e))));
    }
  });
}

async function evaluate(expression, awaitPromise = false) {
  const res = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
  if (res && res.exceptionDetails) {
    const d = res.exceptionDetails;
    return { error: "页面脚本异常：" + ((d.exception && d.exception.description) || d.text || "未知") };
  }
  return { ok: true, value: res && res.result ? res.result.value : undefined };
}

// DOM 快照：URL/标题/正文摘要/可交互元素（含 CSS 选择器路径 + 中心坐标）
const WEB_DOM_JS =
  "(() => {" +
  " const cssPath = (el) => {" +
  "   if (el.id) return '#' + CSS.escape(el.id);" +
  "   const parts = [];" +
  "   let n = el;" +
  "   while (n && n.nodeType === 1 && parts.length < 6) {" +
  "     let sel = n.tagName.toLowerCase();" +
  "     if (n.classList && n.classList.length) sel += '.' + Array.from(n.classList).slice(0,2).map(c=>CSS.escape(c)).join('.');" +
  "     const parent = n.parentElement;" +
  "     if (parent) { const sibs = Array.from(parent.children).filter(c=>c.tagName===n.tagName); if (sibs.length>1) sel += ':nth-of-type(' + (sibs.indexOf(n)+1) + ')'; }" +
  "     parts.unshift(sel); n = n.parentElement;" +
  "   }" +
  "   return parts.join(' > ');" +
  " };" +
  " const out = { url: location.href, title: document.title, text: (document.body && document.body.innerText || '').slice(0, 3000), interactive: [] };" +
  " const els = document.querySelectorAll('a,button,input,select,textarea,[role=button],[onclick]');" +
  " for (const el of Array.from(els).slice(0, 80)) {" +
  "   const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;" +
  "   out.interactive.push({ selector: cssPath(el), tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').slice(0, 60), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) });" +
  " }" +
  " return JSON.stringify(out);" +
  "})()";

// 解析选择器 → 视口中心坐标（CSS 像素，CDP Input 用）；找不到返回 null
function resolveSelectorJs(selector) {
  const sel = JSON.stringify(String(selector));
  return (
    "(() => { const el = document.querySelector(" + sel + ");" +
    " if (!el) return null;" +
    " el.scrollIntoView({ block: 'center', inline: 'center' });" +
    " const r = el.getBoundingClientRect();" +
    " return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2, w: r.width, h: r.height });" +
    " })()"
  );
}

async function mouseAt(x, y, button = "left", clickCount = 1) {
  const btn = button === "right" ? "right" : button === "middle" ? "middle" : "left";
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: btn, clickCount });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: btn, clickCount });
}

// ---------- RECORD & REPLAY：演示录制转技能 ----------
// 录制：给页面注入捕获脚本，把 click/输入/回车/导航 实时经 CDP binding 回流到 Node 侧累积（跨导航不丢）。
// 回放：按录制的 steps 顺序重放（选择器优先定位，坐标兜底），可存成命名技能反复复用。
let recording = false;
let recordedSteps = [];
let lastRecording = null; // 最近一次 stop 的 steps，供 save 落盘
let recBindingListener = null;
let recNewDocId = null;

// 捕获脚本：每个新文档注入一次，装好 cssPath + 事件监听，通过 __xlRecEmit 把步骤送回 Node。
const RECORDER_JS =
  "(() => {" +
  " if (window.__xlRecInstalled) return 'already';" +
  " window.__xlRecInstalled = true;" +
  " const cssPath = (el) => {" +
  "   if (!el || el.nodeType !== 1) return '';" +
  "   if (el.id) return '#' + CSS.escape(el.id);" +
  "   const parts = []; let n = el;" +
  "   while (n && n.nodeType === 1 && parts.length < 6) {" +
  "     let sel = n.tagName.toLowerCase();" +
  "     if (n.classList && n.classList.length) sel += '.' + Array.from(n.classList).slice(0,2).map(c=>CSS.escape(c)).join('.');" +
  "     const parent = n.parentElement;" +
  "     if (parent) { const sibs = Array.from(parent.children).filter(c=>c.tagName===n.tagName); if (sibs.length>1) sel += ':nth-of-type(' + (sibs.indexOf(n)+1) + ')'; }" +
  "     parts.unshift(sel); n = n.parentElement;" +
  "   }" +
  "   return parts.join(' > ');" +
  " };" +
  " const emit = (step) => { try { window.__xlRecEmit(JSON.stringify(step)); } catch (e) {} };" +
  " emit({ type: 'navigate', url: location.href, title: document.title, t: Date.now() });" +
  " document.addEventListener('click', (e) => {" +
  "   const el = e.target; if (!el || el.nodeType !== 1) return;" +
  "   emit({ type: 'click', selector: cssPath(el), text: (el.innerText || el.value || '').slice(0, 40), x: Math.round(e.clientX), y: Math.round(e.clientY), t: Date.now() });" +
  " }, true);" +
  " document.addEventListener('keydown', (e) => {" +
  "   if (e.key !== 'Enter' && e.key !== 'Tab') return;" +
  "   const el = e.target;" +
  "   emit({ type: 'key', key: e.key, selector: (el && el.nodeType === 1) ? cssPath(el) : undefined, t: Date.now() });" +
  " }, true);" +
  " document.addEventListener('change', (e) => {" +
  "   const el = e.target; if (!el || el.nodeType !== 1) return;" +
  "   const tag = el.tagName.toLowerCase();" +
  "   if (tag === 'input' || tag === 'textarea' || tag === 'select')" +
  "     emit({ type: 'type', selector: cssPath(el), value: el.value != null ? String(el.value) : '', t: Date.now() });" +
  " }, true);" +
  " return 'installed';" +
  "})()";

// 技能库目录（userData/brain-skills）
function skillsDir() {
  return join(userDataDir, "brain-skills");
}
function safeName(name) {
  return String(name || "").replace(/[^\w\u4e00-\u9fa5.-]+/g, "_").slice(0, 80);
}
function skillPath(name) {
  return join(skillsDir(), safeName(name) + ".json");
}
function saveSkill(name, steps) {
  const dir = skillsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const rec = { name: safeName(name), steps: Array.isArray(steps) ? steps : [], createdAt: Date.now() };
  writeFileSync(skillPath(name), JSON.stringify(rec, null, 2), "utf8");
  return rec;
}
function loadSkill(name) {
  const f = skillPath(name);
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; }
}
function listSkills() {
  const dir = skillsDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          const rec = JSON.parse(readFileSync(join(dir, f), "utf8"));
          return { name: rec.name || f.replace(/\.json$/, ""), steps: Array.isArray(rec.steps) ? rec.steps.length : 0, createdAt: rec.createdAt || 0 };
        } catch { return { name: f.replace(/\.json$/, ""), steps: 0 }; }
      });
  } catch { return []; }
}
function deleteSkill(name) {
  const f = skillPath(name);
  if (!existsSync(f)) return false;
  try { rmSync(f); return true; } catch { return false; }
}

async function waitLoad(timeoutMs = 20000) {
  await new Promise((resolve) => {
    const onMsg = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m && m.method === "Page.loadEventFired") { pageWs.removeEventListener("message", onMsg); resolve(); }
    };
    pageWs.addEventListener("message", onMsg);
    setTimeout(() => { try { pageWs.removeEventListener("message", onMsg); } catch {} resolve(); }, timeoutMs);
  });
}

const SPECIAL_KEYS = { enter: "Enter", return: "Enter", tab: "Tab", escape: "Escape", esc: "Escape", backspace: "Backspace", delete: "Delete", space: " ", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown" };

// 回放单步（复用现有 evaluate/mouseAt/cdp；失败记进 log 但不中断整条）
async function replayStep(s) {
  const type = String(s && s.type || "");
  try {
    if (type === "navigate") {
      const url = String(s.url || "");
      if (!/^https?:\/\//i.test(url)) return { step: type, ok: false, note: "跳过非法 url" };
      const loaded = waitLoad();
      await cdp("Page.navigate", { url });
      await loaded; await sleep(400);
      return { step: type, ok: true, url };
    }
    if (type === "click") {
      let x = Number(s.x), y = Number(s.y);
      if (s.selector) {
        const r = await evaluate(resolveSelectorJs(s.selector));
        if (!r.error && r.value) { const b = JSON.parse(r.value); x = b.x; y = b.y; }
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { step: type, ok: false, note: "选择器与坐标都缺失" };
      await sleep(120); await mouseAt(x, y, "left", 1);
      return { step: type, ok: true, selector: s.selector || null };
    }
    if (type === "type") {
      const value = String(s.value != null ? s.value : (s.text != null ? s.text : ""));
      if (s.selector) {
        const focus = await evaluate(
          "(() => { const el = document.querySelector(" + JSON.stringify(String(s.selector)) + ");" +
          " if (!el) return 'NO'; el.scrollIntoView({block:'center'}); el.focus();" +
          " if ('value' in el) el.value = ''; return 'OK'; })()",
        );
        if (focus.value === "NO") return { step: type, ok: false, note: "选择器未命中：" + s.selector };
      }
      if (value) await cdp("Input.insertText", { text: value });
      return { step: type, ok: true, selector: s.selector || null };
    }
    if (type === "key") {
      const raw = String(s.key || "").toLowerCase();
      const key = SPECIAL_KEYS[raw] || s.key;
      if (s.selector) await evaluate("(() => { const el = document.querySelector(" + JSON.stringify(String(s.selector)) + "); if (el) el.focus(); return 'OK'; })()");
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", key });
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key });
      return { step: type, ok: true, key: s.key };
    }
    return { step: type || "unknown", ok: false, note: "不支持的步骤类型" };
  } catch (e) {
    return { step: type, ok: false, note: e instanceof Error ? e.message : String(e) };
  }
}

async function replaySteps(steps, stepDelay) {
  const log = [];
  for (const s of steps) {
    const r = await replayStep(s);
    log.push(r);
    await sleep(Number.isFinite(stepDelay) ? stepDelay : 250);
  }
  return log;
}

async function startRecording() {
  if (recording) return { ok: true, note: "已在录制中" };
  recordedSteps = [];
  recording = true;
  await cdp("Runtime.addBinding", { name: "__xlRecEmit" });
  const res = await cdp("Page.addScriptToEvaluateOnNewDocument", { source: RECORDER_JS });
  recNewDocId = res && res.identifier ? res.identifier : null;
  // 先挂监听再注入：RECORDER_JS 会立即 emit 一条 navigate 步骤，监听晚挂会漏掉它。
  recBindingListener = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m && m.method === "Runtime.bindingCalled" && m.params && m.params.name === "__xlRecEmit") {
      try { recordedSteps.push(JSON.parse(m.params.payload)); } catch {}
    }
  };
  pageWs.addEventListener("message", recBindingListener);
  await evaluate(RECORDER_JS); // 当前文档也立即装上
  await sleep(120); // 给首条 navigate 事件一点回流时间
  return { ok: true, note: "开始录制：请在浏览器里操作，完成后调用 web_record op=stop" };
}

async function stopRecording() {
  if (!recording) return { ok: true, steps: lastRecording || [], note: "当前没有进行中的录制" };
  recording = false;
  if (recBindingListener && pageWs) { try { pageWs.removeEventListener("message", recBindingListener); } catch {} }
  recBindingListener = null;
  if (recNewDocId != null) { try { await cdp("Page.removeScriptToEvaluateOnNewDocument", { identifier: recNewDocId }); } catch {} recNewDocId = null; }
  try { await cdp("Runtime.removeBinding", { name: "__xlRecEmit" }); } catch {}
  lastRecording = recordedSteps.slice();
  return { ok: true, steps: lastRecording, count: lastRecording.length };
}

/** brain:webdrive IPC 入口。action: status|navigate|screenshot|dom|text|click|type|scroll|key|eval|close */
export async function handleWebDriverPayload(payload) {
  const p = payload || {};
  const action = String(p.action || "");
  try {
    if (action === "status") {
      return { ok: true, connected: Boolean(pageWs && browserProc), browser: findBrowser() || null, port: debugPort };
    }
    if (action === "close") {
      shutdownWebDriver();
      return { ok: true };
    }
    const err = await ensureBrowser();
    if (err) return { error: err };

    if (action === "navigate") {
      const url = String(p.url || "");
      if (!/^https?:\/\//i.test(url)) return { error: "url 必须以 http(s):// 开头" };
      const loaded = new Promise((resolve) => {
        const onMsg = (ev) => {
          let m;
          try { m = JSON.parse(ev.data); } catch { return; }
          if (m && m.method === "Page.loadEventFired") {
            pageWs.removeEventListener("message", onMsg);
            resolve();
          }
        };
        pageWs.addEventListener("message", onMsg);
        setTimeout(() => { try { pageWs.removeEventListener("message", onMsg); } catch {} resolve(); }, 20000);
      });
      await cdp("Page.navigate", { url });
      await loaded;
      await sleep(400);
      const meta = await evaluate("JSON.stringify({url:location.href,title:document.title})");
      return { ok: true, ...(meta.value ? JSON.parse(meta.value) : {}) };
    }

    if (action === "screenshot") {
      const shot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const layout = await cdp("Page.getLayoutMetrics").catch(() => null);
      const width = layout && layout.cssVisualViewport ? Math.round(layout.cssVisualViewport.clientWidth) : 0;
      const height = layout && layout.cssVisualViewport ? Math.round(layout.cssVisualViewport.clientHeight) : 0;
      return { ok: true, width, height, dataUrl: "data:image/png;base64," + shot.data };
    }

    if (action === "dom") {
      const r = await evaluate(WEB_DOM_JS);
      return r.error ? { error: r.error } : { ok: true, result: r.value };
    }

    if (action === "text") {
      const r = await evaluate("(document.body && document.body.innerText || '').slice(0, " + (Number(p.max) || 6000) + ")");
      return r.error ? { error: r.error } : { ok: true, result: String(r.value ?? "") };
    }

    if (action === "click") {
      let x = Number(p.x);
      let y = Number(p.y);
      if (p.selector) {
        const r = await evaluate(resolveSelectorJs(p.selector));
        if (r.error) return { error: r.error };
        if (!r.value) return { error: "选择器未命中元素：" + p.selector };
        const box = JSON.parse(r.value);
        x = box.x; y = box.y;
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: "click 需要 selector 或坐标 x/y" };
      await sleep(150);
      await mouseAt(x, y, p.button === "right" ? "right" : "left", p.double ? 2 : 1);
      return { ok: true, x: Math.round(x), y: Math.round(y) };
    }

    if (action === "type") {
      const text = String(p.text ?? "");
      if (p.selector) {
        const focus = await evaluate(
          "(() => { const el = document.querySelector(" + JSON.stringify(String(p.selector)) + ");" +
          " if (!el) return 'NO'; el.scrollIntoView({block:'center'}); el.focus();" +
          ( p.clear ? " if ('value' in el) el.value = '';" : "" ) +
          " return 'OK'; })()",
        );
        if (focus.error) return { error: focus.error };
        if (focus.value === "NO") return { error: "选择器未命中可输入元素：" + p.selector };
      }
      if (text) await cdp("Input.insertText", { text });
      return { ok: true };
    }

    if (action === "key") {
      const combo = String(p.key ?? "");
      if (!combo) return { error: "key 为空" };
      // 简化：逐段用 Input.dispatchKeyEvent 发送（支持 Enter/Tab/Escape 及单字符）
      const SPECIAL = { enter: "Enter", return: "Enter", tab: "Tab", escape: "Escape", esc: "Escape", backspace: "Backspace", delete: "Delete", space: " ", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown" };
      const raw = combo.toLowerCase();
      const key = SPECIAL[raw] || (combo.length === 1 ? combo : combo);
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", key });
      await cdp("Input.dispatchKeyEvent", { type: "keyUp", key });
      return { ok: true };
    }

    if (action === "scroll") {
      const x = Number(p.x ?? 0);
      const y = Number(p.y ?? 0);
      await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: Number(p.dx ?? 0), deltaY: Number(p.dy ?? -600) });
      return { ok: true };
    }

    if (action === "eval") {
      const js = String(p.js ?? "");
      if (!js) return { error: "js 为空" };
      const r = await evaluate(js, Boolean(p.awaitPromise));
      return r.error ? { error: r.error } : { ok: true, result: typeof r.value === "string" ? r.value : JSON.stringify(r.value ?? null) };
    }

    // ---- RECORD & REPLAY ----
    if (action === "record-start") {
      return await startRecording();
    }
    if (action === "record-stop") {
      return await stopRecording();
    }
    if (action === "skill-save") {
      const name = safeName(p.name);
      if (!name) return { error: "skill-save 需要 name" };
      const steps = Array.isArray(p.steps) ? p.steps : (lastRecording || []);
      if (!steps.length) return { error: "没有可保存的步骤（先录制或传入 steps）" };
      const rec = saveSkill(name, steps);
      return { ok: true, name: rec.name, count: rec.steps.length };
    }
    if (action === "skill-list") {
      return { ok: true, skills: listSkills() };
    }
    if (action === "skill-load") {
      const rec = loadSkill(p.name);
      if (!rec) return { error: "技能不存在：" + p.name };
      return { ok: true, name: rec.name, steps: rec.steps, count: rec.steps.length };
    }
    if (action === "skill-delete") {
      return deleteSkill(p.name) ? { ok: true } : { error: "技能不存在或删除失败：" + p.name };
    }
    if (action === "replay") {
      let steps = Array.isArray(p.steps) ? p.steps : null;
      if (!steps && p.name) {
        const rec = loadSkill(p.name);
        if (!rec) return { error: "技能不存在：" + p.name };
        steps = rec.steps;
      }
      if (!steps || !steps.length) return { error: "replay 需要 steps 或已存技能 name" };
      const log = await replaySteps(steps, p.stepDelay);
      const failed = log.filter((r) => !r.ok).length;
      return { ok: failed === 0, replayed: log.length, failed, log };
    }

    return { error: "未知 action：" + action };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** 回收：关 WS + 杀浏览器进程（before-quit 调用） */
export function shutdownWebDriver() {
  recording = false;
  if (recBindingListener && pageWs) { try { pageWs.removeEventListener("message", recBindingListener); } catch {} }
  recBindingListener = null;
  recNewDocId = null;
  closeWs();
  if (browserProc) {
    try {
      browserProc.kill();
    } catch {
      /* 忽略 */
    }
    browserProc = null;
  }
  debugPort = 0;
}
