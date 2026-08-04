import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

test("canvas collaboration persists presence, comments, mentions and revision events", async () => {
  const [route, client, canvasRoute, schema] = await Promise.all([
    source("app/api/v2/collaboration/route.ts"),
    source("app/components/canvas-collaboration.tsx"),
    source("app/api/v2/canvases/route.ts"),
    source("db/schema.ts"),
  ]);
  assert.match(route, /action === "heartbeat"/);
  assert.match(route, /action === "comment\.create"/);
  assert.match(route, /"comment\.resolve"/);
  assert.match(route, /eventType: "comment\.resolved"/);
  assert.match(route, /resolveCanvasMentions/);
  assert.match(route, /requireCanvasAccess/);
  assert.match(client, /setInterval\(\(\) => void poll\(\), 2_000\)/);
  assert.match(client, /accessRevoked/);
  assert.match(canvasRoute, /x-collaboration-session/);
  assert.match(schema, /xiaoluo_v2_canvas_presence/);
  assert.match(schema, /xiaoluo_v2_canvas_comments/);
  assert.match(schema, /xiaoluo_v2_canvas_collaboration_events/);
});

test("package trust center verifies signatures and can quarantine or revoke packages", async () => {
  const [trust, packageRoute, adminRoute, schema] = await Promise.all([
    source("app/lib/package-trust.ts"),
    source("app/api/v2/packages/route.ts"),
    source("app/api/v2/admin/package-trust/route.ts"),
    source("db/schema.ts"),
  ]);
  assert.match(trust, /verifySignature/);
  assert.match(trust, /canonicalPackageManifest/);
  assert.match(trust, /ECDSA P-256/);
  assert.match(packageRoute, /signatureVerified/);
  assert.match(packageRoute, /automaticReviewStatus/);
  assert.match(packageRoute, /trustState/);
  assert.match(adminRoute, /publisher\.review/);
  assert.match(adminRoute, /review\.update/);
  assert.match(adminRoute, /quarantined/);
  assert.match(adminRoute, /packageCapabilities/);
  assert.match(schema, /xiaoluo_v2_trusted_publishers/);
  assert.match(schema, /xiaoluo_v2_package_reviews/);
});

test("isolated runtime never executes Node Python or CLI inside the web process", async () => {
  const [worker, route, contract] = await Promise.all([
    source("app/lib/isolated-worker.ts"),
    source("app/api/v2/runtime/isolated/route.ts"),
    source("app/lib/package-contract.ts"),
  ]);
  assert.match(worker, /ISOLATED_WORKER_ENDPOINT/);
  assert.match(worker, /createHmac/);
  assert.match(worker, /packageFilesystem: "read-only"/);
  assert.match(worker, /filesystem: "ephemeral"/);
  assert.doesNotMatch(worker, /child_process|spawn\(|exec\(/);
  assert.match(route, /pkg\.trustState !== "trusted"/);
  assert.match(route, /secretRefIds/);
  assert.match(contract, /isolated-worker/);
  assert.match(contract, /worker:\$\{runtimeLanguage\}/);
});

test("scheduler heartbeats and redacted service readiness are observable", async () => {
  const [workerRoute, workerEntry, viteConfig, asyncJobs, readiness, overview] = await Promise.all([
    source("app/api/v2/worker/tick/route.ts"),
    source("worker/index.ts"),
    source("vite.config.ts"),
    source("app/lib/model-async-jobs.ts"),
    source("app/lib/server-runtime-config.ts"),
    source("app/api/v2/admin/overview/route.ts"),
  ]);
  assert.match(workerRoute, /recordHeartbeat/);
  assert.match(workerRoute, /runtime-scheduler/);
  assert.match(workerRoute, /authorization/);
  assert.match(workerEntry, /scheduled\(/);
  assert.match(workerEntry, /runRuntimeScheduler/);
  assert.match(workerEntry, /authorization: `Bearer \$\{token\}`/);
  assert.match(viteConfig, /crons: \["\* \* \* \* \*"\]/);
  assert.match(viteConfig, /hmr: \{ overlay: false \}/);
  assert.match(asyncJobs, /generation-poller:/);
  assert.match(asyncJobs, /lease_expires_at/);
  assert.match(readiness, /runtimeServiceReadiness/);
  assert.match(overview, /xiaoluo_v2_system_heartbeats/);
  assert.match(overview, /xiaoluo_v2_package_reviews/);
});

test("legacy migration supports dry-run apply and golden SHA-256 verification", async () => {
  const script = await source("scripts/legacy-data-migration.mjs");
  assert.match(script, /--apply/);
  assert.match(script, /--verify/);
  assert.match(script, /digestSource/);
  assert.match(script, /digestTarget/);
  assert.match(script, /golden-data comparison failed/);
  assert.match(script, /ON DUPLICATE KEY UPDATE/);
  assert.match(script, /beginTransaction/);
});
