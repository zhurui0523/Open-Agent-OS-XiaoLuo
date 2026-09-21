import type { RowDataPacket } from "mysql2/promise";
import { mysqlRows } from "./mysql";

export type OrganizationRole = "admin" | "member";

interface OrganizationAccessRow extends RowDataPacket {
  role: OrganizationRole;
  organizationStatus: "pending" | "active" | "rejected" | "disabled";
  membershipStatus: "active" | "disabled";
  workspaceId: string | null;
}

function forbidden(message: string) {
  return new Response(JSON.stringify({ error: message }), {
    status: 403,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function requireOrganizationAccess(
  userId: string,
  organizationId: string,
  adminOnly = false,
) {
  const rows = await mysqlRows<OrganizationAccessRow>(
    `SELECT
       om.role,
       o.status AS organizationStatus,
       om.status AS membershipStatus,
       o.workspace_id AS workspaceId
     FROM xiaoluo_v2_organization_members om
     INNER JOIN xiaoluo_v2_organizations o ON o.id = om.organization_id
     WHERE om.organization_id = ? AND om.user_id = ?
     LIMIT 1`,
    [organizationId, userId],
  );
  const access = rows[0];
  if (
    !access ||
    access.organizationStatus !== "active" ||
    access.membershipStatus !== "active"
  ) {
    throw forbidden("没有访问该企业的权限");
  }
  if (adminOnly && access.role !== "admin") {
    throw forbidden("仅企业管理员可以执行此操作");
  }
  return access;
}

