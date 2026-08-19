import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../../../../../db";
import {
  intentConversations,
  intentMessages,
  intentPlans,
  assets,
  modelConnections,
  packageCapabilities,
  packages,
} from "../../../../../db/schema";
import { coreCapabilities } from "../../../../data";
import { jsonError, requireUser } from "../../../../lib/auth";
import { requireCanvasAccess } from "../../../../lib/authorization";
import {
  getOrCreateConversation,
  readIntentState,
} from "../../../../lib/intent-store";
import { mysqlNow } from "../../../../lib/mysql";
import { packageAvailableToUser } from "../../../../lib/package-availability";
import { planIntent } from "../../../../lib/server-intent-planner";
import {
  detectIntentGaps,
  formatGapQuestion,
} from "../../../../lib/intent-analysis";
import type { IntentGap } from "../../../../types";

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

export async function PATCH(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      canvasId?: string;
      content?: string;
      metadata?: Record<string, unknown>;
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
    });
    const db = await getDb();
    const now = mysqlNow();
    const message = {
      id: `message_${crypto.randomUUID()}`,
      conversationId: conversation.id,
      role: "assistant" as const,
      content,
      metadataJson: JSON.stringify(payload.metadata ?? {}).slice(0, 8_000),
      createdAt: now,
    };
    await db.insert(intentMessages).values(message);
    await db
      .update(intentConversations)
      .set({ updatedAt: now })
      .where(eq(intentConversations.id, conversation.id));
    return Response.json({ conversation, message });
  } catch (error) {
    return jsonError(error, "保存 Intent 消息失败");
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      canvasId?: string;
      content?: string;
      attachments?: Array<{
        id?: string;
        uri?: string;
        name?: string;
        kind?: string;
        mimeType?: string;
      }>;
      preferredCapabilityId?: string;
      preferredModelId?: string;
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
    const requestedAttachments = (payload.attachments ?? [])
      .slice(0, 8)
      .filter((attachment) => Boolean(attachment.id));
    const attachmentIds = requestedAttachments.map((attachment) =>
      String(attachment.id),
    );
    const validAttachments = attachmentIds.length
      ? await (await getDb())
          .select({
            id: assets.id,
            uri: assets.uri,
            name: assets.name,
            kind: assets.kind,
            mimeType: assets.mimeType,
          })
          .from(assets)
          .where(
            and(
              eq(assets.workspaceId, access.workspaceId),
              inArray(assets.id, attachmentIds),
              isNull(assets.trashedAt),
            ),
          )
      : [];
    if (validAttachments.length !== attachmentIds.length) {
      return Response.json(
        { error: "附件不存在、已删除或当前账号无权访问" },
        { status: 400 },
      );
    }
    const preferredCapabilityId = payload.preferredCapabilityId?.trim();
    let preferredCapabilityTitle = "";
    if (preferredCapabilityId) {
      preferredCapabilityTitle =
        coreCapabilities.find(
          (capability) =>
            capability.id === preferredCapabilityId && capability.enabled,
        )?.title ?? "";
      if (!preferredCapabilityTitle) {
        const [packageCapability] = await (await getDb())
          .select({ title: packageCapabilities.title })
          .from(packageCapabilities)
          .innerJoin(packages, eq(packages.id, packageCapabilities.packageId))
          .where(
            and(
              eq(packageCapabilities.id, preferredCapabilityId),
              eq(packageCapabilities.enabled, true),
              packageAvailableToUser(access.workspaceId, user.id),
              eq(packages.enabled, true),
            ),
          )
          .limit(1);
        preferredCapabilityTitle = packageCapability?.title ?? "";
      }
      if (!preferredCapabilityTitle) {
        return Response.json(
          { error: "首选能力不存在、已禁用或当前账号无权访问" },
          { status: 400 },
        );
      }
    }
    const preferredModelId = payload.preferredModelId?.trim();
    let preferredModelName = "";
    if (preferredModelId) {
      const [preferredModel] = await (await getDb())
        .select({ name: modelConnections.name })
        .from(modelConnections)
        .where(
          and(
            eq(modelConnections.id, preferredModelId),
            eq(modelConnections.workspaceId, access.workspaceId),
            eq(modelConnections.enabled, true),
          ),
        )
        .limit(1);
      preferredModelName = preferredModel?.name ?? "";
      if (!preferredModelName) {
        return Response.json(
          { error: "首选模型不存在、已禁用或当前账号无权访问" },
          { status: 400 },
        );
      }
    }
    const conversation = await getOrCreateConversation({
      workspaceId: access.workspaceId,
      canvasId,
      userId: user.id,
      title: content.slice(0, 80),
    });
    const db = await getDb();
    const [previousMessage] = await db
      .select({
        role: intentMessages.role,
        metadataJson: intentMessages.metadataJson,
      })
      .from(intentMessages)
      .where(eq(intentMessages.conversationId, conversation.id))
      .orderBy(desc(intentMessages.createdAt))
      .limit(1);
    let originalIntent = content;
    if (previousMessage?.role === "assistant") {
      try {
        const metadata = JSON.parse(previousMessage.metadataJson) as {
          pendingGaps?: IntentGap[];
          originalIntent?: string;
        };
        if (metadata.pendingGaps?.length && metadata.originalIntent) {
          originalIntent = `${metadata.originalIntent}\n\n用户补充：${content}`;
        }
      } catch {
        // Historical messages may contain metadata from older versions.
      }
    }
    const now = mysqlNow();
    const userMessage = {
      id: `message_${crypto.randomUUID()}`,
      conversationId: conversation.id,
      role: "user" as const,
      content,
      metadataJson: JSON.stringify({
        attachments: validAttachments,
        ...(preferredCapabilityId
          ? { preferredCapabilityId, preferredCapabilityTitle }
          : {}),
        ...(preferredModelId ? { preferredModelId, preferredModelName } : {}),
      }),
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
            const gaps = detectIntentGaps(originalIntent);
            if (gaps.some((gap) => gap.required)) {
              const assistantMessage = {
                id: `message_${crypto.randomUUID()}`,
                conversationId: conversation.id,
                role: "assistant" as const,
                content: formatGapQuestion(gaps),
                metadataJson: JSON.stringify({
                  pendingGaps: gaps,
                  originalIntent,
                  planner: "kernel.information-gap-detector",
                }),
                createdAt: mysqlNow(),
              };
              await db.insert(intentMessages).values(assistantMessage);
              controller.enqueue(event("message.created", assistantMessage));
              controller.enqueue(
                event("planner.questions", { gaps, status: "awaiting_input" }),
              );
              controller.enqueue(event("done", { ok: true, needsInput: true }));
              return;
            }
            const planningInput = validAttachments.length
              ? `${originalIntent}\n\n参考附件：${validAttachments
                  .map((attachment) => `${attachment.name} (${attachment.uri})`)
                  .join("；")}`
              : originalIntent;
            const preferenceInstructions = [
              preferredCapabilityTitle
                ? `用户明确指定首选能力：${preferredCapabilityTitle}。计划中优先使用该能力；只有模态确实不适配时才选择其他能力。`
                : "",
              preferredModelName
                ? `用户明确指定首选模型：${preferredModelName}。计划节点中优先使用该模型；只有模态确实不适配时才自动选择其他模型。`
                : "",
            ].filter(Boolean);
            const planned = await planIntent(
              access.workspaceId,
              preferenceInstructions.length
                ? `${planningInput}\n\n${preferenceInstructions.join("\n")}`
                : planningInput,
            );
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
