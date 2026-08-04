import { and, asc, desc, eq } from "drizzle-orm";
import { getDb } from "../../db";
import {
  modelConnections,
  modelExecutionAudits,
} from "../../db/schema";
import type { KernelUpstreamInput, NodeKind } from "../types";
import {
  executeModel,
  ModelExecutionError,
  type ExecutorResult,
  type KernelNodeRequest,
} from "./kernel-executors";
import { mysqlExecute, mysqlNow } from "./mysql";
import {
  canAccessRegistryResource,
  modelAccessScope,
} from "./registry-access";
import {
  parseModelInputConstraints,
  validateModelInputAssets,
} from "./model-input-constraints";

type ModelRow = typeof modelConnections.$inferSelect;

export interface ModelRoutingContext {
  workspaceId: string;
  userId: string;
  runId?: string | null;
  nodeId?: string | null;
}

export interface RoutedModelExecution extends ExecutorResult {
  requestedModelId: string;
  actualModelId: string;
  attempts: number;
  fallbackUsed: boolean;
}

function parseModalities(row: ModelRow) {
  try {
    return JSON.parse(row.modalitiesJson) as NodeKind[];
  } catch {
    return [];
  }
}

function isCompatible(row: ModelRow, kind: NodeKind) {
  return row.enabled && parseModalities(row).includes(kind);
}

function isAccessible(row: ModelRow, context: ModelRoutingContext) {
  let uiSchema: Record<string, unknown> = {};
  try {
    uiSchema = JSON.parse(row.uiSchemaJson) as Record<string, unknown>;
  } catch {
    uiSchema = {};
  }
  return canAccessRegistryResource({
    scope: modelAccessScope(uiSchema),
    createdBy: row.createdBy,
    userId: context.userId,
  });
}

function orderedCandidates(
  all: ModelRow[],
  requestedModelId: string,
  kind: NodeKind,
) {
  const byId = new Map(all.map((row) => [row.id, row]));
  const result: ModelRow[] = [];
  const visited = new Set<string>();
  const addWithFallback = (id: string | null) => {
    if (!id || visited.has(id)) return;
    visited.add(id);
    const row = byId.get(id);
    if (!row || !isCompatible(row, kind)) return;
    result.push(row);
    addWithFallback(row.fallbackModelId);
  };
  addWithFallback(requestedModelId);
  all
    .filter((row) => isCompatible(row, kind))
    .sort((left, right) => {
      const health =
        Number(right.state === "healthy") - Number(left.state === "healthy");
      return health || left.priority - right.priority;
    })
    .forEach((row) => addWithFallback(row.id));
  return result.slice(0, 8);
}

async function acquireSlot(modelId: string) {
  const result = await mysqlExecute(
    `UPDATE xiaoluo_v2_model_connections
     SET active_requests = active_requests + 1,
         circuit_state = IF(circuit_state = 'open', 'half_open', circuit_state),
         updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?
       AND enabled = 1
       AND active_requests < max_concurrency
       AND (circuit_state <> 'half_open' OR active_requests = 0)
       AND (
         circuit_state <> 'open'
         OR circuit_opened_at IS NULL
         OR DATE_ADD(
           circuit_opened_at,
           INTERVAL circuit_cooldown_seconds SECOND
         ) <= CURRENT_TIMESTAMP(3)
       )`,
    [modelId],
  );
  return result.affectedRows === 1;
}

async function releaseSlot(modelId: string) {
  await mysqlExecute(
    `UPDATE xiaoluo_v2_model_connections
     SET active_requests = GREATEST(active_requests - 1, 0)
     WHERE id = ?`,
    [modelId],
  );
}

async function markSuccess(modelId: string, latencyMs: number) {
  await mysqlExecute(
    `UPDATE xiaoluo_v2_model_connections
     SET circuit_state = 'closed',
         circuit_failure_count = 0,
         circuit_opened_at = NULL,
         state = 'healthy',
         latency_ms = ?,
         last_success_at = CURRENT_TIMESTAMP(3),
         updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?`,
    [latencyMs, modelId],
  );
}

async function markFailure(modelId: string) {
  await mysqlExecute(
    `UPDATE xiaoluo_v2_model_connections
     SET circuit_failure_count = circuit_failure_count + 1,
         circuit_state = IF(
           circuit_failure_count + 1 >= circuit_failure_threshold,
           'open',
           circuit_state
         ),
         circuit_opened_at = IF(
           circuit_failure_count + 1 >= circuit_failure_threshold,
           CURRENT_TIMESTAMP(3),
           circuit_opened_at
         ),
         state = IF(
           circuit_failure_count + 1 >= circuit_failure_threshold,
           'attention',
           state
         ),
         last_failure_at = CURRENT_TIMESTAMP(3),
         updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?`,
    [modelId],
  );
}

function errorInfo(error: unknown) {
  if (error instanceof ModelExecutionError) {
    return {
      code: error.code,
      message: error.message,
      retryable:
        error.status === 408 ||
        error.status === 409 ||
        error.status === 425 ||
        error.status === 429 ||
        error.status >= 500,
      retryAfterMs: error.retryAfterMs,
    };
  }
  if (error instanceof Error) {
    return {
      code: error.name === "AbortError" ? "ABORTED" : "NETWORK_ERROR",
      message: error.message,
      retryable: error.name !== "AbortError",
      retryAfterMs: null,
    };
  }
  return {
    code: "UNKNOWN_ERROR",
    message: "模型执行失败",
    retryable: false,
    retryAfterMs: null,
  };
}

function wait(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

async function writeUsage(
  context: ModelRoutingContext,
  connectionId: string,
  modality: NodeKind,
  values: {
    total: number;
    success: number;
    failure: number;
    retries: number;
    fallback: number;
  },
) {
  const usageDay = new Date().toISOString().slice(0, 10);
  await mysqlExecute(
    `INSERT INTO xiaoluo_v2_model_usage_stats
      (
        workspace_id, connection_id, usage_day, modality,
        total_count, success_count, failure_count,
        retry_count, fallback_count
      )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       total_count = total_count + VALUES(total_count),
       success_count = success_count + VALUES(success_count),
       failure_count = failure_count + VALUES(failure_count),
       retry_count = retry_count + VALUES(retry_count),
       fallback_count = fallback_count + VALUES(fallback_count),
       updated_at = CURRENT_TIMESTAMP(3)`,
    [
      context.workspaceId,
      connectionId,
      usageDay,
      modality,
      values.total,
      values.success,
      values.failure,
      values.retries,
      values.fallback,
    ],
  );
}

async function writeAudit(input: {
  context: ModelRoutingContext;
  requestedConnectionId: string;
  actualConnectionId: string;
  modelName: string;
  modality: NodeKind;
  status: string;
  attempts: number;
  fallbackUsed: boolean;
  latencyMs?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}) {
  const db = await getDb();
  await db.insert(modelExecutionAudits).values({
    id: `model_audit_${crypto.randomUUID()}`,
    workspaceId: input.context.workspaceId,
    userId: input.context.userId,
    runId: input.context.runId ?? null,
    nodeId: input.context.nodeId ?? null,
    requestedConnectionId: input.requestedConnectionId,
    actualConnectionId: input.actualConnectionId,
    modelName: input.modelName,
    modality: input.modality,
    status: input.status,
    attempts: input.attempts,
    fallbackUsed: input.fallbackUsed,
    latencyMs: input.latencyMs ?? null,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage?.slice(0, 1000) ?? null,
    createdAt: mysqlNow(),
    completedAt: mysqlNow(),
  });
}

export async function recordAsyncModelCompletion(input: {
  context: ModelRoutingContext;
  connectionId: string;
  modelName: string;
  modality: NodeKind;
  succeeded: boolean;
  error?: string;
}) {
  await Promise.all([
    writeUsage(input.context, input.connectionId, input.modality, {
      total: 0,
      success: input.succeeded ? 1 : 0,
      failure: input.succeeded ? 0 : 1,
      retries: 0,
      fallback: 0,
    }),
    writeAudit({
      context: input.context,
      requestedConnectionId: input.connectionId,
      actualConnectionId: input.connectionId,
      modelName: input.modelName,
      modality: input.modality,
      status: input.succeeded ? "async_succeeded" : "async_failed",
      attempts: 1,
      fallbackUsed: false,
      errorCode: input.succeeded ? null : "ASYNC_JOB_FAILED",
      errorMessage: input.error ?? null,
    }),
  ]);
}

export async function invokeRoutedModel(
  requestedModelId: string,
  node: KernelNodeRequest,
  inputs: KernelUpstreamInput[],
  context: ModelRoutingContext,
  signal?: AbortSignal,
): Promise<RoutedModelExecution> {
  const db = await getDb();
  const all = await db
    .select()
    .from(modelConnections)
    .where(
      and(
        eq(modelConnections.workspaceId, context.workspaceId),
        eq(modelConnections.enabled, true),
      ),
    )
    .orderBy(
      asc(modelConnections.priority),
      desc(modelConnections.updatedAt),
    );
  const candidates = orderedCandidates(
    all.filter((row) => isAccessible(row, context)),
    requestedModelId,
    node.kind,
  );
  if (!candidates.length) {
    throw new Error(`没有可用的${node.kind}模型连接`);
  }

  let totalAttempts = 0;
  let lastError: unknown = new Error("没有模型完成请求");
  let lastModel = candidates[0];
  candidateLoop: for (const [candidateIndex, model] of candidates.entries()) {
    lastModel = model;
    let attemptedCurrentCandidate = false;
    const inputValidation = validateModelInputAssets(
      parseModelInputConstraints(
        model.inputConstraintsJson,
        node.kind,
        model.protocol,
      ),
      inputs,
    );
    if (!inputValidation.valid) {
      lastError = new ModelExecutionError(
        inputValidation.errors.join("；"),
        { status: 400, code: "MODEL_INPUT_CONSTRAINT" },
      );
      continue;
    }
    const maxAttempts = Math.max(1, Math.min(5, model.retryLimit));
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const acquired = await acquireSlot(model.id);
      if (!acquired) {
        if (!attemptedCurrentCandidate) {
          lastError = new ModelExecutionError("模型正在限流或熔断中", {
            status: 429,
            code: "MODEL_UNAVAILABLE",
          });
        }
        break;
      }
      attemptedCurrentCandidate = true;
      const startedAt = Date.now();
      totalAttempts += 1;
      try {
        const execution = await executeModel(model, node, inputs, signal, {
          workspaceId: context.workspaceId,
        });
        const latencyMs = Date.now() - startedAt;
        await markSuccess(model.id, latencyMs);
        const fallbackUsed = candidateIndex > 0;
        const status = execution.asyncJob ? "submitted" : "succeeded";
        await Promise.all([
          writeUsage(context, model.id, node.kind, {
            total: 1,
            success: execution.asyncJob ? 0 : 1,
            failure: 0,
            retries: Math.max(0, totalAttempts - 1),
            fallback: fallbackUsed ? 1 : 0,
          }),
          writeAudit({
            context,
            requestedConnectionId: requestedModelId,
            actualConnectionId: model.id,
            modelName: model.modelName,
            modality: node.kind,
            status,
            attempts: totalAttempts,
            fallbackUsed,
            latencyMs,
          }),
        ]);
        return {
          ...execution,
          requestedModelId,
          actualModelId: model.id,
          attempts: totalAttempts,
          fallbackUsed,
        };
      } catch (error) {
        lastError = error;
        const info = errorInfo(error);
        const credentialFailure =
          info.code === "MODEL_CREDENTIAL_MISSING" ||
          info.code === "MODEL_CREDENTIAL_DECRYPT_FAILED";
        if (!credentialFailure) {
          await markFailure(model.id);
        }
        if (credentialFailure) {
          break candidateLoop;
        }
        if (!info.retryable || attempt >= maxAttempts) break;
        const exponential = Math.min(8_000, 500 * 2 ** (attempt - 1));
        const delay = Math.min(
          10_000,
          Math.max(exponential, info.retryAfterMs ?? 0),
        );
        await wait(delay + Math.floor(Math.random() * 250), signal);
      } finally {
        await releaseSlot(model.id);
      }
    }
  }

  const info = errorInfo(lastError);
  await Promise.all([
    writeUsage(context, lastModel.id, node.kind, {
      total: 1,
      success: 0,
      failure: 1,
      retries: Math.max(0, totalAttempts - 1),
      fallback: candidates.length > 1 ? 1 : 0,
    }),
    writeAudit({
      context,
      requestedConnectionId: requestedModelId,
      actualConnectionId: lastModel.id,
      modelName: lastModel.modelName,
      modality: node.kind,
      status: "failed",
      attempts: Math.max(1, totalAttempts),
      fallbackUsed: candidates.length > 1,
      errorCode: info.code,
      errorMessage: info.message,
    }),
  ]);
  throw lastError;
}
