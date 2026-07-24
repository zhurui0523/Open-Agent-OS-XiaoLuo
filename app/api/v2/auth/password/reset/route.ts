import type { RowDataPacket } from "mysql2/promise";
import { hashPassword, jsonError, sha256 } from "../../../../../lib/auth";
import { mysqlTransaction } from "../../../../../lib/mysql";

interface ResetRow extends RowDataPacket {
  id: string;
  userId: string;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      resetToken?: string;
      newPassword?: string;
    };
    const password = body.newPassword ?? "";
    if (password.length < 10) {
      return Response.json(
        { error: "新密码至少需要 10 个字符" },
        { status: 400 },
      );
    }
    if (!body.resetToken) {
      return Response.json({ error: "重置凭证无效" }, { status: 400 });
    }
    const tokenHash = await sha256(body.resetToken);
    const passwordHash = await hashPassword(password);
    await mysqlTransaction(async (connection) => {
      const [rows] = await connection.execute<ResetRow[]>(
        `SELECT id, user_id AS userId
         FROM xiaoluo_v2_password_reset_tokens
         WHERE token_hash = ?
           AND used_at IS NULL
           AND expires_at > CURRENT_TIMESTAMP(3)
         LIMIT 1
         FOR UPDATE`,
        [tokenHash],
      );
      const reset = rows[0];
      if (!reset) {
        throw new Response(JSON.stringify({ error: "重置凭证无效或已过期" }), {
          status: 400,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      await connection.execute(
        `UPDATE xiaoluo_v2_users
         SET password_hash = ?,
             password_changed_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?`,
        [passwordHash, reset.userId],
      );
      await connection.execute(
        `UPDATE xiaoluo_v2_password_reset_tokens
         SET used_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?`,
        [reset.id],
      );
      await connection.execute(
        "DELETE FROM xiaoluo_v2_auth_sessions WHERE user_id = ?",
        [reset.userId],
      );
    });
    return Response.json({ message: "密码已重置，请重新登录" });
  } catch (error) {
    return jsonError(error, "重置密码失败");
  }
}

