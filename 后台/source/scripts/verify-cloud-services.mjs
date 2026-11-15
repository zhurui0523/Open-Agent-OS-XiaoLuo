import OSS from "ali-oss";
import mysql from "mysql2/promise";
import { mysqlSslOptions } from "./mysql-tls.mjs";

process.loadEnvFile(".env.local");

const requiredNames = [
  "DB_HOST",
  "DB_USER",
  "DB_PASSWORD",
  "DB_NAME",
  "OSS_REGION",
  "OSS_ACCESS_KEY_ID",
  "OSS_ACCESS_KEY_SECRET",
  "OSS_BUCKET",
];

const missing = requiredNames.filter((name) => !process.env[name]?.trim());
if (missing.length) {
  console.error(`缺少服务器环境变量：${missing.join(", ")}`);
  process.exit(1);
}

function safeError(error) {
  if (!error || typeof error !== "object") return "未知错误";
  const code = "code" in error ? String(error.code) : "UNKNOWN";
  const message = "message" in error ? String(error.message) : "连接失败";
  const secrets = [
    process.env.DB_PASSWORD,
    process.env.OSS_ACCESS_KEY_ID,
    process.env.OSS_ACCESS_KEY_SECRET,
  ].filter(Boolean);
  return `${code}: ${secrets.reduce(
    (value, secret) => value.replaceAll(secret, "[REDACTED]"),
    message,
  )}`;
}

let failed = false;
let connection;

try {
  connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    charset: "utf8mb4",
    connectTimeout: 10_000,
    ssl: mysqlSslOptions(),
  });
  await connection.query("SELECT 1 AS ok");
  console.log("MySQL：连接成功，查询正常。");
  const tlsSocket = connection.connection?.stream;
  if (typeof tlsSocket?.getPeerCertificate === "function") {
    const peer = tlsSocket.getPeerCertificate();
    const cipher = tlsSocket.getCipher?.();
    console.log(
      `MySQL TLS：${tlsSocket.getProtocol?.() ?? "unknown"} / ${cipher?.name ?? "unknown"} / ${peer?.issuer?.CN ?? "unknown issuer"}`,
    );
  }
} catch (error) {
  failed = true;
  console.error(`MySQL：连接失败（${safeError(error)}）。`);
} finally {
  await connection?.end().catch(() => undefined);
}

try {
  const client = new OSS({
    region: process.env.OSS_REGION,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET,
    endpoint: process.env.OSS_ENDPOINT?.trim() || undefined,
    secure: true,
    timeout: 10_000,
  });
  await client.getBucketInfo(process.env.OSS_BUCKET);
  console.log("阿里云 OSS：连接成功，Bucket 可访问。");
} catch (error) {
  failed = true;
  console.error(`阿里云 OSS：连接失败（${safeError(error)}）。`);
}

if (failed) process.exitCode = 1;
