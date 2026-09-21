import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../db";
import {
  intentConversations,
  intentMessages,
  intentPlans,
} from "../../db/schema";
import { mysqlNow } from "./mysql";

export async function getOrCreateConversation(input: {
  workspaceId: string;
  canvasId: string;
  userId: string;
  title?: string;
}) {
  const db = await getDb();
  const [existing] = await db
    .select()
    .from(intentConversations)
    .where(
      and(
        eq(intentConversations.canvasId, input.canvasId),
        eq(intentConversations.createdBy, input.userId),
        eq(intentConversations.status, "active"),
      ),
    )
    .orderBy(desc(intentConversations.updatedAt))
    .limit(1);
  if (existing) return existing;

  const now = mysqlNow();
  const id = `conversation_${crypto.randomUUID()}`;
  await db.insert(intentConversations).values({
    id,
    workspaceId: input.workspaceId,
    canvasId: input.canvasId,
    createdBy: input.userId,
    title: input.title?.trim().slice(0, 180) || "新的意图",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const [created] = await db
    .select()
    .from(intentConversations)
    .where(eq(intentConversations.id, id))
    .limit(1);
  if (!created) throw new Error("无法创建 Intent 会话");
  return created;
}

export async function readIntentState(conversationId: string) {
  const db = await getDb();
  const [messages, plans] = await Promise.all([
    db
      .select()
      .from(intentMessages)
      .where(eq(intentMessages.conversationId, conversationId))
      .orderBy(intentMessages.createdAt),
    db
      .select()
      .from(intentPlans)
      .where(eq(intentPlans.conversationId, conversationId))
      .orderBy(desc(intentPlans.version))
      .limit(1),
  ]);
  return {
    messages,
    plan: plans[0] ?? null,
  };
}
