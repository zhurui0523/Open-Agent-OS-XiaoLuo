import { jsonError, requireUser } from "../../../../lib/auth";
import { requireCanvasAccess } from "../../../../lib/authorization";
import {
  getOrCreateConversation,
  readIntentState,
} from "../../../../lib/intent-store";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const canvasId = new URL(request.url).searchParams.get("canvasId")?.trim();
    if (!canvasId) {
      return Response.json({ error: "canvasId 必填" }, { status: 400 });
    }
    const access = await requireCanvasAccess(user.id, canvasId, "view");
    const conversation = await getOrCreateConversation({
      workspaceId: access.workspaceId,
      canvasId,
      userId: user.id,
    });
    const state = await readIntentState(conversation.id);
    return Response.json({ conversation, ...state });
  } catch (error) {
    return jsonError(error, "读取 Intent 会话失败");
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      canvasId?: string;
      title?: string;
    };
    if (!payload.canvasId) {
      return Response.json({ error: "canvasId 必填" }, { status: 400 });
    }
    const access = await requireCanvasAccess(user.id, payload.canvasId, "edit");
    const conversation = await getOrCreateConversation({
      workspaceId: access.workspaceId,
      canvasId: payload.canvasId,
      userId: user.id,
      title: payload.title,
    });
    return Response.json({ conversation }, { status: 201 });
  } catch (error) {
    return jsonError(error, "创建 Intent 会话失败");
  }
}
