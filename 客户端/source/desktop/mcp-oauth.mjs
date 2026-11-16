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

/**
 * token 端点的重试背压：只重试"可能自己会好"的状态（429/5xx/网络抖动），
 * 4xx（除 408/425/429）= 配置或凭据问题，重试只是把错误拖长。
 * 退避 = 300ms 起指数翻倍 + 抖动，封顶 5 秒；服务器给了 Retry-After 就按它等。
 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_TOKEN_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 300;
const MAX_BACKOFF_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function backoffMs(attempt, retryAfterHeader) {
  const retryAfter = Number(retryAfterHeader);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(MAX_BACKOFF_MS, retryAfter * 1000);
  const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
  return Math.min(MAX_BACKOFF_MS, base + Math.floor(Math.random() * Math.min(200, base / 2)));
}

/**
 * 机密客户端认证：client_secret_basic / client_secret_post。
 * 公共客户端（或没配 secret）两者都不发；secret 只在内存里拼进请求，不落盘。
 */
function authFor(auth) {
  if (!auth || !auth.clientSecret) return { headers: {}, params: {} };
  const method = auth.method === "post" ? "post" : "basic";
  if (method === "post") return { headers: {}, params: { client_id: auth.clientId, client_secret: auth.clientSecret } };
  const basic = Buffer.from(auth.clientId + ":" + auth.clientSecret, "utf8").toString("base64");
  return { headers: { authorization: "Basic " + basic }, params: {} };
}

async function tokenRequest(url, params, fetchImpl, auth, opts = {}) {
  const attempts = Math.max(1, opts.maxAttempts ?? MAX_TOKEN_ATTEMPTS);
  const a = authFor(auth);
  const body = { ...params, ...a.params };
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let res;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...a.headers },
        body: new URLSearchParams(body).toString(),
      });
    } catch (error) {
      lastError = new Error("OAuth 端点网络失败：" + (error instanceof Error ? error.message : String(error)));
      if (attempt === attempts) break;
      await sleep(backoffMs(attempt));
      continue;
    }
    const text = await res.text();
    if (res.ok) {
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error("OAuth 端点返回的不是 JSON：" + text.slice(0, 120));
      }
      return json;
    }
    lastError = new Error("OAuth 端点返回 " + res.status + "：" + text.slice(0, 200));
    if (!RETRYABLE_STATUS.has(res.status) || attempt === attempts) break;
    const retryAfter = res.headers && typeof res.headers.get === "function" ? res.headers.get("retry-after") : null;
    await sleep(backoffMs(attempt, retryAfter));
  }
  throw lastError;
}

async function postForm(url, params, fetchImpl, auth) {
  return tokenRequest(url, params, fetchImpl, auth);
}

/** 授权码换 token */
export async function exchangeCode({ tokenEndpoint, code, verifier, redirectUri, clientId, resource, clientSecret, authMethod }, fetchImpl = fetch) {
  const params = {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  };
  if (resource) params.resource = resource;
  return await postForm(tokenEndpoint, params, fetchImpl, { method: authMethod, clientId, clientSecret });
}

/** 刷新 token */
export async function refreshToken({ tokenEndpoint, refreshTokenValue, clientId, resource, clientSecret, authMethod }, fetchImpl = fetch) {
  const params = {
    grant_type: "refresh_token",
    refresh_token: refreshTokenValue,
    client_id: clientId,
  };
  if (resource) params.resource = resource;
  return await postForm(tokenEndpoint, params, fetchImpl, { method: authMethod, clientId, clientSecret });
}

/** RFC 8693 token-exchange：拿一个 upstream subject token 换资源绑定的 MCP token（Codex 的 EMA 那条） */
export const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";

/** 机器对机器：client_credentials（无人值守，没有 refresh_token，只能重取） */
export async function clientCredentialsToken({ tokenEndpoint, clientId, clientSecret, scope, resource, authMethod }, fetchImpl = fetch) {
  if (!clientId) throw new Error("client_credentials 需要 client_id");
  if (!clientSecret) throw new Error("client_credentials 需要 client_secret（机密客户端）");
  const params = { grant_type: "client_credentials", client_id: clientId };
  if (scope) params.scope = scope;
  if (resource) params.resource = resource;
  return await postForm(tokenEndpoint, params, fetchImpl, { method: authMethod, clientId, clientSecret });
}

export async function exchangeToken(
  {
    tokenEndpoint,
    subjectToken,
    subjectTokenType = "urn:ietf:params:oauth:token-type:access_token",
    requestedTokenType = "urn:ietf:params:oauth:token-type:access_token",
    audience,
    resource,
    scope,
    clientId,
    clientSecret,
    authMethod,
    extraParams,
  },
  fetchImpl = fetch,
) {
  if (!subjectToken) throw new Error("token_exchange 需要 subject_token");
  const params = {
    grant_type: TOKEN_EXCHANGE_GRANT,
    subject_token: subjectToken,
    subject_token_type: subjectTokenType,
    requested_token_type: requestedTokenType,
  };
  if (clientId) params.client_id = clientId;
  if (audience) params.audience = audience;
  if (resource) params.resource = resource;
  if (scope) params.scope = scope;
  for (const [k, v] of Object.entries(extraParams && typeof extraParams === "object" ? extraParams : {})) {
    if (v !== undefined && v !== null) params[k] = String(v);
  }
  return await postForm(tokenEndpoint, params, fetchImpl, { method: authMethod, clientId, clientSecret });
}

function oauthConfig(cfg) {
  const oauth = (cfg && cfg.oauth) || {};
  const tokenEndpoint = String(oauth.tokenEndpoint || oauth.token_endpoint || "");
  const authorizationEndpoint = String(oauth.authorizationEndpoint || oauth.authorization_endpoint || "");
  const clientId = String(oauth.clientId || oauth.client_id || "");
  const clientSecret = String(oauth.clientSecret || oauth.client_secret || "");
  // 机密客户端才需要 key：只配了 secret 没配 id 是配置错，和 Codex 一样直接报错而不是猜
  if (clientSecret && !clientId) throw new Error("MCP OAuth 配了 client_secret 却没有 client_id：请补上 client_id");
  if (clientSecret && !clientSecret.trim()) throw new Error("MCP OAuth 的 client_secret 不能是空字符串");
  const grantRaw = String(oauth.grant || oauth.grantType || oauth.grant_type || "authorization_code").toLowerCase();
  const grant = grantRaw === "client_credentials" ? "client_credentials" : grantRaw === "token_exchange" ? "token_exchange" : "authorization_code";
  // 机器类 grant 不需要 browser 授权端点
  if (grant === "authorization_code" && (!tokenEndpoint || !authorizationEndpoint || !clientId)) {
    throw new Error("MCP OAuth 配置不全：需要 authorizationEndpoint / tokenEndpoint / clientId");
  }
  if (grant !== "authorization_code" && !tokenEndpoint) {
    throw new Error("MCP OAuth 配置不全：grant=" + grant + " 至少需要 tokenEndpoint");
  }
  const authMethodRaw = String(oauth.authMethod || oauth.tokenEndpointAuthMethod || oauth.token_endpoint_auth_method || "").toLowerCase();
  const authMethod = authMethodRaw === "post" || authMethodRaw === "client_secret_post" ? "post" : authMethodRaw === "none" ? "none" : clientSecret ? "basic" : "none";
  return {
    tokenEndpoint,
    authorizationEndpoint,
    clientId,
    clientSecret,
    authMethod,
    grant,
    scope: String(oauth.scope || ""),
    resource: String(oauth.resource || ""),
    redirectPort: Number(oauth.redirectPort || oauth.redirect_port || 0),
    extraParams: oauth.extraParams && typeof oauth.extraParams === "object" ? oauth.extraParams : {},
    subjectToken: String(oauth.subjectToken || oauth.subject_token || ""),
    subjectTokenType: String(oauth.subjectTokenType || oauth.subject_token_type || "urn:ietf:params:oauth:token-type:access_token"),
    audience: String(oauth.audience || ""),
  };
}

/** token_exchange 的 subject token：显式配置优先，其次环境变量（CI / 无人值守用） */
function resolveSubjectToken(oauth) {
  return oauth.subjectToken || process.env.XIAOLUO_MCP_SUBJECT_TOKEN || "";
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
    // 机器类 grant 不需要浏览器授权，也就不需要动态注册 client
    if (base.clientId || base.grant !== "authorization_code") return base;
    // 显式端点了但没有 client_id：有 registrationEndpoint 就注册，否则报错
    const reg = String(explicit.registrationEndpoint || explicit.registration_endpoint || "");
    const redirect = redirectUri || "http://127.0.0.1:" + (base.redirectPort || 33333) + "/auth/callback";
    const registered = await registerClient({ registrationEndpoint: reg, redirectUri: redirect, clientName }, fetchImpl);
    const cache = await readClientCache();
    cache[server + "@" + redirect] = { ...registered, redirectUri: redirect, tokenEndpoint: base.tokenEndpoint };
    await writeClientCache(cache);
    return { ...base, clientId: registered.clientId };
  }
  if (!cfg || !cfg.url) throw new Error("MCP 服务器既没有 oauth 配置也没有 url，无法发现授权");
  const discovered = await discoverAuthorizationServer({ resourceUrl: cfg.url, resourceMetadataUrl, fetchImpl });
  const cache = await readClientCache();
  const redirect = redirectUri || "http://127.0.0.1:33333/auth/callback";
  // 注册出来的 client 被授权服务器绑定在注册时的 redirect_uri 上；回调端口每次可能不同，
  // 所以按 server+回调地址分别缓存，对不上就重新注册（否则真实服务器会拒授权）
  const cacheKey = server + "@" + redirect;
  let clientId = cache[cacheKey] && cache[cacheKey].clientId ? String(cache[cacheKey].clientId) : "";
  if (!clientId) {
    const registered = await registerClient({
      registrationEndpoint: discovered.registrationEndpoint,
      redirectUri: redirect,
      clientName,
    }, fetchImpl);
    clientId = registered.clientId;
    cache[cacheKey] = { clientId, redirectUri: redirect, ...(registered.clientSecret ? { clientSecret: registered.clientSecret } : {}) };
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

/** 机器类 grant（client_credentials / token_exchange）：没有 refresh_token，过期就重新取一次 */
async function fetchMachineToken(server, oauth, fetchImpl) {
  try {
    let fresh;
    if (oauth.grant === "client_credentials") {
      fresh = await clientCredentialsToken(
        {
          tokenEndpoint: oauth.tokenEndpoint,
          clientId: oauth.clientId,
          clientSecret: oauth.clientSecret,
          scope: oauth.scope,
          resource: oauth.resource,
          authMethod: oauth.authMethod,
        },
        fetchImpl,
      );
    } else {
      const subjectToken = resolveSubjectToken(oauth);
      if (!subjectToken) {
        return {
          ok: false,
          reason: "needs_subject_token",
          grant: oauth.grant,
          error: "token_exchange 需要一个 subject token：在 mcp.json 的 oauth.subjectToken 里写，或设环境变量 XIAOLUO_MCP_SUBJECT_TOKEN",
        };
      }
      fresh = await exchangeToken(
        {
          tokenEndpoint: oauth.tokenEndpoint,
          subjectToken,
          subjectTokenType: oauth.subjectTokenType,
          audience: oauth.audience || undefined,
          resource: oauth.resource || undefined,
          scope: oauth.scope || undefined,
          clientId: oauth.clientId || undefined,
          clientSecret: oauth.clientSecret || undefined,
          authMethod: oauth.authMethod,
        },
        fetchImpl,
      );
    }
    const saved = await saveTokens(server, { ...fresh, token_endpoint: oauth.tokenEndpoint, grant: oauth.grant });
    return { ok: true, token: saved.access_token, refreshed: true, grant: oauth.grant };
  } catch (error) {
    return { ok: false, reason: "needs_auth", grant: oauth.grant, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 取可用 token：过期就刷新；没有凭据就返回 needsAuth（带授权地址，由调用方提示用户打开） */
export async function ensureToken(server, cfg, fetchImpl = fetch) {
  const oauth = oauthConfig(cfg);
  const existing = await readTokens(server);
  if (existing && !needsRefresh(existing)) {
    return { ok: true, token: existing.access_token, refreshed: false };
  }
  // 机器类 grant 不走 refresh_token：重取一次就好
  if (oauth.grant !== "authorization_code") return await fetchMachineToken(server, oauth, fetchImpl);
  if (existing && existing.refresh_token) {
    try {
      const fresh = await refreshToken(
        {
          // 刷新优先用落盘时记下的端点：授权服务器换过端点也能续上
          tokenEndpoint: existing.token_endpoint || oauth.tokenEndpoint,
          refreshTokenValue: existing.refresh_token,
          clientId: oauth.clientId,
          resource: oauth.resource,
          clientSecret: oauth.clientSecret,
          authMethod: oauth.authMethod,
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
  if (oauth.grant !== "authorization_code") return await fetchMachineToken(server, oauth, fetchImpl);
  const existing = await readTokens(server);
  if (!existing || !existing.refresh_token) return { ok: false, reason: "needs_auth" };
  try {
    const fresh = await refreshToken(
      {
        tokenEndpoint: existing.token_endpoint || oauth.tokenEndpoint,
        refreshTokenValue: existing.refresh_token,
        clientId: oauth.clientId,
        resource: oauth.resource,
        clientSecret: oauth.clientSecret,
        authMethod: oauth.authMethod,
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
          clientSecret: oauth.clientSecret,
          authMethod: oauth.authMethod,
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
