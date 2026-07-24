import { currentUser, jsonError } from "../../../../lib/auth";

export async function GET(request: Request) {
  try {
    const user = await currentUser(request);
    if (!user) {
      return Response.json({ user: null }, { status: 401 });
    }
    return Response.json({ user });
  } catch (error) {
    return jsonError(error, "读取会话失败");
  }
}
