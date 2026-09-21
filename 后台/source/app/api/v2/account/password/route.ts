import {
  currentSessionId,
  hashPassword,
  jsonError,
  requireUser,
  userById,
  verifyPassword,
} from "../../../../lib/auth";
import { mysqlTransaction } from "../../../../lib/mysql";

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const body = (await request.json()) as {
      currentPassword?: string;
      newPassword?: string;
    };
    const newPassword = body.newPassword ?? "";
    if (!body.currentPassword) {
      return Response.json({ error: "请输入当前密码" }, { status: 400 });
    }
    if (newPassword.length < 6 || newPassword.length > 128) {
      return Response.json(
        { error: "新密码需要 6–128 个字符" },
        { status: 400 },
      );
    }
    if (body.currentPassword === newPassword) {
      return Response.json(
        { error: "新密码不能与当前密码相同" },
        { status: 400 },
      );
    }
    const account = await userById(user.id);
    if (
      !account ||
      !(await verifyPassword(body.currentPassword, account.passwordHash))
    ) {
      return Response.json({ error: "当前密码不正确" }, { status: 401 });
    }
    const passwordHash = await hashPassword(newPassword);
    const sessionId = await currentSessionId(request);
    await mysqlTransaction(async (connection) => {
      await connection.execute(
        `UPDATE xiaoluo_v2_users
         SET password_hash = ?,
             password_changed_at = CURRENT_TIMESTAMP(3),
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?`,
        [passwordHash, user.id],
      );
      await connection.execute(
        `DELETE FROM xiaoluo_v2_auth_sessions
         WHERE user_id = ? AND id <> ?`,
        [user.id, sessionId ?? ""],
      );
    });
    return Response.json({
      message: "密码已修改，其他设备会话已退出",
    });
  } catch (error) {
    return jsonError(error, "修改密码失败");
  }
}
