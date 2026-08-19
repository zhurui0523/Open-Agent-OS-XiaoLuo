/**
 * 本地大模型启动器 —— 持久化状态 v2（Electron 主进程写，Next 服务端读）
 * 状态目录：%APPDATA%/xiaoluo-local-ai（state.json / config.json，原子写入）
 * 二期：state.engine → state.engines = { text, diffusion }（llama.cpp 与 sd.cpp 双引擎并行）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function localAiDirectory() {
  const base =
    process.platform === "win32"
      ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "xiaoluo-local-ai")
      : join(homedir(), ".xiaoluo-local-ai");
  return base;
}
export function statePath() {
  return join(localAiDirectory(), "state.json");
}
export function configPath() {
  return join(localAiDirectory(), "config.json");
}
export function defaultStoragePath() {
  return join(localAiDirectory(), "models");
}

export function emptyEngineState(kind) {
  return {
    kind,
    installed: false,
    engineVersion: "",
    status: "stopped", // stopped | starting | running | crashed
    modelId: null,
    modelName: null,
    modality: null, // text | image | video
    port: 0,
    pid: 0,
    startedAt: null,
    error: "",
  };
}

export function emptyState() {
  return {
    version: 2,
    engines: {
      text: emptyEngineState("text"),
      diffusion: emptyEngineState("diffusion"),
    },
    models: [],
    download: null,
    updatedAt: null,
  };
}

export function defaultConfig() {
  return {
    storagePath: "",
    defaultModelId: "",
    preferredPort: 11435,
    diffusionPort: 12235,
    idleTtlMinutes: 10,
    autostart: false,
  };
}

function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return { ...fallback, ...JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(localAiDirectory(), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, path);
}

export function readState() {
  const state = readJson(statePath(), emptyState());
  // 结构自愈：engines 缺失/损坏时重建
  if (!state.engines || typeof state.engines !== "object") state.engines = {};
  if (!state.engines.text) state.engines.text = emptyEngineState("text");
  if (!state.engines.diffusion) state.engines.diffusion = emptyEngineState("diffusion");
  return state;
}
export function mutateState(mutator) {
  const state = readState();
  mutator(state);
  state.updatedAt = new Date().toISOString();
  writeJsonAtomic(statePath(), state);
  return state;
}
export function readConfig() {
  return readJson(configPath(), defaultConfig());
}
export function mutateConfig(mutator) {
  const config = readConfig();
  mutator(config);
  writeJsonAtomic(configPath(), config);
  return config;
}
