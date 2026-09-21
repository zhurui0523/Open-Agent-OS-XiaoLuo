import type { RowDataPacket } from "mysql2/promise";
import { mysqlExecute, mysqlRows } from "./mysql";
import { ensureUserHome } from "./workspace-store";

const ACCESS_COOKIE = "xiaoluo_access";
const REFRESH_COOKIE = "xiaoluo_refresh";
const LEGACY_SESSION_COOKIE = "xiaoluo_session";
const ACCESS_TOKEN_SECONDS = 15 * 60;
const DEFAULT_REFRESH_DAYS = 30;
const PASSWORD_ITERATIONS = 310_000;

export interface AuthUser {
  id: string;
  email: string;
  username: string;
  displayName: string;
  phoneLast4: string | null;
  platformRole: "system_admin" | "user";
}

interface UserRow extends RowDataPacket, AuthUser {
  passwordHash: string;
  status: "active" | "disabled";
}

interface SessionUserRow extends RowDataPacket, AuthUser {
  sessionId: string;
  refreshExpiresAt: string;
}

interface SecuritySettingsRow extends RowDataPacket {
  allowMultipleSessions: number | boolean;
  sessionTtlDays: number;
}

interface AccessTokenPayload {
  v: 2;
  sub: string;
  sid: string;
  iat: number;
  exp: number;
}

export interface AuthTokenPair {
  accessToken: string;
  accessExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
  sessionId: string;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64UrlEncode(value: string | Uint8Array) {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  return bytesToBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlDecode(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  return base64ToBytes(
    value.replaceAll("-", "+").replaceAll("_", "/") + padding,
  );
}

function accessTokenSecret() {
  const configured = process.env.ACCESS_TOKEN_SECRET?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("ACCESS_TOKEN_SECRET 未配置");
  }
  const developmentFallback = process.env.DB_PASSWORD?.trim();
  if (!developmentFallback) {
    throw new Error("ACCESS_TOKEN_SECRET 未配置");
  }
  return `xiaoluo-development-access-token:${developmentFallback}`;
}

async function hmac(value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(accessTokenSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
}

async function issueAccessToken(userId: string, sessionId: string) {
  const now = Math.floor(Date.now() / 1000);
  const payload: AccessTokenPayload = {
    v: 2,
    sub: userId,
    sid: sessionId,
    iat: now,
    exp: now + ACCESS_TOKEN_SECONDS,
  };
  const encoded = base64UrlEncode(JSON.stringify(payload));
  const signature = base64UrlEncode(await hmac(encoded));
  return {
    token: `${encoded}.${signature}`,
    expiresAt: new Date(payload.exp * 1000),
  };
}

async function verifyAccessToken(token: string) {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) return null;
  const expected = base64UrlEncode(await hmac(encoded));
  const actualBytes = new TextEncoder().encode(signature);
  const expectedBytes = new TextEncoder().encode(expected);
  if (actualBytes.length !== expectedBytes.length) return null;
  let difference = 0;
  actualBytes.forEach((byte, index) => {
    difference |= byte ^ expectedBytes[index];
  });
  if (difference !== 0) return null;
  try {
    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(encoded)),
    ) as Partial<AccessTokenPayload>;
    const now = Math.floor(Date.now() / 1000);
    if (
      payload.v !== 2 ||
      typeof payload.sub !== "string" ||
      typeof payload.sid !== "string" ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      payload.exp <= now
    ) {
      return null;
    }
    return payload as AccessTokenPayload;
  } catch {
    return null;
  }
}

export function randomToken(byteLength = 32) {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations: PASSWORD_ITERATIONS,
    },
    key,
    256,
  );
  return [
    "pbkdf2-sha256",
    PASSWORD_ITERATIONS,
    bytesToBase64(salt),
    bytesToBase64(new Uint8Array(bits)),
  ].join("$");
}

export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, iterationsText, saltText, expectedText] =
    encoded.split("$");
  if (
    algorithm !== "pbkdf2-sha256" ||
    !iterationsText ||
    !saltText ||
    !expectedText
  ) {
    return false;
  }
  const iterations = Number(iterationsText);
  if (!Number.isSafeInteger(iterations) || iterations < 100_000) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const actual = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: base64ToBytes(saltText),
        iterations,
      },
      key,
      256,
    ),
  );
  const expected = base64ToBytes(expectedText);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  actual.forEach((byte, index) => {
    difference |= byte ^ expected[index];
  });
  return difference === 0;
}

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get("cookie") ?? "";
  for (const segment of cookie.split(";")) {
    const [key, ...rest] = segment.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function requestIp(request: Request) {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "本地网络"
  )
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 64);
}

function deviceName(userAgent: string) {
  const browser = /Edg\//.test(userAgent)
    ? "Microsoft Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\//.test(userAgent)
        ? "Google Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : "未知浏览器";
  const system = /Windows/.test(userAgent)
    ? "Windows"
    : /Android/.test(userAgent)
      ? "Android"
      : /iPhone|iPad/.test(userAgent)
        ? "iOS / iPadOS"
        : /Mac OS/.test(userAgent)
          ? "macOS"
          : /Linux/.test(userAgent)
            ? "Linux"
            : "未知系统";
  return `${browser} · ${system}`;
}

function authCookie(
  name: string,
  token: string,
  expires: Date,
  request: Request,
) {
  const secure = new URL(request.url).protocol === "https:";
  const maxAge = Math.max(
    0,
    Math.floor((expires.getTime() - Date.now()) / 1000),
  );
  return [
    `${name}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    `Expires=${expires.toUTCString()}`,
    `Max-Age=${maxAge}`,
  ]
    .filter(Boolean)
    .join("; ");
}

function clearCookie(name: string, request: Request) {
  const secure = new URL(request.url).protocol === "https:";
  return [
    `${name}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    "Max-Age=0",
  ]
    .filter(Boolean)
    .join("; ");
}

export function authCookieHeaders(pair: AuthTokenPair, request: Request) {
  const headers = new Headers();
  headers.append(
    "set-cookie",
    authCookie(
      ACCESS_COOKIE,
      pair.accessToken,
      pair.accessExpiresAt,
      request,
    ),
  );
  headers.append(
    "set-cookie",
    authCookie(
      REFRESH_COOKIE,
      pair.refreshToken,
      pair.refreshExpiresAt,
      request,
    ),
  );
  headers.append("set-cookie", clearCookie(LEGACY_SESSION_COOKIE, request));
  return headers;
}

export function clearAuthCookieHeaders(request: Request) {
  const headers = new Headers();
  for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, LEGACY_SESSION_COOKIE]) {
    headers.append("set-cookie", clearCookie(name, request));
  }
  return headers;
}

function validRefreshDays(value: number | undefined) {
  return value && [7, 30, 90].includes(value)
    ? value
    : DEFAULT_REFRESH_DAYS;
}

async function securitySettings(userId: string) {
  const [security] = await mysqlRows<SecuritySettingsRow>(
    `SELECT
       allow_multiple_sessions AS allowMultipleSessions,
       session_ttl_days AS sessionTtlDays
     FROM xiaoluo_v2_user_security_settings
     WHERE user_id = ?
     LIMIT 1`,
    [userId],
  );
  return {
    allowMultipleSessions: security
      ? Boolean(security.allowMultipleSessions)
      : true,
    refreshDays: validRefreshDays(Number(security?.sessionTtlDays)),
  };
}

async function makeTokenPair(
  userId: string,
  sessionId: string,
  refreshExpiresAt: Date,
) {
  const access = await issueAccessToken(userId, sessionId);
  return {
    accessToken: access.token,
    accessExpiresAt: access.expiresAt,
    refreshToken: randomToken(48),
    refreshExpiresAt,
    sessionId,
  } satisfies AuthTokenPair;
}

export async function createAuthSession(userId: string, request: Request) {
  const security = await securitySettings(userId);
  if (!security.allowMultipleSessions) {
    await mysqlExecute(
      "DELETE FROM xiaoluo_v2_auth_sessions WHERE user_id = ?",
      [userId],
    );
  }
  const sessionId = crypto.randomUUID();
  const refreshExpiresAt = new Date(
    Date.now() + security.refreshDays * 24 * 60 * 60 * 1000,
  );
  const pair = await makeTokenPair(userId, sessionId, refreshExpiresAt);
  const refreshHash = await sha256(pair.refreshToken);
  const userAgent = (request.headers.get("user-agent") ?? "未知设备")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 500);
  await mysqlExecute(
    `INSERT INTO xiaoluo_v2_auth_sessions
      (
        id, user_id, token_hash, expires_at,
        refresh_token_hash, refresh_expires_at, refresh_rotated_at,
        device_name, user_agent, ip_address
      )
     VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3), ?, ?, ?)`,
    [
      sessionId,
      userId,
      refreshHash,
      refreshExpiresAt,
      refreshHash,
      refreshExpiresAt,
      deviceName(userAgent),
      userAgent,
      requestIp(request),
    ],
  );
  return pair;
}

function publicUser(row: SessionUserRow | UserRow): AuthUser {
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    displayName: row.displayName,
    phoneLast4: row.phoneLast4,
    platformRole: row.platformRole,
  };
}

async function userForAccessPayload(payload: AccessTokenPayload) {
  const [row] = await mysqlRows<SessionUserRow>(
    `SELECT
       u.id,
       u.email,
       u.username,
       u.display_name AS displayName,
       u.phone_last4 AS phoneLast4,
       u.platform_role AS platformRole,
       s.id AS sessionId,
       COALESCE(s.refresh_expires_at, s.expires_at) AS refreshExpiresAt
     FROM xiaoluo_v2_auth_sessions s
     INNER JOIN xiaoluo_v2_users u ON u.id = s.user_id
     WHERE s.id = ?
       AND s.user_id = ?
       AND COALESCE(s.refresh_expires_at, s.expires_at) > CURRENT_TIMESTAMP(3)
       AND u.status = 'active'
     LIMIT 1`,
    [payload.sid, payload.sub],
  );
  if (!row) return null;
  await mysqlExecute(
    `UPDATE xiaoluo_v2_auth_sessions
     SET last_seen_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?`,
    [payload.sid],
  ).catch(() => undefined);
  return row;
}

async function accessPayload(request: Request) {
  const token = cookieValue(request, ACCESS_COOKIE);
  return token ? verifyAccessToken(token) : null;
}

export async function currentSessionId(request: Request) {
  const payload = await accessPayload(request);
  return payload?.sid ?? null;
}

export async function currentUser(
  request: Request,
): Promise<AuthUser | null> {
  const payload = await accessPayload(request);
  if (!payload) return null;
  const row = await userForAccessPayload(payload);
  return row ? publicUser(row) : null;
}

export async function refreshAuthSession(
  request: Request,
  refreshExpiresAtOverride?: Date,
) {
  const refreshToken = cookieValue(request, REFRESH_COOKIE);
  if (!refreshToken) return null;
  const refreshHash = await sha256(refreshToken);
  const [row] = await mysqlRows<SessionUserRow>(
    `SELECT
       u.id,
       u.email,
       u.username,
       u.display_name AS displayName,
       u.phone_last4 AS phoneLast4,
       u.platform_role AS platformRole,
       s.id AS sessionId,
       s.refresh_expires_at AS refreshExpiresAt
     FROM xiaoluo_v2_auth_sessions s
     INNER JOIN xiaoluo_v2_users u ON u.id = s.user_id
     WHERE s.refresh_token_hash = ?
       AND s.refresh_expires_at > CURRENT_TIMESTAMP(3)
       AND u.status = 'active'
     LIMIT 1`,
    [refreshHash],
  );
  if (!row) return null;
  const refreshExpiresAt =
    refreshExpiresAtOverride ?? new Date(row.refreshExpiresAt);
  const pair = await makeTokenPair(row.id, row.sessionId, refreshExpiresAt);
  const nextHash = await sha256(pair.refreshToken);
  const result = await mysqlExecute(
    `UPDATE xiaoluo_v2_auth_sessions
     SET token_hash = ?,
         expires_at = ?,
         refresh_token_hash = ?,
         refresh_expires_at = ?,
         refresh_rotated_at = CURRENT_TIMESTAMP(3),
         last_seen_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND refresh_token_hash = ?`,
    [
      nextHash,
      refreshExpiresAt,
      nextHash,
      refreshExpiresAt,
      row.sessionId,
      refreshHash,
    ],
  );
  if (result.affectedRows !== 1) return null;
  return { user: publicUser(row), pair };
}

export async function upgradeLegacySession(request: Request) {
  const legacyToken = cookieValue(request, LEGACY_SESSION_COOKIE);
  if (!legacyToken) return null;
  const legacyHash = await sha256(legacyToken);
  const [row] = await mysqlRows<SessionUserRow>(
    `SELECT
       u.id,
       u.email,
       u.username,
       u.display_name AS displayName,
       u.phone_last4 AS phoneLast4,
       u.platform_role AS platformRole,
       s.id AS sessionId,
       s.expires_at AS refreshExpiresAt
     FROM xiaoluo_v2_auth_sessions s
     INNER JOIN xiaoluo_v2_users u ON u.id = s.user_id
     WHERE s.token_hash = ?
       AND s.refresh_token_hash IS NULL
       AND s.expires_at > CURRENT_TIMESTAMP(3)
       AND u.status = 'active'
     LIMIT 1`,
    [legacyHash],
  );
  if (!row) return null;
  const refreshExpiresAt = new Date(row.refreshExpiresAt);
  const pair = await makeTokenPair(row.id, row.sessionId, refreshExpiresAt);
  const nextHash = await sha256(pair.refreshToken);
  const result = await mysqlExecute(
    `UPDATE xiaoluo_v2_auth_sessions
     SET token_hash = ?,
         refresh_token_hash = ?,
         refresh_expires_at = expires_at,
         refresh_rotated_at = CURRENT_TIMESTAMP(3),
         last_seen_at = CURRENT_TIMESTAMP(3)
     WHERE id = ? AND token_hash = ? AND refresh_token_hash IS NULL`,
    [nextHash, nextHash, row.sessionId, legacyHash],
  );
  if (result.affectedRows !== 1) return null;
  return { user: publicUser(row), pair };
}

export async function destroySession(request: Request) {
  const payload = await accessPayload(request);
  if (payload) {
    await mysqlExecute(
      "DELETE FROM xiaoluo_v2_auth_sessions WHERE id = ? AND user_id = ?",
      [payload.sid, payload.sub],
    );
    return;
  }
  const refreshToken = cookieValue(request, REFRESH_COOKIE);
  if (refreshToken) {
    await mysqlExecute(
      "DELETE FROM xiaoluo_v2_auth_sessions WHERE refresh_token_hash = ?",
      [await sha256(refreshToken)],
    );
    return;
  }
  const legacyToken = cookieValue(request, LEGACY_SESSION_COOKIE);
  if (legacyToken) {
    await mysqlExecute(
      "DELETE FROM xiaoluo_v2_auth_sessions WHERE token_hash = ?",
      [await sha256(legacyToken)],
    );
  }
}

export async function requireUser(request: Request) {
  const user = await currentUser(request);
  if (!user) {
    throw new Response(JSON.stringify({ error: "登录状态已过期，请重新验证" }), {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  return user;
}

export async function requireSystemAdmin(request: Request) {
  const user = await requireUser(request);
  if (user.platformRole !== "system_admin") {
    throw new Response(JSON.stringify({ error: "仅系统管理员可以执行此操作" }), {
      status: 403,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  return user;
}

const userSelect = `SELECT
  id,
  email,
  username,
  display_name AS displayName,
  password_hash AS passwordHash,
  phone_last4 AS phoneLast4,
  platform_role AS platformRole,
  status
FROM xiaoluo_v2_users`;

export async function userByEmail(email: string) {
  const [user] = await mysqlRows<UserRow>(
    `${userSelect} WHERE email = ? LIMIT 1`,
    [email],
  );
  return user ?? null;
}

export async function userByUsername(username: string) {
  const [user] = await mysqlRows<UserRow>(
    `${userSelect} WHERE username = ? LIMIT 1`,
    [username.trim().toLowerCase()],
  );
  return user ?? null;
}

export async function userById(id: string) {
  const [user] = await mysqlRows<UserRow>(
    `${userSelect} WHERE id = ? LIMIT 1`,
    [id],
  );
  return user ?? null;
}

export function normalizeUsername(value: string) {
  const username = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_]{2,31}$/.test(username)) {
    throw new Response(
      JSON.stringify({
        error: "用户名需要 3–32 位，仅支持小写字母、数字和下划线，且必须以字母或数字开头",
      }),
      {
        status: 400,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }
  return username;
}

export async function userByLoginIdentifier(identifier: string) {
  const normalized = identifier.trim().toLowerCase();
  const [user] = await mysqlRows<UserRow>(
    `${userSelect} WHERE email = ? OR username = ? LIMIT 1`,
    [normalized, normalized],
  );
  return user ?? null;
}

function dependencyFailure(error: unknown) {
  const signals: Array<{ code: string; message: string }> = [];
  let current = error;

  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (current instanceof Error) {
      const extended = current as Error & {
        code?: unknown;
        cause?: unknown;
      };
      signals.push({
        code: typeof extended.code === "string" ? extended.code : "",
        message: extended.message,
      });
      current = extended.cause;
      continue;
    }
    if (typeof current === "object") {
      const record = current as Record<string, unknown>;
      signals.push({
        code: typeof record.code === "string" ? record.code : "",
        message: typeof record.message === "string" ? record.message : "",
      });
      current = record.cause;
      continue;
    }
    break;
  }

  const combined = signals
    .map(({ code, message }) => `${code} ${message}`)
    .join(" ")
    .toLowerCase();
  if (
    combined.includes("handshake_no_ssl_support") ||
    combined.includes("does not support secure connection")
  ) {
    return {
      code: "DATABASE_TLS_REQUIRED",
      developmentMessage:
        "MySQL 服务未启用 TLS，请先在 RDS 控制台开启 SSL/TLS 后重试。",
    };
  }
  if (
    combined.includes("proxy request failed") ||
    combined.includes("cannot connect to the specified address") ||
    combined.includes("econnrefused") ||
    combined.includes("etimedout") ||
    combined.includes("enotfound") ||
    combined.includes("protocol_connection_lost")
  ) {
    return {
      code: "DEPENDENCY_UNAVAILABLE",
      developmentMessage: "依赖服务连接失败，请检查网络、MySQL 与 OSS 配置。",
    };
  }
  return null;
}

export function jsonError(error: unknown, fallback: string) {
  if (error instanceof Response) return error;
  const dependency = dependencyFailure(error);
  if (dependency) {
    return Response.json(
      {
        error:
          process.env.NODE_ENV === "production"
            ? "服务暂不可用，请稍后重试"
            : dependency.developmentMessage,
        code: dependency.code,
      },
      { status: 503 },
    );
  }
  const message =
    process.env.NODE_ENV === "production"
      ? fallback
      : error instanceof Error
        ? error.message
        : fallback;
  return Response.json({ error: message }, { status: 500 });
}
