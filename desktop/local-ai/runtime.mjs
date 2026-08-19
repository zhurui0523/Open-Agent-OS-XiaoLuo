/**
 * 双引擎生命周期（二期）：text=llama-server（对话），diffusion=sd-server（图片/视频）。
 * 端口占用自动切换、健康轮询、崩溃/显存不足标记、空闲 TTL 自动停止、进程树杀除。
 * 引擎二进制查找顺序：环境变量覆盖 → desktop/runtime-local-ai/ → mock 兜底。
 */
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { NODE_EXE } from "./paths.mjs";
import { mutateState, readConfig, readState } from "./state.mjs";
import { detectHardware } from "./hardware.mjs";
import { modelById, modelFiles, primaryFileName } from "./manifest.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = join(__dirname, "..");

const KINDS = ["text", "diffusion"];
const children = { text: null, diffusion: null };
const failCounts = { text: 0, diffusion: 0 };
const lastActivity = { text: Date.now(), diffusion: Date.now() };
let healthTimer = null;
let eventSink = () => {};
export function setRuntimeEventSink(fn) { eventSink = fn; }

function binaryFor(kind) {
  if (kind === "diffusion") {
    const override = process.env.XIAOLUO_SD_SERVER?.trim();
    if (override && existsSync(override)) return { kind: "real", path: override };
    const bundled = join(desktopDir, "runtime-local-ai", "sd-server.exe");
    if (existsSync(bundled)) return { kind: "real", path: bundled };
    return { kind: "mock", path: join(desktopDir, "local-ai", "mock-diffusion.mjs") };
  }
  const override = process.env.XIAOLUO_LLAMA_SERVER?.trim();
  if (override && existsSync(override)) return { kind: "real", path: override };
  const bundled = join(desktopDir, "runtime-local-ai", "llama-server.exe");
  if (existsSync(bundled)) return { kind: "real", path: bundled };
  return { kind: "mock", path: join(desktopDir, "local-ai", "mock-engine.mjs") };
}

export function engineInfo() {
  const info = {};
  for (const kind of KINDS) {
    const binary = binaryFor(kind);
    info[kind] = {
      binaryKind: binary.kind,
      binaryPath: binary.path,
      available: binary.kind === "real" ? true : existsSync(binary.path),
    };
  }
  return info;
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function pickPort(preferred) {
  for (let offset = 0; offset <= 20; offset += 1) {
    const candidate = preferred + offset;
    if (await portFree(candidate)) return candidate;
  }
  throw new Error("找不到可用端口（" + preferred + "~" + (preferred + 20) + " 均被占用）");
}

async function probeOnce(port) {
  // /health 优先（llama-server / mock）；sd-server 无 /health 时以任意 HTTP 响应判活
  for (const path of ["/health", "/"]) {
    try {
      const res = await fetch("http://127.0.0.1:" + port + path, { signal: AbortSignal.timeout(2000) });
      if (path === "/health") return res.ok;
      if (res.status > 0) return true;
    } catch (error) {
      if (path === "/" && error && error.name !== "TimeoutError" && error.cause && String(error.cause?.code || "").includes("ECONNREFUSED")) return false;
    }
  }
  return false;
}

async function waitHealthy(port, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeOnce(port)) return true;
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

function gpuLayersFor(tier) {
  if (tier === "high") return "99";
  if (tier === "balanced") return "33";
  return "0";
}

/** sd.cpp 参数按文件 role 组装：model→-m，text-encoder/vae/audio-vae→对应开关 */
function diffusionArgsFor(model, storagePath) {
  const roleFlag = {
    model: "-m",
    "text-encoder": "--text-encoder",
    vae: "--vae",
    "audio-vae": "--audio-vae",
  };
  const args = [];
  for (const file of modelFiles(model)) {
    const flag = roleFlag[file.role];
    if (!flag) continue;
    args.push(flag, join(storagePath, file.fileName));
  }
  return args;
}

function killProcess(proc) {
  return new Promise((resolve) => {
    if (!proc || !proc.pid) return resolve();
    if (process.platform === "win32") {
      execFile("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true }, () => resolve());
    } else {
      try { proc.kill("SIGTERM"); } catch {}
      resolve();
    }
  });
}

export async function startModel(modelId) {
  const state = readState();
  const model = modelById(modelId);
  if (!model) throw new Error("模型不在内置清单中：" + modelId);
  const kind = model.modality === "text" ? "text" : "diffusion";
  if (state.engines[kind].status === "running" && state.engines[kind].modelId === modelId) {
    return state.engines[kind];
  }
  await stopEngine(kind, true);
  const config = readConfig();
  const storagePath = config.storagePath || join(desktopDir, "..", ".xiaoluo-local-ai", "models");
  const binary = binaryFor(kind);
  if (binary.kind === "real") {
    for (const file of modelFiles(model)) {
      if (!existsSync(join(storagePath, file.fileName))) {
        throw new Error("模型文件尚未下载完成：" + file.fileName);
      }
    }
  }
  const preferred = kind === "diffusion" ? (config.diffusionPort || 12235) : (config.preferredPort || 11435);
  const port = await pickPort(preferred);
  mutateState((s) => {
    const engine = s.engines[kind];
    engine.status = "starting";
    engine.modelId = modelId;
    engine.modelName = model.name;
    engine.modality = model.modality;
    engine.port = port;
    engine.error = "";
  });
  const hardware = await detectHardware(storagePath);
  let proc;
  let args;
  if (binary.kind === "real" && kind === "text") {
    args = ["--model", join(storagePath, primaryFileName(model)), "--host", "127.0.0.1", "--port", String(port), "--ctx-size", String(model.context || 8192), "--n-gpu-layers", gpuLayersFor(hardware.tier), "--alias", modelId];
    proc = spawn(binary.path, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  } else if (binary.kind === "real") {
    args = [...diffusionArgsFor(model, storagePath), "--host", "127.0.0.1", "--port", String(port)];
    proc = spawn(binary.path, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  } else {
    const mockScript = binary.path;
    proc = spawn(NODE_EXE, [mockScript], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        XIAOLUO_MOCK_PORT: String(port),
        XIAOLUO_MOCK_ALIAS: modelId,
        XIAOLUO_MOCK_MODALITY: model.modality,
      },
    });
  }
  children[kind] = proc;
  let stderrTail = "";
  proc.stderr?.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    // 显存不足检测（三期）：OOM/CUDA 关键字 → 标记引擎错误
    if (/out of memory|cuda error|vk error|insufficient.*memory|oom/i.test(chunk.toString())) {
      mutateState((s) => {
        s.engines[kind].error = "显存/内存不足：建议换用更小量化模型或降低分辨率";
      });
      eventSink({ type: "engine-oom", kind, modelId });
    }
  });
  proc.on("exit", (code) => {
    if (children[kind] === proc) {
      children[kind] = null;
      mutateState((s) => {
        s.engines[kind].status = "stopped";
        s.engines[kind].pid = 0;
        if (code && code !== 0) s.engines[kind].error = "引擎进程退出（code " + code + "）";
      });
      eventSink({ type: "engine-stopped", kind, modelId, code });
    }
  });
  const healthy = await waitHealthy(port, kind === "diffusion" ? 120000 : 60000);
  if (!healthy) {
    await killProcess(proc);
    children[kind] = null;
    mutateState((s) => {
      s.engines[kind].status = "crashed";
      s.engines[kind].error = "引擎启动失败（健康检查超时）" + (stderrTail ? "：" + stderrTail.slice(-300) : "");
      s.engines[kind].pid = 0;
    });
    throw new Error("引擎启动失败（健康检查超时）");
  }
  lastActivity[kind] = Date.now();
  const engine = mutateState((s) => {
    s.engines[kind].status = "running";
    s.engines[kind].pid = proc.pid || 0;
    s.engines[kind].startedAt = new Date().toISOString();
    s.engines[kind].error = "";
  }).engines[kind];
  startMonitors();
  eventSink({ type: "engine-running", kind, modelId, port });
  return engine;
}

export async function stopEngine(kind, silent = false) {
  const kinds = kind ? [kind] : KINDS;
  for (const k of kinds) {
    const proc = children[k];
    children[k] = null;
    await killProcess(proc);
    const current = readState().engines[k];
    mutateState((s) => {
      s.engines[k].status = "stopped";
      s.engines[k].pid = 0;
      s.engines[k].modelId = null;
      s.engines[k].modality = null;
      s.engines[k].port = 0;
      if (!silent) s.engines[k].error = "";
    });
    if (!silent) eventSink({ type: "engine-stopped", kind: k, modelId: current.modelId, code: 0 });
  }
  const anyRunning = KINDS.some((k) => children[k]);
  if (!anyRunning) stopMonitors();
  return readState().engines[kinds[0]];
}

function startMonitors() {
  stopMonitors();
  healthTimer = setInterval(async () => {
    const state = readState();
    const config = readConfig();
    for (const kind of KINDS) {
      const engine = state.engines[kind];
      if (engine.status !== "running" || !engine.port) continue;
      const alive = await probeOnce(engine.port);
      failCounts[kind] = alive ? 0 : failCounts[kind] + 1;
      if (failCounts[kind] >= 3) {
        failCounts[kind] = 0;
        mutateState((s) => {
          s.engines[kind].status = "crashed";
          s.engines[kind].error = "引擎健康检查连续失败，已标记为崩溃";
        });
        eventSink({ type: "engine-crashed", kind });
        continue;
      }
      // 空闲 TTL 自动停止（按引擎独立计时）
      const ttlMinutes = config.idleTtlMinutes;
      if (ttlMinutes > 0 && Date.now() - lastActivity[kind] > ttlMinutes * 60000) {
        eventSink({ type: "engine-idle-stop", kind });
        void stopEngine(kind);
      }
    }
  }, 30000);
  healthTimer.unref?.();
}

function stopMonitors() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
}

export function notifyActivity(kind) {
  if (kind && lastActivity[kind] !== undefined) {
    lastActivity[kind] = Date.now();
  } else {
    for (const k of KINDS) lastActivity[k] = Date.now();
  }
}

export function shutdownRuntime() {
  stopMonitors();
  for (const kind of KINDS) {
    const proc = children[kind];
    children[kind] = null;
    void killProcess(proc);
  }
}
