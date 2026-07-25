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
  const [messages, runs, worker, domainEvents, schema] = await Promise.all([
    source("app/api/v2/intent/messages/route.ts"),
    source("app/api/v2/kernel/runs/route.ts"),
    source("app/lib/kernel-worker.ts"),
    source("app/lib/domain-events.ts"),
    source("db/schema.ts"),
  ]);

  assert.match(messages, /text\/event-stream/);
  assert.match(messages, /planIntent/);
  assert.match(runs, /idempotencyKey/);
  assert.match(worker, /leaseExpiresAt/);
  assert.match(worker, /maxAttempts/);
  assert.match(worker, /storeAsset/);
  assert.match(runs, /capabilitySnapshot/);
  assert.match(schema, /export const intentPlans/);
  assert.match(schema, /export const runEvents/);
  assert.match(schema, /export const generationJobs/);
  assert.match(schema, /export const auditLogs/);
  assert.match(schema, /export const outboxEvents/);
  assert.match(domainEvents, /FOR UPDATE SKIP LOCKED/);
  assert.match(domainEvents, /runAuditedMutation/);
  assert.match(domainEvents, /status = 'published'/);
});

test("routes model calls with retry fallback circuit breaking and async jobs", async () => {
  const [
    router,
    executors,
    asyncJobs,
    pollRoute,
    taskRoute,
    catalogRoute,
    statsRoute,
    schema,
    migration,
  ] = await Promise.all([
    source("app/lib/model-runtime-router.ts"),
    source("app/lib/kernel-executors.ts"),
    source("app/lib/model-async-jobs.ts"),
    source("app/api/v2/tasks/poll/route.ts"),
    source("app/api/v2/tasks/route.ts"),
    source("app/api/v2/models/catalog/route.ts"),
    source("app/api/v2/models/stats/route.ts"),
    source("db/schema.ts"),
    source("drizzle/0005_grey_peter_parker.sql"),
  ]);

  assert.match(router, /orderedCandidates/);
  assert.match(router, /fallbackModelId/);
  assert.match(router, /retryAfterMs/);
  assert.match(router, /circuit_state/);
  assert.match(router, /active_requests < max_concurrency/);
  assert.match(router, /modelExecutionAudits/);
  assert.match(executors, /AsyncJobDescriptor/);
  assert.match(executors, /pollModelJob/);
  assert.match(executors, /cancelModelJob/);
  assert.match(asyncJobs, /persistAsyncResult/);
  assert.match(asyncJobs, /storeAsset/);
  assert.match(pollRoute, /pollGenerationJob/);
  assert.match(taskRoute, /cancelGenerationJob/);
  assert.match(catalogRoute, /modelCatalogEntries/);
  assert.match(statsRoute, /total_count/);
  assert.match(statsRoute, /不计算 Token、用量金额或第三方账单/);
  assert.doesNotMatch(statsRoute, /price|cost_usd|token_count/i);
  assert.match(schema, /export const modelCatalogEntries/);
  assert.match(schema, /export const modelExecutionAudits/);
  assert.match(schema, /export const modelUsageStats/);
  assert.match(migration, /circuit_failure_threshold/);
  assert.match(migration, /model_execution_audits/);
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
  assert.match(route, /packageSignaturesRequired/);
  assert.match(schema, /packageKey/);
  assert.match(schema, /lifecycleState/);
});

test("ships all eight frozen baseline inventories", async () => {
  const files = [
    "web-pages-and-entrypoints.csv",
    "user-actions-and-states.csv",
    "api-routes-and-events.csv",
    "data-tables-fields-storage.csv",
    "skills-agents-models-packages.csv",
    "workers-jobs-integrations.csv",
    "roles-and-permissions.csv",
    "requirements-coverage.csv",
  ];
  await Promise.all(
    files.map((file) => access(new URL(`docs/baseline/${file}`, root))),
  );
});
