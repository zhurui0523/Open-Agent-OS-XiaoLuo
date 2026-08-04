import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { CanvasEdge, CanvasGroup, CanvasNode } from "../types";
import { mysqlRows, mysqlTransaction } from "./mysql";
import { normalizeEdgePorts } from "./node-ports";

interface HomeRow extends RowDataPacket {
  workspaceId: string;
  projectId: string | null;
  projectName: string | null;
  canvasId: string | null;
}

interface ProjectOptionRow extends RowDataPacket {
  id: string;
  name: string;
  description: string;
  status: "active" | "archived" | "trashed";
  updatedAt: Date | string;
}

export interface UserHome {
  // Legacy tenancy keys kept only for database isolation. They are not a
  // user-manageable product concept; the product surface is canvas-first.
  workspaceId: string;
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
  starred: boolean;
  arrangeMode: "free" | "time" | "type";
  viewportJson: string | { x?: number; y?: number; zoom?: number };
  groupsJson: string | CanvasGroup[];
  nodeCount: number;
  updatedAt: Date | string;
  enterpriseShared?: number;
}

interface NodeRow extends RowDataPacket {
  id: string;
  title: string;
  prompt: string;
  kind: CanvasNode["kind"];
  role: CanvasNode["role"];
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
  sourcePort: string;
  targetPort: string;
  dataType: CanvasEdge["dataType"];
}

function parsedJson<T>(value: string | T, fallback: T): T {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parsedViewport(
  value: string | { x?: number; y?: number; zoom?: number },
) {
  const parsed = parsedJson(value, {});
  return {
    x: Number.isFinite(parsed.x) ? Number(parsed.x) : 0,
    y: Number.isFinite(parsed.y) ? Number(parsed.y) : 0,
    zoom: Number.isFinite(parsed.zoom) ? Number(parsed.zoom) : 100,
  };
}

function timestamp(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value) : date.toISOString();
}

export async function ensureUserHome(
  userId: string,
  displayName: string,
): Promise<UserHome> {
  const existing = await mysqlRows<HomeRow>(
    `SELECT
       w.id AS workspaceId,
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
     ORDER BY w.created_at, p.created_at, c.created_at
     LIMIT 1`,
    [userId],
  );
  if (
    existing[0]?.projectId &&
    existing[0]?.projectName &&
    existing[0]?.canvasId
  ) {
    return {
      workspaceId: existing[0].workspaceId,
      projectId: existing[0].projectId,
      projectName: existing[0].projectName,
      canvasId: existing[0].canvasId,
    };
  }

  return mysqlTransaction(async (connection) => {
    let workspaceId = existing[0]?.workspaceId;
    if (!workspaceId) {
      workspaceId = crypto.randomUUID();
      await connection.execute(
        `INSERT INTO xiaoluo_v2_workspaces (id, name, owner_id) VALUES (?, ?, ?)`,
        [workspaceId, `${displayName}账户数据`, userId],
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
        [canvasId, projectId, JSON.stringify({ x: 0, y: 0, zoom: 100 }), userId],
      );
    }

    if (
      !workspaceId ||
      !projectId ||
      !projectName ||
      !canvasId
    ) {
      throw new Error("无法初始化用户画布数据");
    }
    return { workspaceId, projectId, projectName, canvasId };
  });
}

export async function listCanvases(
  projectId: string,
  state: "active" | "archived" | "deleted" = "active",
  userId = "",
) {
  const stateClause =
    state === "deleted"
      ? "c.deleted_at IS NOT NULL"
      : state === "archived"
        ? "c.deleted_at IS NULL AND c.archived_at IS NOT NULL"
        : "c.deleted_at IS NULL AND c.archived_at IS NULL";
  const rows = await mysqlRows<CanvasRow>(
    `SELECT
       c.id,
       c.title,
       c.project_id AS projectId,
       p.name AS projectName,
       c.revision,
       c.starred,
       c.arrange_mode AS arrangeMode,
       c.viewport_json AS viewportJson,
       c.groups_json AS groupsJson,
       COUNT(n.id) AS nodeCount,
       CASE WHEN c.project_id = ? THEN 0 ELSE 1 END AS enterpriseShared,
       c.updated_at AS updatedAt
     FROM xiaoluo_v2_canvases c
     INNER JOIN xiaoluo_v2_projects p ON p.id = c.project_id
     LEFT JOIN xiaoluo_v2_canvas_nodes n ON n.canvas_id = c.id
     WHERE (
       c.project_id = ?
       ${
         state === "active" && userId
           ? `OR EXISTS (
               SELECT 1
               FROM xiaoluo_v2_canvas_enterprise_shares enterprise_share
               INNER JOIN xiaoluo_v2_organization_members enterprise_member
                 ON enterprise_member.organization_id = enterprise_share.organization_id
                AND enterprise_member.user_id = ?
                AND enterprise_member.status = 'active'
               INNER JOIN xiaoluo_v2_organizations enterprise
                 ON enterprise.id = enterprise_share.organization_id
                AND enterprise.status = 'active'
               WHERE enterprise_share.canvas_id = c.id
             )`
           : ""
       }
     )
       AND p.status = 'active'
       AND ${stateClause}
     GROUP BY c.id, p.name
     ORDER BY c.updated_at DESC`,
    state === "active" && userId
      ? [projectId, projectId, userId]
      : [projectId, projectId],
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    project: row.projectName,
    nodes: Number(row.nodeCount),
    updatedAt: timestamp(row.updatedAt),
    revision: Number(row.revision),
    starred: Boolean(row.starred),
    arrangeMode: row.arrangeMode,
    viewport: parsedViewport(row.viewportJson),
    enterpriseShared: Boolean(row.enterpriseShared),
    canManage: !row.enterpriseShared,
  }));
}

export async function listUserCanvases(
  userId: string,
  state: "active" | "archived" | "deleted" = "active",
) {
  const stateClause =
    state === "deleted"
      ? "c.deleted_at IS NOT NULL"
      : state === "archived"
        ? "c.deleted_at IS NULL AND c.archived_at IS NOT NULL"
        : "c.deleted_at IS NULL AND c.archived_at IS NULL";
  const rows = await mysqlRows<CanvasRow>(
    `SELECT
       c.id,
       c.title,
       c.project_id AS projectId,
       p.name AS projectName,
       c.revision,
       c.starred,
       c.arrange_mode AS arrangeMode,
       c.viewport_json AS viewportJson,
       c.groups_json AS groupsJson,
       COUNT(n.id) AS nodeCount,
       CASE WHEN c.created_by = ? THEN 0 ELSE 1 END AS enterpriseShared,
       c.updated_at AS updatedAt
     FROM xiaoluo_v2_canvases c
     INNER JOIN xiaoluo_v2_projects p ON p.id = c.project_id
     LEFT JOIN xiaoluo_v2_canvas_nodes n ON n.canvas_id = c.id
     WHERE (
       c.created_by = ?
       OR EXISTS (
         SELECT 1
         FROM xiaoluo_v2_workspace_members member_scope
         WHERE member_scope.workspace_id = p.workspace_id
           AND member_scope.user_id = ?
       )
       OR EXISTS (
         SELECT 1
         FROM xiaoluo_v2_canvas_enterprise_shares enterprise_share
         INNER JOIN xiaoluo_v2_organization_members enterprise_member
           ON enterprise_member.organization_id = enterprise_share.organization_id
          AND enterprise_member.user_id = ?
          AND enterprise_member.status = 'active'
         WHERE enterprise_share.canvas_id = c.id
       )
     )
       AND p.status = 'active'
       AND ${stateClause}
     GROUP BY c.id, p.name
     ORDER BY c.updated_at DESC`,
    [userId, userId, userId, userId],
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    project: row.projectName,
    nodes: Number(row.nodeCount),
    updatedAt: timestamp(row.updatedAt),
    revision: Number(row.revision),
    starred: Boolean(row.starred),
    arrangeMode: row.arrangeMode,
    viewport: parsedViewport(row.viewportJson),
    enterpriseShared: Boolean(row.enterpriseShared),
    canManage: !row.enterpriseShared,
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
       c.starred,
       c.arrange_mode AS arrangeMode,
       c.viewport_json AS viewportJson,
       c.groups_json AS groupsJson,
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
         node_role AS role,
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
         target_node_id AS target,
         source_port_id AS sourcePort,
         target_port_id AS targetPort,
         data_type AS dataType
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
    role: row.role ?? undefined,
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
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const edges: CanvasEdge[] = edgeRows.flatMap((row) => {
    const source = nodeMap.get(row.source);
    const target = nodeMap.get(row.target);
    return source && target
      ? [
          normalizeEdgePorts(
            {
              id: row.id,
              source: row.source,
              target: row.target,
              sourcePort: row.sourcePort,
              targetPort: row.targetPort,
              dataType: row.dataType,
            },
            source,
            target,
          ),
        ]
      : [];
  });

  return {
    id: canvas.id,
    title: canvas.title,
    projectId: canvas.projectId,
    projectName: canvas.projectName,
    revision: Number(canvas.revision),
    arrangeMode: canvas.arrangeMode,
    viewport: parsedViewport(canvas.viewportJson),
    groups: parsedJson(canvas.groupsJson, []),
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
  groups: CanvasGroup[];
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}) {
  return mysqlTransaction(async (connection) => {
    const [updated] = await connection.execute<ResultSetHeader>(
      `UPDATE xiaoluo_v2_canvases
       SET revision = revision + 1,
           arrange_mode = ?,
           viewport_json = ?,
           groups_json = ?,
           updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ? AND revision = ? AND deleted_at IS NULL`,
      [
        input.arrangeMode,
        JSON.stringify(input.viewport),
        JSON.stringify(input.groups),
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
           id, canvas_id, kind, node_role, title, prompt, status, capability_id, model_id,
           x, y, progress, result, parameters_json, client_created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          node.id,
          input.canvasId,
          node.kind,
          node.role ?? String(node.parameters?.nodeRole ?? "execution"),
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
          (
            id, canvas_id, source_node_id, target_node_id,
            source_port_id, target_port_id, data_type
          )
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          edge.id,
          input.canvasId,
          edge.source,
          edge.target,
          edge.sourcePort,
          edge.targetPort,
          edge.dataType,
        ],
      );
    }
    return input.revision + 1;
  });
}
