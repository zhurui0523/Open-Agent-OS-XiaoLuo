import type { ResultSetHeader } from "mysql2/promise";
import {
  createSession,
  hashPassword,
  jsonError,
  sessionCookie,
  userByEmail,
} from "../../../../lib/auth";
import { verifyPhoneChallenge } from "../../../../lib/phone-auth";
import { mysqlTransaction } from "../../../../lib/mysql";
import { ensureUserHome } from "../../../../lib/workspace-store";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      email?: string;
      password?: string;
      displayName?: string;
      phone?: string;
      code?: string;
    };
    const email = body.email?.trim().toLowerCase() ?? "";
    const displayName = body.displayName?.trim().slice(0, 80) ?? "";
    const password = body.password ?? "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return Response.json({ error: "请输入有效邮箱" }, { status: 400 });
    }
    if (displayName.length < 2) {
      return Response.json(
        { error: "显示名称至少需要 2 个字符" },
        { status: 400 },
      );
    }
    if (password.length < 10) {
      return Response.json(
        { error: "密码至少需要 10 个字符" },
        { status: 400 },
      );
    }
    if (!body.phone || !body.code) {
      return Response.json(
        { error: "请输入手机号和短信验证码" },
        { status: 400 },
      );
    }
    if (await userByEmail(email)) {
      return Response.json({ error: "该邮箱已经注册" }, { status: 409 });
    }

    const userId = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    let phoneLast4 = "";
    try {
      await mysqlTransaction(async (connection) => {
        const phone = await verifyPhoneChallenge(connection, {
          phone: body.phone ?? "",
          code: body.code ?? "",
          purpose: "register",
        });
        phoneLast4 = phone.phoneLast4;
        await connection.execute<ResultSetHeader>(
          `INSERT INTO xiaoluo_v2_users
            (
              id, email, display_name, password_hash,
              phone_hash, phone_last4, phone_verified_at
            )
           VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3))`,
          [
            userId,
            email,
            displayName,
            passwordHash,
            phone.phoneHash,
            phone.phoneLast4,
          ],
        );
      });
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ER_DUP_ENTRY"
      ) {
        return Response.json(
          { error: "该邮箱或手机号已经注册" },
          { status: 409 },
        );
      }
      throw error;
    }

    await ensureUserHome(userId, displayName);
    const session = await createSession(userId);
    return Response.json(
      {
        user: {
          id: userId,
          email,
          displayName,
          phoneLast4,
          platformRole: "user",
        },
      },
      {
        status: 201,
        headers: {
          "set-cookie": sessionCookie(session.token, session.expires, request),
        },
      },
    );
  } catch (error) {
    return jsonError(error, "创建账号失败");
  }
}

