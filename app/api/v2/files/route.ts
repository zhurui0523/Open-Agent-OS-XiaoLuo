import {
  and,
  desc,
  eq,
  isNotNull,
  isNull,
  like,
} from "drizzle-orm";
import { getDb } from "../../../../db";
import {
  assets,
  assetVersions,
  registryEvents,
} from "../../../../db/schema";
import {
  getFileBucket,
  MAX_FILE_BYTES,
  sanitizeAssetName,
  serializeFileAsset,
  storeAsset,
} from "../../../lib/asset-kernel";
import { requireWorkspaceContext } from "../../../lib/cloud-context";
import { mysqlNow } from "../../../lib/mysql";
import { validateExternalEndpoint } from "../../../lib/model-adapters";
import type { NodeKind } from "../../../types";

function errorResponse(error: unknown, status = 400) {
  if (error instanceof Response) return error;
  return Response.json(
    { error: error instanceof Error ? error.message : "文件系统操作失败" },
    { status },
  );
}

function jsonTags(value: unknown) {
  if (typeof value === "string" && value.trim().startsWith("[")) {
    try {
      return jsonTags(JSON.parse(value));
    } catch {
      // Fall back to comma-separated input.
    }
  }
  const tags = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  return [
    ...new Set(
      tags
        .filter((tag): tag is string => typeof tag === "string")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ].slice(0, 24);
}

function generatedName(kind: NodeKind, title?: string) {
  const extension = kind === "text" ? "txt" : kind === "image" ? "png" : "mp4";
  return `${sanitizeAssetName(title ?? "AI 生成结果")}.${extension}`;
}

async function generatedBytes(payload: {
  kind?: NodeKind;
  result?: string;
  assetUrl?: string;
}) {
  if (payload.assetUrl) {
    const url = validateExternalEndpoint(payload.assetUrl);
    const response = await fetch(url, { redirect: "error" });
    if (!response.ok) throw new Error(`无法读取生成结果：HTTP ${response.status}`);
    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (declaredSize > MAX_FILE_BYTES) {
      throw new Error("生成文件超过 100 MB，未写入资产库");
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_FILE_BYTES) {
      throw new Error("生成文件超过 100 MB，未写入资产库");
    }
    return {
      bytes,
      mimeType:
        response.headers.get("content-type") ??
        (payload.kind === "image" ? "image/png" : "video/mp4"),
    };
  }
  return {
    bytes: new TextEncoder().encode(payload.result ?? "").buffer,
    mimeType: "text/plain;charset=utf-8",
  };
}

export async function GET(request: Request) {
  try {
    const { home } = await requireWorkspaceContext(request);
    const url = new URL(request.url);
    const query = url.searchParams.get("q")?.trim() ?? "";
    const kind = url.searchParams.get("kind")?.trim() ?? "";
    const folder = url.searchParams.get("folder");
    const trashed = url.searchParams.get("trash") === "1";
    const favorite = url.searchParams.get("favorite") === "1";
    const conditions = [
      eq(assets.workspaceId, home.workspaceId),
      trashed ? isNotNull(assets.trashedAt) : isNull(assets.trashedAt),
    ];
    if (query) conditions.push(like(assets.searchText, `%${query}%`));
    if (kind) conditions.push(eq(assets.kind, kind));
    if (favorite) conditions.push(eq(assets.favorite, true));
    if (folder === "root") conditions.push(isNull(assets.folderId));
    else if (folder) conditions.push(eq(assets.folderId, folder));
    const db = await getDb();
    const rows = await db
      .select()
      .from(assets)
      .where(and(...conditions))
      .orderBy(desc(assets.updatedAt))
      .limit(500);
    return Response.json({
      assets: rows.map(serializeFileAsset),
      total: rows.length,
    });
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export async function POST(request: Request) {
  try {
    const { user, home } = await requireWorkspaceContext(request);
    const contentType = request.headers.get("content-type") ?? "";
    let input: Parameters<typeof storeAsset>[2];
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new Error("请选择要上传的文件");
      if (file.size > MAX_FILE_BYTES) {
        throw new Error("单个文件暂时不能超过 100 MB");
      }
      input = {
        workspaceId: home.workspaceId,
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        bytes: await file.arrayBuffer(),
        folderId: String(form.get("folderId") ?? "").trim() || null,
        tags: jsonTags(String(form.get("tags") ?? "")),
        description: String(form.get("description") ?? "").trim(),
        sourceType: String(form.get("sourceType") ?? "upload").trim(),
        sourceRef: String(form.get("sourceRef") ?? "").trim() || null,
      };
    } else {
      const payload = (await request.json()) as {
        title?: string;
        kind?: NodeKind;
        result?: string;
        assetUrl?: string;
        sourceType?: string;
        sourceRef?: string;
        tags?: string[];
        metadata?: Record<string, unknown>;
      };
      if (!payload.result && !payload.assetUrl) {
        throw new Error("生成资产缺少内容");
      }
      const generated = await generatedBytes(payload);
      input = {
        workspaceId: home.workspaceId,
        name: generatedName(payload.kind ?? "text", payload.title),
        mimeType: generated.mimeType,
        bytes: generated.bytes,
        tags: jsonTags(payload.tags),
        sourceType: payload.sourceType ?? "kernel-output",
        sourceRef: payload.sourceRef ?? null,
        metadata: payload.metadata,
        description: payload.result?.slice(0, 500) ?? "",
      };
    }
    const db = await getDb();
    const bucket = await getFileBucket();
    const asset = await storeAsset(db, bucket, input);
    await db.insert(registryEvents).values({
      id: crypto.randomUUID(),
      workspaceId: home.workspaceId,
      actorUserId: user.id,
      eventType: "asset.created",
      entityId: asset.id,
      detailJson: JSON.stringify({
        uri: asset.uri,
        sourceType: asset.sourceType,
        dedupeHash: asset.contentHash,
      }),
    });
    return Response.json({ asset }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const { user, home } = await requireWorkspaceContext(request);
    const payload = (await request.json()) as {
      id?: string;
      name?: string;
      folderId?: string | null;
      tags?: string[];
      description?: string;
      favorite?: boolean;
      action?: "trash" | "restore";
    };
    if (!payload.id) throw new Error("文件 ID 必填");
    const db = await getDb();
    const [current] = await db
      .select()
      .from(assets)
      .where(
        and(
          eq(assets.id, payload.id),
          eq(assets.workspaceId, home.workspaceId),
        ),
      )
      .limit(1);
    if (!current) return errorResponse(new Error("文件不存在"), 404);
    const now = mysqlNow();
    await db
      .update(assets)
      .set({
        ...(payload.name !== undefined
          ? { name: sanitizeAssetName(payload.name) }
          : {}),
        ...(payload.folderId !== undefined
          ? { folderId: payload.folderId || null }
          : {}),
        ...(payload.tags !== undefined
          ? { tagsJson: JSON.stringify(jsonTags(payload.tags)) }
          : {}),
        ...(payload.description !== undefined
          ? { description: payload.description.slice(0, 2000) }
          : {}),
        ...(payload.favorite !== undefined
          ? { favorite: payload.favorite }
          : {}),
        ...(payload.action === "trash" ? { trashedAt: now } : {}),
        ...(payload.action === "restore" ? { trashedAt: null } : {}),
        searchText: [
          payload.name ?? current.name,
          payload.description ?? current.description,
          (payload.tags ?? jsonTags(current.tagsJson)).join(" "),
          current.searchText,
        ]
          .filter(Boolean)
          .join("\n")
          .slice(0, 240_000),
        updatedAt: now,
      })
      .where(
        and(
          eq(assets.id, current.id),
          eq(assets.workspaceId, home.workspaceId),
        ),
      );
    const [updated] = await db
      .select()
      .from(assets)
      .where(
        and(
          eq(assets.id, current.id),
          eq(assets.workspaceId, home.workspaceId),
        ),
      )
      .limit(1);
    if (!updated) return errorResponse(new Error("文件不存在"), 404);
    await db.insert(registryEvents).values({
      id: crypto.randomUUID(),
      workspaceId: home.workspaceId,
      actorUserId: user.id,
      eventType: `asset.${payload.action ?? "updated"}`,
      entityId: current.id,
      detailJson: "{}",
    });
    return Response.json({ asset: serializeFileAsset(updated) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const { user, home } = await requireWorkspaceContext(request);
    const id = new URL(request.url).searchParams.get("id")?.trim();
    if (!id) throw new Error("文件 ID 必填");
    const db = await getDb();
    const [ownedAsset] = await db
      .select({ id: assets.id })
      .from(assets)
      .where(
        and(eq(assets.id, id), eq(assets.workspaceId, home.workspaceId)),
      )
      .limit(1);
    if (!ownedAsset) return errorResponse(new Error("文件不存在"), 404);
    const versions = await db
      .select()
      .from(assetVersions)
      .where(eq(assetVersions.assetId, id));
    await db
      .delete(assets)
      .where(
        and(eq(assets.id, id), eq(assets.workspaceId, home.workspaceId)),
      );
    const bucket = await getFileBucket();
    for (const blobKey of [...new Set(versions.map((version) => version.blobKey))]) {
      const [remaining] = await db
        .select({ id: assetVersions.id })
        .from(assetVersions)
        .where(eq(assetVersions.blobKey, blobKey))
        .limit(1);
      if (!remaining) await bucket.delete(blobKey);
    }
    await db.insert(registryEvents).values({
      id: crypto.randomUUID(),
      workspaceId: home.workspaceId,
      actorUserId: user.id,
      eventType: "asset.deleted",
      entityId: id,
      detailJson: "{}",
    });
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
