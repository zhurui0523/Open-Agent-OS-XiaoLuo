import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import {
  kernelRuns,
  kernelTasks,
  modelConnections,
  packageCapabilities,
  packages,
  registryEvents,
} from "../../../../../db/schema";
import {
  executeBuiltin,
  executeModel,
  executeRemotePackage,
  type KernelNodeRequest,
} from "../../../../lib/kernel-executors";
import type {
  CanvasEdge,
  CanvasNode,
  KernelNodeOutput,
  KernelUpstreamInput,
} from "../../../../types";

function errorResponse(error: unknown, status = 400) {
  return Response.json(
    { error: error instanceof Error ? error.message : "节点执行失败" },
    { status },
  );
}

export async function POST(request: Request) {
  try {
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
      .where(eq(kernelRuns.id, payload.runId))
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

    const now = new Date().toISOString();
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
        .select()
        .from(packageCapabilities)
        .where(eq(packageCapabilities.id, node.capabilityId))
        .limit(1);
      const [pkg] = capability
        ? await db
            .select()
            .from(packages)
            .where(eq(packages.id, capability.packageId))
            .limit(1)
        : [];
      const [model] =
        node.modelId && node.modelId !== "unconfigured"
          ? await db
              .select()
              .from(modelConnections)
              .where(eq(modelConnections.id, node.modelId))
              .limit(1)
          : [];

      const execution =
        pkg?.enabled && pkg.runtimeType === "remote-api"
          ? await executeRemotePackage(pkg, node, inputs, request.signal)
          : model?.enabled
            ? await executeModel(model, node, inputs, request.signal)
            : executeBuiltin(node, inputs);
      const completedAt = new Date().toISOString();
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
      const failedAt = new Date().toISOString();
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
