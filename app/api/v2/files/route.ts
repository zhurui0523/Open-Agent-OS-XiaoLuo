import {
  and,
  desc,
  eq,
  isNotNull,
  isNull,
  like,
  lt,
  or,
} from "drizzle-orm";
import type { RowDataPacket } from "mysql2/promise";
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
  validateUploadedFile,
} from "../../../lib/asset-kernel";
import { requireWorkspaceContext } from "../../../lib/cloud-context";
import { mysqlNow, mysqlRows } from "../../../lib/mysql";
import { validateExternalEndpoint } from "../../../lib/model-adapters";
import type { NodeKind } from "../../../types";
import { artifactFormat } from "../../../lib/artifact-format";

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
  const extension = artifactFormat(kind).extension;
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
      mimeType: artifactFormat(
        payload.kind ?? "document",
        response.headers.get("content-type"),
      ).mimeType,
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
    const cursor = url.searchParams.get("cursor")?.trim() ?? "";
    const limit = Math.min(
      100,
      Math.max(20, Number.parseInt(url.searchParams.get("limit") ?? "60", 10) || 60),
    );
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
    if (cursor) {
      const separator = cursor.indexOf("::");
      const cursorUpdatedAt = separator > 0
        ? new Date(cursor.slice(0, separator))
        : null;
      const cursorId = separator > 0 ? cursor.slice(separator + 2) : "";
      if (cursorUpdatedAt && !Number.isNaN(cursorUpdatedAt.getTime()) && cursorId) {
        const cursorCondition = or(
          lt(assets.updatedAt, cursorUpdatedAt),
          and(eq(assets.updatedAt, cursorUpdatedAt), lt(assets.id, cursorId)),
        );
        if (cursorCondition) conditions.push(cursorCondition);
      }
    }
    const rows = await db
      .select()
      .from(assets)
      .where(and(...conditions))
      .orderBy(desc(assets.updatedAt))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return Response.json({
      assets: page.map(serializeFileAsset),
      total: page.length,
      nextCursor:
        hasMore && last?.updatedAt
          ? `${new Date(last.updatedAt).toISOString()}::${last.id}`
          : null,
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
      const bytes = await file.arrayBuffer();
      const validated = validateUploadedFile({
        name: file.name,
        declaredMimeType: file.type,
        bytes,
      });
      input = {
        workspaceId: home.workspaceId,
        name: validated.name,
        mimeType: validated.mimeType,
        bytes,
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
      .select({ id: assets.id, uri: assets.uri })
      .from(assets)
      .where(
        and(eq(assets.id, id), eq(assets.workspaceId, home.workspaceId)),
      )
      .limit(1);
    if (!ownedAsset) return errorResponse(new Error("文件不存在"), 404);
    const [referenceCount] = await mysqlRows<
      RowDataPacket & { count: number }
    >(
      `SELECT (
         (
           SELECT COUNT(*)
           FROM xiaoluo_v2_asset_relations ar
           WHERE ar.from_asset_id = ? OR ar.to_asset_id = ?
         ) +
         (
           SELECT COUNT(*)
           FROM xiaoluo_v2_canvas_nodes n
           INNER JOIN xiaoluo_v2_canvases c ON c.id = n.canvas_id
           INNER JOIN xiaoluo_v2_projects p ON p.id = c.project_id
           WHERE p.workspace_id = ?
             AND (
               CAST(n.parameters_json AS CHAR) LIKE ?
               OR n.result LIKE ?
             )
         )
       ) AS count`,
      [
        id,
        id,
        home.workspaceId,
        `%${ownedAsset.uri}%`,
        `%${ownedAsset.uri}%`,
      ],
    );
    if (Number(referenceCount?.count ?? 0) > 0) {
      return Response.json(
        {
          error: "该文件仍被画布或其他资产引用，请先移除引用",
          code: "ASSET_IN_USE",
          references: Number(referenceCount.count),
        },
        { status: 409 },
      );
    }
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
