import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../../db";
import {
  kernelRuns,
  kernelTasks,
  packageCapabilities,
  packages,
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
import { roleForNode } from "../../../../lib/node-role";
import {
  validateEdgePorts,
  validatePortCardinality,
} from "../../../../lib/node-ports";
import { hasSelectedSkillCapability } from "../../../../lib/runtime-capability";
import { packageAvailableToUser } from "../../../../lib/package-availability";

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
      !["text", "image", "video", "audio", "document"].includes(node.kind)
    ) {
      throw new Error("工作流包含无效节点");
    }
    if (
      node.role !== undefined &&
      !["material", "plugin", "execution", "result"].includes(node.role)
    ) {
      throw new Error("工作流包含无效节点角色");
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
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const edge of graph.edges) {
      const source = nodesById.get(edge.source);
      const target = nodesById.get(edge.target);
      if (!source || !target) throw new Error("连线引用了不存在的节点");
      const incompatibility = validateEdgePorts(edge, source, target);
      if (incompatibility) throw new Error(`连线 ${edge.id}：${incompatibility}`);
      const cardinality = validatePortCardinality(
        edge,
        graph.edges.filter((candidate) => candidate.id !== edge.id),
        target,
      );
      if (cardinality) throw new Error(`连线 ${edge.id}：${cardinality}`);
    }
    const db = await getDb();
    const capabilityIds = [
      ...new Set(
        graph.nodes
          .filter((node) => roleForNode(node) === "execution")
          .map((node) => node.capabilityId)
          .filter(hasSelectedSkillCapability),
      ),
    ];
    const capabilityRows = capabilityIds.length
      ? await db
          .select({
            capability: packageCapabilities,
            packageId: packages.id,
            packageKey: packages.packageKey,
            packageVersion: packages.version,
            packageType: packages.packageType,
            packageEnabled: packages.enabled,
          })
          .from(packageCapabilities)
          .innerJoin(packages, eq(packages.id, packageCapabilities.packageId))
          .where(
            and(
              inArray(packageCapabilities.id, capabilityIds),
              packageAvailableToUser(access.workspaceId, user.id),
            ),
          )
      : [];
    const capabilityById = new Map(
      capabilityRows.map((row) => [row.capability.id, row]),
    );
    const pluginPackageIds = [
      ...new Set(
        graph.nodes
          .filter((node) => roleForNode(node) === "plugin")
          .map((node) =>
            typeof node.parameters?.packageId === "string"
              ? node.parameters.packageId
              : "",
          )
          .filter(Boolean),
      ),
    ];
    const pluginRows = pluginPackageIds.length
      ? await db
          .select()
          .from(packages)
          .where(
            and(
              inArray(packages.id, pluginPackageIds),
              eq(packages.workspaceId, access.workspaceId),
              eq(packages.enabled, true),
            ),
          )
      : [];
    const pluginById = new Map(pluginRows.map((row) => [row.id, row]));
    for (const node of graph.nodes) {
      const role = roleForNode(node);
      if (role === "execution") {
        const capabilityId = node.capabilityId?.trim();
        if (hasSelectedSkillCapability(capabilityId) && capabilityId) {
          const row = capabilityById.get(capabilityId);
          if (
            !row ||
            !row.packageEnabled ||
            row.packageType !== "skill" ||
            row.capability.contributionType !== "skill"
          ) {
            throw new Error(
              `执行节点“${node.title}”选择的 Skill 未安装或已停用`,
            );
          }
        }
      }
      if (role === "plugin") {
        const packageId =
          typeof node.parameters?.packageId === "string"
            ? node.parameters.packageId
            : "";
        const plugin = pluginById.get(packageId);
        if (!plugin || plugin.packageType !== "plugin") {
          throw new Error(
            `插件运行器“${node.title}”必须绑定当前账号可用的 Plugin Package`,
          );
        }
      }
    }
    const runtimeGraph = {
      nodes: graph.nodes.map((node) => {
        const row = capabilityById.get(node.capabilityId);
        if (!row) return node;
        return {
          ...node,
          parameters: {
            ...node.parameters,
            capabilitySnapshot: {
              id: row.capability.id,
              capabilityKey: row.capability.capabilityKey,
              title: row.capability.title,
              packageId: row.packageId,
              packageKey: row.packageKey,
              packageVersion: row.packageVersion,
              contributionType: row.capability.contributionType,
              inputSchema: JSON.parse(row.capability.inputSchemaJson),
              outputSchema: JSON.parse(row.capability.outputSchemaJson),
              uiSchema: JSON.parse(row.capability.uiSchemaJson),
              ports: JSON.parse(row.capability.portsJson),
              executionMode: row.capability.executionMode,
              modelRequirements: JSON.parse(
                row.capability.modelRequirementsJson,
              ),
            },
          },
        };
      }),
      edges: graph.edges,
    };
    const workflow = compileWorkflow(runtimeGraph.nodes, runtimeGraph.edges);
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
      graphJson: JSON.stringify(runtimeGraph),
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(kernelTasks).values(
      runtimeGraph.nodes.map((node) => {
        // 单节点运行中被标记复用的上游节点：直接预植为已成功任务（输出=已有结果），
        // 下游照常读取其输出，节点本身不会再次执行
        const reuseOutput = node.parameters?.reuseKernelOutput
          ? node.parameters?.kernelOutput
          : undefined;
        if (reuseOutput && typeof reuseOutput === "object") {
          return {
            id: `${runId}:${node.id}`,
            runId,
            nodeId: node.id,
            status: "succeeded",
            dependenciesJson: JSON.stringify(workflow.dependencies[node.id]),
            outputJson: JSON.stringify(reuseOutput),
            executor: "reuse",
            attempt: 0,
            maxAttempts: 1,
            completedAt: now,
            updatedAt: now,
          };
        }
        return {
          id: `${runId}:${node.id}`,
          runId,
          nodeId: node.id,
          status: "queued",
          dependenciesJson: JSON.stringify(workflow.dependencies[node.id]),
          attempt: 0,
          maxAttempts: Math.min(
            5,
            Math.max(
              1,
              Number(
                node.parameters?.failurePolicy === "retry"
                  ? node.parameters?.retryLimit ?? 3
                  : 1,
              ) || 1,
            ),
          ),
          updatedAt: now,
        };
      }),
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
