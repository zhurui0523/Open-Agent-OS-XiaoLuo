import { eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import {
  kernelRuns,
  kernelTasks,
  registryEvents,
} from "../../../../../db/schema";
import { compileWorkflow, WorkflowCompileError } from "../../../../lib/workflow-kernel";
import type { CanvasEdge, CanvasNode } from "../../../../types";

const terminalStates = new Set(["succeeded", "failed", "canceled"]);
const mutableStates = new Set([
  "queued",
  "running",
  "paused",
  "succeeded",
  "failed",
  "canceled",
]);

function errorResponse(error: unknown, status = 400) {
  return Response.json(
    {
      error: error instanceof Error ? error.message : "微内核运行请求失败",
      ...(error instanceof WorkflowCompileError ? { code: error.code } : {}),
    },
    { status },
  );
}

function validGraph(value: unknown): {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
} {
  if (!value || typeof value !== "object") {
    throw new Error("工作流必须是一个对象");
  }
  const graph = value as { nodes?: CanvasNode[]; edges?: CanvasEdge[] };
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new Error("工作流缺少 nodes 或 edges");
  }
  graph.nodes.forEach((node) => {
    if (
      !node ||
      typeof node.id !== "string" ||
      typeof node.title !== "string" ||
      typeof node.prompt !== "string" ||
      !["text", "image", "video"].includes(node.kind)
    ) {
      throw new Error("工作流包含无效节点");
    }
  });
  graph.edges.forEach((edge) => {
    if (
      !edge ||
      typeof edge.id !== "string" ||
      typeof edge.source !== "string" ||
      typeof edge.target !== "string"
    ) {
      throw new Error("工作流包含无效连线");
    }
  });
  return { nodes: graph.nodes, edges: graph.edges };
}

export async function POST(request: Request) {
  try {
    const graph = validGraph(await request.json());
    const workflow = compileWorkflow(graph.nodes, graph.edges);
    const db = await getDb();
    const runId = `run_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await db.insert(kernelRuns).values({
      id: runId,
      status: "queued",
      graphJson: JSON.stringify(graph),
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(kernelTasks).values(
      graph.nodes.map((node) => ({
        id: `${runId}:${node.id}`,
        runId,
        nodeId: node.id,
        status: "queued",
        dependenciesJson: JSON.stringify(workflow.dependencies[node.id]),
        updatedAt: now,
      })),
    );
    await db.insert(registryEvents).values({
      id: crypto.randomUUID(),
      eventType: "kernel.run.created",
      entityId: runId,
      detailJson: JSON.stringify({
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        levels: workflow.levels.length,
      }),
    });
    return Response.json(
      {
        runId,
        status: "queued",
        levels: workflow.levels,
        dependencies: workflow.dependencies,
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const payload = (await request.json()) as {
      runId?: string;
      status?: string;
      error?: string;
    };
    if (
      !payload.runId ||
      !payload.status ||
      !mutableStates.has(payload.status)
    ) {
      return errorResponse(new Error("runId 或 status 无效"));
    }
    const db = await getDb();
    const now = new Date().toISOString();
    const [run] = await db
      .update(kernelRuns)
      .set({
        status: payload.status,
        error: payload.error ?? null,
        ...(payload.status === "running" ? { startedAt: now } : {}),
        ...(terminalStates.has(payload.status) ? { completedAt: now } : {}),
        updatedAt: now,
      })
      .where(eq(kernelRuns.id, payload.runId))
      .returning();
    if (!run) return errorResponse(new Error("运行记录不存在"), 404);
    await db.insert(registryEvents).values({
      id: crypto.randomUUID(),
      eventType: `kernel.run.${payload.status}`,
      entityId: payload.runId,
      detailJson: JSON.stringify({ error: payload.error ?? null }),
    });
    return Response.json({ runId: run.id, status: run.status });
  } catch (error) {
    return errorResponse(error, 500);
  }
}
