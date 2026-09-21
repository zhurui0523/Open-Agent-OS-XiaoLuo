/**
 * 本地大模型启动器 —— 服务端桥接。
 * 读取 Electron 主进程写入的状态文件（%APPDATA%/xiaoluo-local-ai/state.json），
 * 探测引擎健康，并把运行中的本地引擎注册为 provider: "local" 的 ModelConnection。
 * 二期：state 升级为 engines = { text, diffusion } 双引擎结构（兼容一期单 engine 字段）。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { and, eq, like } from "drizzle-orm";
import { getDb } from "../../db";
import { modelConnections } from "../../db/schema";
import type { ModelInputConstraints, NodeKind } from "../types";
import { mysqlNow } from "./mysql";
import { normalizeModelInputConstraints } from "./model-input-constraints";

export type LocalAiEngineKind = "text" | "diffusion";

export interface LocalAiEngineState {
  kind?: LocalAiEngineKind;
  installed: boolean;
  engineVersion: string;
  status: string;
  modelId: string | null;
  modelName?: string | null;
  modality?: string | null;
  port: number;
  pid: number;
  startedAt: string | null;
  error: string;
}

export interface LocalAiState {
  version: number;
  engines: Record<LocalAiEngineKind, LocalAiEngineState>;
  models: Array<Record<string, unknown>>;
  download: unknown;
  updatedAt: string | null;
}

const EMPTY_ENGINE: LocalAiEngineState = {
  installed: false,
  engineVersion: "",
  status: "stopped",
  modelId: null,
  modelName: null,
  modality: null,
  port: 0,
  pid: 0,
  startedAt: null,
  error: "",
};

export function localAiDirectory(): string {
  if (process.env.LOCAL_AI_DIR?.trim()) return process.env.LOCAL_AI_DIR.trim();
  if (process.platform === "win32") {
    const base = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return join(base, "xiaoluo-local-ai");
  }
  return join(homedir(), ".xiaoluo-local-ai");
}

// 一期 state 只有 engine（文本引擎）字段：归一化为 engines.text
function normalizeEngines(raw: unknown): Record<LocalAiEngineKind, LocalAiEngineState> {
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const legacy = (record.engine && typeof record.engine === "object"
    ? record.engine
    : null) as LocalAiEngineState | null;
  const engines = (record.engines && typeof record.engines === "object"
    ? record.engines
    : {}) as Record<string, unknown>;
  const merge = (kind: LocalAiEngineKind): LocalAiEngineState => {
    const base = (engines[kind] && typeof engines[kind] === "object"
      ? engines[kind]
      : kind === "text" && legacy
        ? legacy
        : {}) as Partial<LocalAiEngineState>;
    return { ...EMPTY_ENGINE, ...base, kind };
  };
  return { text: merge("text"), diffusion: merge("diffusion") };
}

export function readLocalAiState(): LocalAiState | null {
  const path = join(localAiDirectory(), "state.json");
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return {
      version: typeof raw.version === "number" ? raw.version : 1,
      engines: normalizeEngines(raw),
      models: Array.isArray(raw.models) ? (raw.models as Array<Record<string, unknown>>) : [],
      download: raw.download ?? null,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : null,
    };
  } catch {
    return null;
  }
}

function writeLocalAiEnginePatch(kind: LocalAiEngineKind, patchBody: Partial<LocalAiEngineState>) {
  const path = join(localAiDirectory(), "state.json");
  if (!existsSync(path)) return;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const engines = normalizeEngines(raw);
    engines[kind] = { ...engines[kind], ...patchBody, kind };
    raw.engines = engines;
    raw.updatedAt = new Date().toISOString();
    writeFileSync(path, JSON.stringify(raw, null, 2), "utf8");
  } catch {
    /* 状态文件不可写时静默（不影响主流程） */
  }
}

export async function probeEngineHealth(port: number, kind: LocalAiEngineKind = "text"): Promise<boolean> {
  const probe = async (path: string) => {
    try {
      const res = await fetch("http://127.0.0.1:" + port + path, {
        signal: AbortSignal.timeout(2500),
      });
      return { alive: true, ok: res.ok };
    } catch {
      return { alive: false, ok: false };
    }
  };
  const health = await probe("/health");
  if (health.ok) return true;
  if (kind === "diffusion") {
    // sd-server 未必实现 /health：任意 HTTP 响应（含 404）即视为存活
    return (await probe("/")).alive;
  }
  return false;
}

function localModelMarker(modelId: string) {
  return '"localModelId":"' + modelId + '"';
}

async function findLocalConnection(workspaceId: string, modelId: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(modelConnections)
    .where(
      and(
        eq(modelConnections.workspaceId, workspaceId),
        like(modelConnections.uiSchemaJson, "%" + localModelMarker(modelId) + "%"),
      ),
    )
    .limit(1);
  return row ?? null;
}

function diffusionConstraints(modality: string): ModelInputConstraints {
  return normalizeModelInputConstraints(
    { textRequired: true },
    (modality === "video" ? "video" : "image") as NodeKind,
    "local-diffusion",
  );
}

export async function upsertLocalModelConnection(params: {
  workspaceId: string;
  userId: string;
  modelId: string;
  modelName: string;
  port: number;
  modality?: string;
  engine?: LocalAiEngineKind;
}): Promise<string> {
  const db = await getDb();
  const now = mysqlNow();
  const engineKind: LocalAiEngineKind = params.engine ?? "text";
  const modality = params.modality?.trim() || (engineKind === "diffusion" ? "image" : "text");
  // diffusion：回环直连本地 sd 引擎（免 Key、协议 local-diffusion），baseUrl 不带 /v1 前缀
  const protocol = engineKind === "diffusion" ? "local-diffusion" : "openai-compatible";
  const baseUrl =
    engineKind === "diffusion"
      ? "http://127.0.0.1:" + params.port
      : "http://127.0.0.1:" + params.port + "/v1";
  const modalities = engineKind === "diffusion" ? [modality] : ["text"];
  const name = params.modelName + "（本地）";
  const uiSchema = {
    provider: "local",
    localModelId: params.modelId,
    engine: engineKind,
    modelAccessScope: "personal",
  };
  const existing = await findLocalConnection(params.workspaceId, params.modelId);
  if (existing) {
    await db
      .update(modelConnections)
      .set({
        baseUrl,
        name,
        protocol,
        modalitiesJson: JSON.stringify(modalities),
        inputConstraintsJson: JSON.stringify(
          engineKind === "diffusion"
            ? diffusionConstraints(modality)
            : normalizeModelInputConstraints({}, "text", "openai-compatible"),
        ),
        enabled: true,
        state: "healthy",
        lastCheckedAt: now,
        updatedAt: now,
      })
      .where(eq(modelConnections.id, existing.id));
    return existing.id;
  }
  const id = "model_" + crypto.randomUUID();
  await db.insert(modelConnections).values({
    id,
    workspaceId: params.workspaceId,
    createdBy: params.userId,
    name,
    protocol,
    baseUrl,
    modelName: params.modelId,
    modalitiesJson: JSON.stringify(modalities),
    parameterSchemaJson: JSON.stringify({ type: "object", properties: {} }),
    uiSchemaJson: JSON.stringify(uiSchema),
    inputConstraintsJson: JSON.stringify(
      engineKind === "diffusion"
        ? diffusionConstraints(modality)
        : normalizeModelInputConstraints({}, "text", "openai-compatible"),
    ),
    capabilityTagsJson: JSON.stringify(["local"]),
    credentialRef: "LOCAL_AI",
    secretRefId: null,
    priority: 200,
    fallbackModelId: null,
    maxConcurrency: 2,
    retryLimit: 3,
    circuitFailureThreshold: 5,
    circuitCooldownSeconds: 60,
    state: "healthy",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function disableLocalModelConnection(
  workspaceId: string,
  modelId: string,
) {
  const existing = await findLocalConnection(workspaceId, modelId);
  if (!existing) return;
  const db = await getDb();
  await db
    .update(modelConnections)
    .set({ enabled: false, state: "attention", updatedAt: mysqlNow() })
    .where(eq(modelConnections.id, existing.id));
}

export interface LocalAiEngineSummary {
  kind: LocalAiEngineKind;
  healthy: boolean;
  registeredModelId: string | null;
}

/**
 * 按状态文件同步本地模型连接（遍历 text/diffusion 双引擎）：
 * 引擎运行且健康 → upsert 为 healthy；运行但不健康 → 标记崩溃并禁用；未运行 → 禁用。
 */
export async function syncLocalModelConnections(
  workspaceId: string,
  userId: string,
): Promise<{
  available: boolean;
  engines: Record<LocalAiEngineKind, LocalAiEngineSummary>;
  healthy: boolean;
  registeredModelId: string | null;
  engine: LocalAiEngineState | null;
}> {
  const none: Record<LocalAiEngineKind, LocalAiEngineSummary> = {
    text: { kind: "text", healthy: false, registeredModelId: null },
    diffusion: { kind: "diffusion", healthy: false, registeredModelId: null },
  };
  const state = readLocalAiState();
  if (!state) {
    return { available: false, engines: none, healthy: false, registeredModelId: null, engine: null };
  }
  const engines = state.engines;
  const summary: Record<LocalAiEngineKind, LocalAiEngineSummary> = { ...none };
  for (const kind of ["text", "diffusion"] as LocalAiEngineKind[]) {
    const engine = engines[kind];
    if (engine.status === "running" && engine.port && engine.modelId) {
      const healthy = await probeEngineHealth(engine.port, kind);
      if (healthy) {
        const id = await upsertLocalModelConnection({
          workspaceId,
          userId,
          modelId: engine.modelId,
          modelName: engine.modelName || engine.modelId,
          port: engine.port,
          modality: engine.modality || (kind === "diffusion" ? "image" : "text"),
          engine: kind,
        });
        summary[kind] = { kind, healthy: true, registeredModelId: id };
        continue;
      }
      writeLocalAiEnginePatch(kind, {
        status: "crashed",
        error: "服务端健康探测失败，引擎可能已退出",
      });
      await disableLocalModelConnection(workspaceId, engine.modelId);
      continue;
    }
    if (engine.modelId) {
      await disableLocalModelConnection(workspaceId, engine.modelId);
    }
  }
  return {
    available: true,
    engines: summary,
    healthy: summary.text.healthy,
    registeredModelId: summary.text.registeredModelId,
    engine: engines.text,
  };
}
