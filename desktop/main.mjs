import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  session,
  shell,
} from "electron";
import { handleCommandPayload, handleDeployPayload, handleFsPayload, handleFetchPayload, handleServicePayload, initLocalRuntime, shutdownLocalServices } from "./local-runtime.mjs";
import { handleMcpPayload, initMcpRuntime, shutdownMcp } from "./mcp-runtime.mjs";
import { registerLocalAiIpc, shutdownLocalAi } from "./local-ai/ipc.mjs";

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
  appName: "\u5c0f\u903b",
  windowTitle: "\u5c0f\u903b\u5de5\u4f5c\u53f0",
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
  : forceProduction || app.isPackaged
    ? "production"
    : "development";
const configuredUrl =
  process.env.XIAOLUO_DESKTOP_URL?.trim() ||
  (desktopMode === "production"
    ? String(productionConfig.appUrl || "").trim()
    : "http://127.0.0.1:3001/");

function parseAppUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    if (desktopMode === "production" && parsed.protocol !== "https:") return null;
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return parsed;
  } catch {
    return null;
  }
}

const appUrl = parseAppUrl(configuredUrl);
const healthPath =
  desktopMode === "production"
    ? String(productionConfig.healthPath || "/api/v2/health/ready")
    : "/api/v2/health/live";
const healthUrl = appUrl
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

ipcMain.handle("brain:command", (_event, payload) => handleCommandPayload(payload));
ipcMain.handle("brain:fs", (_event, payload) => handleFsPayload(payload));
ipcMain.handle("brain:services", (_event, payload) => handleServicePayload(payload));
ipcMain.handle("brain:deploy", (_event, payload) => handleDeployPayload(payload));
ipcMain.handle("brain:fetch", (_event, payload) => handleFetchPayload(payload));
ipcMain.handle("brain:mcp", (_event, payload) => handleMcpPayload(payload));
ipcMain.handle("desktop:get-status", () => lastStatus);
ipcMain.handle("desktop:get-meta", () => ({
  mode: desktopMode,
  appUrl: appUrl?.toString() || "",
}));
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
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
