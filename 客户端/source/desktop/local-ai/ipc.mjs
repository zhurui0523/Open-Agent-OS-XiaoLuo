/**
 * 本地大模型启动器 IPC（二期）：单通道 local-ai（action 分发）+ local-ai:event 事件推送。
 * engines 映射（text/diffusion 双引擎）、多文件模型清单、硬件门禁、TTL/自启配置。
 */
import { ipcMain, BrowserWindow, app, dialog } from "electron";
import { join } from "node:path";
import { mkdirSync, existsSync, unlinkSync, statSync } from "node:fs";
import {
  mutateState, readState, readConfig, mutateConfig, defaultStoragePath, localAiDirectory,
  customModels, resolveModel,
} from "./state.mjs";
import { detectHardware } from "./hardware.mjs";
import { ENGINE_VERSION, MODEL_MANIFEST, modelById, modelFiles, modelSizeBytes, primaryFileName, recommendedModelId, modelGate } from "./manifest.mjs";
import {
  startDownload, pauseDownload, resumeDownload, cancelDownload, getDownloadTask, setDownloadEventSink,
} from "./downloader.mjs";
import { startModel, stopEngine, notifyActivity, shutdownRuntime, engineInfo, setRuntimeEventSink } from "./runtime.mjs";

function broadcast(event) {
  for (const win of BrowserWindow.getAllWindows()) {
    try { win.webContents.send("local-ai:event", event); } catch {}
  }
}

function storagePathOf(config) {
  return config.storagePath || defaultStoragePath();
}

function customModelEntries() {
  return customModels().map((model) => {
    const exists = Boolean(model.filePath) && existsSync(model.filePath);
    const size = exists ? statSync(model.filePath).size : 0;
    return {
      id: model.id,
      name: model.name,
      modality: model.modality || "text",
      description: "自定义模型 · " + (model.filePath || "未指定文件"),
      minTier: "custom",
      license: "",
      confirmHuge: false,
      context: model.context || 8192,
      fileCount: 1,
      fileName: model.filePath ? model.filePath.split(/[\\/]/).pop() : "",
      sizeBytes: size,
      installed: exists,
      downloadedBytes: size,
      downloading: false,
      gate: exists
        ? { ok: true, reason: "" }
        : { ok: false, reason: "模型文件不存在：" + (model.filePath || "未指定") },
      custom: true,
      filePath: model.filePath || "",
    };
  });
}

function installedModels(config, hardware) {
  const dir = storagePathOf(config);
  return MODEL_MANIFEST.map((model) => {
    const files = modelFiles(model);
    const fileStates = files.map((file) => {
      const filePath = join(dir, file.fileName);
      const exists = existsSync(filePath);
      return { fileName: file.fileName, exists, size: exists ? statSync(filePath).size : 0 };
    });
    const installed = files.length > 0 && fileStates.every((f) => f.exists);
    const gate = modelGate(hardware, model);
    return {
      id: model.id,
      name: model.name,
      modality: model.modality,
      description: model.description,
      minTier: model.minTier,
      license: model.license || "",
      confirmHuge: Boolean(model.confirmHuge),
      context: model.context || 0,
      fileCount: files.length,
      fileName: primaryFileName(model),
      sizeBytes: modelSizeBytes(model),
      installed,
      downloadedBytes: fileStates.reduce((sum, f) => sum + f.size, 0),
      downloading: Boolean(getDownloadTask(model.id)),
      gate,
    };
  }).concat(customModelEntries());
}

export async function buildSnapshot() {
  const config = readConfig();
  const storage = storagePathOf(config);
  const hardware = await detectHardware(storage);
  const state = readState();
  const info = engineInfo();
  const engines = {
    text: { ...state.engines.text, ...info.text, engineVersion: ENGINE_VERSION },
    diffusion: { ...state.engines.diffusion, ...info.diffusion, engineVersion: ENGINE_VERSION },
  };
  return {
    engines,
    // 一期兼容别名：engine 指向文本引擎
    engine: engines.text,
    hardware,
    config: { ...config, storagePath: storage },
    models: installedModels(config, hardware),
    recommendedModelId: config.defaultModelId || recommendedModelId(hardware.tier, "text"),
  };
}

export function registerLocalAiIpc() {
  setDownloadEventSink(broadcast);
  setRuntimeEventSink(broadcast);
  ipcMain.handle("local-ai", async (_event, payload) => {
    const action = payload?.action;
    try {
      switch (action) {
        case "status":
          return { ok: true, data: await buildSnapshot() };
        case "install-engine": {
          mkdirSync(localAiDirectory(), { recursive: true });
          const config = readConfig();
          mkdirSync(storagePathOf(config), { recursive: true });
          mutateState((s) => {
            for (const kind of ["text", "diffusion"]) {
              s.engines[kind].installed = true;
              s.engines[kind].engineVersion = ENGINE_VERSION;
            }
          });
          return { ok: true };
        }
        case "set-storage-path": {
          const next = String(payload.path || "").trim();
          if (!next) throw new Error("存储路径不能为空");
          mkdirSync(next, { recursive: true });
          mutateConfig((c) => { c.storagePath = next; });
          return { ok: true };
        }
        case "set-default": {
          mutateConfig((c) => { c.defaultModelId = String(payload.modelId || ""); });
          return { ok: true };
        }
        case "set-config": {
          mutateConfig((c) => {
            if (typeof payload.idleTtlMinutes === "number") c.idleTtlMinutes = payload.idleTtlMinutes;
            if (typeof payload.autostart === "boolean") c.autostart = payload.autostart;
          });
          if (typeof payload.autostart === "boolean") {
            try { app.setLoginItemSettings({ openAtLogin: payload.autostart }); } catch {}
          }
          return { ok: true };
        }
        case "pick-model-file": {
          const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
          const result = await dialog.showOpenDialog(win, {
            title: "选择本地模型文件",
            properties: ["openFile"],
            filters: [{ name: "模型文件", extensions: ["gguf", "bin"] }],
          });
          if (result.canceled || !result.filePaths.length) return { ok: false, message: "已取消选择" };
          return { ok: true, data: { filePath: result.filePaths[0] } };
        }
        case "add-custom-model": {
          const filePath = String(payload.filePath || "").trim();
          if (!filePath) throw new Error("请选择模型文件");
          if (!existsSync(filePath)) throw new Error("模型文件不存在：" + filePath);
          if (!/\.(gguf|bin)$/i.test(filePath)) throw new Error("仅支持 .gguf / .bin 模型文件");
          const name = String(payload.name || "").trim()
            || filePath.split(/[\\/]/).pop().replace(/\.(gguf|bin)$/i, "");
          const context = Number(payload.context) > 0 ? Number(payload.context) : 8192;
          const id = "custom-" + Date.now().toString(36);
          mutateConfig((c) => {
            if (!Array.isArray(c.customModels)) c.customModels = [];
            c.customModels.push({
              id,
              name,
              modality: "text",
              context,
              filePath,
              addedAt: new Date().toISOString(),
            });
          });
          return { ok: true, data: { id } };
        }
        case "download-model": {
          const model = modelById(String(payload.modelId || ""));
          if (!model) throw new Error("模型不存在");
          const config = readConfig();
          await startDownload(model, storagePathOf(config));
          return { ok: true };
        }
        case "pause-download":
          pauseDownload(String(payload.modelId || ""));
          return { ok: true };
        case "resume-download":
          resumeDownload(String(payload.modelId || ""));
          return { ok: true };
        case "cancel-download":
          cancelDownload(String(payload.modelId || ""));
          return { ok: true };
        case "start-model": {
          const engine = await startModel(String(payload.modelId || ""));
          return { ok: true, data: engine };
        }
        case "stop-engine": {
          const kind = payload.kind === "diffusion" || payload.kind === "text" ? payload.kind : undefined;
          await stopEngine(kind);
          return { ok: true };
        }
        case "delete-model": {
          const modelId = String(payload.modelId || "");
          // 自定义模型：仅移除注册信息，不删除用户本地文件
          if (customModels().some((m) => m.id === modelId)) {
            mutateConfig((c) => {
              c.customModels = (c.customModels || []).filter((m) => m.id !== modelId);
            });
            return { ok: true };
          }
          const model = modelById(modelId);
          if (!model) throw new Error("模型不存在");
          const config = readConfig();
          for (const file of modelFiles(model)) {
            const filePath = join(storagePathOf(config), file.fileName);
            if (existsSync(filePath)) unlinkSync(filePath);
            const partPath = filePath + ".part";
            if (existsSync(partPath)) unlinkSync(partPath);
          }
          return { ok: true };
        }
        case "notify-activity": {
          const kind = payload.kind === "diffusion" || payload.kind === "text" ? payload.kind : undefined;
          notifyActivity(kind);
          return { ok: true };
        }
        default:
          throw new Error("未知操作：" + action);
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });
}

export function shutdownLocalAi() {
  shutdownRuntime();
}
