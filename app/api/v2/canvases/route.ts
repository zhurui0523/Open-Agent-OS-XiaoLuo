import type { RowDataPacket } from "mysql2/promise";
import { jsonError, requireUser } from "../../../lib/auth";
import {
  requireCanvasAccess,
  requireProjectAccess,
} from "../../../lib/authorization";
import { mysqlExecute, mysqlRows } from "../../../lib/mysql";
import {
  listCanvases,
  readCanvasGraph,
  replaceCanvasGraph,
} from "../../../lib/workspace-store";
import type { CanvasEdge, CanvasNode } from "../../../types";
import { validateEdgePorts } from "../../../lib/node-ports";
import {
  compileWorkflow,
  WorkflowCompileError,
} from "../../../lib/workflow-kernel";

interface ProjectRow extends RowDataPacket {
  name: string;
}

function validArrangeMode(
  value: unknown,
): value is "free" | "time" | "type" {
  return value === "free" || value === "time" || value === "type";
}

function validNodes(value: unknown): value is CanvasNode[] {
  return (
    Array.isArray(value) &&
    value.length <= 2_000 &&
    value.every(
      (node) =>
        node &&
        typeof node === "object" &&
        typeof node.id === "string" &&
        typeof node.title === "string" &&
        typeof node.prompt === "string" &&
        (node.kind === "text" ||
          node.kind === "image" ||
          node.kind === "video" ||
          node.kind === "audio" ||
          node.kind === "document") &&
        typeof node.x === "number" &&
        Number.isFinite(node.x) &&
        typeof node.y === "number" &&
        Number.isFinite(node.y),
    )
  );
}

function validEdges(value: unknown, nodeIds: Set<string>): value is CanvasEdge[] {
  return (
    Array.isArray(value) &&
    value.length <= 10_000 &&
    value.every(
      (edge) =>
        edge &&
        typeof edge === "object" &&
        typeof edge.id === "string" &&
        typeof edge.source === "string" &&
        typeof edge.target === "string" &&
        typeof edge.sourcePort === "string" &&
        typeof edge.targetPort === "string" &&
        (edge.dataType === "text" ||
          edge.dataType === "image" ||
          edge.dataType === "video" ||
          edge.dataType === "audio" ||
          edge.dataType === "document" ||
          edge.dataType === "json") &&
        edge.source !== edge.target &&
        nodeIds.has(edge.source) &&
        nodeIds.has(edge.target),
    )
  );
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (id) {
      await requireCanvasAccess(user.id, id, "view");
      const canvas = await readCanvasGraph(id);
      return canvas
        ? Response.json({ canvas })
        : Response.json({ error: "画布不存在" }, { status: 404 });
    }
    const projectId = url.searchParams.get("projectId");
    if (!projectId) {
      return Response.json({ error: "缺少 projectId" }, { status: 400 });
    }
    await requireProjectAccess(user.id, projectId, "view");
    const requestedState = url.searchParams.get("state");
    const state =
      requestedState === "archived" || requestedState === "deleted"
        ? requestedState
        : "active";
    return Response.json({ canvases: await listCanvases(projectId, state) });
  } catch (error) {
    return jsonError(error, "读取画布失败");
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const body = (await request.json()) as {
      projectId?: string;
      title?: string;
      sourceCanvasId?: string;
    };
    const projectId = body.projectId ?? "";
    const title = body.title?.trim().slice(0, 180) || "未命名画布";
    await requireProjectAccess(user.id, projectId, "edit");
    const projects = await mysqlRows<ProjectRow>(
      "SELECT name FROM xiaoluo_v2_projects WHERE id = ? LIMIT 1",
      [projectId],
    );
    if (!projects[0]) {
      return Response.json({ error: "项目不存在" }, { status: 404 });
    }
    let sourceGraph: Awaited<ReturnType<typeof readCanvasGraph>> = null;
    if (body.sourceCanvasId) {
      await requireCanvasAccess(user.id, body.sourceCanvasId, "view");
      sourceGraph = await readCanvasGraph(body.sourceCanvasId);
      if (!sourceGraph || sourceGraph.projectId !== projectId) {
        return Response.json(
          { error: "只能复制当前项目中可访问的画布" },
          { status: 400 },
        );
      }
    }
    const id = crypto.randomUUID();
    await mysqlExecute(
      `INSERT INTO xiaoluo_v2_canvases
        (id, project_id, title, viewport_json, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [
        id,
        projectId,
        title,
        JSON.stringify(sourceGraph?.viewport ?? { x: 0, y: 0, zoom: 92 }),
        user.id,
      ],
    );
    let revision = 1;
    let nodeCount = 0;
    if (sourceGraph) {
      nodeCount = sourceGraph.nodes.length;
      revision =
        (await replaceCanvasGraph({
          canvasId: id,
          revision: 1,
          arrangeMode: sourceGraph.arrangeMode,
          viewport: sourceGraph.viewport,
          nodes: sourceGraph.nodes.map((node) => ({ ...node })),
          edges: sourceGraph.edges.map((edge) => ({ ...edge })),
        })) ?? 1;
    }
    return Response.json(
      {
        canvas: {
          id,
          title,
          project: projects[0].name,
          nodes: nodeCount,
          updatedAt: new Date().toISOString(),
          revision,
          arrangeMode: sourceGraph?.arrangeMode ?? "free",
          viewport: sourceGraph?.viewport ?? { x: 0, y: 0, zoom: 92 },
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return jsonError(error, "创建画布失败");
  }
}

export async function PUT(request: Request) {
  try {
    const user = await requireUser(request);
    const body = (await request.json()) as {
      id?: string;
      revision?: number;
      arrangeMode?: unknown;
      viewport?: { x?: unknown; y?: unknown; zoom?: unknown };
      nodes?: unknown;
      edges?: unknown;
    };
    const id = body.id ?? "";
    if (!id || !Number.isSafeInteger(body.revision) || !validArrangeMode(body.arrangeMode)) {
      return Response.json({ error: "画布保存参数无效" }, { status: 400 });
    }
    if (!validNodes(body.nodes)) {
      return Response.json({ error: "节点数据无效" }, { status: 400 });
    }
    const nodeIds = new Set(body.nodes.map((node) => node.id));
    if (!validEdges(body.edges, nodeIds)) {
      return Response.json({ error: "连线数据无效" }, { status: 400 });
    }
    const nodesById = new Map(body.nodes.map((node) => [node.id, node]));
    for (const edge of body.edges) {
      const source = nodesById.get(edge.source);
      const target = nodesById.get(edge.target);
      if (!source || !target) continue;
      const incompatibility = validateEdgePorts(edge, source, target);
      if (incompatibility) {
        return Response.json(
          {
            error: `连线 ${edge.id} 不兼容：${incompatibility}`,
            code: "INCOMPATIBLE_PORTS",
          },
          { status: 422 },
        );
      }
    }
    if (body.nodes.length) {
      try {
        compileWorkflow(body.nodes, body.edges);
      } catch (error) {
        if (error instanceof WorkflowCompileError) {
          return Response.json(
            { error: error.message, code: error.code },
            { status: 422 },
          );
        }
        throw error;
      }
    }
    const viewport = body.viewport;
    if (
      !viewport ||
      typeof viewport.x !== "number" ||
      typeof viewport.y !== "number" ||
      typeof viewport.zoom !== "number"
    ) {
      return Response.json({ error: "画布视口数据无效" }, { status: 400 });
    }
    await requireCanvasAccess(user.id, id, "edit");
    const revision = await replaceCanvasGraph({
      canvasId: id,
      revision: body.revision as number,
      arrangeMode: body.arrangeMode,
      viewport: { x: viewport.x, y: viewport.y, zoom: viewport.zoom },
      nodes: body.nodes,
      edges: body.edges,
    });
    if (revision === null) {
      return Response.json(
        { error: "画布已在其他位置更新，请刷新后重试", conflict: true },
        { status: 409 },
      );
    }
    return Response.json({ ok: true, revision, savedAt: new Date().toISOString() });
  } catch (error) {
    return jsonError(error, "保存画布失败");
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await requireUser(request);
    const body = (await request.json()) as {
      id?: string;
      projectId?: string;
      action?: "rename" | "archive" | "restore" | "star";
      title?: string;
      starred?: boolean;
    };
    if (!body.id || !body.action) {
      return Response.json({ error: "画布参数无效" }, { status: 400 });
    }
    if (body.action === "restore") {
      if (!body.projectId) {
        return Response.json({ error: "恢复画布需要 projectId" }, { status: 400 });
      }
      await requireProjectAccess(user.id, body.projectId, "manage");
      await mysqlExecute(
        `UPDATE xiaoluo_v2_canvases
         SET deleted_at = NULL,
             archived_at = NULL,
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND project_id = ?`,
        [body.id, body.projectId],
      );
      return Response.json({ ok: true });
    }
    await requireCanvasAccess(user.id, body.id, "manage");
    if (body.action === "rename") {
      const title = body.title?.trim().slice(0, 180);
      if (!title) {
        return Response.json({ error: "画布名称不能为空" }, { status: 400 });
      }
      await mysqlExecute(
        `UPDATE xiaoluo_v2_canvases
         SET title = ?, updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND deleted_at IS NULL`,
        [title, body.id],
      );
    } else if (body.action === "archive") {
      await mysqlExecute(
        `UPDATE xiaoluo_v2_canvases
         SET archived_at = CURRENT_TIMESTAMP(3),
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND deleted_at IS NULL`,
        [body.id],
      );
    } else {
      await mysqlExecute(
        `UPDATE xiaoluo_v2_canvases
         SET starred = ?, updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND deleted_at IS NULL`,
        [Boolean(body.starred), body.id],
      );
    }
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error, "更新画布失败");
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireUser(request);
    const id = new URL(request.url).searchParams.get("id")?.trim();
    if (!id) return Response.json({ error: "画布 ID 必填" }, { status: 400 });
    await requireCanvasAccess(user.id, id, "manage");
    await mysqlExecute(
      `UPDATE xiaoluo_v2_canvases
       SET deleted_at = CURRENT_TIMESTAMP(3),
           updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?`,
      [id],
    );
    return Response.json({ ok: true, recoverableDays: 30 });
  } catch (error) {
    return jsonError(error, "删除画布失败");
  }
}
