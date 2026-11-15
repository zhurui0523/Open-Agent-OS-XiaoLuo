/**
 * 会话状态查询接口（P1-3）：只回派生状态（消息数 / token 用量 / 工具调用数），不带消息正文。
 * 用途：排查"这个会话为什么这么贵/为什么断了"，以及后续做用量面板。
 */
import { jsonError, requireUser } from "../../../../lib/auth";
import { listThreadState } from "../../../../lib/brain-state-store";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const limitRaw = Number(new URL(request.url).searchParams.get("limit") ?? 20);
    const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : 20));
    const rows = await listThreadState(user.id, limit);
    return Response.json({ threads: rows });
  } catch (error) {
    return jsonError(error, "读取会话状态失败");
  }
}
