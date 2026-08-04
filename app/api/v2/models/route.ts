import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import { modelConnections, registryEvents } from "../../../../db/schema";
import type {
  ModelConnectionDraft,
  ModelProtocol,
  NodeKind,
} from "../../../types";
import { validateExternalEndpoint } from "../../../lib/model-adapters";
import { normalizeModelInputConstraints } from "../../../lib/model-input-constraints";
import { serializeModel } from "../../../lib/registry-serialization";
import { mysqlNow } from "../../../lib/mysql";
import { requireUser } from "../../../lib/auth";
import type { AuthUser } from "../../../lib/auth";
import { requireRequestedWorkspace } from "../../../lib/workspace-context";
import {
  assertOwnedSecretReference,
  deleteModelSecretIfUnreferenced,
  saveSecret,
} from "../../../lib/secret-vault";
import {
  canManageRegistryResource,
  MODEL_ACCESS_SCOPE_KEY,
  modelAccessScope,
  normalizeRegistryAccessScope,
} from "../../../lib/registry-access";

const protocols = new Set<ModelProtocol>([
  "openai-compatible",
  "openai-responses",
  "anthropic-compatible",
  "gemini",
  "dall-e-3",
  "runninghub-sparkvideo-mini",
  "runninghub-sparkvideo-mini-multimodal",
  "runninghub-sparkvideo",
  "runninghub-sparkvideo-multimodal",
  "runninghub-minimax-h3",
  "ark",
  "async-video",
  "generic-rest",
]);
const modalities = new Set<NodeKind>(["text", "image", "video"]);

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(parsed)));
}

function validateDraft(value: unknown): ModelConnectionDraft {
  if (!value || typeof value !== "object") throw new Error("连接配置必须是对象");
  const draft = value as Partial<ModelConnectionDraft>;
  const name = draft.name?.trim() ?? "";
  const baseUrl = draft.baseUrl?.trim() ?? "";
  const modelName = draft.modelName?.trim() ?? "";
  if (!name || !baseUrl || !modelName) throw new Error("名称、端点和模型 ID 必填");
  if (!draft.protocol || !protocols.has(draft.protocol)) {
    throw new Error("不支持的模型协议");
  }
  const selected = Array.isArray(draft.modalities)
    ? draft.modalities.filter((item): item is NodeKind => modalities.has(item))
    : [];
  if (!selected.length) throw new Error("至少选择一种模态");
  validateExternalEndpoint(baseUrl);
  const credentialRef = draft.credentialRef?.trim();
  if (credentialRef && !/^[A-Z][A-Z0-9_]{2,63}$/.test(credentialRef)) {
    throw new Error("凭据引用必须是大写环境变量名，例如 OPENAI_API_KEY");
  }
  const parameterSchema =
    draft.parameterSchema &&
    typeof draft.parameterSchema === "object" &&
    !Array.isArray(draft.parameterSchema)
      ? draft.parameterSchema
      : {};
  const uiSchema =
    draft.uiSchema &&
    typeof draft.uiSchema === "object" &&
    !Array.isArray(draft.uiSchema)
      ? draft.uiSchema
      : {};
  const accessScope =
    normalizeRegistryAccessScope(draft.accessScope) === "workspace"
      ? "workspace"
      : "personal";
  const capabilityTags = Array.isArray(draft.capabilityTags)
    ? [
        ...new Set(
          draft.capabilityTags
            .map((item) => String(item).trim().toLowerCase())
            .filter(Boolean),
        ),
      ].slice(0, 32)
    : [];
  return {
    name,
    protocol: draft.protocol,
    baseUrl,
    modelName,
    modalities: [...new Set(selected)],
    priority: boundedInteger(draft.priority, 100, 1, 1000),
    fallbackModelId: draft.fallbackModelId?.trim() || null,
    maxConcurrency: boundedInteger(draft.maxConcurrency, 2, 1, 20),
    retryLimit: boundedInteger(draft.retryLimit, 3, 1, 5),
    circuitFailureThreshold: boundedInteger(
      draft.circuitFailureThreshold,
      5,
      2,
      20,
    ),
    circuitCooldownSeconds: boundedInteger(
      draft.circuitCooldownSeconds,
      60,
      10,
      600,
    ),
    parameterSchema,
    uiSchema: {
      ...uiSchema,
      [MODEL_ACCESS_SCOPE_KEY]: accessScope,
    },
    inputConstraints: normalizeModelInputConstraints(
      draft.inputConstraints,
      selected[0],
      draft.protocol,
    ),
    capabilityTags,
    accessScope,
    ...(credentialRef ? { credentialRef } : {}),
  };
}

async function validateFallback(
  workspaceId: string,
  fallbackModelId: string | null | undefined,
  currentModelId?: string,
) {
  if (!fallbackModelId) return;
  if (fallbackModelId === currentModelId) {
    throw new Error("备用模型不能选择当前连接");
  }
  const db = await getDb();
  const [fallback] = await db
    .select({ id: modelConnections.id })
    .from(modelConnections)
    .where(
      and(
        eq(modelConnections.id, fallbackModelId),
        eq(modelConnections.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!fallback) throw new Error("备用模型不存在或当前账号无权访问");
}

function errorResponse(error: unknown, status = 400) {
  if (error instanceof Response) return error;
  return Response.json(
    { error: error instanceof Error ? error.message : "Model operation failed" },
    { status },
  );
}

function parsedUiSchema(uiSchemaJson: string) {
  try {
    return JSON.parse(uiSchemaJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function requireModelManagement(
  model: { createdBy: string; uiSchemaJson: string },
  user: AuthUser,
) {
  if (
    !canManageRegistryResource({
      scope: modelAccessScope(parsedUiSchema(model.uiSchemaJson)),
      createdBy: model.createdBy,
      userId: user.id,
      platformRole: user.platformRole,
      canManageWorkspace: true,
    })
  ) {
    throw new Response(
      JSON.stringify({ error: "无权管理其他用户的个人模型连接" }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as ModelConnectionDraft & {
      workspaceId?: string;
    };
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "manage",
      payload,
    );
    const draft = validateDraft(payload);
    await validateFallback(workspaceId, draft.fallbackModelId);
    const secretValue = payload.secretValue?.trim();
    const storedSecret = secretValue
      ? await saveSecret({
          workspaceId,
          userId: user.id,
          name: payload.secretName || `${draft.name} API Key`,
          value: secretValue,
          purpose: "model_api_key",
        })
      : null;
    const requestedSecretRefId = payload.secretRefId?.trim() || null;
    if (!storedSecret && requestedSecretRefId) {
      await assertOwnedSecretReference({
        secretRefId: requestedSecretRefId,
        workspaceId,
        userId: user.id,
        purpose: "model_api_key",
      });
    }
    if (!storedSecret && !requestedSecretRefId && !draft.credentialRef) {
      throw new Error("请填写 API Key 后再保存模型连接");
    }
    const db = await getDb();
    const now = mysqlNow();
    const id = `model_${crypto.randomUUID()}`;
    await db
      .insert(modelConnections)
      .values({
        id,
        workspaceId,
        createdBy: user.id,
        name: draft.name,
        protocol: draft.protocol,
        baseUrl: draft.baseUrl,
        modelName: draft.modelName,
        modalitiesJson: JSON.stringify(draft.modalities),
        parameterSchemaJson: JSON.stringify(draft.parameterSchema ?? {}),
        uiSchemaJson: JSON.stringify(draft.uiSchema ?? {}),
        inputConstraintsJson: JSON.stringify(draft.inputConstraints ?? {}),
        capabilityTagsJson: JSON.stringify(draft.capabilityTags ?? []),
        credentialRef: draft.credentialRef ?? null,
        secretRefId: storedSecret?.id ?? requestedSecretRefId,
        priority: draft.priority,
        fallbackModelId: draft.fallbackModelId ?? null,
        maxConcurrency: draft.maxConcurrency,
        retryLimit: draft.retryLimit,
        circuitFailureThreshold: draft.circuitFailureThreshold,
        circuitCooldownSeconds: draft.circuitCooldownSeconds,
        state: "attention",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });
    const [saved] = await db
      .select()
      .from(modelConnections)
      .where(eq(modelConnections.id, id))
      .limit(1);
    if (!saved) throw new Error("模型连接创建后无法读取");
    await db.insert(registryEvents).values({
      id: crypto.randomUUID(),
      workspaceId,
      actorUserId: user.id,
      eventType: "model.created",
      entityId: id,
      detailJson: JSON.stringify({
        protocol: draft.protocol,
        priority: draft.priority,
        maxConcurrency: draft.maxConcurrency,
        retryLimit: draft.retryLimit,
        fallbackModelId: draft.fallbackModelId ?? null,
      }),
    });
    return Response.json({ model: serializeModel(saved) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as Partial<ModelConnectionDraft> & {
      id?: string;
      enabled?: boolean;
      workspaceId?: string;
    };
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "manage",
      payload,
    );
    if (!payload.id) return errorResponse(new Error("id 必填"));
    const db = await getDb();
    const [existing] = await db
      .select()
      .from(modelConnections)
      .where(
        and(
          eq(modelConnections.id, payload.id),
          eq(modelConnections.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!existing) return errorResponse(new Error("模型连接不存在"), 404);

    requireModelManagement(existing, user);

    let update: Partial<typeof modelConnections.$inferInsert>;
    if (typeof payload.enabled === "boolean" && !payload.name) {
      update = {
        enabled: payload.enabled,
        updatedAt: mysqlNow(),
      };
    } else {
      const draft = validateDraft(payload);
      await validateFallback(workspaceId, draft.fallbackModelId, existing.id);
      const secretValue = payload.secretValue?.trim();
      const storedSecret = secretValue
        ? await saveSecret({
            workspaceId,
            userId: user.id,
            name: payload.secretName || `${draft.name} API Key`,
            value: secretValue,
            purpose: "model_api_key",
          })
        : null;
      const requestedSecretRefId = payload.secretRefId?.trim() || null;
      if (
        !storedSecret &&
        requestedSecretRefId &&
        requestedSecretRefId !== existing.secretRefId
      ) {
        await assertOwnedSecretReference({
          secretRefId: requestedSecretRefId,
          workspaceId,
          userId: user.id,
          purpose: "model_api_key",
        });
      }
      const nextSecretRefId =
        storedSecret?.id ?? requestedSecretRefId ?? existing.secretRefId;
      if (!nextSecretRefId && !draft.credentialRef) {
        throw new Error("请填写 API Key 后再保存模型连接");
      }
      update = {
        name: draft.name,
        protocol: draft.protocol,
        baseUrl: draft.baseUrl,
        modelName: draft.modelName,
        modalitiesJson: JSON.stringify(draft.modalities),
        parameterSchemaJson: JSON.stringify(draft.parameterSchema ?? {}),
        uiSchemaJson: JSON.stringify(draft.uiSchema ?? {}),
        inputConstraintsJson: JSON.stringify(draft.inputConstraints ?? {}),
        capabilityTagsJson: JSON.stringify(draft.capabilityTags ?? []),
        credentialRef: draft.credentialRef ?? null,
        secretRefId: nextSecretRefId,
        priority: draft.priority,
        fallbackModelId: draft.fallbackModelId ?? null,
        maxConcurrency: draft.maxConcurrency,
        retryLimit: draft.retryLimit,
        circuitFailureThreshold: draft.circuitFailureThreshold,
        circuitCooldownSeconds: draft.circuitCooldownSeconds,
        state: "attention",
        latencyMs: null,
        lastCheckedAt: null,
        updatedAt: mysqlNow(),
      };
    }
    await db
      .update(modelConnections)
      .set(update)
      .where(
        and(
          eq(modelConnections.id, payload.id),
          eq(modelConnections.workspaceId, workspaceId),
        ),
      );
    const [updated] = await db
      .select()
      .from(modelConnections)
      .where(
        and(
          eq(modelConnections.id, payload.id),
          eq(modelConnections.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!updated) return errorResponse(new Error("模型连接不存在"), 404);
    if (
      existing.secretRefId &&
      updated.secretRefId !== existing.secretRefId
    ) {
      await deleteModelSecretIfUnreferenced({
        secretRefId: existing.secretRefId,
        workspaceId,
      });
    }
    await db.insert(registryEvents).values({
      id: crypto.randomUUID(),
      workspaceId,
      actorUserId: user.id,
      eventType:
        typeof payload.enabled === "boolean" && !payload.name
          ? payload.enabled
            ? "model.enabled"
            : "model.disabled"
          : "model.updated",
      entityId: updated.id,
      detailJson: JSON.stringify({
        protocol: updated.protocol,
        priority: updated.priority,
        maxConcurrency: updated.maxConcurrency,
        retryLimit: updated.retryLimit,
        fallbackModelId: updated.fallbackModelId,
      }),
    });
    return Response.json({ model: serializeModel(updated) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireUser(request);
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "manage",
    );
    const id = new URL(request.url).searchParams.get("id")?.trim();
    if (!id) return errorResponse(new Error("id 必填"));
    const db = await getDb();
    const [existing] = await db
      .select({
        id: modelConnections.id,
        createdBy: modelConnections.createdBy,
        uiSchemaJson: modelConnections.uiSchemaJson,
        secretRefId: modelConnections.secretRefId,
      })
      .from(modelConnections)
      .where(
        and(
          eq(modelConnections.id, id),
          eq(modelConnections.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!existing) return errorResponse(new Error("模型连接不存在"), 404);
    requireModelManagement(existing, user);
    await db
      .update(modelConnections)
      .set({ fallbackModelId: null, updatedAt: mysqlNow() })
      .where(
        and(
          eq(modelConnections.workspaceId, workspaceId),
          eq(modelConnections.fallbackModelId, id),
        ),
      );
    await db
      .delete(modelConnections)
      .where(
        and(
          eq(modelConnections.id, id),
          eq(modelConnections.workspaceId, workspaceId),
        ),
      );
    if (existing.secretRefId) {
      await deleteModelSecretIfUnreferenced({
        secretRefId: existing.secretRefId,
        workspaceId,
      });
    }
    await db.insert(registryEvents).values({
      id: crypto.randomUUID(),
      workspaceId,
      actorUserId: user.id,
      eventType: "model.deleted",
      entityId: id,
      detailJson: "{}",
    });
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error, 500);
  }
}
