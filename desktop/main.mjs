import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
  startingDev: "\u6b63\u5728\u542f\u52a8\u5c0f\u903b\u5f00\u53d1\u73af\u5883",
  firstStart:
    "\u9996\u6b21\u542f\u52a8\u53ef\u80fd\u9700\u8981\u51e0\u5341\u79d2\uff0c\u8bf7\u4e0d\u8981\u5173\u95ed\u7a97\u53e3\u3002",
  cloudUnavailable:
    "\u6682\u65f6\u65e0\u6cd5\u8fde\u63a5\u5c0f\u903b\u4e91\u7aef\u3002\u8bf7\u68c0\u67e5\u7f51\u7edc\u540e\u91cd\u8bd5\uff1b\u82e5\u7f51\u7edc\u6b63\u5e38\uff0c\u670d\u52a1\u53ef\u80fd\u6b63\u5728\u7ef4\u62a4\u3002",
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
const healthUrl = appUrl
  ? new URL(String(productionConfig.healthPath || "/api/v2/health/live"), appUrl)
  : null;

let mainWindow = null;
let startupPromise = null;
let loadingStatusReady = false;
let lastStatus = {
  phase: "checking",
  mode: desktopMode,
  title: desktopMode === "production" ? copy.connectingCloud : copy.checkingLocal,
  detail: copy.pleaseWait,
};

app.setName(copy.appName);
app.setAppUserModelId("cn.luosheji.xiaoluo.desktop");

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function updateStatus(nextStatus) {
  lastStatus = { ...lastStatus, ...nextStatus, mode: desktopMode };
  if (loadingStatusReady && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("desktop:status", lastStatus);
  }
}

async function endpointIsReady(url, timeoutMs = 2_500) {
  if (!url) return false;
  try {
    const response = await fetch(url, {
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function serverIsReady(timeoutMs = 2_500) {
  if (!appUrl || !healthUrl) return false;
  const [healthReady, pageReady] = await Promise.all([
    endpointIsReady(healthUrl, timeoutMs),
    endpointIsReady(appUrl, timeoutMs),
  ]);
  return healthReady && pageReady;
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

  if (await serverIsReady(8_000)) {
    updateStatus({
      phase: "ready",
      title: copy.cloudReady,
      detail: copy.openingWorkbench,
    });
    return;
  }

  throw new Error(copy.cloudUnavailable);
}

async function ensureLocalServer() {
  if (await serverIsReady()) {
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
    if (await serverIsReady(2_000)) {
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
    await showStatusPage({
      phase: "error",
      title:
        desktopMode === "production"
          ? "\u65e0\u6cd5\u8fde\u63a5\u5c0f\u903b\u4e91\u7aef"
          : "\u5c0f\u903b\u542f\u52a8\u5931\u8d25",
      detail: message,
    });
  }
}

function recoverFromPageFailure(title, detail) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  void showStatusPage({ phase: "error", title, detail });
}

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
  mainWindow.webContents.on("render-process-gone", () => {
    recoverFromPageFailure(copy.rendererGone, copy.rendererGoneDetail);
  });
  mainWindow.on("unresponsive", () => {
    recoverFromPageFailure(copy.unresponsive, copy.unresponsiveDetail);
  });

  void loadWorkbench();
}

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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
