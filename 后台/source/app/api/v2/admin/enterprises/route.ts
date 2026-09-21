import type { RowDataPacket } from "mysql2/promise";
import { jsonError, requireSystemAdmin } from "../../../../lib/auth";
import { mysqlRows, mysqlTransaction } from "../../../../lib/mysql";

interface ApplicationRow extends RowDataPacket {
  id: string;
  organizationId: string;
  organizationName: string;
  registrationCode: string | null;
  contactName: string;
  note: string;
  status: "pending" | "approved" | "rejected";
  applicantId: string;
  applicantName: string;
  applicantEmail: string;
  phoneLast4: string | null;
  createdAt: string;
}

export async function GET(request: Request) {
  try {
    await requireSystemAdmin(request);
    const status = new URL(request.url).searchParams.get("status");
    const filter =
      status === "approved" || status === "rejected" ? status : "pending";
    const applications = await mysqlRows<ApplicationRow>(
      `SELECT
         ea.id,
         ea.organization_id AS organizationId,
         o.name AS organizationName,
         o.registration_code AS registrationCode,
         ea.contact_name AS contactName,
         ea.note,
         ea.status,
         ea.applicant_id AS applicantId,
         u.display_name AS applicantName,
         u.email AS applicantEmail,
         u.phone_last4 AS phoneLast4,
         ea.created_at AS createdAt
       FROM xiaoluo_v2_enterprise_applications ea
       INNER JOIN xiaoluo_v2_organizations o ON o.id = ea.organization_id
       INNER JOIN xiaoluo_v2_users u ON u.id = ea.applicant_id
       WHERE ea.status = ?
       ORDER BY ea.created_at ASC
       LIMIT 200`,
      [filter],
    );
    return Response.json({ applications });
  } catch (error) {
    return jsonError(error, "读取企业审核列表失败");
  }
}

export async function PATCH(request: Request) {
  try {
    const admin = await requireSystemAdmin(request);
    const body = (await request.json()) as {
      applicationId?: string;
      decision?: "approve" | "reject";
    };
    if (
      !body.applicationId ||
      (body.decision !== "approve" && body.decision !== "reject")
    ) {
      return Response.json({ error: "审核参数无效" }, { status: 400 });
    }
    const applicationId = body.applicationId;
    await mysqlTransaction(async (connection) => {
      const [rows] = await connection.execute<ApplicationRow[]>(
        `SELECT
           ea.id,
           ea.organization_id AS organizationId,
           o.name AS organizationName,
           o.registration_code AS registrationCode,
           ea.contact_name AS contactName,
           ea.note,
           ea.status,
           ea.applicant_id AS applicantId,
           u.display_name AS applicantName,
           u.email AS applicantEmail,
           u.phone_last4 AS phoneLast4,
           ea.created_at AS createdAt
         FROM xiaoluo_v2_enterprise_applications ea
         INNER JOIN xiaoluo_v2_organizations o ON o.id = ea.organization_id
         INNER JOIN xiaoluo_v2_users u ON u.id = ea.applicant_id
         WHERE ea.id = ?
         LIMIT 1
         FOR UPDATE`,
        [applicationId],
      );
      const application = rows[0];
      if (!application || application.status !== "pending") {
        throw new Response(
          JSON.stringify({ error: "申请不存在或已经处理" }),
          {
            status: 409,
            headers: { "content-type": "application/json; charset=utf-8" },
          },
        );
      }
      const nextStatus =
        body.decision === "approve" ? "approved" : "rejected";
      await connection.execute(
        `UPDATE xiaoluo_v2_enterprise_applications
         SET status = ?,
             reviewed_by = ?,
             reviewed_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?`,
        [nextStatus, admin.id, application.id],
      );
      if (body.decision === "reject") {
        await connection.execute(
          `UPDATE xiaoluo_v2_organizations
           SET status = 'rejected',
               reviewed_by = ?,
               reviewed_at = CURRENT_TIMESTAMP(3)
           WHERE id = ?`,
          [admin.id, application.organizationId],
        );
        return;
      }

      const workspaceId = crypto.randomUUID();
      const projectId = crypto.randomUUID();
      const canvasId = crypto.randomUUID();
      await connection.execute(
        `INSERT INTO xiaoluo_v2_workspaces (id, name, owner_id)
         VALUES (?, ?, ?)`,
        [
          workspaceId,
          `${application.organizationName}企业数据`,
          application.applicantId,
        ],
      );
      await connection.execute(
        `INSERT INTO xiaoluo_v2_workspace_members
          (workspace_id, user_id, role)
         VALUES (?, ?, 'owner')`,
        [workspaceId, application.applicantId],
      );
      await connection.execute(
        `INSERT INTO xiaoluo_v2_projects
          (id, workspace_id, name, description, created_by)
         VALUES (?, ?, '企业默认项目', '', ?)`,
        [projectId, workspaceId, application.applicantId],
      );
      await connection.execute(
        `INSERT INTO xiaoluo_v2_canvases
          (id, project_id, title, viewport_json, created_by)
         VALUES (?, ?, '企业灵境画布', ?, ?)`,
        [
          canvasId,
          projectId,
          JSON.stringify({ x: 0, y: 0, zoom: 100 }),
          application.applicantId,
        ],
      );
      await connection.execute(
        `UPDATE xiaoluo_v2_organizations
         SET status = 'active',
             workspace_id = ?,
             reviewed_by = ?,
             reviewed_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?`,
        [workspaceId, admin.id, application.organizationId],
      );
      await connection.execute(
        `INSERT INTO xiaoluo_v2_organization_members
          (organization_id, user_id, role, status)
         VALUES (?, ?, 'admin', 'active')`,
        [application.organizationId, application.applicantId],
      );
    });
    return Response.json({
      message: body.decision === "approve" ? "企业已通过审核" : "企业申请已拒绝",
    });
  } catch (error) {
    return jsonError(error, "企业审核失败");
  }
}
