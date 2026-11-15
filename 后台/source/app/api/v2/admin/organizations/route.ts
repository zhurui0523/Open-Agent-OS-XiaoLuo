import type { RowDataPacket } from "mysql2/promise";
import { jsonError, requireSystemAdmin } from "../../../../lib/auth";
import { mysqlRows } from "../../../../lib/mysql";

interface OrganizationRow extends RowDataPacket {
  id: string;
  name: string;
  registrationCode: string | null;
  status: "pending" | "active" | "rejected" | "disabled";
  createdAt: string;
  creatorName: string;
  creatorUsername: string;
  adminNames: string | null;
  memberCount: number;
}

export async function GET(request: Request) {
  try {
    await requireSystemAdmin(request);
    const organizations = await mysqlRows<OrganizationRow>(
      `SELECT
         o.id,
         o.name,
         o.registration_code AS registrationCode,
         o.status,
         o.created_at AS createdAt,
         creator.display_name AS creatorName,
         creator.username AS creatorUsername,
         (
           SELECT GROUP_CONCAT(u.display_name ORDER BY om.created_at SEPARATOR '、')
           FROM xiaoluo_v2_organization_members om
           INNER JOIN xiaoluo_v2_users u ON u.id = om.user_id
           WHERE om.organization_id = o.id AND om.role = 'admin' AND om.status = 'active'
         ) AS adminNames,
         (
           SELECT COUNT(*)
           FROM xiaoluo_v2_organization_members om
           WHERE om.organization_id = o.id
         ) AS memberCount
       FROM xiaoluo_v2_organizations o
       LEFT JOIN xiaoluo_v2_users creator ON creator.id = o.created_by
       ORDER BY FIELD(o.status, 'active', 'pending', 'disabled', 'rejected'),
                o.created_at DESC
       LIMIT 500`,
    );
    return Response.json({ organizations });
  } catch (error) {
    return jsonError(error, "读取企业列表失败");
  }
}
