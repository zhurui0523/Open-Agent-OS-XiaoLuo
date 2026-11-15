/**
 * 单会话的文件变更账（P1-3 收尾）：谁改了什么文件、是写/移动/删除。
 * 只回路径与操作，不回文件内容。
 */
import { jsonError, requireUser } from "../../../../lib/auth";
import { listFileChanges } from "../../../../lib/brain-state-store";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const params = new URL(request.url).searchParams;
    const conversationId = params.get("conversationId")?.trim();
    if (!conversationId) {
      return Response.json({ error: "conversationId 必填" }, { status: 400 });
    }
    const limitRaw = Number(params.get("limit") ?? 50);
    const limit = Math.min(200, Math.max(1, Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : 50));
    const changes = await listFileChanges(user.id, conversationId, limit);
    return Response.json({ conversationId, changes });
  } catch (error) {
    return jsonError(error, "读取文件变更账失败");
  }
}
