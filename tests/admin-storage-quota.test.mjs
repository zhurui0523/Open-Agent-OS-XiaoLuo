import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("persists and reports per-user storage quotas", async () => {
  const [schema, migration, accountUsage, organizations] = await Promise.all([
    read("db/schema.ts"),
    read("drizzle/0020_user_storage_quotas.sql"),
    read("app/api/v2/account/usage/route.ts"),
    read("app/api/v2/organizations/route.ts"),
  ]);

  assert.match(schema, /storageQuotaBytes: bigint\("storage_quota_bytes"/);
  assert.match(migration, /ADD `storage_quota_bytes` bigint unsigned NULL/);
  assert.match(accountUsage, /resolveStorageQuotaBytes/);
  assert.match(organizations, /workspace_owner\.storage_quota_bytes/);
});

test("only system admins can increase eligible user storage", async () => {
  const route = await read("app/api/v2/admin/users/storage/route.ts");

  assert.match(route, /requireSystemAdmin\(request\)/);
  assert.match(route, /target\.accountType === "enterprise_member"/);
  assert.match(route, /target\.platformRole !== "user"/);
  assert.match(route, /admin\.user\.storage_increased/);
});

test("admin UI offers storage increases only for ordinary users and enterprise admins", async () => {
  const [route, component] = await Promise.all([
    read("app/api/v2/admin/users/route.ts"),
    read("app/components/admin-center.tsx"),
  ]);

  assert.match(route, /row\.accountType === "ordinary_user"/);
  assert.match(route, /row\.accountType === "enterprise_admin"/);
  assert.match(component, /企业成员不单独分配/);
  assert.match(component, /增加空间/);
  assert.match(component, /\/api\/v2\/admin\/users\/storage/);
});

test("asset writes enforce the workspace owner's assigned storage", async () => {
  const kernel = await read("app/lib/asset-kernel.ts");

  assert.match(kernel, /assertWorkspaceStorageAvailable/);
  assert.match(kernel, /eq\(workspaces\.ownerId, workspace\.ownerId\)/);
  assert.match(kernel, /projectedBytes > quotaBytes/);
});
