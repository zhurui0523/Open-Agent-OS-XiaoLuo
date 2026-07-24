import type { RowDataPacket } from "mysql2/promise";
import { jsonError, requireUser } from "../../../lib/auth";
import { mysqlRows, mysqlTransaction } from "../../../lib/mysql";

interface OrganizationRow extends RowDataPacket {
  id: string;
  name: string;
  status: "pending" | "active" | "rejected" | "disabled";
  role: "admin" | "member" | null;
  membershipStatus: "active" | "disabled" | null;
  workspaceId: string | null;
  applicationStatus: "pending" | "approved" | "rejected" | null;
  createdAt: string;
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const organizations = await mysqlRows<OrganizationRow>(
      `SELECT
         o.id,
         o.name,
         o.status,
         om.role,
         om.status AS membershipStatus,
         o.workspace_id AS workspaceId,
         ea.status AS applicationStatus,
         o.created_at AS createdAt
       FROM xiaoluo_v2_organizations o
       LEFT JOIN xiaoluo_v2_organization_members om
         ON om.organization_id = o.id AND om.user_id = ?
       LEFT JOIN xiaoluo_v2_enterprise_applications ea
         ON ea.organization_id = o.id AND ea.applicant_id = ?
       WHERE om.user_id = ? OR ea.applicant_id = ?
       ORDER BY o.created_at DESC`,
      [user.id, user.id, user.id, user.id],
    );
    return Response.json({ organizations });
  } catch (error) {
    return jsonError(error, "读取企业信息失败");
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const body = (await request.json()) as {
      name?: string;
      registrationCode?: string;
      contactName?: string;
      note?: string;
    };
    const name = body.name?.trim().slice(0, 160) ?? "";
    const contactName =
      body.contactName?.trim().slice(0, 80) || user.displayName;
    if (name.length < 2) {
      return Response.json(
        { error: "企业名称至少需要 2 个字符" },
        { status: 400 },
      );
    }
    const pending = await mysqlRows<RowDataPacket>(
      `SELECT 1
       FROM xiaoluo_v2_enterprise_applications
       WHERE applicant_id = ? AND status = 'pending'
       LIMIT 1`,
      [user.id],
    );
    if (pending.length) {
      return Response.json(
        { error: "你已有待审核的企业申请" },
        { status: 409 },
      );
    }
    const organizationId = crypto.randomUUID();
    const applicationId = crypto.randomUUID();
    await mysqlTransaction(async (connection) => {
      await connection.execute(
        `INSERT INTO xiaoluo_v2_organizations
          (id, name, registration_code, created_by)
         VALUES (?, ?, ?, ?)`,
        [
          organizationId,
          name,
          body.registrationCode?.trim().slice(0, 80) || null,
          user.id,
        ],
      );
      await connection.execute(
        `INSERT INTO xiaoluo_v2_enterprise_applications
          (id, organization_id, applicant_id, contact_name, note)
         VALUES (?, ?, ?, ?, ?)`,
        [
          applicationId,
          organizationId,
          user.id,
          contactName,
          body.note?.trim().slice(0, 2000) ?? "",
        ],
      );
    });
    return Response.json(
      {
        application: {
          id: applicationId,
          organizationId,
          name,
          status: "pending",
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return jsonError(error, "提交企业申请失败");
  }
}

