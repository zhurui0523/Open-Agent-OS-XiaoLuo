import {
  currentSessionId,
  jsonError,
  requireUser,
  userById,
  verifyPassword,
} from "../../../../lib/auth";
import { mysqlTransaction } from "../../../../lib/mysql";
import { verifyPhoneChallenge } from "../../../../lib/phone-auth";

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const body = (await request.json()) as {
      phone?: string;
      code?: string;
      currentPassword?: string;
    };
    if (!body.phone || !body.code || !body.currentPassword) {
      return Response.json(
        { error: "请输入新手机号、验证码和当前密码" },
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
    const sessionId = await currentSessionId(request);
    let phoneLast4 = "";
    try {
      await mysqlTransaction(async (connection) => {
        const phone = await verifyPhoneChallenge(connection, {
          phone: body.phone ?? "",
          code: body.code ?? "",
          purpose: "phone_change",
        });
        phoneLast4 = phone.phoneLast4;
        await connection.execute(
          `UPDATE xiaoluo_v2_users
           SET phone_hash = ?,
               phone_last4 = ?,
               phone_verified_at = CURRENT_TIMESTAMP(3),
               updated_at = CURRENT_TIMESTAMP(3)
           WHERE id = ?`,
          [phone.phoneHash, phone.phoneLast4, user.id],
        );
        await connection.execute(
          `DELETE FROM xiaoluo_v2_auth_sessions
           WHERE user_id = ? AND id <> ?`,
          [user.id, sessionId ?? ""],
        );
      });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ER_DUP_ENTRY"
      ) {
        return Response.json(
          { error: "该手机号已绑定其他账号" },
          { status: 409 },
        );
      }
      throw error;
    }
    return Response.json({
      user: { ...user, phoneLast4 },
      message: "手机号已更新，其他设备会话已退出",
    });
  } catch (error) {
    return jsonError(error, "更换手机号失败");
  }
}
