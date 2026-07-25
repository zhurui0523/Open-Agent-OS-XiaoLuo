import { jsonError, requireUser } from "../../../../lib/auth";
import { mysqlExecute } from "../../../../lib/mysql";

export async function PATCH(request: Request) {
  try {
    const user = await requireUser(request);
    const body = (await request.json()) as {
      displayName?: string;
    };
    const displayName = body.displayName?.trim().slice(0, 80) ?? "";
    if (displayName.length < 2) {
      return Response.json(
        { error: "显示名称至少需要 2 个字符" },
        { status: 400 },
      );
    }
    await mysqlExecute(
      `UPDATE xiaoluo_v2_users
       SET display_name = ?,
           updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?`,
      [displayName, user.id],
    );
    return Response.json({
      user: { ...user, displayName },
      message: "个人资料已更新",
    });
  } catch (error) {
    return jsonError(error, "更新个人资料失败");
  }
}
