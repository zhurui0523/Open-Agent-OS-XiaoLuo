import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import {
  kernelRuns,
  kernelTasks,
  registryEvents,
  runEvents,
} from "../../../../../db/schema";
import { requireUser } from "../../../../lib/auth";
import { requireCanvasAccess } from "../../../../lib/authorization";
import { readKernelRun } from "../../../../lib/kernel-worker";
import { mysqlNow } from "../../../../lib/mysql";
import {
  compileWorkflow,
  WorkflowCompileError,
} from "../../../../lib/workflow-kernel";
import type { CanvasEdge, CanvasNode } from "../../../../types";

function errorResponse(error: unknown, status = 400) {
  if (error instanceof Response) return error;
  return Response.json(
    {
      error:
        error instanceof Error ? error.message : "内核运行请求失败",
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
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      canvasId?: string;
      nodes?: CanvasNode[];
      edges?: CanvasEdge[];
      idempotencyKey?: string;
    };
    if (!payload.canvasId) {
      return errorResponse(new Error("canvasId 必填"));
    }
    const access = await requireCanvasAccess(user.id, payload.canvasId, "edit");
    const idempotencyKey = (
      request.headers.get("idempotency-key") ??
      payload.idempotencyKey ??
      ""
    )
      .trim()
      .slice(0, 160);
    if (!idempotencyKey) {
      return errorResponse(new Error("Idempotency-Key 必填"));
    }
    const graph = validGraph(payload);
    const workflow = compileWorkflow(graph.nodes, graph.edges);
    const db = await getDb();
    const [existing] = await db
      .select()
      .from(kernelRuns)
      .where(
        and(
          eq(kernelRuns.createdBy, user.id),
          eq(kernelRuns.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (existing) {
      return Response.json({
        runId: existing.id,
        status: existing.status,
        levels: workflow.levels,
        dependencies: workflow.dependencies,
        replayed: true,
      });
    }

    const runId = `run_${crypto.randomUUID()}`;
    const now = mysqlNow();
    await db.insert(kernelRuns).values({
      id: runId,
      workspaceId: access.workspaceId,
      createdBy: user.id,
      canvasId: payload.canvasId,
      idempotencyKey,
      status: "queued",
      desiredStatus: "running",
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
        attempt: 0,
        maxAttempts: 3,
        updatedAt: now,
      })),
    );
    await Promise.all([
      db.insert(registryEvents).values({
        id: crypto.randomUUID(),
        workspaceId: access.workspaceId,
        actorUserId: user.id,
        eventType: "kernel.run.created",
        entityId: runId,
        detailJson: JSON.stringify({
          nodes: graph.nodes.length,
          edges: graph.edges.length,
          levels: workflow.levels.length,
        }),
      }),
      db.insert(runEvents).values({
        id: `event_${crypto.randomUUID()}`,
        runId,
        eventType: "run.created",
        nodeId: null,
        payloadJson: JSON.stringify({
          nodes: graph.nodes.length,
          levels: workflow.levels.length,
        }),
        createdAt: now,
      }),
    ]);
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

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const runId = new URL(request.url).searchParams.get("runId")?.trim();
    if (!runId) return errorResponse(new Error("runId 必填"));
    return Response.json(await readKernelRun(runId, user.id));
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      runId?: string;
      action?: "pause" | "resume" | "cancel" | "retry";
    };
    if (!payload.runId || !payload.action) {
      return errorResponse(new Error("runId 和 action 无效"));
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

    const now = mysqlNow();
    if (payload.action === "retry") {
      await db
        .update(kernelTasks)
        .set({
          status: "queued",
          error: null,
          completedAt: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(kernelTasks.runId, run.id),
            eq(kernelTasks.status, "failed"),
          ),
        );
    }
    if (payload.action === "cancel") {
      await db
        .update(kernelTasks)
        .set({ status: "canceled", updatedAt: now })
        .where(
          and(
            eq(kernelTasks.runId, run.id),
            eq(kernelTasks.status, "queued"),
          ),
        );
    }
    const desiredStatus =
      payload.action === "pause"
        ? "paused"
        : payload.action === "cancel"
          ? "canceled"
          : "running";
    const visibleStatus =
      payload.action === "pause"
        ? "paused"
        : payload.action === "cancel"
          ? "canceled"
          : "queued";
    await db
      .update(kernelRuns)
      .set({
        desiredStatus,
        status: visibleStatus,
        error: payload.action === "retry" ? null : run.error,
        ...(payload.action === "cancel" ? { completedAt: now } : {}),
        ...(payload.action === "resume" || payload.action === "retry"
          ? { completedAt: null, leaseOwner: null, leaseExpiresAt: null }
          : {}),
        updatedAt: now,
      })
      .where(eq(kernelRuns.id, run.id));
    await Promise.all([
      db.insert(registryEvents).values({
        id: crypto.randomUUID(),
        workspaceId: run.workspaceId,
        actorUserId: user.id,
        eventType: `kernel.run.${payload.action}`,
        entityId: run.id,
        detailJson: "{}",
      }),
      db.insert(runEvents).values({
        id: `event_${crypto.randomUUID()}`,
        runId: run.id,
        eventType: `run.${payload.action}`,
        nodeId: null,
        payloadJson: "{}",
        createdAt: now,
      }),
    ]);
    return Response.json({
      runId: run.id,
      status: visibleStatus,
      desiredStatus,
    });
  } catch (error) {
    return errorResponse(error, 500);
  }
}
