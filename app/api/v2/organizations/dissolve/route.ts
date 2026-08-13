import type { RowDataPacket } from "mysql2/promise";
import { jsonError, requireUser } from "../../../../lib/auth";
import { requireOrganizationAccess } from "../../../../lib/organization-auth";
import { mysqlTransaction } from "../../../../lib/mysql";

interface MemberCountRow extends RowDataPacket {
  total: number;
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const body = (await request.json()) as { organizationId?: string };
    const organizationId = body.organizationId ?? "";
    if (!organizationId) {
      return Response.json({ error: "缺少企业 ID" }, { status: 400 });
    }
    const access = await requireOrganizationAccess(
      user.id,
      organizationId,
      true,
    );
    await mysqlTransaction(async (connection) => {
      const [counts] = await connection.execute<MemberCountRow[]>(
        `SELECT COUNT(*) AS total
         FROM xiaoluo_v2_organization_members
         WHERE organization_id = ? AND user_id <> ?`,
        [organizationId, user.id],
      );
      if (Number(counts[0]?.total ?? 0) > 0) {
        throw new Response(
          JSON.stringify({
            error:
              "解散企业前必须先将所有成员从企业中移出",
          }),
          {
            status: 409,
            headers: { "content-type": "application/json; charset=utf-8" },
          },
        );
      }
      if (access.workspaceId) {
        await connection.execute(
          `DELETE FROM xiaoluo_v2_workspaces WHERE id = ?`,
          [access.workspaceId],
        );
      }
      await connection.execute(
        `DELETE FROM xiaoluo_v2_organizations WHERE id = ?`,
        [organizationId],
      );
    });
    return Response.json({ message: "企业已解散" });
  } catch (error) {
    return jsonError(error, "解散企业失败");
  }
}
