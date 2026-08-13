import { and, eq, inArray } from "drizzle-orm";
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
  executeIsolatedPackage,
  executeRemotePackage,
  type ExecutorResult,
  type KernelNodeRequest,
} from "./kernel-executors";
import { invokeRoutedModel } from "./model-runtime-router";
import { validateRuntimeModel } from "./runtime-capability";
import {
  getFileBucket,
  MAX_FILE_BYTES,
  storeAsset,
} from "./asset-kernel";
import { mysqlExecute, mysqlNow } from "./mysql";
import { compileWorkflow } from "./workflow-kernel";
import { artifactFormat, artifactName } from "./artifact-format";
import { batchModeForNode, roleForNode } from "./node-role";
import { packageAvailableToUser } from "./package-availability";
import { sharedModelWorkspaceIds } from "./organization-workspaces";
import {
  canAccessRegistryResource,
  modelAccessScope,
} from "./registry-access";
import {
  fetchExternalEndpoint,
  readResponseBytesLimited,
} from "./model-adapters";
import { skillInstructionsFromSchema } from "./skill-markdown";
import {
  parseModelInputConstraints,
  validateModelInputAssets,
} from "./model-input-constraints";
import {
  materializeKernelRunResultGraph,
  persistKernelRunResultGraph,
} from "./kernel-run-canvas-sync";

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

const CANVAS_RESULT_PERSIST_RETRY_DELAYS = [0, 150, 500] as const;

async function persistCompletedRunCanvasResults(run: RunRow) {
  if (!run.canvasId) return null;
  const db = await getDb();
  const tasks = await db
    .select()
    .from(kernelTasks)
    .where(eq(kernelTasks.runId, run.id));
  let latestError: unknown;
  for (let index = 0; index < CANVAS_RESULT_PERSIST_RETRY_DELAYS.length; index += 1) {
    const delay = CANVAS_RESULT_PERSIST_RETRY_DELAYS[index];
    if (delay) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    try {
      return await persistKernelRunResultGraph({
        runId: run.id,
        canvasId: run.canvasId,
        graphJson: run.graphJson,
        tasks,
      });
    } catch (error) {
      latestError = error;
      if (index + 1 < CANVAS_RESULT_PERSIST_RETRY_DELAYS.length) {
        await appendRunEvent(run.id, "run.canvas_results_persist_retry", {
          attempt: index + 1,
          error: error instanceof Error ? error.message : "Canvas result persistence failed",
        }).catch(() => undefined);
      }
    }
  }
  await appendRunEvent(run.id, "run.canvas_results_persist_failed", {
    attempts: CANVAS_RESULT_PERSIST_RETRY_DELAYS.length,
    error:
      latestError instanceof Error
        ? latestError.message
        : "Canvas result persistence failed",
  }).catch(() => undefined);
  return null;
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
    if (
      !dependency ||
      !["succeeded", "skipped"].includes(dependency.status)
    ) {
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
  const role = roleForNode(node);

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
          packageAvailableToUser(run.workspaceId, run.createdBy),
        ),
      )
      .limit(1);
    if (capability?.capability.inputSchemaJson) {
      try {
        request.instructions = skillInstructionsFromSchema(
          JSON.parse(capability.capability.inputSchemaJson),
        );
      } catch {
        request.instructions = "";
      }
    }
    const pluginPackageId =
      role === "plugin" && typeof node.parameters?.packageId === "string"
        ? node.parameters.packageId
        : "";
    const [pluginPackage] = pluginPackageId
      ? await db
          .select()
          .from(packages)
          .where(
            and(
              eq(packages.id, pluginPackageId),
              eq(packages.workspaceId, run.workspaceId),
              eq(packages.enabled, true),
            ),
          )
          .limit(1)
      : [];
    let model: typeof modelConnections.$inferSelect | undefined;
    if (
      role === "execution" &&
      node.modelId &&
      node.modelId !== "unconfigured"
    ) {
      const modelScopeWorkspaceIds = await sharedModelWorkspaceIds(
        run.workspaceId,
        run.createdBy,
      );
      const [modelRow] = await db
        .select()
        .from(modelConnections)
        .where(
          and(
            eq(modelConnections.id, node.modelId),
            inArray(modelConnections.workspaceId, modelScopeWorkspaceIds),
          ),
        )
        .limit(1);
      if (modelRow) {
        let modelUiSchema: Record<string, unknown> = {};
        try {
          modelUiSchema = JSON.parse(
            modelRow.uiSchemaJson,
          ) as Record<string, unknown>;
        } catch {
          modelUiSchema = {};
        }
        if (
          canAccessRegistryResource({
            scope: modelAccessScope(modelUiSchema),
            createdBy: modelRow.createdBy,
            userId: run.createdBy,
          })
        ) {
          model = modelRow;
        }
      }
    }
    const pkg = role === "plugin" ? pluginPackage : capability?.pkg;
    if (role === "execution" && model?.enabled) {
      const inputValidation = validateModelInputAssets(
        parseModelInputConstraints(
          model.inputConstraintsJson,
          node.kind,
          model.protocol,
        ),
        inputs,
      );
      if (!inputValidation.valid) {
        throw new Error(inputValidation.errors.join("；"));
      }
    }
    const generationJobId =
      role === "execution" && model?.enabled && node.kind !== "text"
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
        modelConnectionId: model.id,
        inputJson: JSON.stringify({ request, inputs }),
        startedAt: mysqlNow(),
        createdAt: mysqlNow(),
        updatedAt: mysqlNow(),
      });
    }
    let execution: ExecutorResult;
    if (role === "material" || role === "result") {
      execution = executeBuiltin(request, inputs);
    } else if (role === "plugin") {
      if (!pkg) {
        throw new Error("插件运行器尚未绑定可用的 Plugin Package");
      }
      const executePlugin = (pluginInputs: KernelUpstreamInput[]) => {
        if (pkg.runtimeType === "remote-api") {
          return executeRemotePackage(pkg, request, pluginInputs);
        }
        if (pkg.runtimeType === "isolated-worker") {
          return executeIsolatedPackage(pkg, request, pluginInputs);
        }
        if (pkg.runtimeType === "sandbox-ui") {
          throw new Error("UI 沙盒插件不能作为后端自动化运行器执行");
        }
        throw new Error("该插件没有可执行的远程或隔离运行时");
      };
      const batchMode = batchModeForNode(node);
      if (batchMode === "each" && inputs.length > 1) {
        const items = await Promise.all(
          inputs.map(async (input) => ({
            inputNodeId: input.nodeId,
            execution: await executePlugin([input]),
          })),
        );
        execution = {
          executor: `plugin:${pkg.id}:batch-each`,
          result: `插件已逐项处理 ${items.length} 个输入素材`,
          output: {
            type: "json",
            text: `已完成 ${items.length} 个素材的批处理`,
            data: {
              mode: "each",
              items: items.map((item) => ({
                inputNodeId: item.inputNodeId,
                result: item.execution.result,
                output: item.execution.output,
              })),
            },
            executor: `plugin:${pkg.id}:batch-each`,
          },
        };
      } else {
        execution = await executePlugin(inputs);
      }
    } else {
      validateRuntimeModel(capability?.capability, model, node.kind);
      if (
        capability?.capability.executionMode === "remote" &&
        pkg?.enabled &&
        pkg.runtimeType === "remote-api"
      ) {
        execution = await executeRemotePackage(pkg, request, inputs);
      } else if (model?.enabled) {
        execution = await invokeRoutedModel(
          model.id,
          request,
          inputs,
          {
            workspaceId: run.workspaceId,
            userId: run.createdBy,
            runId: run.id,
            nodeId: node.id,
          },
        );
      } else {
        throw new Error("节点需要选择已启用且兼容的模型后才能执行");
      }
    }
    if (
      role !== "material" &&
      role !== "result" &&
      !execution.asyncJob &&
      !execution.output.preview &&
      (execution.output.assetUrl || execution.output.text)
    ) {
      let bytes: ArrayBuffer;
      let mimeType: string;
      if (execution.output.assetUrl) {
        const response = await fetchExternalEndpoint(
          execution.output.assetUrl,
          {},
          60_000,
        );
        if (!response.ok) {
          throw new Error(`无法读取生成结果：HTTP ${response.status}`);
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
      const asset = await storeAsset(await getDb(), await getFileBucket(), {
        workspaceId: run.workspaceId,
        name: artifactName(node.title, node.kind, mimeType),
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
      const data =
        execution.output.data &&
        typeof execution.output.data === "object"
          ? (execution.output.data as Record<string, unknown>)
          : {};
      await db
        .update(generationJobs)
        .set({
          status: execution.asyncJob ? "submitted" : "succeeded",
          progress: execution.asyncJob?.progress ?? 100,
          provider:
            "actualModelId" in execution
              ? String(execution.actualModelId)
              : model.id,
          modelConnectionId:
            "actualModelId" in execution
              ? String(execution.actualModelId)
              : model.id,
          externalJobId:
            execution.asyncJob?.externalJobId ??
            (typeof data.id === "string"
              ? data.id
              : typeof data.jobId === "string"
                ? data.jobId
                : null),
          pollUrl: execution.asyncJob?.pollUrl ?? null,
          cancelUrl: execution.asyncJob?.cancelUrl ?? null,
          providerStatus: execution.asyncJob?.providerStatus ?? "succeeded",
          nextPollAt: execution.asyncJob
            ? futureMysql(2_000)
            : null,
          outputJson: JSON.stringify(execution.output),
          ...(execution.asyncJob ? {} : { completedAt }),
          updatedAt: completedAt,
        })
        .where(eq(generationJobs.id, generationJobId));
    }
    await db
      .update(kernelTasks)
      .set({
        status: execution.asyncJob ? "waiting" : "succeeded",
        outputJson: JSON.stringify({
          ...execution.output,
          result: execution.result,
        }),
        executor: execution.executor,
        completedAt: execution.asyncJob ? null : completedAt,
        updatedAt: completedAt,
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(eq(kernelTasks.id, task.id));
    await appendRunEvent(
      run.id,
      execution.asyncJob ? "task.submitted" : "task.succeeded",
      {
        executor: execution.executor,
        ...(execution.asyncJob
          ? { externalJobId: execution.asyncJob.externalJobId }
          : {}),
      },
      node.id,
    );
    return {
      ...task,
      status: execution.asyncJob ? "waiting" : "succeeded",
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

async function executeTaskWithFailurePolicy(
  run: RunRow,
  node: CanvasNode,
  graph: { nodes: CanvasNode[]; edges: CanvasEdge[] },
  workerId: string,
) {
  const policy = String(node.parameters?.failurePolicy ?? "stop");
  const maxAttempts = Math.min(
    5,
    Math.max(1, Number(node.parameters?.retryLimit ?? 3) || 3),
  );
  let latestError: unknown;
  const allowedAttempts = policy === "retry" ? maxAttempts : 1;
  for (let attempt = 0; attempt < allowedAttempts; attempt += 1) {
    try {
      return await executeQueuedTask(run, node, graph, workerId);
    } catch (error) {
      latestError = error;
      if (attempt + 1 < allowedAttempts) {
        await appendRunEvent(
          run.id,
          "task.retrying",
          {
            attempt: attempt + 1,
            error: error instanceof Error ? error.message : "节点执行失败",
          },
          node.id,
        );
      }
    }
  }
  if (policy === "skip") {
    const db = await getDb();
    const skippedAt = mysqlNow();
    await db
      .update(kernelTasks)
      .set({
        status: "skipped",
        error:
          latestError instanceof Error ? latestError.message : "节点执行失败",
        completedAt: skippedAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: skippedAt,
      })
      .where(
        and(eq(kernelTasks.runId, run.id), eq(kernelTasks.nodeId, node.id)),
      );
    await appendRunEvent(
      run.id,
      "task.skipped",
      {
        error:
          latestError instanceof Error ? latestError.message : "节点执行失败",
      },
      node.id,
    );
    return { status: "skipped" };
  }
  throw latestError;
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
        return executeTaskWithFailurePolicy(run, node, graph, workerId);
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
    const waiting = settled.some(
      (item) =>
        item.status === "fulfilled" && item.value?.status === "waiting",
    );
    if (waiting) {
      await db
        .update(kernelRuns)
        .set({
          status: "waiting",
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: mysqlNow(),
          updatedAt: mysqlNow(),
        })
        .where(eq(kernelRuns.id, runId));
      await appendRunEvent(runId, "run.waiting");
      return readKernelRun(runId, userId);
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
  if (failure) {
    await db
      .update(kernelTasks)
      .set({
        status: "skipped",
        error: `因上游节点失败未执行：${failure.message}`,
        completedAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: completedAt,
      })
      .where(
        and(eq(kernelTasks.runId, runId), eq(kernelTasks.status, "queued")),
      );
  }
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
  if (!failure) {
    await persistCompletedRunCanvasResults(run);
  }
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
  let canvasRevision: number | null = null;
  let canvasPersistenceError: string | null = null;
  let canvasResultGraph: ReturnType<
    typeof materializeKernelRunResultGraph
  > | null = null;
  if (run.status === "succeeded" && run.canvasId) {
    canvasResultGraph = materializeKernelRunResultGraph({
      runId: run.id,
      graphJson: run.graphJson,
      tasks,
    });
    try {
      canvasRevision = await persistKernelRunResultGraph({
        runId: run.id,
        canvasId: run.canvasId,
        graphJson: run.graphJson,
        tasks,
      });
    } catch (error) {
      canvasPersistenceError =
        error instanceof Error ? error.message : "画布结果保存失败";
    }
  }
  return {
    run,
    tasks,
    events,
    canvasRevision,
    canvasPersistenceError,
    canvasResultGraph,
  };
}
