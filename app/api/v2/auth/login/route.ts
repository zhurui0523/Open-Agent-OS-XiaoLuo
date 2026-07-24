import {
  createSession,
  jsonError,
  sessionCookie,
  userByEmail,
  verifyPassword,
} from "../../../../lib/auth";
import { ensureUserHome } from "../../../../lib/workspace-store";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      email?: string;
      password?: string;
    };
    const email = body.email?.trim().toLowerCase() ?? "";
    const user = await userByEmail(email);
    if (
      !user ||
      user.status !== "active" ||
      !(await verifyPassword(body.password ?? "", user.passwordHash))
    ) {
      return Response.json(
        { error: "邮箱或密码不正确" },
        { status: 401 },
      );
    }
    await ensureUserHome(user.id, user.displayName);
    const session = await createSession(user.id);
    return Response.json(
      {
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          phoneLast4: user.phoneLast4,
          platformRole: user.platformRole,
        },
      },
      {
        headers: {
          "set-cookie": sessionCookie(session.token, session.expires, request),
        },
      },
    );
  } catch (error) {
    return jsonError(error, "登录失败");
  }
}
