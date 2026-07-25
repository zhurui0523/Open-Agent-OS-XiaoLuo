import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import {
  assets,
  assetVersions,
  registryEvents,
} from "../../../../../db/schema";
import {
  getFileBucket,
  MAX_FILE_BYTES,
  storeAssetVersion,
  validateUploadedFile,
} from "../../../../lib/asset-kernel";
import { requireWorkspaceContext } from "../../../../lib/cloud-context";

function errorResponse(error: unknown, status = 400) {
  if (error instanceof Response) return error;
  return Response.json(
    { error: error instanceof Error ? error.message : "版本操作失败" },
    { status },
  );
}

export async function GET(request: Request) {
  try {
    const { home } = await requireWorkspaceContext(request);
    const assetId = new URL(request.url).searchParams.get("assetId")?.trim();
    if (!assetId) throw new Error("文件 ID 必填");
    const db = await getDb();
    const [asset] = await db
      .select({ id: assets.id })
      .from(assets)
      .where(
        and(
          eq(assets.id, assetId),
          eq(assets.workspaceId, home.workspaceId),
        ),
      )
      .limit(1);
    if (!asset) return errorResponse(new Error("文件不存在"), 404);
    const versions = await db
      .select({
        id: assetVersions.id,
        version: assetVersions.version,
        mimeType: assetVersions.mimeType,
        size: assetVersions.size,
        contentHash: assetVersions.contentHash,
        sourceType: assetVersions.sourceType,
        sourceRef: assetVersions.sourceRef,
        createdAt: assetVersions.createdAt,
      })
      .from(assetVersions)
      .where(eq(assetVersions.assetId, assetId))
      .orderBy(desc(assetVersions.version));
    return Response.json({ versions });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { user, home } = await requireWorkspaceContext(request);
    const form = await request.formData();
    const assetId = String(form.get("assetId") ?? "").trim();
    const file = form.get("file");
    if (!assetId || !(file instanceof File)) {
      throw new Error("文件 ID 和新版本文件必填");
    }
    if (file.size > MAX_FILE_BYTES) {
      throw new Error("单个文件暂时不能超过 100 MB");
    }
    const db = await getDb();
    const [asset] = await db
      .select()
      .from(assets)
      .where(
        and(
          eq(assets.id, assetId),
          eq(assets.workspaceId, home.workspaceId),
        ),
      )
      .limit(1);
    if (!asset) return errorResponse(new Error("文件不存在"), 404);
    const bytes = await file.arrayBuffer();
    const validated = validateUploadedFile({
      name: file.name || asset.name,
      declaredMimeType: file.type || asset.mimeType,
      bytes,
    });
    if (
      validated.mimeType.split("/")[0] !== asset.mimeType.split("/")[0] &&
      validated.mimeType !== asset.mimeType
    ) {
      throw new Error("新版本必须与原文件保持相同的内容类型");
    }
    const bucket = await getFileBucket();
    const updated = await storeAssetVersion(db, bucket, asset, {
      name: validated.name,
      mimeType: validated.mimeType,
      bytes,
      sourceType: String(form.get("sourceType") ?? "version-upload"),
      sourceRef: String(form.get("sourceRef") ?? "").trim() || null,
    });
    await db.insert(registryEvents).values({
      id: crypto.randomUUID(),
      workspaceId: home.workspaceId,
      actorUserId: user.id,
      eventType: "asset.version.created",
      entityId: asset.id,
      detailJson: JSON.stringify({ version: updated.currentVersion }),
    });
    return Response.json({ asset: updated }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
