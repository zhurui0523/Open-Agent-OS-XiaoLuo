import {
  jsonError,
  normalizeUsername,
  requireUser,
} from "../../../../lib/auth";
import { mysqlExecute } from "../../../../lib/mysql";

export async function PATCH(request: Request) {
  try {
    const user = await requireUser(request);
    const body = (await request.json()) as {
      username?: string;
      displayName?: string;
    };
    const username = normalizeUsername(body.username ?? "");
    const displayName = body.displayName?.trim().slice(0, 80) ?? "";
    if (displayName.length < 2) {
      return Response.json(
        { error: "显示名称至少需要 2 个字符" },
        { status: 400 },
      );
    }
    try {
      await mysqlExecute(
        `UPDATE xiaoluo_v2_users
         SET username = ?,
             display_name = ?,
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?`,
        [username, displayName, user.id],
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ER_DUP_ENTRY"
      ) {
        return Response.json(
          { error: "该用户名已经被使用" },
          { status: 409 },
        );
      }
      throw error;
    }
    return Response.json({
      user: { ...user, username, displayName },
      message: "个人资料已更新",
    });
  } catch (error) {
    return jsonError(error, "更新个人资料失败");
  }
}
