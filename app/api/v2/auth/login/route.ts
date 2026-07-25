import {
  authCookieHeaders,
  createAuthSession,
  jsonError,
  userByLoginIdentifier,
  verifyPassword,
} from "../../../../lib/auth";
import { ensureUserHome } from "../../../../lib/workspace-store";
import {
  enforceRateLimit,
  privateRateLimitSubject,
  requestClientIp,
} from "../../../../lib/rate-limit";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      email?: string;
      identifier?: string;
      password?: string;
    };
    const identifier = (body.identifier ?? body.email)?.trim() ?? "";
    const [ipSubject, identifierSubject] = await Promise.all([
      privateRateLimitSubject(`ip:${requestClientIp(request)}`),
      privateRateLimitSubject(`identifier:${identifier || "missing"}`),
    ]);
    await Promise.all([
      enforceRateLimit({
        subject: ipSubject,
        route: "auth.login.ip",
        max: 60,
        windowMs: 15 * 60 * 1000,
      }),
      enforceRateLimit({
        subject: identifierSubject,
        route: "auth.login.identifier",
        max: 10,
        windowMs: 15 * 60 * 1000,
      }),
    ]);
    const user = await userByLoginIdentifier(identifier);
    if (
      !user ||
      user.status !== "active" ||
      !(await verifyPassword(body.password ?? "", user.passwordHash))
    ) {
      return Response.json(
        { error: "账号或密码不正确" },
        { status: 401 },
      );
    }
    await ensureUserHome(user.id, user.displayName);
    const session = await createAuthSession(user.id, request);
    return Response.json(
      {
        user: {
          id: user.id,
          email: user.email,
          username: user.username,
          displayName: user.displayName,
          phoneLast4: user.phoneLast4,
          platformRole: user.platformRole,
        },
      },
      { headers: authCookieHeaders(session, request) },
    );
  } catch (error) {
    return jsonError(error, "登录失败");
  }
}
