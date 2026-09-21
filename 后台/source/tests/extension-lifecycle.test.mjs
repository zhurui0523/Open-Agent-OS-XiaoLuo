import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("imports Markdown Skills and synchronizes their rules into execution", async () => {
  const [markdown, capabilities, worker, executor] = await Promise.all([
    source("app/lib/skill-markdown.ts"),
    source("app/components/capabilities-view.tsx"),
    source("app/lib/kernel-worker.ts"),
    source("app/lib/kernel-executors.ts"),
  ]);
  assert.match(markdown, /Skill Markdown/);
  assert.match(markdown, /x-xiaoluo-instructions/);
  assert.match(capabilities, /\.md,\.xlpkg,\.json/);
  assert.match(worker, /skillInstructionsFromSchema/);
  assert.match(executor, /Skill 执行规则/);
});

test("enforces private and shared Skill scopes for administrators and users", async () => {
  const [access, registry, packageRoute, marketplace, router, settings, capabilities] =
    await Promise.all([
      source("app/lib/registry-access.ts"),
      source("app/api/v2/registry/route.ts"),
      source("app/api/v2/packages/route.ts"),
      source("app/api/v2/packages/marketplace/route.ts"),
      source("app/lib/model-runtime-router.ts"),
      source("app/components/settings-center.tsx"),
      source("app/components/capabilities-view.tsx"),
    ]);
  assert.match(access, /personal/);
  assert.match(access, /workspace/);
  assert.match(access, /marketplace/);
  assert.match(registry, /canAccessRegistryResource/);
  assert.match(packageRoute, /安装 Skill 或插件时只能选择“私有”或“共享”可见范围/);
  assert.match(packageRoute, /scope: payload\.accessScope/);
  assert.match(packageRoute, /不能修改其他用户创建的 Skill 或插件/);
  assert.match(packageRoute, /canDeleteOwnExtension/);
  assert.match(marketplace, /packageAccessScope/);
  assert.match(marketplace, /u\.platform_role AS platformRole/);
  assert.match(marketplace, /JSON_UNQUOTE\(JSON_EXTRACT/);
  assert.match(router, /isAccessible/);
  assert.match(settings, /使用权限/);
  assert.match(capabilities, /可用 Skill/);
  assert.match(capabilities, /私有 Skill/);
  assert.match(capabilities, /共享 Skill/);
  assert.match(capabilities, /系统管理员发布的/);
  assert.match(capabilities, /供所有用户添加/);
  assert.match(capabilities, /所有用户可见并可添加/);
});

test("shows personal modality usage and OSS storage percentage", async () => {
  const [route, personal] = await Promise.all([
    source("app/api/v2/account/usage/route.ts"),
    source("app/components/personal-settings.tsx"),
  ]);
  assert.match(route, /model_execution_audits/);
  assert.match(route, /resolveStorageQuotaBytes/);
  assert.match(personal, /用量与存储/);
  assert.match(personal, /storage\.usedPercent/);
});

test("starts and probes the local isolated plugin worker", async () => {
  const [launcher, workerClient, pluginProbe] = await Promise.all([
    source("scripts/start-local-next.mjs"),
    source("app/lib/isolated-worker.ts"),
    source("app/api/v2/plugins/test/route.ts"),
  ]);
  assert.match(launcher, /isolated-worker\/server\.mjs/);
  assert.match(workerClient, /probeIsolatedWorker/);
  assert.match(pluginProbe, /隔离 Worker 健康/);
});
