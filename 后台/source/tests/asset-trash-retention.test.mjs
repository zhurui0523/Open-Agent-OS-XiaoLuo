import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("recycle-bin assets expire after 72 hours", async () => {
  const [policy, cleanup] = await Promise.all([
    source("app/lib/asset-trash-policy.ts"),
    source("app/lib/asset-trash-cleanup.ts"),
  ]);

  assert.match(policy, /ASSET_TRASH_RETENTION_HOURS = 72/);
  assert.match(policy, /timestamp \+ ASSET_TRASH_RETENTION_MS/);
  assert.match(cleanup, /lte\(assets\.trashedAt, cutoff\)/);
  assert.match(cleanup, /delete\(assets\)\.where\(inArray\(assets\.id, assetIds\)\)/);
});

test("expired assets remove only unreferenced local or OSS objects", async () => {
  const cleanup = await source("app/lib/asset-trash-cleanup.ts");

  assert.match(cleanup, /inArray\(assetVersions\.blobKey, candidateBlobKeys\)/);
  assert.match(cleanup, /!referencedBlobKeys\.has\(blobKey\)/);
  assert.match(cleanup, /await bucket\.delete\(blobKey\)/);
  assert.match(cleanup, /failedObjectKeys\.push\(blobKey\)/);
});

test("cleanup runs from both file access and the background worker", async () => {
  const [filesRoute, workerRoute] = await Promise.all([
    source("app/api/v2/files/route.ts"),
    source("app/api/v2/worker/tick/route.ts"),
  ]);

  assert.match(filesRoute, /purgeExpiredTrashedAssets\(\{/);
  assert.match(filesRoute, /workspaceId: home\.workspaceId/);
  assert.match(workerRoute, /purgeExpiredTrashedAssets\(\{/);
  assert.match(workerRoute, /expiredTrashAssets: trashCleanup\.deletedAssets/);
});

test("the recycle-bin UI explains retention and shows a countdown", async () => {
  const [component, styles] = await Promise.all([
    source("app/components/assets-view.tsx"),
    source("app/globals.css"),
  ]);

  assert.match(component, /回收站文件保留 \{ASSET_TRASH_RETENTION_HOURS\} 小时/);
  assert.match(component, /永久删除后无法恢复/);
  assert.match(component, /assetTrashRemainingLabel\(asset\.trashedAt\)/);
  assert.match(component, /自动删除时间/);
  assert.match(styles, /\.file-trash-retention-notice/);
  assert.match(styles, /\.file-trash-countdown/);
});
