/**
 * MCP OAuth 凭据管理（P1-4 收尾）。
 *
 * 照 Codex `login/` 的做法：授权码 + PKCE(S256) + loopback 回调（http://127.0.0.1:<port>/auth/callback）
 * + state 校验 + 到期刷新（提前 30 秒）+ 被 401 拒绝时换新 token 重试一次。
 * 凭据落在 <userData>/mcp-auth/<server>.json，只授读写权限给当前用户（chmod 600，失败不致命）。
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

/** 提前量：token 还剩这么少秒数就当过期，避免"刚发出去就过期" */
export const REFRESH_SKEW_SECONDS = 30;

let authDir = "";

/** 初始化凭据目录（由 main.mjs 注入 userData 下的目录） */
export function initMcpOAuth(dir) {
  authDir = dir;
}

function tokenFile(server) {
  return join(authDir, String(server).replace(/[^A-Za-z0-9._-]/g, "_") + ".json");
}

function base64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE：verifier 43 字节随机，challenge = base64url(sha256(verifier)) */
export function createPkcePair() {
  const verifier = base64url(randomBytes(43));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

export function generateState() {
  return base64url(randomBytes(24));
}

/** Codex 允许 state 后带附加元数据（如 onboarding 参数），所以按前缀匹配 */
export function stateMatches(expected, actual) {
  if (!expected || !actual) return false;
  return String(actual) === expected || String(actual).startsWith(expected + ".");
}

export async function readTokens(server) {
  try {
    const raw = await readFile(tokenFile(server), "utf8");
    const data = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!data || typeof data.access_token !== "string") return null;
    return data;
  } catch {
    return null;
  }
}

export async function saveTokens(server, tokens) {
  await mkdir(authDir, { recursive: true });
  const payload = {
    access_token: tokens.access_token,
    ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
    ...(tokens.token_type ? { token_type: tokens.token_type } : {}),
    ...(typeof tokens.expires_in === "number" ? { expires_at: Date.now() + tokens.expires_in * 1000 } : {}),
    ...(tokens.scope ? { scope: tokens.scope } : {}),
    token_endpoint: tokens.token_endpoint,
    updated_at: Date.now(),
  };
  const file = tokenFile(server);
  await writeFile(file, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
  return payload;
}

export async function clearTokens(server) {
  await rm(tokenFile(server), { force: true });
}

/** 是否该刷新：有 expires_at 且剩余小于提前量；没有 expires_at 的按"不主动刷新"处理 */
export function needsRefresh(tokens, now = Date.now()) {
  if (!tokens) return false;
  if (typeof tokens.expires_at !== "number") return false;
  return tokens.expires_at - now <= REFRESH_SKEW_SECONDS * 1000;
}

async function postForm(url, params, fetchImpl) {
  const body = new URLSearchParams(params).toString();
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error("OAuth 端点返回 " + res.status + "：" + text.slice(0, 200));
  let json;
  try { json = JSON.parse(text); } catch { throw new Error("OAuth 端点返回的不是 JSON：" + text.slice(0, 120)); }
  return json;
}

/** 授权码换 token */
export async function exchangeCode({ tokenEndpoint, code, verifier, redirectUri, clientId, resource }, fetchImpl = fetch) {
  const params = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  };
  if (resource) params.resource = resource;
  return await postForm(tokenEndpoint, params, fetchImpl);
}

/** 刷新 token */
export async function refreshToken({ tokenEndpoint, refreshTokenValue, clientId, resource }, fetchImpl = fetch) {
  const params = {
    grant_type: "refresh_token",
    refresh_token: refreshTokenValue,
    client_id: clientId,
  };
  if (resource) params.resource = resource;
  return await postForm(tokenEndpoint, params, fetchImpl);
}

function oauthConfig(cfg) {
  const oauth = (cfg && cfg.oauth) || {};
  const tokenEndpoint = String(oauth.tokenEndpoint || oauth.token_endpoint || "");
  const authorizationEndpoint = String(oauth.authorizationEndpoint || oauth.authorization_endpoint || "");
  const clientId = String(oauth.clientId || oauth.client_id || "");
  if (!tokenEndpoint || !authorizationEndpoint || !clientId) {
    throw new Error("MCP OAuth 配置不全：需要 authorizationEndpoint / tokenEndpoint / clientId");
  }
  return {
    tokenEndpoint,
    authorizationEndpoint,
    clientId,
    scope: String(oauth.scope || ""),
    resource: String(oauth.resource || ""),
    redirectPort: Number(oauth.redirectPort || oauth.redirect_port || 0),
    extraParams: oauth.extraParams && typeof oauth.extraParams === "object" ? oauth.extraParams : {},
  };
}

/** 解析 401 的 WWW-Authenticate（Bearer resource_metadata="...", scope="...", error="..."） */
export function parseWwwAuthenticate(header) {
  const text = String(header || "");
  const out = { scheme: "", params: {} };
  const schemeMatch = text.match(/^(\w+)\s*/);
  if (schemeMatch) out.scheme = schemeMatch[1].toLowerCase();
  for (const m of text.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|([^\s,]+))/g)) {
    out.params[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3];
  }
  return out;
}

/** RFC 8414 里 well-known 要插在 issuer 的 path 之前：https://h/p → https://h/.well-known/oauth-authorization-server/p */
function wellKnownUrl(base, suffix) {
  const url = new URL(base);
  const path = url.pathname.replace(/\/$/, "");
  url.pathname = "/.well-known/" + suffix + path;
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function getJson(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error("发现端点 " + url + " 返回 " + res.status);
  return await res.json();
}

/**
 * OAuth 自动发现（照 Codex 的 oauth_discovery）：
 * 1) 优先用 401 里给的 resource_metadata；
 * 2) 否则取 <resource>/.well-known/oauth-protected-resource，读 authorization_servers[0]；
 * 3) 再取 issuer 的 /.well-known/oauth-authorization-server 拿端点。
 */
export async function discoverAuthorizationServer({ resourceUrl, resourceMetadataUrl, fetchImpl = fetch }) {
  let metadata;
  if (resourceMetadataUrl) {
    metadata = await getJson(resourceMetadataUrl, fetchImpl);
  } else {
    if (!resourceUrl) throw new Error("缺少 resourceUrl，无法发现授权服务器");
    try {
      metadata = await getJson(wellKnownUrl(resourceUrl, "oauth-protected-resource"), fetchImpl);
    } catch {
      metadata = null;
    }
  }
  let issuer = metadata && Array.isArray(metadata.authorization_servers) ? metadata.authorization_servers[0] : "";
  if (!issuer && resourceUrl) issuer = new URL(resourceUrl).origin;
  const serverMeta = await getJson(wellKnownUrl(issuer, "oauth-authorization-server"), fetchImpl);
  const authorizationEndpoint = String(serverMeta.authorization_endpoint || "");
  const tokenEndpoint = String(serverMeta.token_endpoint || "");
  if (!authorizationEndpoint || !tokenEndpoint) {
    throw new Error("授权服务器元数据里缺 authorization_endpoint / token_endpoint");
  }
  return {
    issuer,
    authorizationEndpoint,
    tokenEndpoint,
    registrationEndpoint: String(serverMeta.registration_endpoint || ""),
    scopesSupported: Array.isArray(serverMeta.scopes_supported) ? serverMeta.scopes_supported : [],
    resource: String((metadata && metadata.resource) || resourceUrl || ""),
  };
}

/** 动态注册公开客户端（Codex 也是这条路：用户不用手填 client_id） */
export async function registerClient({ registrationEndpoint, redirectUri, clientName = "xiaoluo-mcp" }, fetchImpl = fetch) {
  if (!registrationEndpoint) throw new Error("授权服务器不支持动态注册（没有 registration_endpoint）");
  const res = await fetchImpl(registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error("客户端注册失败 " + res.status + "：" + text.slice(0, 200));
  let json;
  try { json = JSON.parse(text); } catch { throw new Error("注册响应不是 JSON"); }
  if (!json.client_id) throw new Error("注册响应缺 client_id");
  return { clientId: String(json.client_id), clientSecret: json.client_secret ? String(json.client_secret) : "" };
}

/** 已注册客户端缓存：<authDir>/clients.json，按 server 记一份，免得每次授权都重新注册 */
async function readClientCache() {
  try {
    return JSON.parse((await readFile(join(authDir, "clients.json"), "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return {};
  }
}

async function writeClientCache(cache) {
  await mkdir(authDir, { recursive: true });
  await writeFile(join(authDir, "clients.json"), JSON.stringify(cache, null, 2), { encoding: "utf8", mode: 0o600 });
}

/**
 * 把用户最少量的配置补全成完整 OAuth 配置：
 * 显式写了 oauth 就用显式（缺 clientId 时自动注册），否则按 url 自动发现 + 注册。
 */
export async function resolveOAuthConfig(server, cfg, { fetchImpl = fetch, redirectUri, clientName, resourceMetadataUrl } = {}) {
  const explicit = cfg && cfg.oauth;
  if (explicit && (explicit.tokenEndpoint || explicit.token_endpoint)) {
    const base = oauthConfig(cfg);
    if (base.clientId) return base;
    // 显式端点了但没有 client_id：有 registrationEndpoint 就注册，否则报错
    const reg = String(explicit.registrationEndpoint || explicit.registration_endpoint || "");
    const redirect = redirectUri || "http://127.0.0.1:" + (base.redirectPort || 33333) + "/auth/callback";
    const registered = await registerClient({ registrationEndpoint: reg, redirectUri: redirect, clientName }, fetchImpl);
    const cache = await readClientCache();
    cache[server] = { ...registered, tokenEndpoint: base.tokenEndpoint };
    await writeClientCache(cache);
    return { ...base, clientId: registered.clientId };
  }
  if (!cfg || !cfg.url) throw new Error("MCP 服务器既没有 oauth 配置也没有 url，无法发现授权");
  const discovered = await discoverAuthorizationServer({ resourceUrl: cfg.url, resourceMetadataUrl, fetchImpl });
  const cache = await readClientCache();
  const cached = cache[server];
  const redirect = redirectUri || "http://127.0.0.1:33333/auth/callback";
  let clientId = cached && cached.clientId ? String(cached.clientId) : "";
  if (!clientId) {
    const registered = await registerClient({
      registrationEndpoint: discovered.registrationEndpoint,
      redirectUri: redirect,
      clientName,
    }, fetchImpl);
    clientId = registered.clientId;
    cache[server] = { clientId, ...(registered.clientSecret ? { clientSecret: registered.clientSecret } : {}) };
    await writeClientCache(cache);
  }
  return {
    authorizationEndpoint: discovered.authorizationEndpoint,
    tokenEndpoint: discovered.tokenEndpoint,
    clientId,
    scope: discovered.scopesSupported.join(" ") || "",
    resource: discovered.resource,
    redirectPort: 0,
    extraParams: {},
  };
}

/** 取可用 token：过期就刷新；没有凭据就返回 needsAuth（带授权地址，由调用方提示用户打开） */
export async function ensureToken(server, cfg, fetchImpl = fetch) {
  const oauth = oauthConfig(cfg);
  const existing = await readTokens(server);
  if (existing && !needsRefresh(existing)) {
    return { ok: true, token: existing.access_token, refreshed: false };
  }
  if (existing && existing.refresh_token) {
    try {
      const fresh = await refreshToken(
        {
          // 刷新优先用落盘时记下的端点：授权服务器换过端点也能续上
          tokenEndpoint: existing.token_endpoint || oauth.tokenEndpoint,
          refreshTokenValue: existing.refresh_token,
          clientId: oauth.clientId,
          resource: oauth.resource,
        },
        fetchImpl,
      );
      const saved = await saveTokens(server, {
        ...fresh,
        // 有些端点刷新时不回 refresh_token：沿用旧的，不然下次会被踢下线
        refresh_token: fresh.refresh_token || existing.refresh_token,
        token_endpoint: oauth.tokenEndpoint,
      });
      return { ok: true, token: saved.access_token, refreshed: true };
    } catch (error) {
      // 刷新失败不直接报错到底：留 needsAuth，让用户重新授权一次
      return { ok: false, reason: "needs_auth", error: error instanceof Error ? error.message : String(error) };
    }
  }
  return { ok: false, reason: "needs_auth" };
}

/** token 被拒（401）后强制换新一次，照 Codex 的 refresh_on_rejected_token */
export async function refreshRejected(server, cfg, fetchImpl = fetch) {
  const oauth = oauthConfig(cfg);
  const existing = await readTokens(server);
  if (!existing || !existing.refresh_token) return { ok: false, reason: "needs_auth" };
  try {
    const fresh = await refreshToken(
      {
        tokenEndpoint: existing.token_endpoint || oauth.tokenEndpoint,
        refreshTokenValue: existing.refresh_token,
        clientId: oauth.clientId,
        resource: oauth.resource,
      },
      fetchImpl,
    );
    const saved = await saveTokens(server, {
      ...fresh,
      refresh_token: fresh.refresh_token || existing.refresh_token,
      token_endpoint: oauth.tokenEndpoint,
    });
    return { ok: true, token: saved.access_token, refreshed: true };
  } catch (error) {
    return { ok: false, reason: "needs_auth", error: error instanceof Error ? error.message : String(error) };
  }
}

/** 生成授权地址（不启动回调监听，便于"先给用户看链接"的场景） */
export function buildAuthorizeUrl(server, cfg, { redirectUri, state, challenge }) {
  const oauth = oauthConfig(cfg);
  const url = new URL(oauth.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", oauth.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (oauth.scope) url.searchParams.set("scope", oauth.scope);
  if (oauth.resource) url.searchParams.set("resource", oauth.resource);
  for (const [k, v] of Object.entries(oauth.extraParams)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/**
 * 走完一次浏览器授权：起 loopback 回调 → 换 token → 落盘。
 * 返回 { url, done }：url 交给宿主打开浏览器，done 在拿到 token 后 resolve（超时则 reject）。
 */
export async function beginLogin(server, cfg, { timeoutMs = 300_000, fetchImpl = fetch } = {}) {
  const explicitOauth = (cfg && cfg.oauth) || {};
  const preferredPort = Number(explicitOauth.redirectPort || explicitOauth.redirect_port || 0);
  const { verifier, challenge } = createPkcePair();
  const state = generateState();
  let settle;
  const done = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  let finished = false;
  const finish = (fn, value) => {
    if (finished) return;
    finished = true;
    fn(value);
  };
  // 回调要用到的两项，监听起来之后才确定（动态注册依赖真实 redirect_uri）
  let oauth = null;
  let redirectUri = "";

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (!url.pathname.startsWith("/auth/callback")) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
        return;
      }
      const code = url.searchParams.get("code");
      const returned = url.searchParams.get("state");
      const err = url.searchParams.get("error");
      if (err) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("授权被拒绝：" + err);
        finish(settle.reject, new Error("授权被拒绝：" + err));
        return;
      }
      if (!stateMatches(state, returned || "")) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("state 不匹配，已中止");
        finish(settle.reject, new Error("state 不匹配，可能不是本次授权"));
        return;
      }
      if (!code) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("缺少 code");
        finish(settle.reject, new Error("回调缺少 code"));
        return;
      }
      const tokens = await exchangeCode(
        {
          tokenEndpoint: oauth.tokenEndpoint,
          code,
          verifier,
          redirectUri,
          clientId: oauth.clientId,
          resource: oauth.resource,
        },
        fetchImpl,
      );
      await saveTokens(server, { ...tokens, token_endpoint: oauth.tokenEndpoint });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
        "<html><body style=\"font-family:system-ui;padding:40px\"><h2>授权完成</h2><p>可以关闭这个页面回到小逻了。</p></body></html>",
      );
      finish(settle.resolve, { ok: true });
    } catch (e) {
      finish(settle.reject, e instanceof Error ? e : new Error(String(e)));
    }
  });

  const ready = new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(preferredPort, "127.0.0.1", () => {
      const port = httpServer.address().port;
      redirectUri = `http://127.0.0.1:${port}/auth/callback`;
      resolve(redirectUri);
    });
  });

  const cleanup = () => {
    try { httpServer.close(); } catch { /* 已关闭 */ }
    if (timer) clearTimeout(timer);
  };
  const timer = setTimeout(() => {
    finish(settle.reject, new Error("授权超时（" + Math.round(timeoutMs / 1000) + " 秒内没等到回调）"));
  }, timeoutMs);
  // 用 then(cleanup, cleanup) 而不是 finally：finally 会产生一条无人处理的 rejected promise
  done.then(cleanup, cleanup);

  let uri = "";
  try {
    uri = await ready;
    const hasExplicitClient = Boolean(explicitOauth.clientId || explicitOauth.client_id);
    oauth = hasExplicitClient
      ? oauthConfig(cfg)
      : await resolveOAuthConfig(server, cfg, { fetchImpl, redirectUri: uri });
  } catch (error) {
    finish(settle.reject, error instanceof Error ? error : new Error(String(error)));
    cleanup();
    throw error;
  }

  return {
    url: buildAuthorizeUrl(server, { ...cfg, oauth }, { redirectUri: uri, state, challenge }),
    done,
    cancel: () => { finish(settle.reject, new Error("授权已取消")); cleanup(); },
  };
}
