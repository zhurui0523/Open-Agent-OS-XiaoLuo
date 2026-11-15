import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../../db";
import {
  generationJobs,
  kernelRuns,
  kernelTasks,
  modelConnections,
  packageCapabilities,
  packages,
  registryEvents,
} from "../../../../../db/schema";
import {
  executeBuiltin,
  executeRemotePackage,
  type KernelNodeRequest,
} from "../../../../lib/kernel-executors";
import { skillInstructionsFromSchema } from "../../../../lib/skill-markdown";
import { invokeRoutedModel } from "../../../../lib/model-runtime-router";
import { validateRuntimeModel } from "../../../../lib/runtime-capability";
import type {
  CanvasEdge,
  CanvasNode,
  KernelNodeOutput,
  KernelUpstreamInput,
} from "../../../../types";
import { mysqlNow } from "../../../../lib/mysql";
import { requireUser } from "../../../../lib/auth";
import { packageAvailableToUser } from "../../../../lib/package-availability";
import { sharedModelWorkspaceIds } from "../../../../lib/organization-workspaces";
import {
  canAccessRegistryResource,
  modelAccessScope,
} from "../../../../lib/registry-access";

function errorResponse(error: unknown, status = 400) {
  if (error instanceof Response) return error;
  return Response.json(
    { error: error instanceof Error ? error.message : "节点执行失败" },
    { status },
  );
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      runId?: string;
      nodeId?: string;
    };
    if (!payload.runId || !payload.nodeId) {
      return errorResponse(new Error("runId 和 nodeId 必填"));
    }

    const db = await getDb();
    const [run] = await db
      .select()
      .from(kernelRuns)
      .where(
        and(
          eq(kernelRuns.id, payload.runId),
          eq(kernelRuns.createdBy, user.id),
        ),
      )
      .limit(1);
    if (!run) return errorResponse(new Error("运行记录不存在"), 404);
    if (run.status === "canceled") {
      return errorResponse(new Error("工作流已取消"), 409);
    }

    const graph = JSON.parse(run.graphJson) as {
      nodes: CanvasNode[];
      edges: CanvasEdge[];
    };
    const sourceNode = graph.nodes.find((node) => node.id === payload.nodeId);
    if (!sourceNode) return errorResponse(new Error("节点不在当前运行图中"), 404);
    const node: KernelNodeRequest = {
      id: sourceNode.id,
      title: sourceNode.title,
      prompt: sourceNode.prompt,
      kind: sourceNode.kind,
      capabilityId: sourceNode.capabilityId,
      modelId: sourceNode.modelId,
      parameters: sourceNode.parameters,
    };

    const [task] = await db
      .select()
      .from(kernelTasks)
      .where(
        and(
          eq(kernelTasks.runId, payload.runId),
          eq(kernelTasks.nodeId, payload.nodeId),
        ),
      )
      .limit(1);
    if (!task) return errorResponse(new Error("节点任务不存在"), 404);
    const dependencyIds = JSON.parse(task.dependenciesJson) as string[];
    const runTasks = await db
      .select()
      .from(kernelTasks)
      .where(eq(kernelTasks.runId, payload.runId));
    const taskByNode = new Map(runTasks.map((item) => [item.nodeId, item]));
    const inputs: KernelUpstreamInput[] = dependencyIds.map((nodeId) => {
      const dependency = taskByNode.get(nodeId);
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

    const now = mysqlNow();
    await db
      .update(kernelRuns)
      .set({
        status: "running",
        startedAt: run.startedAt ?? now,
        updatedAt: now,
      })
      .where(eq(kernelRuns.id, run.id));
    await db
      .update(kernelTasks)
      .set({
        status: "running",
        inputJson: JSON.stringify(inputs),
        error: null,
        startedAt: now,
        updatedAt: now,
      })
      .where(eq(kernelTasks.id, task.id));

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
          node.instructions = skillInstructionsFromSchema(
            JSON.parse(capability.capability.inputSchemaJson),
          );
        } catch {
          node.instructions = "";
        }
      }
      const [pkg] = capability
        ? await db
            .select()
            .from(packages)
            .where(
              and(
                eq(packages.id, capability.capability.packageId),
                packageAvailableToUser(run.workspaceId, run.createdBy),
              ),
            )
            .limit(1)
        : [];
      let model: typeof modelConnections.$inferSelect | undefined;
      if (node.modelId && node.modelId !== "unconfigured") {
        const modelScopeWorkspaceIds = await sharedModelWorkspaceIds(
          run.workspaceId,
          user.id,
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
              userId: user.id,
            })
          ) {
            model = modelRow;
          }
        }
      }

      validateRuntimeModel(capability?.capability, model, node.kind);
      const execution =
        capability?.capability.executionMode === "remote" &&
        pkg?.enabled &&
        pkg.runtimeType === "remote-api"
          ? await executeRemotePackage(pkg, node, inputs, request.signal)
          : model?.enabled
            ? await invokeRoutedModel(
                model.id,
                node,
                inputs,
                {
                  workspaceId: run.workspaceId,
                  userId: user.id,
                  runId: run.id,
                  nodeId: node.id,
                },
                request.signal,
              )
            : executeBuiltin(node, inputs);
      const completedAt = mysqlNow();
      if (execution.asyncJob && model) {
        const generationJobId = `generation_${crypto.randomUUID()}`;
        const actualModelId =
          "actualModelId" in execution
            ? String(execution.actualModelId)
            : model.id;
        await db.insert(generationJobs).values({
          id: generationJobId,
          workspaceId: run.workspaceId,
          requestedBy: user.id,
          runId: run.id,
          nodeId: node.id,
          kind: node.kind,
          status: "submitted",
          progress: execution.asyncJob.progress,
          provider: actualModelId,
          modelConnectionId: actualModelId,
          externalJobId: execution.asyncJob.externalJobId,
          pollUrl: execution.asyncJob.pollUrl,
          cancelUrl: execution.asyncJob.cancelUrl ?? null,
          providerStatus: execution.asyncJob.providerStatus,
          nextPollAt: new Date(Date.now() + 2_000)
            .toISOString()
            .replace("T", " ")
            .replace("Z", ""),
          inputJson: JSON.stringify({ node, inputs }),
          outputJson: JSON.stringify(execution.output),
          startedAt: now,
          createdAt: now,
          updatedAt: now,
        });
        await db
          .update(kernelTasks)
          .set({
            status: "waiting",
            outputJson: JSON.stringify(execution.output),
            executor: execution.executor,
            completedAt: null,
            updatedAt: completedAt,
          })
          .where(eq(kernelTasks.id, task.id));
        return Response.json(
          {
            runId: run.id,
            nodeId: node.id,
            generationJobId,
            ...execution,
          },
          { status: 202 },
        );
      }
      await db
        .update(kernelTasks)
        .set({
          status: "succeeded",
          outputJson: JSON.stringify(execution.output),
          executor: execution.executor,
          completedAt,
          updatedAt: completedAt,
        })
        .where(eq(kernelTasks.id, task.id));
      await db.insert(registryEvents).values({
        id: crypto.randomUUID(),
        workspaceId: run.workspaceId,
        actorUserId: user.id,
        eventType: "kernel.node.succeeded",
        entityId: task.id,
        detailJson: JSON.stringify({
          runId: run.id,
          nodeId: node.id,
          executor: execution.executor,
        }),
      });
      return Response.json({
        runId: run.id,
        nodeId: node.id,
        ...execution,
      });
    } catch (error) {
      const failedAt = mysqlNow();
      const message = error instanceof Error ? error.message : "节点执行失败";
      await db
        .update(kernelTasks)
        .set({
          status: "failed",
          error: message,
          completedAt: failedAt,
          updatedAt: failedAt,
        })
        .where(eq(kernelTasks.id, task.id));
      await db.insert(registryEvents).values({
        id: crypto.randomUUID(),
        workspaceId: run.workspaceId,
        actorUserId: user.id,
        eventType: "kernel.node.failed",
        entityId: task.id,
        detailJson: JSON.stringify({
          runId: run.id,
          nodeId: node.id,
          error: message,
        }),
      });
      return errorResponse(error, 502);
    }
  } catch (error) {
    return errorResponse(error);
  }
}
