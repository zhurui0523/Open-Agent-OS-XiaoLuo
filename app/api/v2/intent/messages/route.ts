import { eq, sql } from "drizzle-orm";
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
import { planIntent } from "../../../../lib/server-intent-planner";

const encoder = new TextEncoder();

function event(name: string, data: unknown) {
  return encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

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
    return Response.json({
      conversation,
      ...(await readIntentState(conversation.id)),
    });
  } catch (error) {
    return jsonError(error, "读取 Intent 消息失败");
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      canvasId?: string;
      content?: string;
    };
    const canvasId = payload.canvasId?.trim();
    const content = payload.content?.trim().slice(0, 20_000);
    if (!canvasId || !content) {
      return Response.json(
        { error: "canvasId 和 content 必填" },
        { status: 400 },
      );
    }
    const access = await requireCanvasAccess(user.id, canvasId, "edit");
    const conversation = await getOrCreateConversation({
      workspaceId: access.workspaceId,
      canvasId,
      userId: user.id,
      title: content.slice(0, 80),
    });
    const db = await getDb();
    const now = mysqlNow();
    const userMessage = {
      id: `message_${crypto.randomUUID()}`,
      conversationId: conversation.id,
      role: "user" as const,
      content,
      metadataJson: "{}",
      createdAt: now,
    };
    await db.insert(intentMessages).values(userMessage);
    await db
      .update(intentConversations)
      .set({ updatedAt: now })
      .where(eq(intentConversations.id, conversation.id));

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        void (async () => {
          try {
            controller.enqueue(
              event("message.accepted", {
                conversationId: conversation.id,
                message: userMessage,
              }),
            );
            controller.enqueue(
              event("planner.status", { status: "planning" }),
            );
            const planned = await planIntent(access.workspaceId, content);
            const assistantContent =
              "计划已经生成。你可以先检查和编辑节点，再确认写入画布。";
            const assistantMessage = {
              id: `message_${crypto.randomUUID()}`,
              conversationId: conversation.id,
              role: "assistant" as const,
              content: assistantContent,
              metadataJson: JSON.stringify({ planner: planned.planner }),
              createdAt: mysqlNow(),
            };
            await db.insert(intentMessages).values(assistantMessage);
            const [versionRow] = await db
              .select({
                nextVersion: sql<number>`COALESCE(MAX(${intentPlans.version}), 0) + 1`,
              })
              .from(intentPlans)
              .where(eq(intentPlans.conversationId, conversation.id));
            const version = Number(versionRow?.nextVersion ?? 1);
            const planRow = {
              id: `plan_${crypto.randomUUID()}`,
              conversationId: conversation.id,
              version,
              status: "awaiting_confirmation" as const,
              goal: planned.plan.goal,
              planJson: JSON.stringify(planned.plan),
              planner: planned.planner,
              createdAt: mysqlNow(),
              updatedAt: mysqlNow(),
            };
            await db.insert(intentPlans).values(planRow);
            controller.enqueue(event("message.created", assistantMessage));
            controller.enqueue(
              event("plan.ready", {
                id: planRow.id,
                version,
                planner: planned.planner,
                plan: planned.plan,
              }),
            );
            controller.enqueue(event("done", { ok: true }));
          } catch (error) {
            controller.enqueue(
              event("error", {
                error:
                  error instanceof Error ? error.message : "Planner 执行失败",
              }),
            );
          } finally {
            controller.close();
          }
        })();
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      },
    });
  } catch (error) {
    return jsonError(error, "提交 Intent 失败");
  }
}
