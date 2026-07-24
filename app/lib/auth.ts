import type { RowDataPacket } from "mysql2/promise";
import { mysqlExecute, mysqlRows } from "./mysql";

const SESSION_COOKIE = "xiaoluo_session";
const SESSION_DAYS = 30;
const PASSWORD_ITERATIONS = 310_000;

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  phoneLast4: string | null;
  platformRole: "system_admin" | "user";
}

interface UserRow extends RowDataPacket {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  phoneLast4: string | null;
  platformRole: "system_admin" | "user";
  status: "active" | "disabled";
}

interface SessionUserRow extends RowDataPacket {
  id: string;
  email: string;
  displayName: string;
  phoneLast4: string | null;
  platformRole: "system_admin" | "user";
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

export function randomToken(byteLength = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return bytesToBase64(bytes)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
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

export async function createSession(userId: string) {
  const token = randomToken();
  const tokenHash = await sha256(token);
  const expires = new Date(
    Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000,
  );
  await mysqlExecute(
    `INSERT INTO xiaoluo_v2_auth_sessions
      (id, user_id, token_hash, expires_at)
     VALUES (?, ?, ?, ?)`,
    [crypto.randomUUID(), userId, tokenHash, expires],
  );
  return { token, expires };
}

export function sessionCookie(
  token: string,
  expires: Date,
  request: Request,
) {
  const secure = new URL(request.url).protocol === "https:";
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    `Expires=${expires.toUTCString()}`,
    `Max-Age=${SESSION_DAYS * 24 * 60 * 60}`,
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearSessionCookie(request: Request) {
  const secure = new URL(request.url).protocol === "https:";
  return [
    `${SESSION_COOKIE}=`,
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

export async function destroySession(request: Request) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return;
  await mysqlExecute("DELETE FROM xiaoluo_v2_auth_sessions WHERE token_hash = ?", [
    await sha256(token),
  ]);
}

export async function currentUser(
  request: Request,
): Promise<AuthUser | null> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const rows = await mysqlRows<SessionUserRow>(
    `SELECT
       u.id,
       u.email,
       u.display_name AS displayName,
       u.phone_last4 AS phoneLast4,
       u.platform_role AS platformRole
     FROM xiaoluo_v2_auth_sessions s
     INNER JOIN xiaoluo_v2_users u ON u.id = s.user_id
     WHERE s.token_hash = ?
       AND s.expires_at > CURRENT_TIMESTAMP(3)
       AND u.status = 'active'
     LIMIT 1`,
    [tokenHash],
  );
  if (!rows[0]) return null;
  void mysqlExecute(
    `UPDATE xiaoluo_v2_auth_sessions
     SET last_seen_at = CURRENT_TIMESTAMP(3)
     WHERE token_hash = ?`,
    [tokenHash],
  ).catch(() => undefined);
  return rows[0];
}

export async function requireUser(request: Request) {
  const user = await currentUser(request);
  if (!user) {
    throw new Response(JSON.stringify({ error: "请先登录" }), {
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

export async function userByEmail(email: string) {
  const rows = await mysqlRows<UserRow>(
    `SELECT
       id,
       email,
       display_name AS displayName,
       password_hash AS passwordHash,
       phone_last4 AS phoneLast4,
       platform_role AS platformRole,
       status
     FROM xiaoluo_v2_users
     WHERE email = ?
     LIMIT 1`,
    [email],
  );
  return rows[0] ?? null;
}

export function jsonError(error: unknown, fallback: string) {
  if (error instanceof Response) return error;
  const message =
    process.env.NODE_ENV === "production"
      ? fallback
      : error instanceof Error
        ? error.message
        : fallback;
  return Response.json({ error: message }, { status: 500 });
}
