import {
  authCookieHeaders,
  currentUser,
  jsonError,
  refreshAuthSession,
  upgradeLegacySession,
} from "../../../../lib/auth";

export async function GET(request: Request) {
  try {
    const user = await currentUser(request);
    if (user) {
      return Response.json({ user });
    }
    const renewed =
      (await refreshAuthSession(request)) ??
      (await upgradeLegacySession(request));
    if (!renewed) {
      return Response.json({ user: null }, { status: 401 });
    }
    return Response.json(
      { user: renewed.user },
      { headers: authCookieHeaders(renewed.pair, request) },
    );
  } catch (error) {
    return jsonError(error, "读取会话失败");
  }
}
