import { spawn, execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  ipcMain,
  Menu,
  session,
  shell,
} from "electron";
import { handleCommandPayload, handleDeployPayload, handleFsPayload, handleFetchPayload, handleServicePayload, initLocalRuntime, shutdownLocalServices, cancelAllCommands } from "./local-runtime.mjs";
import { handleMcpPayload, initMcpRuntime, shutdownMcp } from "./mcp-runtime.mjs";
import { handleAppServerPayload, initAppServerIpc, shutdownAppServer } from "./app-server-ipc.mjs"; // P21-import
import { registerLocalAiIpc, shutdownLocalAi } from "./local-ai/ipc.mjs";
import { initAppData } from "./app-data.mjs";
import { getStoredServerUrl, handleServerUrlPayload } from "./server-url.mjs"; // SERVER-URL

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(
  process.env.XIAOLUO_PROJECT_ROOT?.trim() || join(__dirname, ".."),
);
const loadingPage = join(__dirname, "loading.html");
const iconPath = join(__dirname, "assets", "xiaoluo.png");
const productionConfigPath = join(__dirname, "config.production.json");
const startupScript = join(projectRoot, "scripts", "start-local-detached.mjs");
const envFile = join(projectRoot, ".env.local-dev");
const logsDirectory = join(projectRoot, ".wrangler");
const smokeTest = process.argv.includes("--smoke-test");

const copy = {
  appName: "\u5c0f\u903bAgent OS",
  windowTitle: "\u5c0f\u903bAgent OS",
  pleaseWait: "\u8bf7\u7a0d\u5019\u2026",
  connectingCloud: "\u6b63\u5728\u8fde\u63a5\u5c0f\u903b\u4e91\u7aef",
  checkingLocal: "\u6b63\u5728\u68c0\u67e5\u5c0f\u903b\u670d\u52a1",
  secureConnection: "\u6b63\u5728\u5efa\u7acb\u5b89\u5168\u8fde\u63a5\u2026",
  cloudReady: "\u5c0f\u903b\u4e91\u7aef\u5df2\u8fde\u63a5",
  localReady: "\u5c0f\u903b\u5df2\u5c31\u7eea",
  openingWorkbench: "\u6b63\u5728\u6253\u5f00\u684c\u9762\u5de5\u4f5c\u53f0\u2026",
  startingDev: "\u6b63\u5728\u542f\u52a8\u4e2d",
  firstStart:
    "\u9996\u6b21\u542f\u52a8\u53ef\u80fd\u9700\u8981\u51e0\u5341\u79d2\uff0c\u8bf7\u4e0d\u8981\u5173\u95ed\u7a97\u53e3\u3002",
  cloudUnavailable:
    "\u6682\u65f6\u65e0\u6cd5\u8fde\u63a5\u5c0f\u903b\u4e91\u7aef\u3002\u8bf7\u68c0\u67e5\u7f51\u7edc\u540e\u91cd\u8bd5\uff1b\u82e5\u7f51\u7edc\u6b63\u5e38\uff0c\u670d\u52a1\u53ef\u80fd\u6b63\u5728\u7ef4\u62a4\u3002",
  cloudAccessRestricted:
    "\u5c0f\u903b\u4e91\u7aef\u5f53\u524d\u9650\u5236\u5916\u90e8\u7528\u6237\u8bbf\u95ee\u3002\u8bf7\u8054\u7cfb\u7cfb\u7edf\u7ba1\u7406\u5458\u5f00\u653e\u751f\u4ea7\u7ad9\u70b9\uff1b\u6570\u636e\u4ecd\u7531\u5c0f\u903b\u8d26\u53f7\u9274\u6743\u4fdd\u62a4\u3002",
  cloudDependenciesUnavailable:
    "\u5c0f\u903b\u4e91\u7aef\u5df2\u8fde\u63a5\uff0c\u4f46\u6570\u636e\u5e93\u6216\u6587\u4ef6\u5b58\u50a8\u6682\u672a\u5c31\u7eea\u3002\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002",
  invalidHealthResponse:
    "\u4e91\u7aef\u5065\u5eb7\u68c0\u67e5\u8fd4\u56de\u4e86\u65e0\u6548\u54cd\u5e94\u3002\u8bf7\u8054\u7cfb\u7cfb\u7edf\u7ba1\u7406\u5458\u3002",
  invalidCloudUrl:
    "\u684c\u9762\u7aef\u5c1a\u672a\u914d\u7f6e\u6709\u6548\u7684 HTTPS \u4e91\u7aef\u5730\u5740\uff0c\u8bf7\u8054\u7cfb\u7cfb\u7edf\u7ba1\u7406\u5458\u3002",
  cloudLoadFailed: "\u4e91\u7aef\u9875\u9762\u52a0\u8f7d\u5931\u8d25",
  localLoadFailed: "\u5de5\u4f5c\u53f0\u9875\u9762\u52a0\u8f7d\u5931\u8d25",
  reconnectLater: "\u9875\u9762\u6682\u65f6\u4e0d\u53ef\u7528\u3002\u8bf7\u7a0d\u540e\u91cd\u65b0\u8fde\u63a5\u3002",
  rendererGone: "\u5c0f\u903b\u9875\u9762\u610f\u5916\u505c\u6b62",
  rendererGoneDetail:
    "\u53ef\u4ee5\u91cd\u65b0\u8fde\u63a5\uff0c\u672a\u63d0\u4ea4\u7684\u9875\u9762\u5185\u5bb9\u53ef\u80fd\u9700\u8981\u6062\u590d\u3002",
  unresponsive: "\u5c0f\u903b\u9875\u9762\u6682\u65f6\u65e0\u54cd\u5e94",
  unresponsiveDetail: "\u8bf7\u91cd\u65b0\u8fde\u63a5\u5de5\u4f5c\u53f0\u3002",
  localLaunchFailedDetail:
    "\u8bf7\u70b9\u51fb\u91cd\u65b0\u542f\u52a8\u518d\u8bd5\uff1b\u82e5\u591a\u6b21\u5931\u8d25\uff0c\u53ef\u67e5\u770b\u65e5\u5fd7\u5b9a\u4f4d\u539f\u56e0\u3002",
};

function readProductionConfig() {
  if (!existsSync(productionConfigPath)) return {};
  try {
    return JSON.parse(readFileSync(productionConfigPath, "utf8"));
  } catch (error) {
    console.error("Invalid desktop production config", error);
    return {};
  }
}

const productionConfig = readProductionConfig();
const requestedMode = process.env.XIAOLUO_DESKTOP_MODE?.trim().toLowerCase();
const forceLocal = process.argv.includes("--local") || requestedMode === "development";
const forceProduction =
  process.argv.includes("--production") || requestedMode === "production";
const desktopMode = forceLocal
  ? "development"
  : forceProduction
    ? "production"
    : app.isPackaged
      ? "production"
      : "development";
// SERVER-URL 优先级：环境变量 > 用户在设置里保存的地址 > 内置默认地址
const configuredUrl =
  process.env.XIAOLUO_DESKTOP_URL?.trim() ||
  getStoredServerUrl() ||
  (desktopMode === "production"
    ? String(productionConfig.appUrl || "").trim()
    : "http://127.0.0.1:3001/");

function isLocalhost(hostname) {
  if (
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname.endsWith(".local")
  ) {
    return true;
  }
  // 局域网私有网段（10/8、172.16/12、192.168/16）同样允许 http
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!parts) return false;
  const [, a, b] = parts.map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function parseAppUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    if (desktopMode === "production" && parsed.protocol !== "https:" && !isLocalhost(parsed.hostname)) return null;
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return parsed;
  } catch {
    return null;
  }
}

let appUrl = parseAppUrl(configuredUrl);
const healthPath =
  desktopMode === "production"
    ? String(productionConfig.healthPath || "/api/v2/health/ready")
    : "/api/v2/health/live";
let healthUrl = appUrl
  ? new URL(healthPath, appUrl)
  : null;

let mainWindow = null;
let startupPromise = null;
let lastAutoReloadAt = 0;
let crashRecentTimes = [];
let loadingStatusReady = false;
let lastStatus = {
  phase: "checking",
  mode: desktopMode,
  title: desktopMode === "production" ? copy.connectingCloud : copy.checkingLocal,
  detail: copy.pleaseWait,
};

app.setName(copy.appName);
initLocalRuntime(app.getPath("userData"));
initMcpRuntime(join(app.getPath("userData"), "brain-workspace", "workspace"));
registerLocalAiIpc();
// DATA-DIR 存储位置设置：配置落 userData/data-dir.json
initAppData(app.getPath("userData"));
// registerAppDataIpc removed - standalone mode removed
// app-server 由真实 node 子进程运行，读不了 asar 虚拟路径：用解包物理目录
initAppServerIpc(
  app.getPath("userData"),
  __dirname.replace(/app\.asar(?![\\/.]?unpacked)/, "app.asar.unpacked"),
  (evt) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("brain:appserver-event", evt);
}); // P21-init
/** 桌面端关键事件落盘（崩溃/自愈）：终端日志在部分启动方式下捕获不到，文件日志保底 */
function logDesktopEvent(line) {
  try {
    const dir = app.getPath("userData");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "desktop-crash.log"), `[${new Date().toISOString()}] ${line}
`);
  } catch { /* 日志失败不影响主流程 */ }
}
app.setAppUserModelId("cn.luosheji.xiaoluo.desktop");
// 渲染进程反复崩溃（desktop-crash.log 两天 85 次，exit 0xC0000005 / 0x80000003）：
// Windows 上 Chromium 图形驱动兼容性崩溃的典型特征，关闭硬件加速改软件渲染根治。
// 工作台无高性能图形诉求，软件渲染代价可忽略。
app.disableHardwareAcceleration();

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function updateStatus(nextStatus) {
  lastStatus = { ...lastStatus, ...nextStatus, mode: desktopMode };
  if (loadingStatusReady && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("desktop:status", lastStatus);
  }
}

async function probeEndpoint(url, { timeoutMs = 2_500, requireHealthJson = false } = {}) {
  if (!url) {
    return { ok: false, kind: "invalid-url", status: 0 };
  }
  try {
    const response = await fetch(url, {
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status === 401 || response.status === 403) {
      return { ok: false, kind: "access-restricted", status: response.status };
    }
    if (!response.ok) {
      return {
        ok: false,
        kind: response.status === 503 ? "dependencies-unavailable" : "http-error",
        status: response.status,
      };
    }
    if (!requireHealthJson) {
      return { ok: true, kind: "ready", status: response.status };
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return { ok: false, kind: "invalid-health-response", status: response.status };
    }
    const payload = await response.json();
    if (!payload || payload.ok !== true) {
      return { ok: false, kind: "dependencies-unavailable", status: response.status };
    }
    return { ok: true, kind: "ready", status: response.status };
  } catch (error) {
    return {
      ok: false,
      kind: error?.name === "TimeoutError" ? "timeout" : "network-error",
      status: 0,
    };
  }
}

async function serverIsReady(timeoutMs = 2_500) {
  if (!appUrl || !healthUrl) {
    return { ok: false, kind: "invalid-url", status: 0 };
  }

  const healthResult = await probeEndpoint(healthUrl, {
    timeoutMs,
    requireHealthJson: true,
  });
  if (!healthResult.ok) return healthResult;

  return probeEndpoint(appUrl, { timeoutMs });
}

function readinessMessage(result) {
  if (result?.kind === "access-restricted") return copy.cloudAccessRestricted;
  if (result?.kind === "dependencies-unavailable") {
    return copy.cloudDependenciesUnavailable;
  }
  if (result?.kind === "invalid-health-response") {
    return copy.invalidHealthResponse;
  }
  return copy.cloudUnavailable;
}

function launchLocalRuntime() {
  if (!existsSync(startupScript)) {
    throw new Error(`Local startup script was not found: ${startupScript}`);
  }

  const args = [];
  if (existsSync(envFile)) args.push(`--env-file=${envFile}`);
  args.push(startupScript);

  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-12_000);
    process.stderr.write(chunk);
  });

  return new Promise((resolvePromise, rejectPromise) => {
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      const reason = signal ? `signal=${signal}` : `code=${code ?? "unknown"}`;
      rejectPromise(
        new Error(
          `Local service failed to start (${reason}). ${stderr.trim() || "Check the runtime logs."}`,
        ),
      );
    });
  });
}

async function ensureRemoteServer() {
  if (!appUrl) throw new Error(copy.invalidCloudUrl);

  updateStatus({
    phase: "connecting",
    title: copy.connectingCloud,
    detail: copy.secureConnection,
  });

  const readiness = await serverIsReady(8_000);
  if (readiness.ok) {
    updateStatus({
      phase: "ready",
      title: copy.cloudReady,
      detail: copy.openingWorkbench,
    });
    return;
  }

  throw new Error(readinessMessage(readiness));
}

async function ensureLocalServer() {
  if ((await serverIsReady()).ok) {
    updateStatus({
      phase: "ready",
      title: copy.localReady,
      detail: copy.openingWorkbench,
    });
    return;
  }

  updateStatus({
    phase: "starting",
    title: copy.startingDev,
    detail: copy.firstStart,
  });

  let launcherError = null;
  const launcher = launchLocalRuntime().catch((error) => {
    launcherError = error;
  });
  const startedAt = Date.now();
  const timeoutMs = 120_000;

  while (Date.now() - startedAt < timeoutMs) {
    if ((await serverIsReady(2_000)).ok) {
      updateStatus({
        phase: "ready",
        title: copy.localReady,
        detail: copy.openingWorkbench,
      });
      return;
    }
    if (launcherError) throw launcherError;

    const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1_000));
    updateStatus({
      phase: "starting",
      title: copy.startingDev,
      detail: `Local service is initializing (${elapsedSeconds}s).`,
    });
    await sleep(900);
  }

  await launcher;
  if (launcherError) throw launcherError;
  throw new Error("The local development service did not become ready within 120 seconds.");
}


async function ensureServer() {
  if (desktopMode === "production") return ensureRemoteServer();
  return ensureLocalServer();
}

// RUNTIME-MODE 云端档连接：单机档允许 http（局域网/本机调试），健康检查走 /api/v2/health/ready
async function ensureCloudServer(cloudUrl) {
  if (!cloudUrl) throw new Error(copy.invalidCloudUrl);
  appUrl = parseAppUrl(cloudUrl.endsWith("/") ? cloudUrl : `${cloudUrl}/`);
  healthUrl = appUrl ? new URL("/api/v2/health/ready", appUrl) : null;
  if (!appUrl) throw new Error(copy.invalidCloudUrl);
  updateStatus({
    phase: "connecting",
    title: copy.connectingCloud,
    detail: copy.secureConnection,
  });
  const readiness = await serverIsReady(8_000);
  if (readiness.ok) {
    updateStatus({ phase: "ready", title: copy.cloudReady, detail: copy.openingWorkbench });
    return;
  }
  throw new Error(readinessMessage(readiness));
}

function isTrustedAppUrl(rawUrl) {
  if (!appUrl) return false;
  try {
    return new URL(rawUrl).origin === appUrl.origin;
  } catch {
    return false;
  }
}

function openExternalUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) return;
    void shell.openExternal(url.toString());
  } catch {
    // Ignore malformed or unsupported external links.
  }
}

async function showStatusPage(status) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  loadingStatusReady = false;
  updateStatus(status);
  await mainWindow.loadFile(loadingPage);
  loadingStatusReady = true;
  updateStatus(lastStatus);
}

async function loadWorkbench() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  await showStatusPage({
    phase: "checking",
    title: desktopMode === "production" ? copy.connectingCloud : copy.checkingLocal,
    detail: copy.pleaseWait,
  });

  try {
    await ensureServer();
    if (!appUrl) throw new Error(copy.invalidCloudUrl);
    loadingStatusReady = false;
    await mainWindow.loadURL(appUrl.toString());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // \u8be6\u7ec6\u9519\u8bef\u53ea\u8fdb\u63a7\u5236\u53f0\u65e5\u5fd7\uff0c\u754c\u9762\u4e0a\u53ea\u7ed9\u7b80\u77ed\u63d0\u793a
    console.error("xiaoluo_desktop=launch_failed " + message);
    await showStatusPage({
      phase: "error",
      title:
        desktopMode === "production"
          ? "\u65e0\u6cd5\u8fde\u63a5\u5c0f\u903b\u4e91\u7aef"
          : "\u5c0f\u903b\u542f\u52a8\u5931\u8d25",
      detail:
        desktopMode === "production"
          ? message
          : copy.localLaunchFailedDetail,
    });
  }
}

function recoverFromPageFailure(title, detail) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  void showStatusPage({ phase: "error", title, detail });
}

app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (attachEvent) => {
    attachEvent.preventDefault();
  });
});

function createWindow() {
  mainWindow = new BrowserWindow({
    title: copy.windowTitle,
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#f6f8fc",
    icon: existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
    mainWindow?.setTitle(copy.windowTitle);
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedAppUrl(url)) mainWindow?.loadURL(url);
    else openExternalUrl(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isTrustedAppUrl(url)) return;
    event.preventDefault();
    openExternalUrl(url);
  });

  mainWindow.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 || validatedUrl.startsWith("file:")) return;
      recoverFromPageFailure(
        desktopMode === "production" ? copy.cloudLoadFailed : copy.localLoadFailed,
        `${errorDescription || copy.reconnectLater}.`,
      );
    },
  );
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    const goneReason = details?.reason ?? "unknown";
    const exitCode = details?.exitCode ?? "?";
    logDesktopEvent(`renderer_gone reason=${goneReason} exitCode=${exitCode}`);
    console.error(`xiaoluo_desktop=renderer_gone reason=${goneReason} exitCode=${exitCode}`);
    // 渲染进程崩溃（dev 热重载瞬间/GPU/内存抖动）：非主动退出且 5 分钟内自愈不超 3 次 → 静默重载
    const benign = ["crashed", "killed", "oom", "abnormal-exit", "launch-failed", "integrity-failure", "unknown", ""];
    if (benign.includes(goneReason)) {
      const now = Date.now();
      crashRecentTimes = crashRecentTimes.filter((t) => now - t < 300_000);
      if (crashRecentTimes.length < 3) {
        crashRecentTimes.push(now);
        lastAutoReloadAt = now;
        logDesktopEvent(`renderer_auto_reload #${crashRecentTimes.length}`);
        mainWindow?.reload();
        return;
      }
    }
    recoverFromPageFailure(copy.rendererGone, `${copy.rendererGoneDetail}（${goneReason}${exitCode !== "?" ? ` / exit ${exitCode}` : ""}）`);
  });
  mainWindow.on("unresponsive", () => {
    recoverFromPageFailure(copy.unresponsive, copy.unresponsiveDetail);
  });

  void loadWorkbench();
}

// ---------- VISION-OPS：截图/鼠标口（V1 内嵌浏览器自验证） ----------

/** 页面快照脚本：URL/标题/正文摘要/可交互元素中心坐标（iframe 内局部坐标，渲染层负责换算窗口坐标） */
const DOM_SNAPSHOT_JS =
  "(() => { const out = { url: location.href, title: document.title, text: (document.body && document.body.innerText || '').slice(0, 3000), interactive: [] };" +
  " const els = document.querySelectorAll('a,button,input,select,textarea,[role=button],[onclick]');" +
  " for (const el of Array.from(els).slice(0, 80)) { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;" +
  " out.interactive.push({ tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').slice(0, 60), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }); }" +
  " return JSON.stringify(out); })()";

/** 内嵌浏览器口：截图（合成器级含 iframe）/ 点击 / 输入 / 按键 / 滚动 / 帧内 JS / DOM 快照；坐标均为窗口内容 CSS 像素 */
async function handleBrowserPayload(payload) {
  const action = payload && payload.action;
  if (!mainWindow || mainWindow.isDestroyed()) return { error: "主窗口不存在" };
  const wc = mainWindow.webContents;
  try {
    if (action === "screenshot") {
      const bounds = mainWindow.getContentBounds();
      const shot = await wc.capturePage();
      const phys = shot.getSize();
      const scale = phys.width > 0 && bounds.width > 0 ? phys.width / bounds.width : 1;
      let img = shot;
      const r = payload.rect;
      if (r && Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.width) && Number.isFinite(r.height)) {
        img = shot.crop({
          x: Math.max(0, Math.round(r.x * scale)),
          y: Math.max(0, Math.round(r.y * scale)),
          width: Math.max(1, Math.min(phys.width, Math.round(r.width * scale))),
          height: Math.max(1, Math.min(phys.height, Math.round(r.height * scale))),
        });
      }
      const size = img.getSize();
      return { ok: true, width: size.width, height: size.height, dataUrl: "data:image/png;base64," + img.toPNG().toString("base64") };
    }
    if (action === "click") {
      const x = Number(payload.x);
      const y = Number(payload.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: "缺少坐标 x/y" };
      const button = payload.button === "right" ? "right" : "left";
      wc.sendInputEvent({ type: "mouseMoved", x, y });
      wc.sendInputEvent({ type: "mouseDown", x, y, button, clickCount: 1 });
      wc.sendInputEvent({ type: "mouseUp", x, y, button, clickCount: 1 });
      if (payload.double) {
        wc.sendInputEvent({ type: "mouseDown", x, y, button, clickCount: 2 });
        wc.sendInputEvent({ type: "mouseUp", x, y, button, clickCount: 2 });
      }
      return { ok: true };
    }
    if (action === "type") {
      const text = String(payload.text ?? "");
      if (!text) return { error: "输入内容为空" };
      wc.insertText(text);
      return { ok: true };
    }
    if (action === "key") {
      const combo = String(payload.key ?? "").toLowerCase();
      if (!combo) return { error: "按键为空" };
      const parts = combo.split("+");
      const key = parts.pop() ?? "";
      const modifiers = parts;
      if (modifiers.length === 0 && key.length === 1) {
        wc.sendInputEvent({ type: "char", keyCode: key });
      } else {
        wc.sendInputEvent({ type: "keyDown", keyCode: key, modifiers });
        wc.sendInputEvent({ type: "keyUp", keyCode: key, modifiers });
      }
      return { ok: true };
    }
    if (action === "scroll") {
      const x = Number(payload.x ?? 0);
      const y = Number(payload.y ?? 0);
      wc.sendInputEvent({ type: "mouseWheel", x, y, deltaX: Number(payload.dx ?? 0), deltaY: Number(payload.dy ?? 0) });
      return { ok: true };
    }
    if (action === "evaluate" || action === "dom") {
      const match = String(payload.urlMatch ?? "");
      const frames = wc.mainFrame.framesInFrameTree;
      const target = match ? frames.find((f) => f.url.includes(match)) : frames[frames.length - 1];
      if (!target) return { error: "未找到目标 frame（urlMatch=" + match + "）" };
      const js = action === "dom" ? DOM_SNAPSHOT_JS : String(payload.js ?? "");
      if (!js) return { error: "js 为空" };
      const out = await target.executeJavaScript(js);
      return { ok: true, result: typeof out === "string" ? out : JSON.stringify(out ?? null) };
    }
    return { error: "未知 action：" + action };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------- DESKTOP-OPS：整桌截屏 + 全局键鼠（V2，默认关闭，需老板显式开启） ----------

const DESKTOP_INPUT_PS = [
  "param(",
  "  [string]$Op,",
  "  [double]$X = 0,",
  "  [double]$Y = 0,",
  "  [string]$Text = '',",
  "  [string]$Key = '',",
  "  [double]$Dx = 0,",
  "  [double]$Dy = 0",
  ")",
  "Add-Type -TypeDefinition @\"",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public sealed class Win32SendInput {",
  "  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }",
  "  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }",
  "  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }",
  "  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public UNION u; }",
  "  [DllImport(\"user32.dll\", SetLastError = true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);",
  "  [DllImport(\"user32.dll\")] public static extern int GetSystemMetrics(int index);",
  "}",
  "\"@",
  "$sizeProbe = New-Object Win32SendInput+INPUT",
  "$SIZE = [System.Runtime.InteropServices.Marshal]::SizeOf($sizeProbe)",
  "function Send-Mouse([uint32]$flags, [int]$adx, [int]$ady, [uint32]$data) {",
  "  $i = New-Object Win32SendInput+INPUT",
  "  $i.type = 0",
  "  $i.u.mi.dx = $adx; $i.u.mi.dy = $ady; $i.u.mi.mouseData = $data; $i.u.mi.dwFlags = $flags; $i.u.mi.time = 0; $i.u.mi.dwExtraInfo = [IntPtr]::Zero",
  "  [Win32SendInput]::SendInput(1, @($i), $SIZE) | Out-Null",
  "}",
  "function Send-Key([uint16]$vk, [uint32]$flags) {",
  "  $i = New-Object Win32SendInput+INPUT",
  "  $i.type = 1",
  "  $i.u.ki.wVk = $vk; $i.u.ki.wScan = 0; $i.u.ki.dwFlags = $flags; $i.u.ki.time = 0; $i.u.ki.dwExtraInfo = [IntPtr]::Zero",
  "  [Win32SendInput]::SendInput(1, @($i), $SIZE) | Out-Null",
  "}",
  "function Send-Char([int]$code) {",
  "  $i = New-Object Win32SendInput+INPUT",
  "  $i.type = 1",
  "  $i.u.ki.wVk = 0; $i.u.ki.wScan = [uint16]$code; $i.u.ki.dwFlags = 4; $i.u.ki.time = 0; $i.u.ki.dwExtraInfo = [IntPtr]::Zero",
  "  [Win32SendInput]::SendInput(1, @($i), $SIZE) | Out-Null",
  "  $i.u.ki.dwFlags = 6",
  "  [Win32SendInput]::SendInput(1, @($i), $SIZE) | Out-Null",
  "}",
  "$sx = [Math]::Max(1, [Win32SendInput]::GetSystemMetrics(0) - 1)",
  "$sy = [Math]::Max(1, [Win32SendInput]::GetSystemMetrics(1) - 1)",
  "$adx = [int](($X * 65535) / $sx)",
  "$ady = [int](($Y * 65535) / $sy)",
  "$ABS = 32768; $MOVE = 1; $LDOWN = 2; $LUP = 4; $RDOWN = 8; $RUP = 16; $WHEEL = 2048; $HWHEEL = 4096",
  "switch ($Op) {",
  "  'click' { Send-Mouse ($MOVE -bor $ABS) $adx $ady 0; Send-Mouse ($LDOWN -bor $ABS) $adx $ady 0; Send-Mouse ($LUP -bor $ABS) $adx $ady 0 }",
  "  'dblclick' { Send-Mouse ($MOVE -bor $ABS) $adx $ady 0; Send-Mouse ($LDOWN -bor $ABS) $adx $ady 0; Send-Mouse ($LUP -bor $ABS) $adx $ady 0; Send-Mouse ($LDOWN -bor $ABS) $adx $ady 0; Send-Mouse ($LUP -bor $ABS) $adx $ady 0 }",
  "  'rightclick' { Send-Mouse ($MOVE -bor $ABS) $adx $ady 0; Send-Mouse ($RDOWN -bor $ABS) $adx $ady 0; Send-Mouse ($RUP -bor $ABS) $adx $ady 0 }",
  "  'scroll' { Send-Mouse ($MOVE -bor $ABS) $adx $ady 0; if ($Dy -ne 0) { Send-Mouse ($WHEEL -bor $ABS) $adx $ady ([int](-$Dy * 120)) }; if ($Dx -ne 0) { Send-Mouse ($HWHEEL -bor $ABS) $adx $ady ([int]($Dx * 120)) } }",
  "  'type' { foreach ($ch in $Text.ToCharArray()) { Send-Char ([int]$ch) } }",
  "  'key' {",
  "    $VK = @{ 'enter' = 13; 'return' = 13; 'tab' = 9; 'escape' = 27; 'esc' = 27; 'backspace' = 8; 'space' = 32; 'up' = 38; 'down' = 40; 'left' = 37; 'right' = 39; 'delete' = 46; 'home' = 36; 'end' = 35; 'pageup' = 33; 'pagedown' = 34; 'ctrl' = 17; 'control' = 17; 'shift' = 16; 'alt' = 18; 'win' = 91 }",
  "    $parts = $Key.ToLower().Split('+')",
  "    $held = @()",
  "    foreach ($p in $parts) {",
  "      if ($VK.ContainsKey($p) -and $p -ne $parts[$parts.Length - 1]) { Send-Key $VK[$p] 0; $held = @($VK[$p]) + $held; continue }",
  "      if ($p.Length -eq 1 -and -not $VK.ContainsKey($p)) { $code = [int][char]::ToUpperInvariant($p[0]); if ($held.Count -eq 0) { Send-Char ([int]$p[0]) } else { Send-Key $code 0; Send-Key $code 2 }; continue }",
  "      if ($VK.ContainsKey($p)) { Send-Key $VK[$p] 0; Send-Key $VK[$p] 2; continue }",
  "      if ($p.Length -eq 1) { $code = [int][char]::ToUpperInvariant($p[0]); Send-Key $code 0; Send-Key $code 2; continue }",
  "    }",
  "    foreach ($h in $held) { Send-Key $h 2 }",
  "  }",
  "}",
].join("\n");

function desktopControlPath() {
  return join(app.getPath("userData"), "desktop-control.json");
}
function desktopControlEnabled() {
  try {
    return Boolean(JSON.parse(readFileSync(desktopControlPath(), "utf8")).enabled);
  } catch {
    return false;
  }
}
function runDesktopInputPs(args) {
  const psPath = join(app.getPath("userData"), "desktop-input.ps1");
  if (!existsSync(psPath)) writeFileSync(psPath, DESKTOP_INPUT_PS, "utf8");
  return new Promise((resolveP) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psPath, ...args],
      { timeout: 15000, windowsHide: true },
      (err, _stdout, stderr) => resolveP(err ? { error: (stderr || err.message || String(err)).slice(0, 300) } : { ok: true }),
    );
  });
}

/** 整桌口：gate 查询/设置、全屏截图、全局键鼠（后两者需 gate 开启 + 渲染层批准） */
async function handleDesktopPayload(payload) {
  const action = payload && payload.action;
  try {
    if (action === "gate") return { ok: true, enabled: desktopControlEnabled() };
    if (action === "setGate") {
      const enabled = Boolean(payload && payload.enabled);
      writeFileSync(desktopControlPath(), JSON.stringify({ enabled }, null, 2));
      return { ok: true, enabled };
    }
    if (!desktopControlEnabled()) {
      return { error: "整桌控制未开启：请先在客户端设置里打开「允许小逻控制本机」开关（desktopAction setGate）" };
    }
    if (action === "screenshot") {
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1600, height: 900 } });
      const s = sources[0];
      if (!s) return { error: "屏幕截取失败" };
      const disp = s.display && s.display.size ? s.display.size : s.thumbnail.getSize();
      const thumb = s.thumbnail.getSize();
      return { ok: true, width: disp.width, height: disp.height, thumbWidth: thumb.width, thumbHeight: thumb.height, dataUrl: "data:image/png;base64," + s.thumbnail.toPNG().toString("base64") };
    }
    if (action === "operate") {
      if (payload.approved !== true) return { code: "approval_required", error: "整桌操作需要老板批准" };
      const op = String(payload.op ?? "");
      const args = ["-Op", op, "-X", String(Number(payload.x ?? 0)), "-Y", String(Number(payload.y ?? 0)), "-Text", String(payload.text ?? ""), "-Key", String(payload.key ?? ""), "-Dx", String(Number(payload.dx ?? 0)), "-Dy", String(Number(payload.dy ?? 0))];
      if (!["click", "dblclick", "rightclick", "scroll", "type", "key"].includes(op)) return { error: "未知操作：" + op };
      return await runDesktopInputPs(args);
    }
    return { error: "未知 action：" + action };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

ipcMain.handle("brain:command", (_event, payload) => handleCommandPayload(payload));
ipcMain.handle("brain:command-cancel", () => { cancelAllCommands(); return { ok: true }; });
ipcMain.handle("brain:fs", (_event, payload) => handleFsPayload(payload));
ipcMain.handle("brain:services", (_event, payload) => handleServicePayload(payload));
ipcMain.handle("brain:deploy", (_event, payload) => handleDeployPayload(payload));
ipcMain.handle("brain:fetch", (_event, payload) => handleFetchPayload(payload));
ipcMain.handle("brain:mcp", (_event, payload) => handleMcpPayload(payload));
ipcMain.handle("brain:browser", (_event, payload) => handleBrowserPayload(payload)); // VISION-OPS
ipcMain.handle("brain:desktop", (_event, payload) => handleDesktopPayload(payload)); // DESKTOP-OPS
ipcMain.handle("brain:appserver", (_event, payload) => handleAppServerPayload(payload)); // P21-ipc
ipcMain.handle("desktop:get-status", () => lastStatus);
// SERVER-URL 设置页「运行模式」自定义连接地址（status/test/set，应用后自动重启）
ipcMain.handle("server-url", (_event, payload) => handleServerUrlPayload(payload));
ipcMain.handle("desktop:get-meta", () => ({
  mode: desktopMode,
  appUrl: appUrl?.toString() || "",
}));
ipcMain.handle("desktop:open-external", (_event, payload) => {
  openExternalUrl(String(payload?.url || ""));
  return { ok: true };
});
ipcMain.handle("desktop:write-clipboard", (_event, payload) => {
  try {
    clipboard.writeText(String(payload?.text || ""));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
});
ipcMain.handle("desktop:retry", async () => {
  if (!startupPromise) {
    startupPromise = loadWorkbench().finally(() => {
      startupPromise = null;
    });
  }
  await startupPromise;
});
ipcMain.handle("desktop:open-secondary", async () => {
  if (desktopMode === "production") {
    if (!appUrl) return { ok: false, message: copy.invalidCloudUrl };
    openExternalUrl(appUrl.toString());
    return { ok: true, message: "" };
  }
  if (!existsSync(logsDirectory)) {
    return { ok: false, message: "Runtime log directory has not been created." };
  }
  const errorMessage = await shell.openPath(logsDirectory);
  return errorMessage
    ? { ok: false, message: errorMessage }
    : { ok: true, message: "" };
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    if (smokeTest) {
      try {
        await ensureServer();
        console.log(`xiaoluo_desktop=ready mode=${desktopMode} url=${appUrl}`);
        app.exit(0);
      } catch (error) {
        console.error(error);
        app.exit(1);
      }
      return;
    }

    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("before-quit", () => {
  shutdownLocalServices();
  shutdownMcp();
  shutdownLocalAi();
shutdownAppServer(); // P21-quit
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
