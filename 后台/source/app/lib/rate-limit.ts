import type { RowDataPacket } from "mysql2/promise";
import { mysqlExecute, mysqlRows } from "./mysql";

interface BucketRow extends RowDataPacket {
  count: number;
  windowStartedAt: Date | string;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function mysqlDate(value: Date) {
  return value.toISOString().slice(0, 23).replace("T", " ");
}

export function requestClientIp(request: Request) {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  )
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 64);
}

export async function privateRateLimitSubject(value: string) {
  return sha256(value.trim().toLowerCase());
}

export async function enforceRateLimit(input: {
  subject: string;
  route: string;
  max: number;
  windowMs: number;
}) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - input.windowMs);
  const id = await sha256(`${input.subject}\u0000${input.route}`);
  await mysqlExecute(
    `INSERT INTO xiaoluo_v2_rate_limit_buckets
       (id, subject, route, window_started_at, count)
     VALUES (?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE
       count = IF(window_started_at < ?, 1, count + 1),
       window_started_at = IF(window_started_at < ?, VALUES(window_started_at), window_started_at),
       updated_at = CURRENT_TIMESTAMP(3)`,
    [
      id,
      input.subject,
      input.route,
      mysqlDate(now),
      mysqlDate(cutoff),
      mysqlDate(cutoff),
    ],
  );
  const [bucket] = await mysqlRows<BucketRow>(
    `SELECT count, window_started_at AS windowStartedAt
     FROM xiaoluo_v2_rate_limit_buckets
     WHERE id = ?
     LIMIT 1`,
    [id],
  );
  if (!bucket || Number(bucket.count) <= input.max) return;
  const resetAt =
    new Date(bucket.windowStartedAt).getTime() + input.windowMs;
  throw new Response(
    JSON.stringify({
      error: "操作过于频繁，请稍后再试",
      code: "RATE_LIMITED",
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((resetAt - Date.now()) / 1_000),
      ),
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "retry-after": String(
          Math.max(1, Math.ceil((resetAt - Date.now()) / 1_000)),
        ),
      },
    },
  );
}
