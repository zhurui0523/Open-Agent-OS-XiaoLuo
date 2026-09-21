import type { RowDataPacket } from "mysql2/promise";
import { jsonError, requireUser } from "../../../../lib/auth";
import { requireOrganizationAccess } from "../../../../lib/organization-auth";
import { mysqlTransaction } from "../../../../lib/mysql";
import { purgeEnterpriseMemberContent } from "../../../../lib/organization-member-exit";
import { ensureUserHome } from "../../../../lib/workspace-store";

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const body = (await request.json()) as { organizationId?: string };
    const organizationId = body.organizationId ?? "";
    if (!organizationId) {
      return Response.json({ error: "缺少企业 ID" }, { status: 400 });
    }
    const access = await requireOrganizationAccess(user.id, organizationId);
    if (access.role === "admin") {
      throw new Response(
        JSON.stringify({
          error:
            "企业管理员不能退出企业，请使用“解散企业”（需先将所有成员移出企业）",
        }),
        {
          status: 409,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      );
    }
    await mysqlTransaction(async (connection) => {
      // 退出即清除其在企业期间产生的全部内容，不再保留任何企业工作资产
      await purgeEnterpriseMemberContent(
        connection,
        organizationId,
        access.workspaceId ?? null,
        user.id,
      );
      if (access.workspaceId) {
        await connection.execute(
          `DELETE FROM xiaoluo_v2_workspace_members
           WHERE workspace_id = ? AND user_id = ?`,
          [access.workspaceId, user.id],
        );
      }
      await connection.execute(
        `DELETE FROM xiaoluo_v2_organization_members
         WHERE organization_id = ? AND user_id = ?`,
        [organizationId, user.id],
      );
    });
    // 转为普通用户后，为其重建一个全新的空个人空间
    await ensureUserHome(user.id, user.displayName);
    return Response.json({ message: "已退出企业" });
  } catch (error) {
    return jsonError(error, "退出企业失败");
  }
}
