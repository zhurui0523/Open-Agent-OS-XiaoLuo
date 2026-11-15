import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { mysqlExecute, mysqlRows } from "./mysql";
import { sendVerificationSms } from "./sms";

export type PhoneChallengePurpose =
  | "register"
  | "password_reset"
  | "phone_change";

interface ChallengeRow extends RowDataPacket {
  id: string;
  codeHash: string;
  attempts: number;
  maxAttempts: number;
}

interface CountRow extends RowDataPacket {
  total: number;
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function secret(name: "PHONE_LOOKUP_KEY" | "OTP_HASH_KEY") {
  const configured = process.env[name]?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV !== "production" && process.env.DB_PASSWORD) {
    return `${name}:${process.env.DB_PASSWORD}`;
  }
  throw new Error(`${name} 未配置`);
}

async function hmacHex(value: string, keyValue: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyValue),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
    ),
  );
}

export async function sha256Hex(value: string) {
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
}

export function normalizePhone(input: string) {
  let value = input.trim().replace(/[\s()-]/g, "");
  if (/^1\d{10}$/.test(value)) value = `+86${value}`;
  if (!/^\+[1-9]\d{7,14}$/.test(value)) {
    throw new Error("请输入有效手机号");
  }
  return value;
}

export async function phoneLookupHash(phone: string) {
  return hmacHex(normalizePhone(phone), secret("PHONE_LOOKUP_KEY"));
}

function requestIp(request: Request) {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  return String(100_000 + (bytes[0] % 900_000));
}

async function codeHash(challengeId: string, code: string) {
  return hmacHex(`${challengeId}:${code}`, secret("OTP_HASH_KEY"));
}

function timingSafeEqual(first: string, second: string) {
  if (first.length !== second.length) return false;
  let difference = 0;
  for (let index = 0; index < first.length; index += 1) {
    difference |= first.charCodeAt(index) ^ second.charCodeAt(index);
  }
  return difference === 0;
}

export async function requestPhoneChallenge(input: {
  request: Request;
  phone: string;
  purpose: PhoneChallengePurpose;
}) {
  const phone = normalizePhone(input.phone);
  const phoneHash = await phoneLookupHash(phone);
  const ipHash = await sha256Hex(requestIp(input.request));
  const [recentPhone, hourlyPhone, hourlyIp] = await Promise.all([
    mysqlRows<CountRow>(
      `SELECT COUNT(*) AS total
       FROM xiaoluo_v2_auth_challenges
       WHERE phone_hash = ?
         AND created_at > DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 60 SECOND)`,
      [phoneHash],
    ),
    mysqlRows<CountRow>(
      `SELECT COUNT(*) AS total
       FROM xiaoluo_v2_auth_challenges
       WHERE phone_hash = ?
         AND created_at > DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 HOUR)`,
      [phoneHash],
    ),
    mysqlRows<CountRow>(
      `SELECT COUNT(*) AS total
       FROM xiaoluo_v2_auth_challenges
       WHERE request_ip_hash = ?
         AND created_at > DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 HOUR)`,
      [ipHash],
    ),
  ]);
  if (Number(recentPhone[0]?.total ?? 0) >= 1) {
    throw new Response(
      JSON.stringify({ error: "验证码发送过于频繁，请 60 秒后再试" }),
      {
        status: 429,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }
  if (
    Number(hourlyPhone[0]?.total ?? 0) >= 5 ||
    Number(hourlyIp[0]?.total ?? 0) >= 20
  ) {
    throw new Response(
      JSON.stringify({ error: "验证码请求次数过多，请稍后再试" }),
      {
        status: 429,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }

  const id = crypto.randomUUID();
  const code = randomCode();
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  await mysqlExecute(
    `INSERT INTO xiaoluo_v2_auth_challenges
      (id, phone_hash, purpose, code_hash, request_ip_hash, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      id,
      phoneHash,
      input.purpose,
      await codeHash(id, code),
      ipHash,
      expiresAt,
    ],
  );

  try {
    const delivery = await sendVerificationSms({
      phone,
      code,
      purpose: input.purpose,
    });
    return {
      expiresIn: 300,
      retryAfter: 60,
      ...(delivery.developmentCode
        ? { developmentCode: delivery.developmentCode }
        : {}),
    };
  } catch (error) {
    await mysqlExecute(
      "UPDATE xiaoluo_v2_auth_challenges SET consumed_at = CURRENT_TIMESTAMP(3) WHERE id = ?",
      [id],
    );
    throw error;
  }
}

export async function verifyPhoneChallenge(
  connection: PoolConnection,
  input: {
    phone: string;
    code: string;
    purpose: PhoneChallengePurpose;
  },
) {
  const phone = normalizePhone(input.phone);
  const phoneHash = await phoneLookupHash(phone);
  const [rows] = await connection.execute<ChallengeRow[]>(
    `SELECT
       id,
       code_hash AS codeHash,
       attempts,
       max_attempts AS maxAttempts
     FROM xiaoluo_v2_auth_challenges
     WHERE phone_hash = ?
       AND purpose = ?
       AND consumed_at IS NULL
       AND expires_at > CURRENT_TIMESTAMP(3)
     ORDER BY created_at DESC
     LIMIT 1
     FOR UPDATE`,
    [phoneHash, input.purpose],
  );
  const challenge = rows[0];
  if (!challenge || challenge.attempts >= challenge.maxAttempts) {
    throw new Response(
      JSON.stringify({ error: "验证码不正确或已失效" }),
      {
        status: 400,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }
  const actualHash = await codeHash(challenge.id, input.code.trim());
  if (!timingSafeEqual(actualHash, challenge.codeHash)) {
    await connection.execute(
      `UPDATE xiaoluo_v2_auth_challenges
       SET attempts = attempts + 1
       WHERE id = ?`,
      [challenge.id],
    );
    throw new Response(
      JSON.stringify({ error: "验证码不正确或已失效" }),
      {
        status: 400,
        headers: { "content-type": "application/json; charset=utf-8" },
      },
    );
  }
  await connection.execute(
    `UPDATE xiaoluo_v2_auth_challenges
     SET consumed_at = CURRENT_TIMESTAMP(3)
     WHERE id = ?`,
    [challenge.id],
  );
  return {
    normalizedPhone: phone,
    phoneHash,
    phoneLast4: phone.slice(-4),
  };
}
