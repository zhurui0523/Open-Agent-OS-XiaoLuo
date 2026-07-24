import { and, eq } from "drizzle-orm";
import { getDb } from "../../db";
import {
  assetRelations,
  generationJobs,
  kernelRuns,
  kernelTasks,
  modelConnections,
  packageCapabilities,
  packages,
  runEvents,
} from "../../db/schema";
import type {
  CanvasEdge,
  CanvasNode,
  KernelNodeOutput,
  KernelUpstreamInput,
} from "../types";
import {
  executeBuiltin,
  executeModel,
  executeRemotePackage,
  type KernelNodeRequest,
} from "./kernel-executors";
import {
  getFileBucket,
  MAX_FILE_BYTES,
  storeAsset,
} from "./asset-kernel";
import { mysqlExecute, mysqlNow } from "./mysql";
import { compileWorkflow } from "./workflow-kernel";

type RunRow = typeof kernelRuns.$inferSelect;

function futureMysql(milliseconds: number) {
  return mysqlNow(new Date(Date.now() + milliseconds));
}

async function appendRunEvent(
  runId: string,
  eventType: string,
  payload: Record<string, unknown> = {},
  nodeId?: string,
) {
  const db = await getDb();
  await db.insert(runEvents).values({
    id: `event_${crypto.randomUUID()}`,
    runId,
    eventType,
    nodeId: nodeId ?? null,
    payloadJson: JSON.stringify(payload),
    createdAt: mysqlNow(),
  });
}

async function desiredState(runId: string) {
  const db = await getDb();
  const [run] = await db
    .select({
      desiredStatus: kernelRuns.desiredStatus,
      status: kernelRuns.status,
    })
    .from(kernelRuns)
    .where(eq(kernelRuns.id, runId))
    .limit(1);
  return run;
}

async function executeQueuedTask(
  run: RunRow,
  node: CanvasNode,
  graph: { nodes: CanvasNode[]; edges: CanvasEdge[] },
  workerId: string,
) {
  const db = await getDb();
  const [task] = await db
    .select()
    .from(kernelTasks)
    .where(
      and(eq(kernelTasks.runId, run.id), eq(kernelTasks.nodeId, node.id)),
    )
    .limit(1);
  if (!task || task.status === "succeeded") return task;
  if (task.attempt >= task.maxAttempts) {
    throw new Error(`节点 ${node.title} 已达到最大重试次数`);
  }

  const dependencies = JSON.parse(task.dependenciesJson) as string[];
  const dependencyRows = await db
    .select()
    .from(kernelTasks)
    .where(eq(kernelTasks.runId, run.id));
  const byNode = new Map(dependencyRows.map((item) => [item.nodeId, item]));
  const inputs: KernelUpstreamInput[] = dependencies.map((nodeId) => {
    const dependency = byNode.get(nodeId);
    if (!dependency || dependency.status !== "succeeded") {
      throw new Error(`上游节点 ${nodeId} 尚未完成`);
    }
    const graphNode = graph.nodes.find((item) => item.id === nodeId);
    return {
      nodeId,
      title: graphNode?.title,
      kind: graphNode?.kind,
      output: dependency.outputJson
        ? (JSON.parse(dependency.outputJson) as KernelNodeOutput)
        : null,
    };
  });

  const startedAt = mysqlNow();
  await db
    .update(kernelTasks)
    .set({
      status: "running",
      attempt: task.attempt + 1,
      leaseOwner: workerId,
      leaseExpiresAt: futureMysql(60_000),
      inputJson: JSON.stringify(inputs),
      error: null,
      startedAt,
      updatedAt: startedAt,
    })
    .where(eq(kernelTasks.id, task.id));
  await appendRunEvent(
    run.id,
    "task.started",
    { attempt: task.attempt + 1 },
    node.id,
  );

  const request: KernelNodeRequest = {
    id: node.id,
    title: node.title,
    prompt: node.prompt,
    kind: node.kind,
    capabilityId: node.capabilityId,
    modelId: node.modelId,
    parameters: node.parameters,
  };

  try {
    const [capability] = await db
      .select({
        capability: packageCapabilities,
        pkg: packages,
      })
      .from(packageCapabilities)
      .innerJoin(packages, eq(packages.id, packageCapabilities.packageId))
      .where(
        and(
          eq(packageCapabilities.id, node.capabilityId),
          eq(packages.workspaceId, run.workspaceId),
        ),
      )
      .limit(1);
    const [model] =
      node.modelId && node.modelId !== "unconfigured"
        ? await db
            .select()
            .from(modelConnections)
            .where(
              and(
                eq(modelConnections.id, node.modelId),
                eq(modelConnections.workspaceId, run.workspaceId),
              ),
            )
            .limit(1)
        : [];
    const pkg = capability?.pkg;
    const generationJobId =
      model?.enabled && node.kind !== "text"
        ? `generation_${crypto.randomUUID()}`
        : null;
    if (generationJobId && model) {
      await db.insert(generationJobs).values({
        id: generationJobId,
        workspaceId: run.workspaceId,
        requestedBy: run.createdBy,
        runId: run.id,
        nodeId: node.id,
        kind: node.kind,
        status: "running",
        progress: 10,
        provider: model.id,
        inputJson: JSON.stringify({ request, inputs }),
        startedAt: mysqlNow(),
        createdAt: mysqlNow(),
        updatedAt: mysqlNow(),
      });
    }
    let execution;
    if (pkg?.enabled && pkg.runtimeType === "remote-api") {
      execution = await executeRemotePackage(pkg, request, inputs);
    } else if (model?.enabled) {
      try {
        execution = await executeModel(model, request, inputs);
      } catch (primaryError) {
        const [fallback] = model.fallbackModelId
          ? await db
              .select()
              .from(modelConnections)
              .where(
                and(
                  eq(modelConnections.id, model.fallbackModelId),
                  eq(modelConnections.workspaceId, run.workspaceId),
                  eq(modelConnections.enabled, true),
                ),
              )
              .limit(1)
          : [];
        if (!fallback) throw primaryError;
        execution = await executeModel(fallback, request, inputs);
      }
    } else {
      execution = executeBuiltin(request, inputs);
    }
    if (
      !execution.output.preview &&
      (execution.output.assetUrl || execution.output.text)
    ) {
      let bytes: ArrayBuffer;
      let mimeType: string;
      if (execution.output.assetUrl) {
        const response = await fetch(execution.output.assetUrl, {
          redirect: "error",
        });
        if (!response.ok) {
          throw new Error(`无法读取生成结果：HTTP ${response.status}`);
        }
        bytes = await response.arrayBuffer();
        if (bytes.byteLength > MAX_FILE_BYTES) {
          throw new Error("生成结果超过文件系统单文件限制");
        }
        mimeType =
          response.headers.get("content-type") ??
          (node.kind === "image" ? "image/png" : "video/mp4");
      } else {
        bytes = new TextEncoder().encode(execution.output.text ?? "").buffer;
        mimeType = "text/plain;charset=utf-8";
      }
      const asset = await storeAsset(await getDb(), await getFileBucket(), {
        workspaceId: run.workspaceId,
        name: `${node.title}.${node.kind === "text" ? "txt" : node.kind === "image" ? "png" : "mp4"}`,
        mimeType,
        bytes,
        tags: [node.kind, "AI 生成"],
        description: (execution.output.text ?? execution.result).slice(0, 500),
        sourceType: "kernel-output",
        sourceRef: generationJobId ?? `${run.id}:${node.id}`,
        metadata: {
          runId: run.id,
          nodeId: node.id,
          executor: execution.executor,
        },
      });
      for (const input of inputs) {
        const sourceAssetId =
          input.output &&
          typeof input.output === "object" &&
          "data" in input.output &&
          (input.output as { data?: unknown }).data &&
          typeof (input.output as { data: unknown }).data === "object"
            ? String(
                (
                  (input.output as { data: Record<string, unknown> }).data
                    .assetId ?? ""
                ),
              )
            : "";
        if (sourceAssetId) {
          await db.insert(assetRelations).values({
            id: `relation_${crypto.randomUUID()}`,
            fromAssetId: sourceAssetId,
            toAssetId: asset.id,
            relationType: "generated-from",
            metadataJson: JSON.stringify({ runId: run.id, nodeId: node.id }),
            createdAt: mysqlNow(),
          });
        }
      }
      execution = {
        ...execution,
        output: {
          ...execution.output,
          assetUrl:
            node.kind === "text"
              ? execution.output.assetUrl
              : asset.contentUrl,
          data: {
            assetId: asset.id,
            assetUri: asset.uri,
            source: execution.output.data ?? null,
          },
        },
      };
    }
    const completedAt = mysqlNow();
    if (generationJobId && model) {
      const asyncSubmitted = model.protocol === "async-video";
      const data =
        execution.output.data &&
        typeof execution.output.data === "object"
          ? (execution.output.data as Record<string, unknown>)
          : {};
      await db
        .update(generationJobs)
        .set({
          status: asyncSubmitted ? "submitted" : "succeeded",
          progress: asyncSubmitted ? 15 : 100,
          externalJobId:
            typeof data.id === "string"
              ? data.id
              : typeof data.jobId === "string"
                ? data.jobId
                : null,
          outputJson: JSON.stringify(execution.output),
          ...(asyncSubmitted ? {} : { completedAt }),
          updatedAt: completedAt,
        })
        .where(eq(generationJobs.id, generationJobId));
    }
    await db
      .update(kernelTasks)
      .set({
        status: "succeeded",
        outputJson: JSON.stringify({
          ...execution.output,
          result: execution.result,
        }),
        executor: execution.executor,
        completedAt,
        updatedAt: completedAt,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(eq(kernelTasks.id, task.id));
    await appendRunEvent(
      run.id,
      "task.succeeded",
      { executor: execution.executor },
      node.id,
    );
    return {
      ...task,
      status: "succeeded",
      outputJson: JSON.stringify({
        ...execution.output,
        result: execution.result,
      }),
    };
  } catch (error) {
    const failedAt = mysqlNow();
    const message = error instanceof Error ? error.message : "节点执行失败";
    await db
      .update(generationJobs)
      .set({
        status: "failed",
        error: message,
        completedAt: failedAt,
        updatedAt: failedAt,
      })
      .where(
        and(
          eq(generationJobs.runId, run.id),
          eq(generationJobs.nodeId, node.id),
          eq(generationJobs.status, "running"),
        ),
      );
    await db
      .update(kernelTasks)
      .set({
        status: "failed",
        error: message,
        completedAt: failedAt,
        updatedAt: failedAt,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(eq(kernelTasks.id, task.id));
    await appendRunEvent(run.id, "task.failed", { error: message }, node.id);
    throw error;
  }
}

export async function dispatchKernelRun(runId: string, userId: string) {
  const db = await getDb();
  const [run] = await db
    .select()
    .from(kernelRuns)
    .where(and(eq(kernelRuns.id, runId), eq(kernelRuns.createdBy, userId)))
    .limit(1);
  if (!run) throw new Response("Run not found", { status: 404 });
  if (["succeeded", "canceled"].includes(run.status)) {
    return readKernelRun(runId, userId);
  }

  const workerId = `worker_${crypto.randomUUID()}`;
  const lease = await mysqlExecute(
    `UPDATE xiaoluo_v2_kernel_runs
     SET lease_owner = ?,
         lease_expires_at = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 90 SECOND),
         heartbeat_at = CURRENT_TIMESTAMP(3),
         status = 'running',
         started_at = COALESCE(started_at, CURRENT_TIMESTAMP(3)),
         updated_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?
       AND created_by = ?
       AND desired_status = 'running'
       AND (
         lease_owner IS NULL
         OR lease_expires_at < CURRENT_TIMESTAMP(3)
         OR lease_owner = ?
       )`,
    [workerId, runId, userId, workerId],
  );
  if (lease.affectedRows !== 1) return readKernelRun(runId, userId);

  await appendRunEvent(runId, "run.started", { workerId });
  const graph = JSON.parse(run.graphJson) as {
    nodes: CanvasNode[];
    edges: CanvasEdge[];
  };
  const workflow = compileWorkflow(graph.nodes, graph.edges);
  let failure: Error | null = null;

  for (const level of workflow.levels) {
    const current = await desiredState(runId);
    if (!current || current.desiredStatus === "canceled") {
      await db
        .update(kernelTasks)
        .set({ status: "canceled", updatedAt: mysqlNow() })
        .where(
          and(
            eq(kernelTasks.runId, runId),
            eq(kernelTasks.status, "queued"),
          ),
        );
      await db
        .update(kernelRuns)
        .set({
          status: "canceled",
          completedAt: mysqlNow(),
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: mysqlNow(),
        })
        .where(eq(kernelRuns.id, runId));
      await appendRunEvent(runId, "run.canceled");
      return readKernelRun(runId, userId);
    }
    if (current.desiredStatus === "paused") {
      await db
        .update(kernelRuns)
        .set({
          status: "paused",
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: mysqlNow(),
        })
        .where(eq(kernelRuns.id, runId));
      await appendRunEvent(runId, "run.paused");
      return readKernelRun(runId, userId);
    }

    const settled = await Promise.allSettled(
      level.map(async (nodeId) => {
        const node = graph.nodes.find((item) => item.id === nodeId);
        if (!node) throw new Error(`节点 ${nodeId} 不存在`);
        return executeQueuedTask(run, node, graph, workerId);
      }),
    );
    const rejected = settled.find(
      (item): item is PromiseRejectedResult => item.status === "rejected",
    );
    if (rejected) {
      failure =
        rejected.reason instanceof Error
          ? rejected.reason
          : new Error("工作流执行失败");
      break;
    }
    await db
      .update(kernelRuns)
      .set({
        heartbeatAt: mysqlNow(),
        leaseExpiresAt: futureMysql(90_000),
        updatedAt: mysqlNow(),
      })
      .where(eq(kernelRuns.id, runId));
  }

  const completedAt = mysqlNow();
  await db
    .update(kernelRuns)
    .set({
      status: failure ? "failed" : "succeeded",
      desiredStatus: failure ? "paused" : "running",
      error: failure?.message ?? null,
      completedAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: completedAt,
    })
    .where(eq(kernelRuns.id, runId));
  await appendRunEvent(
    runId,
    failure ? "run.failed" : "run.succeeded",
    failure ? { error: failure.message } : {},
  );
  return readKernelRun(runId, userId);
}

export async function readKernelRun(runId: string, userId: string) {
  const db = await getDb();
  const [run, tasks, events] = await Promise.all([
    db
      .select()
      .from(kernelRuns)
      .where(and(eq(kernelRuns.id, runId), eq(kernelRuns.createdBy, userId)))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select()
      .from(kernelTasks)
      .where(eq(kernelTasks.runId, runId))
      .orderBy(kernelTasks.updatedAt),
    db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(runEvents.createdAt),
  ]);
  if (!run) throw new Response("Run not found", { status: 404 });
  return { run, tasks, events };
}
