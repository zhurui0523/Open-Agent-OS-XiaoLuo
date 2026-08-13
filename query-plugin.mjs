import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
const require = createRequire("C:\\Users\\Zh\\Documents\\Codex\\2026-07-22\\new-chat\\package.json");
const mysql = require("mysql2/promise");

const envText = readFileSync("C:\\Users\\Zh\\Documents\\Codex\\2026-07-22\\new-chat\\.env.local", "utf8");
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const ca = Buffer.from(env.DB_SSL_CA_BASE64, "base64").toString("utf8");

const conn = await mysql.createConnection({
  host: env.DB_HOST,
  port: Number(env.DB_PORT),
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  database: env.DB_NAME,
  ssl: { rejectUnauthorized: true, ca },
});
const [tables] = await conn.query("SHOW TABLES LIKE 'xiaoluo_v2_canvas%'");
console.log("canvas tables:", JSON.stringify(tables));
const [nodes] = await conn.execute(
  "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND (table_name LIKE '%node%' OR table_name LIKE '%canvas%')",
);
console.log("node/canvas tables:", JSON.stringify(nodes));
await conn.end();
