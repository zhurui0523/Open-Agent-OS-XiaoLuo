import {
  authCookieHeaders,
  createAuthSession,
  hashPassword,
  jsonError,
  normalizeUsername,
  userByEmail,
  userByUsername,
} from "../../../../lib/auth";
import { normalizePhone, phoneLookupHash } from "../../../../lib/phone-auth";
import { mysqlExecute } from "../../../../lib/mysql";
import { ensureUserHome } from "../../../../lib/workspace-store";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      email?: string;
      password?: string;
      username?: string;
      displayName?: string;
      phone?: string;
    };
    const email = body.email?.trim().toLowerCase() ?? "";
    const username = normalizeUsername(body.username ?? "");
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
    if (password.length < 6) {
      return Response.json(
        { error: "密码至少需要 6 个字符" },
        { status: 400 },
      );
    }
    let phone: string;
    try {
      phone = normalizePhone(body.phone ?? "");
    } catch {
      return Response.json({ error: "请输入有效手机号" }, { status: 400 });
    }
    if (await userByEmail(email)) {
      return Response.json({ error: "该邮箱已经注册" }, { status: 409 });
    }
    if (await userByUsername(username)) {
      return Response.json({ error: "该用户名已经被使用" }, { status: 409 });
    }

    const userId = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    const phoneHash = await phoneLookupHash(phone);
    const phoneLast4 = phone.slice(-4);
    try {
      await mysqlExecute(
        `INSERT INTO xiaoluo_v2_users
          (id, email, username, display_name, password_hash, phone_hash, phone_last4)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [userId, email, username, displayName, passwordHash, phoneHash, phoneLast4],
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ER_DUP_ENTRY"
      ) {
        return Response.json(
          { error: "该用户名、邮箱或手机号已经注册" },
          { status: 409 },
        );
      }
      throw error;
    }

    await ensureUserHome(userId, displayName);
    const session = await createAuthSession(userId, request);
    return Response.json(
      {
        user: {
          id: userId,
          email,
          username,
          displayName,
          phoneLast4,
          platformRole: "user",
        },
      },
      {
        status: 201,
        headers: authCookieHeaders(session, request),
      },
    );
  } catch (error) {
    return jsonError(error, "创建账号失败");
  }
}
