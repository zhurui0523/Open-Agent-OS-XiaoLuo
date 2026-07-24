import type { RowDataPacket } from "mysql2/promise";
import { jsonError, requireSystemAdmin } from "../../../../lib/auth";
import { mysqlExecute, mysqlRows } from "../../../../lib/mysql";

interface UserListRow extends RowDataPacket {
  id: string;
  email: string;
  displayName: string;
  phoneLast4: string | null;
  platformRole: "system_admin" | "user";
  status: "active" | "disabled";
  createdAt: string;
}

export async function GET(request: Request) {
  try {
    await requireSystemAdmin(request);
    const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
    const users = await mysqlRows<UserListRow>(
      `SELECT
         id,
         email,
         display_name AS displayName,
         phone_last4 AS phoneLast4,
         platform_role AS platformRole,
         status,
         created_at AS createdAt
       FROM xiaoluo_v2_users
       WHERE (? = '' OR email LIKE ? OR display_name LIKE ? OR phone_last4 = ?)
       ORDER BY created_at DESC
       LIMIT 200`,
      [query, `%${query}%`, `%${query}%`, query.slice(-4)],
    );
    return Response.json({ users });
  } catch (error) {
    return jsonError(error, "读取用户列表失败");
  }
}

export async function PATCH(request: Request) {
  try {
    const admin = await requireSystemAdmin(request);
    const body = (await request.json()) as {
      userId?: string;
      status?: "active" | "disabled";
    };
    if (
      !body.userId ||
      (body.status !== "active" && body.status !== "disabled")
    ) {
      return Response.json({ error: "用户状态无效" }, { status: 400 });
    }
    if (body.userId === admin.id && body.status === "disabled") {
      return Response.json(
        { error: "系统管理员不能停用自己的账号" },
        { status: 409 },
      );
    }
    const result = await mysqlExecute(
      `UPDATE xiaoluo_v2_users
       SET status = ?
       WHERE id = ? AND platform_role = 'user'`,
      [body.status, body.userId],
    );
    if (!result.affectedRows) {
      return Response.json(
        { error: "用户不存在或不能修改系统管理员" },
        { status: 404 },
      );
    }
    if (body.status === "disabled") {
      await mysqlExecute("DELETE FROM xiaoluo_v2_auth_sessions WHERE user_id = ?", [
        body.userId,
      ]);
    }
    return Response.json({ message: "用户状态已更新" });
  } catch (error) {
    return jsonError(error, "更新用户状态失败");
  }
}

