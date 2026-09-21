import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { jsonError, randomToken, sha256 } from "../../../../../lib/auth";
import { verifyPhoneChallenge } from "../../../../../lib/phone-auth";
import { mysqlTransaction } from "../../../../../lib/mysql";

interface UserIdRow extends RowDataPacket {
  id: string;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      phone?: string;
      code?: string;
    };
    const resetToken = randomToken();
    const resetTokenHash = await sha256(resetToken);
    await mysqlTransaction(async (connection) => {
      const phone = await verifyPhoneChallenge(connection, {
        phone: body.phone ?? "",
        code: body.code ?? "",
        purpose: "password_reset",
      });
      const [users] = await connection.execute<UserIdRow[]>(
        `SELECT id
         FROM xiaoluo_v2_users
         WHERE phone_hash = ? AND status = 'active'
         LIMIT 1
         FOR UPDATE`,
        [phone.phoneHash],
      );
      const user = users[0];
      if (!user) {
        throw new Response(
          JSON.stringify({ error: "验证码不正确或已失效" }),
          {
            status: 400,
            headers: { "content-type": "application/json; charset=utf-8" },
          },
        );
      }
      await connection.execute<ResultSetHeader>(
        `UPDATE xiaoluo_v2_password_reset_tokens
         SET used_at = CURRENT_TIMESTAMP(3)
         WHERE user_id = ? AND used_at IS NULL`,
        [user.id],
      );
      await connection.execute<ResultSetHeader>(
        `INSERT INTO xiaoluo_v2_password_reset_tokens
          (id, user_id, token_hash, expires_at)
         VALUES (?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          user.id,
          resetTokenHash,
          new Date(Date.now() + 10 * 60 * 1000),
        ],
      );
    });
    return Response.json({ resetToken, expiresIn: 600 });
  } catch (error) {
    return jsonError(error, "无法验证手机号");
  }
}

