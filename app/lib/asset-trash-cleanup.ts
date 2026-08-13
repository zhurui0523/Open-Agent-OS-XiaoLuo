import {
  and,
  eq,
  inArray,
  isNotNull,
  lte,
} from "drizzle-orm";
import type { getDb } from "../../db";
import { assets, assetVersions } from "../../db/schema";
import { getFileBucket, type FileBucket } from "./asset-kernel";
import {
  ASSET_TRASH_RETENTION_HOURS,
  ASSET_TRASH_RETENTION_MS,
} from "./asset-trash-policy";
import { mysqlNow } from "./mysql";

type Database = Awaited<ReturnType<typeof getDb>>;

export interface AssetTrashCleanupResult {
  cutoff: string;
  retentionHours: number;
  deletedAssets: number;
  deletedObjects: number;
  failedObjectKeys: string[];
}

export async function purgeExpiredTrashedAssets(input: {
  db: Database;
  workspaceId?: string;
  bucket?: FileBucket;
  batchSize?: number;
  now?: Date;
}): Promise<AssetTrashCleanupResult> {
  const now = input.now ?? new Date();
  const cutoff = mysqlNow(
    new Date(now.getTime() - ASSET_TRASH_RETENTION_MS),
  );
  const batchSize = Math.min(500, Math.max(1, input.batchSize ?? 200));
  const conditions = [
    isNotNull(assets.trashedAt),
    lte(assets.trashedAt, cutoff),
  ];
  if (input.workspaceId) {
    conditions.push(eq(assets.workspaceId, input.workspaceId));
  }

  const expired = await input.db
    .select({ id: assets.id })
    .from(assets)
    .where(and(...conditions))
    .limit(batchSize);
  const assetIds = expired.map((asset) => asset.id);
  if (!assetIds.length) {
    return {
      cutoff,
      retentionHours: ASSET_TRASH_RETENTION_HOURS,
      deletedAssets: 0,
      deletedObjects: 0,
      failedObjectKeys: [],
    };
  }

  const versions = await input.db
    .select({ blobKey: assetVersions.blobKey })
    .from(assetVersions)
    .where(inArray(assetVersions.assetId, assetIds));
  const candidateBlobKeys = [
    ...new Set(versions.map((version) => version.blobKey)),
  ];

  await input.db.delete(assets).where(inArray(assets.id, assetIds));

  let unreferencedBlobKeys = candidateBlobKeys;
  if (candidateBlobKeys.length) {
    const remaining = await input.db
      .select({ blobKey: assetVersions.blobKey })
      .from(assetVersions)
      .where(inArray(assetVersions.blobKey, candidateBlobKeys));
    const referencedBlobKeys = new Set(
      remaining.map((version) => version.blobKey),
    );
    unreferencedBlobKeys = candidateBlobKeys.filter(
      (blobKey) => !referencedBlobKeys.has(blobKey),
    );
  }

  const failedObjectKeys: string[] = [];
  if (unreferencedBlobKeys.length) {
    const bucket = input.bucket ?? (await getFileBucket());
    for (const blobKey of unreferencedBlobKeys) {
      try {
        await bucket.delete(blobKey);
      } catch {
        // The database entry is already gone. Leave an orphan for storage
        // reconciliation instead of making every recycle-bin request fail.
        failedObjectKeys.push(blobKey);
      }
    }
  }

  return {
    cutoff,
    retentionHours: ASSET_TRASH_RETENTION_HOURS,
    deletedAssets: assetIds.length,
    deletedObjects: unreferencedBlobKeys.length - failedObjectKeys.length,
    failedObjectKeys,
  };
}
