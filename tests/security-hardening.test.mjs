import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("protects browser mutations and emits application security headers", async () => {
  const worker = await source("worker/index.ts");
  assert.match(worker, /sec-fetch-site/);
  assert.match(worker, /origin !== url\.origin/);
  assert.match(worker, /content-security-policy/);
  assert.match(worker, /strict-transport-security/);
  assert.match(worker, /x-content-type-options/);
  assert.match(worker, /permissions-policy/);
  assert.match(worker, /DEFAULT_API_BODY_LIMIT/);
});

test("rate limits login by private IP and account identifier buckets", async () => {
  const [login, limiter] = await Promise.all([
    source("app/api/v2/auth/login/route.ts"),
    source("app/lib/rate-limit.ts"),
  ]);
  assert.match(login, /auth\.login\.ip/);
  assert.match(login, /auth\.login\.identifier/);
  assert.match(login, /privateRateLimitSubject/);
  assert.match(limiter, /cf-connecting-ip/);
});

test("fails closed for production database TLS secrets and package signatures", async () => {
  const [runtime, vault, packages, executors] = await Promise.all([
    source("app/lib/server-runtime-config.ts"),
    source("app/lib/secret-vault.ts"),
    source("app/api/v2/packages/route.ts"),
    source("app/lib/kernel-executors.ts"),
  ]);
  assert.match(runtime, /生产环境必须配置 DB_SSL_MODE=required/);
  assert.match(runtime, /process\.env\.NODE_ENV === "production"/);
  assert.match(vault, /生产环境必须配置独立的 SECRET_ENCRYPTION_KEY/);
  assert.match(packages, /packageSignaturesRequired\(\)/);
  assert.match(executors, /allowedTrustStates/);
});

test("blocks private endpoints and streams remote responses through byte limits", async () => {
  const [adapters, files, worker, asyncJobs] = await Promise.all([
    source("app/lib/model-adapters.ts"),
    source("app/api/v2/files/route.ts"),
    source("app/lib/kernel-worker.ts"),
    source("app/lib/model-async-jobs.ts"),
  ]);
  assert.match(adapters, /isNonPublicIpv4/);
  assert.match(adapters, /isNonPublicIpv6/);
  assert.match(adapters, /EXTERNAL_API_ALLOWED_PORTS/);
  assert.match(adapters, /readResponseBytesLimited/);
  assert.match(adapters, /response\.body\.getReader\(\)/);
  assert.doesNotMatch(files, /response\.arrayBuffer\(\)/);
  assert.doesNotMatch(worker, /response\.arrayBuffer\(\)/);
  assert.doesNotMatch(asyncJobs, /response\.arrayBuffer\(\)/);
});
