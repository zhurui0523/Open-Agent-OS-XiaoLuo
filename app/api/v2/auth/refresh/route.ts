import {
  authCookieHeaders,
  jsonError,
  refreshAuthSession,
} from "../../../../lib/auth";

export async function POST(request: Request) {
  try {
    const renewed = await refreshAuthSession(request);
    if (!renewed) {
      return Response.json(
        { error: "刷新凭证无效或已过期" },
        { status: 401 },
      );
    }
    return Response.json(
      { user: renewed.user },
      { headers: authCookieHeaders(renewed.pair, request) },
    );
  } catch (error) {
    return jsonError(error, "刷新登录状态失败");
  }
}
