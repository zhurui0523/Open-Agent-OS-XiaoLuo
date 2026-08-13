import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import {
  intentConversations,
  intentMessages,
  intentPlans,
} from "../../../../../db/schema";
import { jsonError, requireUser } from "../../../../lib/auth";
import { requireCanvasAccess } from "../../../../lib/authorization";
import {
  getOrCreateConversation,
  readIntentState,
} from "../../../../lib/intent-store";
import { mysqlNow } from "../../../../lib/mysql";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const url = new URL(request.url);
    const canvasId = url.searchParams.get("canvasId")?.trim();
    const list = url.searchParams.get("list") === "true";
    if (!canvasId) {
      return Response.json({ error: "canvasId 必填" }, { status: 400 });
    }
    const access = await requireCanvasAccess(user.id, canvasId, "view");

    if (list) {
      // 返回该画布的所有对话（active + archived）
      const db = await getDb();
      const conversations = await db
        .select()
        .from(intentConversations)
        .where(eq(intentConversations.canvasId, canvasId))
        .orderBy(desc(intentConversations.updatedAt));
      return Response.json({ conversations });
    }

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


export async function PATCH(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      canvasId?: string;
      conversationId?: string;
      action?: "clear" | "archive" | "restore" | "rename";
      title?: string;
    };
    const canvasId = payload.canvasId?.trim();
    const conversationId = payload.conversationId?.trim();
    const action = payload.action;
    if (!canvasId || !conversationId || !action) {
      return Response.json(
        { error: "canvasId、conversationId 和 action 必填" },
        { status: 400 },
      );
    }
    const access = await requireCanvasAccess(user.id, canvasId, "edit");
    const db = await getDb();

    if (action === "clear") {
      // 清空当前对话的所有消息和计划
      await db
        .delete(intentMessages)
        .where(eq(intentMessages.conversationId, conversationId));
      await db
        .delete(intentPlans)
        .where(eq(intentPlans.conversationId, conversationId));
      return Response.json({ ok: true });
    }

    if (action === "archive") {
      // 结束当前对话（archived），自动从首条用户消息提取标题
      const now = mysqlNow();
      const firstMessage = await db.query.intentMessages.findFirst({
        where: eq(intentMessages.conversationId, conversationId),
        orderBy: (messages, { asc }) => [asc(messages.createdAt)],
      });
      let title = "对话 " + new Date().toLocaleDateString("zh-CN");
      if (firstMessage?.content) {
        // 取前 30 字符作为标题
        title = firstMessage.content.slice(0, 30).replace(/\n/g, " ").trim();
      }
      await db
        .update(intentConversations)
        .set({ status: "archived", title, updatedAt: now })
        .where(
          and(
            eq(intentConversations.id, conversationId),
            eq(intentConversations.status, "active"),
          ),
        );
      const newConversation = await getOrCreateConversation({
        workspaceId: access.workspaceId,
        canvasId,
        userId: user.id,
      });
      return Response.json({ conversation: newConversation });
    }

    if (action === "restore") {
      // 恢复归档对话为 active
      const now = mysqlNow();
      await db
        .update(intentConversations)
        .set({ status: "active", updatedAt: now })
        .where(
          and(
            eq(intentConversations.id, conversationId),
            eq(intentConversations.status, "archived"),
          ),
        );
      const state = await readIntentState(conversationId);
      return Response.json({ conversation: { id: conversationId }, ...state });
    }

    if (action === "rename") {
      const newTitle = (payload as { title?: string }).title?.trim();
      if (!newTitle) {
        return Response.json({ error: "title 必填" }, { status: 400 });
      }
      const now = mysqlNow();
      await db
        .update(intentConversations)
        .set({ title: newTitle, updatedAt: now })
        .where(eq(intentConversations.id, conversationId));
      return Response.json({ ok: true });
    }

    return Response.json({ error: "未知 action" }, { status: 400 });
  } catch (error) {
    return jsonError(error, "操作 Intent 会话失败");
  }
}
