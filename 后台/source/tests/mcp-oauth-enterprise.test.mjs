/**
 * 第 5 项：MCP 企业级认证（Codex rmcp-client 的三张牌）
 *
 * 小逻原来只有"公开客户端 + PKCE + 刷新 + 401 重试一次"。这里补：
 *  - 机密客户端（client_secret_basic / client_secret_post，secret 不落盘）；
 *  - client_credentials（无人值守）；
 *  - RFC 8693 token-exchange（换资源绑定的 token，Codex 的 EMA 那条）；
 *  - token 端点重试背压（429/5xx/网络抖动才重试，4xx 直接失败，遵守 Retry-After）。
 *
 * 注意：这些都是"代码具备"，验收靠假授权服务器；真实企业 IdP（Linear/Okta/Azure AD）仍需一次真机登录。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const OAUTH = await import("../../../客户端/source/desktop/mcp-oauth.mjs");

const TMP = mkdtempSync(join(tmpdir(), "xiaoluo-mcp-enterprise-"));
test.after(() => rmSync(TMP, { recursive: true, force: true }));
OAUTH.initMcpOAuth(join(TMP, "mcp-auth"));

function capture() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, text: async () => JSON.stringify({ access_token: "tok", expires_in: 3600 }) };
  };
  return { calls, fetchImpl };
}

function body(call) {
  return new URLSearchParams(call.init.body);
}

test("client_credentials：走 basic 认证，secret 不进请求体，token 可复用", async () => {
  const { calls, fetchImpl } = capture();
  const cfg = {
    oauth: {
      grant: "client_credentials",
      tokenEndpoint: "https://idp/token",
      clientId: "machine-client",
      clientSecret: "s3cret",
    },
  };
  const first = await OAUTH.ensureToken("cc1", cfg, fetchImpl);
  assert.equal(first.ok, true);
  assert.equal(first.grant, "client_credentials");
  assert.equal(calls.length, 1);
  const b = body(calls[0]);
  assert.equal(b.get("grant_type"), "client_credentials");
  assert.equal(b.get("client_secret"), null, "basic 认证时 secret 不该出现在表单里");
  const expected = "Basic " + Buffer.from("machine-client:s3cret").toString("base64");
  assert.equal(calls[0].init.headers.authorization, expected);

  // 已存且未过期：不再打端点
  const second = await OAUTH.ensureToken("cc1", cfg, fetchImpl);
  assert.equal(second.ok, true);
  assert.equal(second.refreshed, false);
  assert.equal(calls.length, 1);

  const stored = await OAUTH.readTokens("cc1");
  assert.equal(stored.token_endpoint, "https://idp/token");
  assert.equal(stored.client_secret, undefined, "secret 绝不能落盘");
});

test("client_secret_post：secret 进表单，同时校验 client_id/client_secret 必须成对", async () => {
  const { calls, fetchImpl } = capture();
  const cfg = {
    oauth: {
      grant: "client_credentials",
      tokenEndpoint: "https://idp/token",
      clientId: "cid",
      clientSecret: "pw",
      authMethod: "post",
    },
  };
  await OAUTH.ensureToken("cc2", cfg, fetchImpl);
  const b = body(calls[0]);
  assert.equal(b.get("client_secret"), "pw");
  assert.equal(calls[0].init.headers.authorization, undefined);

  await assert.rejects(
    async () => OAUTH.ensureToken("cc3", { oauth: { grant: "client_credentials", tokenEndpoint: "https://idp/token", clientSecret: "pw" } }, fetchImpl),
    /client_secret 却没有 client_id/,
  );
});

test("token_exchange：RFC 8693 参数齐全；缺 subject token 时明确 saying 缺什么", async () => {
  const { calls, fetchImpl } = capture();
  const cfg = {
    oauth: {
      grant: "token_exchange",
      tokenEndpoint: "https://idp/token",
      clientId: "cid",
      clientSecret: "pw",
      subjectToken: "upstream-jwt",
      audience: "mcp.example.com",
      scope: "mcp:read",
    },
  };
  const out = await OAUTH.ensureToken("te1", cfg, fetchImpl);
  assert.equal(out.ok, true);
  const b = body(calls[0]);
  assert.equal(b.get("grant_type"), OAUTH.TOKEN_EXCHANGE_GRANT);
  assert.equal(b.get("subject_token"), "upstream-jwt");
  assert.equal(b.get("subject_token_type"), "urn:ietf:params:oauth:token-type:access_token");
  assert.equal(b.get("requested_token_type"), "urn:ietf:params:oauth:token-type:access_token");
  assert.equal(b.get("audience"), "mcp.example.com");
  assert.equal(b.get("scope"), "mcp:read");

  const missing = await OAUTH.ensureToken("te2", { oauth: { grant: "token_exchange", tokenEndpoint: "https://idp/token" } }, fetchImpl);
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "needs_subject_token");
  assert.match(missing.error, /XIAOLUO_MCP_SUBJECT_TOKEN/);
});

test("重试背压：429 会重试，400 不重试，网络抖动重试一次后成功", async () => {
  // 429 -> 200
  let n = 0;
  const flaky = async () => {
    n += 1;
    if (n === 1) return { ok: false, status: 429, text: async () => "slow down", headers: { get: () => "0.05" } };
    return { ok: true, text: async () => JSON.stringify({ access_token: "tok2", expires_in: 60 }) };
  };
  await OAUTH.ensureToken("rt429", { oauth: { grant: "client_credentials", tokenEndpoint: "https://idp/token", clientId: "c", clientSecret: "s" } }, flaky);
  assert.equal(n, 2, "429 必须再试一次");

  // 400 -> 立刻抛，不再重试
  let m = 0;
  const bad = async () => {
    m += 1;
    return { ok: false, status: 400, text: async () => "invalid_client" };
  };
  const badCfg = { oauth: { grant: "client_credentials", tokenEndpoint: "https://idp/token", clientId: "c", clientSecret: "s" } };
  const badOut = await OAUTH.ensureToken("rt400", badCfg, bad);
  assert.equal(badOut.ok, false);
  assert.equal(m, 1, "401/400 这类配置错误不该重试");

  // 网络异常 -> 重试后成功
  let k = 0;
  const netFlaky = async () => {
    k += 1;
    if (k === 1) throw new Error("ECONNRESET");
    return { ok: true, text: async () => JSON.stringify({ access_token: "tok3", expires_in: 60 }) };
  };
  const netOut = await OAUTH.ensureToken("rtnet", badCfg, netFlaky);
  assert.equal(netOut.ok, true);
  assert.equal(k, 2);
});

test("refreshRejected：机器类 grant 用重取代替 refresh（没有 refresh_token 也不会卡住）", async () => {
  const { calls, fetchImpl } = capture();
  const cfg = { oauth: { grant: "client_credentials", tokenEndpoint: "https://idp/token", clientId: "c", clientSecret: "s" } };
  await OAUTH.ensureToken("rj1", cfg, fetchImpl);
  assert.equal((await OAUTH.readTokens("rj1")).refresh_token, undefined, "client_credentials 通常不发 refresh_token");
  const rejected = await OAUTH.refreshRejected("rj1", cfg, fetchImpl);
  assert.equal(rejected.ok, true);
  assert.equal(calls.length, 2, "401 后应重新取一次 token");
  assert.equal(rejected.grant, "client_credentials");
});
