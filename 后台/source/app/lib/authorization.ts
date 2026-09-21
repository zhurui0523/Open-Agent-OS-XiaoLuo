import type { RowDataPacket } from "mysql2/promise";
import { mysqlRows } from "./mysql";

export type WorkspaceRole = "owner" | "admin" | "editor" | "viewer";
export type AccessLevel = "view" | "edit" | "manage";

const roleWeight: Record<WorkspaceRole, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
  owner: 4,
};

const accessWeight: Record<AccessLevel, number> = {
  view: 1,
  edit: 2,
  manage: 3,
};

interface AccessRow extends RowDataPacket {
  role: WorkspaceRole;
  directPermission: AccessLevel | null;
}

function canAccess(row: AccessRow, required: AccessLevel) {
  const workspaceAllows =
    roleWeight[row.role] >=
    (required === "manage" ? roleWeight.admin : roleWeight.editor);
  if (required === "view") return true;
  if (workspaceAllows) return true;
  return (
    row.directPermission !== null &&
    accessWeight[row.directPermission] >= accessWeight[required]
  );
}

function forbidden() {
  return new Response(JSON.stringify({ error: "没有访问该资源的权限" }), {
    status: 403,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function requireWorkspaceAccess(
  userId: string,
  workspaceId: string,
  required: AccessLevel = "view",
) {
  const rows = await mysqlRows<AccessRow>(
    `SELECT wm.role, NULL AS directPermission
     FROM xiaoluo_v2_workspace_members wm
     INNER JOIN xiaoluo_v2_workspaces w ON w.id = wm.workspace_id
     WHERE wm.workspace_id = ?
       AND wm.user_id = ?
       AND w.status = 'active'
     LIMIT 1`,
    [workspaceId, userId],
  );
  const row = rows[0];
  if (!row || !canAccess(row, required)) throw forbidden();
  return row;
}

export async function requireProjectAccess(
  userId: string,
  projectId: string,
  required: AccessLevel = "view",
) {
  const rows = await mysqlRows<AccessRow & { workspaceId: string }>(
    `SELECT
       wm.role,
       rp.permission AS directPermission,
       p.workspace_id AS workspaceId
     FROM xiaoluo_v2_projects p
     INNER JOIN xiaoluo_v2_workspace_members wm
       ON wm.workspace_id = p.workspace_id AND wm.user_id = ?
     LEFT JOIN xiaoluo_v2_resource_permissions rp
       ON rp.resource_type = 'project'
      AND rp.resource_id = p.id
      AND rp.user_id = ?
     WHERE p.id = ?
       AND p.status = 'active'
     LIMIT 1`,
    [userId, userId, projectId],
  );
  const row = rows[0];
  if (!row || !canAccess(row, required)) throw forbidden();
  return row;
}

export async function requireCanvasAccess(
  userId: string,
  canvasId: string,
  required: AccessLevel = "view",
  includeDeleted = false,
) {
  const rows = await mysqlRows<
    AccessRow & { projectId: string; workspaceId: string }
  >(
    `SELECT
       COALESCE(
         wm.role,
         CASE WHEN enterprise_member.user_id IS NOT NULL THEN 'editor' END
       ) AS role,
       COALESCE(
         canvas_permission.permission,
         project_permission.permission,
         CASE WHEN enterprise_member.user_id IS NOT NULL THEN 'edit' END
       )
         AS directPermission,
       c.project_id AS projectId,
       p.workspace_id AS workspaceId
     FROM xiaoluo_v2_canvases c
     INNER JOIN xiaoluo_v2_projects p ON p.id = c.project_id
     LEFT JOIN xiaoluo_v2_workspace_members wm
       ON wm.workspace_id = p.workspace_id AND wm.user_id = ?
     LEFT JOIN xiaoluo_v2_canvas_enterprise_shares enterprise_share
       ON enterprise_share.canvas_id = c.id
     LEFT JOIN xiaoluo_v2_organization_members enterprise_member
       ON enterprise_member.organization_id = enterprise_share.organization_id
      AND enterprise_member.user_id = ?
      AND enterprise_member.status = 'active'
     LEFT JOIN xiaoluo_v2_organizations enterprise
       ON enterprise.id = enterprise_share.organization_id
      AND enterprise.status = 'active'
     LEFT JOIN xiaoluo_v2_resource_permissions canvas_permission
       ON canvas_permission.resource_type = 'canvas'
      AND canvas_permission.resource_id = c.id
      AND canvas_permission.user_id = ?
     LEFT JOIN xiaoluo_v2_resource_permissions project_permission
       ON project_permission.resource_type = 'project'
      AND project_permission.resource_id = p.id
      AND project_permission.user_id = ?
     WHERE c.id = ?
       AND p.status = 'active'
       ${includeDeleted ? "" : "AND c.deleted_at IS NULL"}
       AND (
         wm.user_id IS NOT NULL
         OR (
           enterprise_member.user_id IS NOT NULL
           AND enterprise.id IS NOT NULL
         )
       )
     LIMIT 1`,
    [userId, userId, userId, userId, canvasId],
  );
  const row = rows[0];
  if (!row || !canAccess(row, required)) throw forbidden();
  return row;
}
