import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { CanvasEdge, CanvasNode } from "../types";
import { mysqlRows, mysqlTransaction } from "./mysql";

interface HomeRow extends RowDataPacket {
  workspaceId: string;
  workspaceName: string;
  projectId: string | null;
  projectName: string | null;
  canvasId: string | null;
}

interface WorkspaceOptionRow extends RowDataPacket {
  id: string;
  name: string;
  role: "owner" | "admin" | "editor" | "viewer";
  organizationName: string | null;
  organizationRole: "admin" | "member" | null;
}

interface ProjectOptionRow extends RowDataPacket {
  id: string;
  name: string;
  description: string;
  status: "active" | "archived" | "trashed";
  updatedAt: Date | string;
}

export interface UserHome {
  workspaceId: string;
  workspaceName: string;
  projectId: string;
  projectName: string;
  canvasId: string;
}

interface CanvasRow extends RowDataPacket {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  revision: number;
  arrangeMode: "free" | "time" | "type";
  viewportJson: string | { x?: number; y?: number; zoom?: number };
  nodeCount: number;
  updatedAt: Date | string;
}

interface NodeRow extends RowDataPacket {
  id: string;
  title: string;
  prompt: string;
  kind: CanvasNode["kind"];
  status: CanvasNode["status"];
  capabilityId: string;
  modelId: string;
  x: number;
  y: number;
  createdAt: number | null;
  progress: number | null;
  result: string | null;
  parametersJson: string | Record<string, unknown>;
}

interface EdgeRow extends RowDataPacket {
  id: string;
  source: string;
  target: string;
}

function parsedJson<T>(value: string | T, fallback: T): T {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function timestamp(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toISOString();
}

export async function ensureUserHome(
  userId: string,
  displayName: string,
  preferredWorkspaceId = "",
): Promise<UserHome> {
  const existing = await mysqlRows<HomeRow>(
    `SELECT
       w.id AS workspaceId,
       w.name AS workspaceName,
       p.id AS projectId,
       p.name AS projectName,
       c.id AS canvasId
     FROM xiaoluo_v2_workspace_members wm
     INNER JOIN xiaoluo_v2_workspaces w ON w.id = wm.workspace_id
     LEFT JOIN xiaoluo_v2_projects p ON p.workspace_id = w.id
     LEFT JOIN xiaoluo_v2_canvases c ON c.project_id = p.id AND c.deleted_at IS NULL
     WHERE wm.user_id = ?
       AND w.status = 'active'
       AND (p.id IS NULL OR p.status = 'active')
       AND (c.id IS NULL OR c.archived_at IS NULL)
       AND (? = '' OR w.id = ?)
     ORDER BY w.created_at, p.created_at, c.created_at
     LIMIT 1`,
    [userId, preferredWorkspaceId, preferredWorkspaceId],
  );
  if (preferredWorkspaceId && !existing[0]) {
    throw new Response(JSON.stringify({ error: "没有访问该工作空间的权限" }), {
      status: 403,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  if (
    existing[0]?.projectId &&
    existing[0]?.projectName &&
    existing[0]?.canvasId
  ) {
    return {
      workspaceId: existing[0].workspaceId,
      workspaceName: existing[0].workspaceName,
      projectId: existing[0].projectId,
      projectName: existing[0].projectName,
      canvasId: existing[0].canvasId,
    };
  }

  return mysqlTransaction(async (connection) => {
    let workspaceId = existing[0]?.workspaceId;
    let workspaceName = existing[0]?.workspaceName;
    if (!workspaceId) {
      workspaceId = crypto.randomUUID();
      workspaceName = `${displayName}的工作空间`;
      await connection.execute(
        `INSERT INTO xiaoluo_v2_workspaces (id, name, owner_id) VALUES (?, ?, ?)`,
        [workspaceId, workspaceName, userId],
      );
      await connection.execute(
        `INSERT INTO xiaoluo_v2_workspace_members
          (workspace_id, user_id, role)
         VALUES (?, ?, 'owner')`,
        [workspaceId, userId],
      );
    }

    let projectId = existing[0]?.projectId;
    let projectName = existing[0]?.projectName;
    if (!projectId) {
      projectId = crypto.randomUUID();
      projectName = "我的第一个项目";
      await connection.execute(
        `INSERT INTO xiaoluo_v2_projects
          (id, workspace_id, name, description, created_by)
         VALUES (?, ?, ?, '', ?)`,
        [projectId, workspaceId, projectName, userId],
      );
    }

    let canvasId = existing[0]?.canvasId;
    if (!canvasId) {
      canvasId = crypto.randomUUID();
      await connection.execute(
        `INSERT INTO xiaoluo_v2_canvases
          (id, project_id, title, viewport_json, created_by)
         VALUES (?, ?, '灵境画布', ?, ?)`,
        [canvasId, projectId, JSON.stringify({ x: 0, y: 0, zoom: 92 }), userId],
      );
    }

    if (
      !workspaceId ||
      !workspaceName ||
      !projectId ||
      !projectName ||
      !canvasId
    ) {
      throw new Error("无法初始化用户工作空间");
    }
    return { workspaceId, workspaceName, projectId, projectName, canvasId };
  });
}

export async function listUserWorkspaces(userId: string) {
  const rows = await mysqlRows<WorkspaceOptionRow>(
    `SELECT
       w.id,
       w.name,
       wm.role,
       o.name AS organizationName,
       om.role AS organizationRole
     FROM xiaoluo_v2_workspace_members wm
     INNER JOIN xiaoluo_v2_workspaces w ON w.id = wm.workspace_id
     LEFT JOIN xiaoluo_v2_organizations o
       ON o.workspace_id = w.id AND o.status = 'active'
     LEFT JOIN xiaoluo_v2_organization_members om
       ON om.organization_id = o.id
      AND om.user_id = wm.user_id
      AND om.status = 'active'
     WHERE wm.user_id = ?
       AND w.status = 'active'
     ORDER BY
       CASE WHEN o.id IS NULL THEN 0 ELSE 1 END,
       w.created_at`,
    [userId],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    role: row.role,
    kind: row.organizationName ? "enterprise" as const : "personal" as const,
    organizationName: row.organizationName,
    organizationRole: row.organizationRole,
  }));
}

export async function listCanvases(projectId: string) {
  const rows = await mysqlRows<CanvasRow>(
    `SELECT
       c.id,
       c.title,
       c.project_id AS projectId,
       p.name AS projectName,
       c.revision,
       c.arrange_mode AS arrangeMode,
       c.viewport_json AS viewportJson,
       COUNT(n.id) AS nodeCount,
       c.updated_at AS updatedAt
     FROM xiaoluo_v2_canvases c
     INNER JOIN xiaoluo_v2_projects p ON p.id = c.project_id
     LEFT JOIN xiaoluo_v2_canvas_nodes n ON n.canvas_id = c.id
     WHERE c.project_id = ?
       AND p.status = 'active'
       AND c.deleted_at IS NULL
       AND c.archived_at IS NULL
     GROUP BY c.id, p.name
     ORDER BY c.updated_at DESC`,
    [projectId],
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    project: row.projectName,
    nodes: Number(row.nodeCount),
    updatedAt: timestamp(row.updatedAt),
    revision: Number(row.revision),
    arrangeMode: row.arrangeMode,
    viewport: parsedJson(row.viewportJson, { x: 0, y: 0, zoom: 92 }),
  }));
}

export async function listProjects(workspaceId: string) {
  const rows = await mysqlRows<ProjectOptionRow>(
    `SELECT id, name, description, status, updated_at AS updatedAt
     FROM xiaoluo_v2_projects
     WHERE workspace_id = ? AND status <> 'trashed'
     ORDER BY
       CASE status WHEN 'active' THEN 0 ELSE 1 END,
       updated_at DESC`,
    [workspaceId],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    updatedAt: timestamp(row.updatedAt),
  }));
}

export async function readCanvasGraph(canvasId: string) {
  const canvases = await mysqlRows<CanvasRow>(
    `SELECT
       c.id,
       c.title,
       c.project_id AS projectId,
       p.name AS projectName,
       c.revision,
       c.arrange_mode AS arrangeMode,
       c.viewport_json AS viewportJson,
       0 AS nodeCount,
       c.updated_at AS updatedAt
     FROM xiaoluo_v2_canvases c
     INNER JOIN xiaoluo_v2_projects p ON p.id = c.project_id
     WHERE c.id = ?
       AND p.status = 'active'
       AND c.deleted_at IS NULL
     LIMIT 1`,
    [canvasId],
  );
  const canvas = canvases[0];
  if (!canvas) return null;
  const [nodeRows, edgeRows] = await Promise.all([
    mysqlRows<NodeRow>(
      `SELECT
         id,
         title,
         prompt,
         kind,
         status,
         capability_id AS capabilityId,
         model_id AS modelId,
         x,
         y,
         client_created_at AS createdAt,
         progress,
         result,
         parameters_json AS parametersJson
       FROM xiaoluo_v2_canvas_nodes
       WHERE canvas_id = ?
       ORDER BY updated_at, id`,
      [canvasId],
    ),
    mysqlRows<EdgeRow>(
      `SELECT
         id,
         source_node_id AS source,
         target_node_id AS target
       FROM xiaoluo_v2_canvas_edges
       WHERE canvas_id = ?
       ORDER BY created_at, id`,
      [canvasId],
    ),
  ]);

  const nodes: CanvasNode[] = nodeRows.map((row) => ({
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    kind: row.kind,
    status: row.status,
    capabilityId: row.capabilityId,
    modelId: row.modelId,
    x: Number(row.x),
    y: Number(row.y),
    ...(row.createdAt === null ? {} : { createdAt: Number(row.createdAt) }),
    ...(row.progress === null ? {} : { progress: Number(row.progress) }),
    ...(row.result === null ? {} : { result: row.result }),
    parameters: parsedJson(row.parametersJson, {}),
  }));
  const edges: CanvasEdge[] = edgeRows.map((row) => ({
    id: row.id,
    source: row.source,
    target: row.target,
  }));

  return {
    id: canvas.id,
    title: canvas.title,
    projectId: canvas.projectId,
    projectName: canvas.projectName,
    revision: Number(canvas.revision),
    arrangeMode: canvas.arrangeMode,
    viewport: parsedJson(canvas.viewportJson, { x: 0, y: 0, zoom: 92 }),
    updatedAt: timestamp(canvas.updatedAt),
    nodes,
    edges,
  };
}

export async function replaceCanvasGraph(input: {
  canvasId: string;
  revision: number;
  arrangeMode: "free" | "time" | "type";
  viewport: { x: number; y: number; zoom: number };
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}) {
  return mysqlTransaction(async (connection) => {
    const [updated] = await connection.execute<ResultSetHeader>(
      `UPDATE xiaoluo_v2_canvases
       SET revision = revision + 1,
           arrange_mode = ?,
           viewport_json = ?,
           updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
      [
        input.arrangeMode,
        JSON.stringify(input.viewport),
        input.canvasId,
        input.revision,
      ],
    );
    if (updated.affectedRows !== 1) return null;

    await connection.execute("DELETE FROM xiaoluo_v2_canvas_edges WHERE canvas_id = ?", [
      input.canvasId,
    ]);
    await connection.execute("DELETE FROM xiaoluo_v2_canvas_nodes WHERE canvas_id = ?", [
      input.canvasId,
    ]);

    for (const node of input.nodes) {
      await connection.execute(
        `INSERT INTO xiaoluo_v2_canvas_nodes (
           id, canvas_id, kind, title, prompt, status, capability_id, model_id,
           x, y, progress, result, parameters_json, client_created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          node.id,
          input.canvasId,
          node.kind,
          node.title,
          node.prompt,
          node.status,
          node.capabilityId,
          node.modelId,
          node.x,
          node.y,
          node.progress ?? null,
          node.result ?? null,
          JSON.stringify(node.parameters ?? {}),
          node.createdAt ?? null,
        ],
      );
    }
    for (const edge of input.edges) {
      await connection.execute(
        `INSERT INTO xiaoluo_v2_canvas_edges
          (id, canvas_id, source_node_id, target_node_id)
         VALUES (?, ?, ?, ?)`,
        [edge.id, input.canvasId, edge.source, edge.target],
      );
    }
    return input.revision + 1;
  });
}
