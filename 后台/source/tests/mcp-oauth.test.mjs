// P1-4 收尾验收：桌面端 MCP OAuth 凭据（PKCE / 刷新 / 回调）与 streamable HTTP 连接
// 被测模块在客户端源码里（MCP 连接由宿主侧负责），这里跨项目 import 同一份代码跑真实逻辑。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";

const OAUTH = await import("../../../客户端/source/desktop/mcp-oauth.mjs");
const MCP = await import("../../../客户端/source/desktop/mcp-runtime.mjs");

const TMP = mkdtempSync(join(tmpdir(), "xiaoluo-mcp-oauth-"));
test.after(() => rmSync(TMP, { recursive: true, force: true }));

OAUTH.initMcpOAuth(join(TMP, "mcp-auth"));

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

test("PKCE 与 state：challenge = base64url(sha256(verifier))，state 允许带附加后缀", () => {
  const { verifier, challenge, method } = OAUTH.createPkcePair();
  assert.equal(method, "S256");
  assert.ok(verifier.length >= 43, "verifier 至少要 43 字符");
  assert.equal(challenge, b64url(createHash("sha256").update(verifier).digest()));
  const state = OAUTH.generateState();
  assert.ok(OAUTH.stateMatches(state, state));
  assert.ok(OAUTH.stateMatches(state, state + ".onboarding=1"), "Codex 允许回调 state 带附加元数据");
  assert.ok(!OAUTH.stateMatches(state, state + "x"));
  assert.ok(!OAUTH.stateMatches(state, "other"));
});

test("凭据落盘：写读清一致，刷新提前量 30 秒", async () => {
  await OAUTH.saveTokens("s1", { access_token: "a1", refresh_token: "r1", expires_in: 3600, token_endpoint: "https://x/token" });
  const saved = await OAUTH.readTokens("s1");
  assert.equal(saved.access_token, "a1");
  assert.equal(saved.token_endpoint, "https://x/token");
  assert.equal(OAUTH.needsRefresh(saved, Date.now()), false);
  assert.equal(OAUTH.needsRefresh(saved, saved.expires_at - 10_000), true, "剩余不足 30 秒就该刷新");
  await OAUTH.clearTokens("s1");
  assert.equal(await OAUTH.readTokens("s1"), null);
});

test("ensureToken：过期用 refresh_token 续期，端点不回新的 refresh_token 时沿用旧的", async () => {
  await OAUTH.saveTokens("s2", {
    access_token: "old",
    refresh_token: "keep-me",
    expires_in: -100, // 已过期
    token_endpoint: "https://x/token",
  });
  const cfg = { oauth: { authorizationEndpoint: "https://x/auth", tokenEndpoint: "https://x/token", clientId: "cid" } };
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = init.body;
    return { ok: true, text: async () => JSON.stringify({ access_token: "fresh", expires_in: 7200 }) };
  };
  const result = await OAUTH.ensureToken("s2", cfg, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.refreshed, true);
  assert.equal(result.token, "fresh");
  assert.match(String(seen), /grant_type=refresh_token/);
  const stored = await OAUTH.readTokens("s2");
  assert.equal(stored.refresh_token, "keep-me", "新 token 没带 refresh_token 时必须沿用旧的");
  await OAUTH.clearTokens("s2");
});

test("ensureToken：没有凭据返回 needs_auth；刷新失败也不抛到底", async () => {
  const cfg = { oauth: { authorizationEndpoint: "https://x/auth", tokenEndpoint: "https://x/token", clientId: "cid" } };
  assert.deepEqual(await OAUTH.ensureToken("nope", cfg), { ok: false, reason: "needs_auth" });

  await OAUTH.saveTokens("s3", { access_token: "a", refresh_token: "r", expires_in: -100, token_endpoint: "https://x/token" });
  const failing = async () => ({ ok: false, status: 400, text: async () => "invalid_grant" });
  const result = await OAUTH.ensureToken("s3", cfg, failing);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "needs_auth");
  assert.match(result.error, /invalid_grant|400/);
  await OAUTH.clearTokens("s3");
});

test("完整授权一次：授权地址带 PKCE+state，回调换 token 落盘，state 不符则拒", async () => {
  // 假 OAuth 端点：/auth 用来确认参数，/token 发 token
  const hits = [];
  const server = createServer((req, res) => {
    if (req.url.startsWith("/token")) {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        hits.push(body);
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ access_token: "tok-from-code", refresh_token: "r-new", expires_in: 3600, scope: "mcp" }),
        );
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;

  const cfg = { oauth: { authorizationEndpoint: base + "/auth", tokenEndpoint: base + "/token", clientId: "cid", scope: "mcp" } };
  const session = await OAUTH.beginLogin("s4", cfg);
  const url = new URL(session.url);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("code_challenge"));
  assert.ok(url.searchParams.get("state"));
  assert.equal(url.searchParams.get("redirect_uri").startsWith("http://127.0.0.1:"), true);

  // 模拟浏览器回调（带正确 code + state）
  const state = url.searchParams.get("state");
  const redirectUri = url.searchParams.get("redirect_uri");
  const callback = await fetch(redirectUri + "?code=abc&state=" + encodeURIComponent(state));
  assert.equal(callback.status, 200);
  await session.done;
  const stored = await OAUTH.readTokens("s4");
  assert.equal(stored.access_token, "tok-from-code");
  assert.match(hits[0], /grant_type=authorization_code/);
  assert.match(hits[0], /code_verifier=/);
  await OAUTH.clearTokens("s4");

  // state 不符：应当拒绝并报错
  const session2 = await OAUTH.beginLogin("s5", cfg);
  const url2 = new URL(session2.url);
  const bad = await fetch(url2.searchParams.get("redirect_uri") + "?code=abc&state=wrong-state");
  assert.equal(bad.status, 400);
  await assert.rejects(session2.done, /state 不匹配/);
  server.close();
});

test("401 的 WWW-Authenticate 能解析出 resource_metadata 与 scope", () => {
  const parsed = OAUTH.parseWwwAuthenticate(
    'Bearer error="invalid_token", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource", scope="mcp:tools"',
  );
  assert.equal(parsed.scheme, "bearer");
  assert.equal(parsed.params.resource_metadata, "https://mcp.example.com/.well-known/oauth-protected-resource");
  assert.equal(parsed.params.scope, "mcp:tools");
  assert.equal(parsed.params.error, "invalid_token");
});

test("只填 url 也能授权：自动发现授权服务器 + 动态注册客户端 + 回调换 token", async () => {
  const seen = { registered: null, tokenBody: "" };
  const authServer = createServer((req, res) => {
    if (req.url.startsWith("/.well-known/oauth-authorization-server")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        issuer: "http://127.0.0.1:" + authServer.address().port,
        authorization_endpoint: "http://127.0.0.1:" + authServer.address().port + "/authorize",
        token_endpoint: "http://127.0.0.1:" + authServer.address().port + "/token",
        registration_endpoint: "http://127.0.0.1:" + authServer.address().port + "/register",
        scopes_supported: ["mcp:tools"],
      }));
      return;
    }
    if (req.url === "/register") {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        seen.registered = JSON.parse(body);
        res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ client_id: "dyn-client" }));
      });
      return;
    }
    if (req.url === "/token") {
      let body = "";
      req.on("data", (d) => { body += d; });
      req.on("end", () => {
        seen.tokenBody = body;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "dyn-token", refresh_token: "dyn-refresh", expires_in: 3600 }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => authServer.listen(0, "127.0.0.1", resolve));
  const authBase = "http://127.0.0.1:" + authServer.address().port;

  const resourceServer = createServer((req, res) => {
    if (req.url.startsWith("/.well-known/oauth-protected-resource")) {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ authorization_servers: [authBase], resource: "http://127.0.0.1:" + resourceServer.address().port + "/mcp" }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => resourceServer.listen(0, "127.0.0.1", resolve));
  const resBase = "http://127.0.0.1:" + resourceServer.address().port;

  const session = await OAUTH.beginLogin("discovered", { url: resBase + "/mcp" });
  const url = new URL(session.url);
  assert.equal(url.searchParams.get("client_id"), "dyn-client", "应使用动态注册拿到的 client_id");
  assert.equal(url.searchParams.get("scope"), "mcp:tools");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.deepEqual(seen.registered.grant_types, ["authorization_code", "refresh_token"]);
  assert.deepEqual(seen.registered.response_types, ["code"]);
  assert.equal(seen.registered.token_endpoint_auth_method, "none");
  assert.ok(seen.registered.redirect_uris[0].startsWith("http://127.0.0.1:"), "注册必须带真实回调地址");

  await fetch(url.searchParams.get("redirect_uri") + "?code=c1&state=" + encodeURIComponent(url.searchParams.get("state")));
  await session.done;
  const stored = await OAUTH.readTokens("discovered");
  assert.equal(stored.access_token, "dyn-token");
  assert.match(seen.tokenBody, /client_id=dyn-client/);
  await OAUTH.clearTokens("discovered");
  authServer.close();
  resourceServer.close();
});

test("HTTP 响应解析：JSON 与 SSE 两种都认，坏行跳过", () => {
  const json = MCP.parseMcpHttpBody("application/json", '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}');
  assert.equal(json.length, 1);
  assert.deepEqual(json[0].result, { tools: [] });
  const sse = MCP.parseMcpHttpBody(
    "text/event-stream",
    'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":1}}\n\ndata: not-json\n\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n',
  );
  assert.equal(sse.length, 2, "坏行被跳过");
  assert.deepEqual(sse[0].result, { ok: 1 });
  assert.equal(MCP.parseMcpHttpBody("application/json", "").length, 0);
});

test("streamable HTTP 连接：握手拿工具，调用带 Bearer token，401 时换新 token 重试一次", async () => {
  const workspace = join(TMP, "ws");
  mkdirSync(workspace, { recursive: true });
  const tokensSeen = [];
  let requireFresh = true;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const auth = req.headers.authorization || "";
      tokensSeen.push(auth);
      // 第一次请求故意用旧 token 把它打回 401，逼客户端刷新一次
      if (requireFresh && auth === "Bearer stale-token") {
        requireFresh = false;
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"invalid_token"}');
        return;
      }
      if (!auth.startsWith("Bearer ")) {
        res.writeHead(401).end();
        return;
      }
      const msg = JSON.parse(body || "{}");
      if (msg.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sid-1" }).end(
          JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake" } } }),
        );
        return;
      }
      if (msg.method === "tools/list") {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "回显", inputSchema: { type: "object" } }] } }),
        );
        return;
      }
      if (msg.method === "tools/call") {
        res.writeHead(200, { "content-type": "text/event-stream" }).end(
          'data: {"jsonrpc":"2.0","id":' + msg.id + ',"result":{"content":[{"type":"text","text":"hi"}]}}\n\n',
        );
        return;
      }
      res.writeHead(202).end();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;

  // 假 OAuth 端点 + 预置一个过期 token（refresh 时拿到新 token）
  const tokenServer = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ access_token: body.includes("refresh_token") ? "fresh-token" : "stale-token", expires_in: 3600 }),
      );
    });
  });
  await new Promise((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
  const tokenBase = "http://127.0.0.1:" + tokenServer.address().port;

  writeFileSync(
    join(workspace, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        remote: {
          url: base + "/mcp",
          oauth: { authorizationEndpoint: tokenBase + "/auth", tokenEndpoint: tokenBase + "/token", clientId: "cid" },
        },
      },
    }, null, 2),
    "utf8",
  );
  // 先放一份快过期（但还没到 30 秒窗口）的旧 token，让首个请求被 401
  await OAUTH.saveTokens("remote", { access_token: "stale-token", refresh_token: "r", expires_in: 600, token_endpoint: tokenBase + "/token" });

  MCP.initMcpRuntime(workspace);
  const listed = await MCP.handleMcpPayload({ action: "servers" });
  const entry = listed.servers.find((s) => s.name === "remote");
  assert.equal(entry.ok, true, entry.error);
  assert.equal(entry.tools.length, 1);
  assert.equal(entry.tools[0].rawName, "echo");

  const called = await MCP.handleMcpPayload({ action: "call", server: "remote", tool: "echo", arguments: { text: "hi" } });
  assert.equal(called.ok, true);
  assert.equal(called.text, "hi");
  assert.ok(tokensSeen.some((t) => t === "Bearer stale-token"), "第一次应带旧 token 被 401");
  assert.ok(tokensSeen.some((t) => t === "Bearer fresh-token"), "401 后应换新 token 重试");

  const status = await MCP.handleMcpPayload({ action: "oauth/status" });
  assert.equal(status.servers[0].hasCredentials, true);

  await MCP.handleMcpPayload({ action: "oauth/logout", server: "remote" });
  assert.equal(await OAUTH.readTokens("remote"), null);
  MCP.shutdownMcp();
  server.close();
  tokenServer.close();
});
