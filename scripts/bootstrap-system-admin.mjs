import { createHmac, pbkdf2Sync, randomBytes, randomUUID } from "node:crypto";
import mysql from "mysql2/promise";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} 未配置`);
  return value;
}

function normalizePhone(input) {
  let value = input.trim().replace(/[\s()-]/g, "");
  if (/^1\d{10}$/.test(value)) value = `+86${value}`;
  if (!/^\+[1-9]\d{7,14}$/.test(value)) throw new Error("管理员手机号无效");
  return value;
}

function passwordHash(password) {
  if (password.length < 6) throw new Error("管理员密码至少需要 6 个字符");
  const salt = randomBytes(16);
  const derived = pbkdf2Sync(password, salt, 310_000, 32, "sha256");
  return [
    "pbkdf2-sha256",
    "310000",
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

const email = required("SYSTEM_ADMIN_EMAIL").toLowerCase();
const username = required("SYSTEM_ADMIN_USERNAME").toLowerCase();
if (!/^[a-z0-9][a-z0-9_]{2,31}$/.test(username)) {
  throw new Error("SYSTEM_ADMIN_USERNAME 需要 3–32 位小写字母、数字或下划线");
}
const displayName = process.env.SYSTEM_ADMIN_DISPLAY_NAME?.trim() || "系统管理员";
const password = required("SYSTEM_ADMIN_PASSWORD");
const phone = normalizePhone(required("SYSTEM_ADMIN_PHONE"));
const lookupKey =
  process.env.PHONE_LOOKUP_KEY?.trim() ||
  `PHONE_LOOKUP_KEY:${required("DB_PASSWORD")}`;
const phoneHash = createHmac("sha256", lookupKey).update(phone).digest("hex");
const connection = await mysql.createConnection({
  host: required("DB_HOST"),
  port: Number(process.env.DB_PORT || 3306),
  user: required("DB_USER"),
  password: required("DB_PASSWORD"),
  database: required("DB_NAME"),
  ssl:
    process.env.DB_SSL_MODE === "disabled"
      ? undefined
      : { rejectUnauthorized: process.env.DB_SSL_MODE === "required" },
});

try {
  const [admins] = await connection.execute(
    "SELECT id, email FROM xiaoluo_v2_users WHERE platform_role = 'system_admin' LIMIT 2",
  );
  if (admins.length && admins[0].email !== email) {
    throw new Error(`系统中已经存在管理员账号：${admins[0].email}`);
  }
  const [users] = await connection.execute(
    "SELECT id FROM xiaoluo_v2_users WHERE email = ? OR username = ? OR phone_hash = ? LIMIT 1",
    [email, username, phoneHash],
  );
  const id = users[0]?.id || randomUUID();
  if (users.length) {
    await connection.execute(
      `UPDATE xiaoluo_v2_users
       SET email = ?,
           username = ?,
           display_name = ?,
           password_hash = ?,
           phone_hash = ?,
           phone_last4 = ?,
           phone_verified_at = CURRENT_TIMESTAMP(3),
           platform_role = 'system_admin',
           status = 'active',
           password_changed_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?`,
      [email, username, displayName, passwordHash(password), phoneHash, phone.slice(-4), id],
    );
  } else {
    await connection.execute(
      `INSERT INTO xiaoluo_v2_users
        (
          id, email, username, display_name, password_hash, phone_hash, phone_last4,
          phone_verified_at, platform_role, status
        )
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3), 'system_admin', 'active')`,
      [id, email, username, displayName, passwordHash(password), phoneHash, phone.slice(-4)],
    );
  }
  console.log("系统管理员已初始化。");
} finally {
  await connection.end();
}
