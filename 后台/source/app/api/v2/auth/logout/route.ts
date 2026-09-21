import {
  clearAuthCookieHeaders,
  destroySession,
  jsonError,
} from "../../../../lib/auth";

export async function POST(request: Request) {
  try {
    await destroySession(request);
    return Response.json(
      { ok: true },
      { headers: clearAuthCookieHeaders(request) },
    );
  } catch (error) {
    return jsonError(error, "退出登录失败");
  }
}
