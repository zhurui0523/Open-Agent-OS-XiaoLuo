import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import {
  intentConversations,
  intentMessages,
} from "../../../../../db/schema";
import { jsonError, requireUser } from "../../../../lib/auth";
import { requireCanvasAccess } from "../../../../lib/authorization";
import { enforceRateLimit } from "../../../../lib/rate-limit";
import { getOrCreateConversation } from "../../../../lib/intent-store";
import { mysqlNow } from "../../../../lib/mysql";
import { invokeRoutedModel } from "../../../../lib/model-runtime-router";
import {
  buildQuickAnswerPrompt,
  QUICK_ANSWER_CAPABILITY_ID,
  type QuickAnswerHistoryMessage,
} from "../../../../lib/quick-answer";

function quickAnswerHistory(
  rows: Array<{ role: string; content: string; metadataJson: string }>,
) {
  return rows
    .filter((row) => {
      if (row.role !== "user" && row.role !== "assistant") return false;
      try {
        return (
          (JSON.parse(row.metadataJson) as { mode?: string }).mode ===
          "quick_answer"
        );
      } catch {
        return false;
      }
    })
    .reverse()
    .map(
      (row) =>
        ({ role: row.role, content: row.content }) as QuickAnswerHistoryMessage,
    );
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      canvasId?: string;
      content?: string;
      preferredModelId?: string;
    };
    const canvasId = payload.canvasId?.trim();
    const content = payload.content?.trim().slice(0, 20_000);
    const preferredModelId = payload.preferredModelId?.trim();
    if (!canvasId || !content || !preferredModelId) {
      return Response.json(
        { error: "canvasId、content 和 preferredModelId 必填" },
        { status: 400 },
      );
    }

    await enforceRateLimit({
      subject: user.id,
      route: "intent:quick-answer",
      max: 30,
      windowMs: 60_000,
    });
    const access = await requireCanvasAccess(user.id, canvasId, "view");
    const conversation = await getOrCreateConversation({
      workspaceId: access.workspaceId,
      canvasId,
      userId: user.id,
      title: content.slice(0, 80),
    });
    const db = await getDb();
    const previousRows = await db
      .select({
        role: intentMessages.role,
        content: intentMessages.content,
        metadataJson: intentMessages.metadataJson,
      })
      .from(intentMessages)
      .where(eq(intentMessages.conversationId, conversation.id))
      .orderBy(desc(intentMessages.createdAt))
      .limit(24);
    const now = mysqlNow();
    const userMessage = {
      id: `message_${crypto.randomUUID()}`,
      conversationId: conversation.id,
      role: "user" as const,
      content,
      metadataJson: JSON.stringify({
        mode: "quick_answer",
        preferredModelId,
      }),
      createdAt: now,
    };
    await db.insert(intentMessages).values(userMessage);
    await db
      .update(intentConversations)
      .set({ updatedAt: now })
      .where(eq(intentConversations.id, conversation.id));

    const execution = await invokeRoutedModel(
      preferredModelId,
      {
        id: `quick_answer_${crypto.randomUUID()}`,
        title: "快速回答用户问题",
        prompt: buildQuickAnswerPrompt(
          content,
          quickAnswerHistory(previousRows),
        ),
        kind: "text",
        capabilityId: QUICK_ANSWER_CAPABILITY_ID,
        modelId: preferredModelId,
      },
      [],
      {
        workspaceId: access.workspaceId,
        userId: user.id,
      },
      request.signal,
    );
    if (execution.asyncJob) {
      return Response.json(
        { error: "快速问答模型返回了异步任务，请改用通用文本模型" },
        { status: 409 },
      );
    }
    const answer = (execution.output.text ?? execution.result).trim();
    if (!answer) {
      return Response.json({ error: "模型没有返回文本答案" }, { status: 502 });
    }
    const assistantMessage = {
      id: `message_${crypto.randomUUID()}`,
      conversationId: conversation.id,
      role: "assistant" as const,
      content: answer,
      metadataJson: JSON.stringify({
        mode: "quick_answer",
        requestedModelId: preferredModelId,
        actualModelId: execution.actualModelId,
        fallbackUsed: execution.fallbackUsed,
      }),
      createdAt: mysqlNow(),
    };
    await db.insert(intentMessages).values(assistantMessage);
    await db
      .update(intentConversations)
      .set({ updatedAt: assistantMessage.createdAt })
      .where(eq(intentConversations.id, conversation.id));

    return Response.json({
      message: assistantMessage,
      model: {
        requestedId: preferredModelId,
        actualId: execution.actualModelId,
        fallbackUsed: execution.fallbackUsed,
      },
    });
  } catch (error) {
    return jsonError(error, "快速问答失败");
  }
}
