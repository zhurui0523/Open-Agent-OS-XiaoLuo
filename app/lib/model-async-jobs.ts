import { and, eq, inArray } from "drizzle-orm";

// 异步任务的总时限：超过后才允许因瞬时错误判失败。此前单纯依赖 pollCount 配额，
// 会被查询/保存阶段的重试快速耗尽，远端实际已成功的任务被误判失败
const MAX_ASYNC_JOB_LIFETIME_MS = 30 * 60_000;
import { getDb } from "../../db";
import {
  assetRelations,
  generationJobs,
  kernelRuns,
  kernelTasks,
  modelConnections,
  runEvents,
} from "../../db/schema";
import type {
  KernelNodeOutput,
  KernelUpstreamInput,
  NodeKind,
} from "../types";
import {
  cancelModelJob,
  ModelExecutionError,
  pollModelJob,
  type KernelNodeRequest,
} from "./kernel-executors";
import { recordAsyncModelCompletion } from "./model-runtime-router";
import { sharedModelWorkspaceIds } from "./organization-workspaces";
import {
  getFileBucket,
  MAX_FILE_BYTES,
  storeAsset,
} from "./asset-kernel";
import {
  fetchExternalEndpoint,
  readResponseBytesLimited,
} from "./model-adapters";
import { mysqlExecute, mysqlNow } from "./mysql";
import { artifactFormat, artifactName } from "./artifact-format";

// 轮询时的瞬时错误（单次请求超时、网络抢失、限流、服务端暂时不可用）：不应终止任务，应重试轮询
function transientPollFailure(error: unknown) {
  // 保存阶段失败（下载产物/上传 OSS）：远端结果已存在，同样属于可重试的瞬时错误
  if (error instanceof Error && error.message.startsWith("保存异步结果失败")) {
    return true;
  }
  if (error instanceof ModelExecutionError) {
    return ["PROVIDER_TIMEOUT", "PROVIDER_NETWORK_ERROR", "RATE_LIMITED", "PROVIDER_UNAVAILABLE"].includes(
      error.code,
    );
  }
  if (error instanceof TypeError) return true;
  // undici 原始超时/中断错误（如结果资产下载或上传 OSS 超时）：按名称与消息逐层判定
  let current: unknown = error;
  for (let depth = 0; current && depth < 3; depth += 1) {
    const err = current as { name?: unknown; message?: unknown; cause?: unknown };
    if (err.name === "TimeoutError" || err.name === "AbortError") return true;
    if (typeof err.message === "string" && /aborted due to timeout/i.test(err.message)) return true;
    current = err.cause ?? null;
  }
  return false;
}

function futureMysql(milliseconds: number) {
  return mysqlNow(new Date(Date.now() + milliseconds));
}

function parsedInput(value: string) {
  const parsed = JSON.parse(value) as {
    request?: KernelNodeRequest;
    node?: KernelNodeRequest;
    inputs?: KernelUpstreamInput[];
  };
  const node = parsed.request ?? parsed.node;
  if (!node) throw new Error("异步任务缺少节点输入");
  return { node, inputs: parsed.inputs ?? [] };
}

async function persistAsyncResult(
  job: typeof generationJobs.$inferSelect,
  node: KernelNodeRequest,
  inputs: KernelUpstreamInput[],
  execution: {
    executor: string;
    result: string;
    output: KernelNodeOutput;
  },
) {
  if (
    execution.output.preview ||
    (!execution.output.assetUrl && !execution.output.text)
  ) {
    return execution;
  }
  let bytes: ArrayBuffer;
  let mimeType: string;
  if (execution.output.assetUrl) {
    const response = await fetchExternalEndpoint(
      execution.output.assetUrl,
      {},
      60_000,
    );
    if (!response.ok) {
      throw new Error(`无法读取异步生成结果：HTTP ${response.status}`);
    }
    bytes = await readResponseBytesLimited(response, MAX_FILE_BYTES);
    mimeType = artifactFormat(
      node.kind,
      response.headers.get("content-type"),
    ).mimeType;
  } else {
    bytes = new TextEncoder().encode(execution.output.text ?? "").buffer;
    mimeType = artifactFormat("text").mimeType;
  }
  const db = await getDb();
  const asset = await storeAsset(db, await getFileBucket(), {
    workspaceId: job.workspaceId,
    name: artifactName(node.title, node.kind, mimeType),
    mimeType,
    bytes,
    tags: [node.kind, "AI 生成", "异步任务"],
    description: (execution.output.text ?? execution.result).slice(0, 500),
    sourceType: "kernel-output",
    sourceRef: job.id,
    metadata: {
      runId: job.runId,
      nodeId: job.nodeId,
      executor: execution.executor,
      externalJobId: job.externalJobId,
    },
  });
  for (const input of inputs) {
    const value =
      input.output && typeof input.output === "object"
        ? (input.output as { data?: unknown }).data
        : null;
    const sourceAssetId =
      value && typeof value === "object" && "assetId" in value
        ? String((value as { assetId?: unknown }).assetId ?? "")
        : "";
    if (!sourceAssetId) continue;
    await db.insert(assetRelations).values({
      id: `relation_${crypto.randomUUID()}`,
      fromAssetId: sourceAssetId,
      toAssetId: asset.id,
      relationType: "generated-from",
      metadataJson: JSON.stringify({
        runId: job.runId,
        nodeId: job.nodeId,
      }),
      createdAt: mysqlNow(),
    });
  }
  return {
    ...execution,
    output: {
      ...execution.output,
      assetUrl:
        node.kind === "text" ? execution.output.assetUrl : asset.contentUrl,
      data: {
        assetId: asset.id,
        assetUri: asset.uri,
        source: execution.output.data ?? null,
      },
    },
  };
}

export async function pollGenerationJob(jobId: string, workspaceId: string) {
  const db = await getDb();
  const [job] = await db
    .select()
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.id, jobId),
        eq(generationJobs.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!job) throw new Response("生成任务不存在", { status: 404 });
  if (["succeeded", "failed", "canceled"].includes(job.status)) return job;
  const leaseOwner = `generation-poller:${crypto.randomUUID()}`;
  const lease = await mysqlExecute(
    `UPDATE xiaoluo_v2_generation_jobs
     SET lease_owner = ?,
         lease_expires_at = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 90 SECOND),
         updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?
       AND workspace_id = ?
       AND status IN ('submitted', 'running')
       AND next_poll_at IS NOT NULL
       AND next_poll_at <= CURRENT_TIMESTAMP(3)
       AND (
         lease_owner IS NULL
         OR lease_expires_at IS NULL
         OR lease_expires_at <= CURRENT_TIMESTAMP(3)
       )`,
    [leaseOwner, jobId, workspaceId],
  );
  if (lease.affectedRows !== 1) return job;
  const now = mysqlNow();
  let model: typeof modelConnections.$inferSelect | undefined;
  try {
    if (!job.modelConnectionId || !job.pollUrl) {
      throw new Error("异步任务缺少模型连接或查询地址");
    }
    const modelScopeWorkspaceIds = await sharedModelWorkspaceIds(
      workspaceId,
      job.requestedBy ?? "",
    );
    [model] = await db
      .select()
      .from(modelConnections)
      .where(
        and(
          eq(modelConnections.id, job.modelConnectionId),
          inArray(modelConnections.workspaceId, modelScopeWorkspaceIds),
        ),
      )
      .limit(1);
    if (!model) throw new Error("异步任务对应的模型连接不存在");
    const { node, inputs } = parsedInput(job.inputJson);
    if (job.pollCount >= job.maxPolls) {
      throw new Error("异步任务超过最大查询次数");
    }
    const result = await pollModelJob(model, node, job.pollUrl);
    if (!result.complete) {
      const delay = Math.min(30_000, 2_000 + job.pollCount * 1_000);
      await db
        .update(generationJobs)
        .set({
          status: "running",
          progress: Math.max(job.progress, result.progress),
          providerStatus: result.providerStatus,
          pollCount: job.pollCount + 1,
          lastPolledAt: now,
          nextPollAt: futureMysql(delay),
          leaseOwner: null,
          leaseExpiresAt: null,
          outputJson: JSON.stringify(result.execution.output),
          updatedAt: now,
        })
        .where(eq(generationJobs.id, job.id));
      return {
        ...job,
        status: "running",
        progress: Math.max(job.progress, result.progress),
        providerStatus: result.providerStatus,
      };
    }

    let persisted: Awaited<ReturnType<typeof persistAsyncResult>>;
    try {
      persisted = await persistAsyncResult(
        job,
        node,
        inputs,
        result.execution,
      );
    } catch (persistError) {
      const detail =
        persistError instanceof Error
          ? persistError.message
          : "未知错误";
      throw new Error(`保存异步结果失败（将自动重试）：${detail}`);
    }
    const outputJson = JSON.stringify({
      ...persisted.output,
      result: persisted.result,
    });
    await Promise.all([
      db
        .update(generationJobs)
        .set({
          status: "succeeded",
          progress: 100,
          providerStatus: result.providerStatus,
          pollCount: job.pollCount + 1,
          lastPolledAt: now,
          nextPollAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          outputJson,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(generationJobs.id, job.id)),
      job.runId && job.nodeId
        ? db
            .update(kernelTasks)
            .set({
              status: "succeeded",
              outputJson,
              executor: persisted.executor,
              error: null,
              completedAt: now,
              leaseOwner: null,
              leaseExpiresAt: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(kernelTasks.runId, job.runId),
                eq(kernelTasks.nodeId, job.nodeId),
              ),
            )
        : Promise.resolve(),
      job.runId
        ? db.insert(runEvents).values({
            id: `event_${crypto.randomUUID()}`,
            runId: job.runId,
            eventType: "task.async_succeeded",
            nodeId: job.nodeId,
            payloadJson: JSON.stringify({
              generationJobId: job.id,
              executor: persisted.executor,
            }),
            createdAt: now,
          })
        : Promise.resolve(),
      recordAsyncModelCompletion({
        context: {
          workspaceId,
          userId: job.requestedBy,
          runId: job.runId,
          nodeId: job.nodeId,
        },
        connectionId: model.id,
        modelName: model.modelName,
        modality: job.kind as NodeKind,
        succeeded: true,
      }),
    ]);
    if (job.runId) {
      await db
        .update(kernelRuns)
        .set({
          status: "queued",
          desiredStatus: "running",
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(eq(kernelRuns.id, job.runId));
    }
    return { ...job, status: "succeeded", progress: 100, outputJson };
  } catch (error) {
    const message = error instanceof Error ? error.message : "异步任务查询失败";
    const startedAtMs = job.startedAt
      ? new Date(job.startedAt).getTime()
      : Number.NaN;
    const expired =
      Number.isFinite(startedAtMs) &&
      Date.now() - startedAtMs > MAX_ASYNC_JOB_LIFETIME_MS;
    // 瞬时错误（含保存阶段超时）：不消耗 pollCount 配额，仅在超过总时限后才判失败
    if (transientPollFailure(error) && !expired) {
      const delay = Math.min(30_000, 5_000 + job.pollCount * 500);
      await db
        .update(generationJobs)
        .set({
          status: "running",
          lastPolledAt: now,
          nextPollAt: futureMysql(delay),
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(eq(generationJobs.id, job.id));
      return { ...job, status: "running" };
    }
    await Promise.all([
      db
        .update(generationJobs)
        .set({
          status: "failed",
          error: message,
          providerStatus: "failed",
          lastPolledAt: now,
          nextPollAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(generationJobs.id, job.id)),
      job.runId && job.nodeId
        ? db
            .update(kernelTasks)
            .set({
              status: "failed",
              error: message,
              completedAt: now,
              leaseOwner: null,
              leaseExpiresAt: null,
              updatedAt: now,
            })
            .where(
              and(
                eq(kernelTasks.runId, job.runId),
                eq(kernelTasks.nodeId, job.nodeId),
              ),
            )
        : Promise.resolve(),
      model
        ? recordAsyncModelCompletion({
            context: {
              workspaceId,
              userId: job.requestedBy,
              runId: job.runId,
              nodeId: job.nodeId,
            },
            connectionId: model.id,
            modelName: model.modelName,
            modality: job.kind as NodeKind,
            succeeded: false,
            error: message,
          })
        : Promise.resolve(),
    ]);
    if (job.runId) {
      await db
        .update(kernelRuns)
        .set({
          status: "failed",
          desiredStatus: "paused",
          error: message,
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(kernelRuns.id, job.runId));
    }
    throw error;
  }
}

export async function cancelGenerationJob(jobId: string, workspaceId: string) {
  const db = await getDb();
  const [job] = await db
    .select()
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.id, jobId),
        eq(generationJobs.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!job) throw new Response("生成任务不存在", { status: 404 });
  if (
    job.cancelUrl &&
    job.modelConnectionId &&
    !["succeeded", "failed", "canceled"].includes(job.status)
  ) {
    const [model] = await db
      .select()
      .from(modelConnections)
      .where(eq(modelConnections.id, job.modelConnectionId))
      .limit(1);
    if (model) await cancelModelJob(model, job.cancelUrl);
  }
  const now = mysqlNow();
  await db
    .update(generationJobs)
    .set({
      status: "canceled",
      providerStatus: "canceled",
      nextPollAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(generationJobs.id, job.id));
  if (job.runId && job.nodeId) {
    await Promise.all([
      db
        .update(kernelTasks)
        .set({
          status: "canceled",
          error: "用户已取消异步生成任务",
          completedAt: now,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(kernelTasks.runId, job.runId),
            eq(kernelTasks.nodeId, job.nodeId),
          ),
        ),
      db
        .update(kernelRuns)
        .set({
          status: "canceled",
          desiredStatus: "canceled",
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(kernelRuns.id, job.runId)),
      db.insert(runEvents).values({
        id: `event_${crypto.randomUUID()}`,
        runId: job.runId,
        eventType: "task.async_canceled",
        nodeId: job.nodeId,
        payloadJson: JSON.stringify({ generationJobId: job.id }),
        createdAt: now,
      }),
    ]);
  }
  return { ...job, status: "canceled" };
}
