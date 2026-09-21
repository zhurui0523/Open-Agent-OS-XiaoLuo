import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { assets, assetVersions } from "../../../../../db/schema";
import { jsonError, requireUser } from "../../../../lib/auth";
import { getFileBucket } from "../../../../lib/asset-kernel";
import { mysqlNow } from "../../../../lib/mysql";
import { requireRequestedWorkspace } from "../../../../lib/workspace-context";

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as { workspaceId?: string };
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "manage",
      payload,
    );
    const db = await getDb();
    const rows = await db
      .select({
        assetId: assets.id,
        blobKey: assetVersions.blobKey,
      })
      .from(assets)
      .innerJoin(
        assetVersions,
        eq(assetVersions.id, assets.currentVersionId),
      )
      .where(
        and(
          eq(assets.workspaceId, workspaceId),
          isNull(assets.trashedAt),
        ),
      )
      .limit(100);
    const bucket = await getFileBucket();
    const missing: string[] = [];
    for (const row of rows) {
      const object = await bucket.get(row.blobKey, {
        range: { offset: 0, length: 1 },
      });
      if (!object) missing.push(row.assetId);
    }
    for (const assetId of missing) {
      await db
        .update(assets)
        .set({
          status: "missing",
          missingAt: mysqlNow(),
          updatedAt: mysqlNow(),
        })
        .where(eq(assets.id, assetId));
    }
    return Response.json({
      scanned: rows.length,
      missing: missing.length,
      missingAssetIds: missing,
    });
  } catch (error) {
    return jsonError(error, "OSS 对账失败");
  }
}
