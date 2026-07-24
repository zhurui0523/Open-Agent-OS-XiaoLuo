import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("keeps schema mutations in versioned migrations only", async () => {
  const [database, mysql, migration, runner] = await Promise.all([
    source("db/index.ts"),
    source("app/lib/mysql.ts"),
    source("drizzle/0001_brainy_virginia_dare.sql"),
    source("scripts/migrate-v2.mjs"),
  ]);

  assert.doesNotMatch(database, /\bCREATE\s+TABLE\b|\bALTER\s+TABLE\b/i);
  assert.doesNotMatch(mysql, /\bCREATE\s+TABLE\b|\bALTER\s+TABLE\b/i);
  assert.match(migration, /xiaoluo_v2_intent_conversations/);
  assert.match(migration, /xiaoluo_v2_run_events/);
  assert.match(migration, /xiaoluo_v2_package_versions/);
  assert.match(runner, /xiaoluo_v2_schema_migrations/);
  assert.match(runner, /Migration checksum mismatch/);
});

test("enforces workspace scope on extension model runtime and asset APIs", async () => {
  const scopedRoutes = [
    "app/api/v2/packages/route.ts",
    "app/api/v2/models/route.ts",
    "app/api/v2/models/test/route.ts",
    "app/api/v2/registry/route.ts",
    "app/api/v2/runtime/invoke/route.ts",
    "app/api/v2/tasks/route.ts",
    "app/api/v2/collections/route.ts",
    "app/api/v2/files/bulk/route.ts",
    "app/api/v2/files/reconcile/route.ts",
  ];

  for (const route of scopedRoutes) {
    const contents = await source(route);
    assert.match(
      contents,
      /requireRequestedWorkspace/,
      `${route} must resolve and authorize workspaceId`,
    );
  }
});

test("persists Intent plans and runtime events on the server", async () => {
  const [messages, runs, worker, schema] = await Promise.all([
    source("app/api/v2/intent/messages/route.ts"),
    source("app/api/v2/kernel/runs/route.ts"),
    source("app/lib/kernel-worker.ts"),
    source("db/schema.ts"),
  ]);

  assert.match(messages, /text\/event-stream/);
  assert.match(messages, /planIntent/);
  assert.match(runs, /idempotencyKey/);
  assert.match(worker, /leaseExpiresAt/);
  assert.match(worker, /maxAttempts/);
  assert.match(worker, /storeAsset/);
  assert.match(schema, /export const intentPlans/);
  assert.match(schema, /export const runEvents/);
  assert.match(schema, /export const generationJobs/);
});

test("stores provider credentials as encrypted server-side references", async () => {
  const [vault, models, schema] = await Promise.all([
    source("app/lib/secret-vault.ts"),
    source("app/api/v2/models/route.ts"),
    source("db/schema.ts"),
  ]);

  assert.match(vault, /AES-GCM/);
  assert.match(vault, /SECRET_ENCRYPTION_KEY/);
  assert.match(models, /saveSecret/);
  assert.doesNotMatch(models, /apiKey:\s*payload\.apiKey/);
  assert.match(schema, /secretRefId/);
});

test("versions packages and removes them through lifecycle state", async () => {
  const [route, schema] = await Promise.all([
    source("app/api/v2/packages/route.ts"),
    source("db/schema.ts"),
  ]);

  assert.match(route, /integritySha256/);
  assert.match(route, /packageVersions/);
  assert.match(route, /uninstalled/);
  assert.match(route, /REQUIRE_PACKAGE_SIGNATURES/);
  assert.match(schema, /packageKey/);
  assert.match(schema, /lifecycleState/);
});

test("ships all eight frozen baseline inventories", async () => {
  const files = [
    "requirements.csv",
    "api-inventory.csv",
    "schema-inventory.csv",
    "route-inventory.csv",
    "permissions-matrix.csv",
    "events.csv",
    "migration-mapping.csv",
    "critical-e2e.csv",
  ];
  await Promise.all(
    files.map((file) => access(new URL(`docs/baseline/${file}`, root))),
  );
});
