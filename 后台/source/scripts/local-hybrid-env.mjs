// 本地混合开发环境：本地 MySQL + 云端 OSS 存储。
// 由 scripts/start-local-detached.mjs、start-local-next.mjs 以副作用方式导入（import "./local-hybrid-env.mjs"），
// 在 Node 启动子进程之前把口径钉住，避免「同一个仓库两套 env 各说各话」。
import { existsSync, readFileSync } from "node:fs";

const ENV_FILE = ".env.local-dev";

/** 缺省值：DB 走本机、存储走 OSS（混合），与 app/lib/server-runtime-config.ts 的口径一致 */
const DEFAULTS = {
  DB_HOST: "127.0.0.1",
  DB_PORT: "3306",
  DB_SSL_MODE: "disabled",
  STORAGE_DRIVER: "oss",
  XIAOLUO_MODE: "standalone",
};

function readEnvKeys(file) {
  const keys = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) keys[m[1]] = m[2].replace(/\s+#.*$/, "").trim();
  }
  return keys;
}

if (!existsSync(ENV_FILE)) {
  throw new Error(
    `.env.local-dev 不存在：本地开发需要它提供本机 MySQL 与存储配置。先运行 pnpm local:setup 生成，再从 .env.example 补齐密钥字段。`,
  );
}

const fileKeys = readEnvKeys(ENV_FILE);
const secretKey = process.env.SECRET_ENCRYPTION_KEY || fileKeys.SECRET_ENCRYPTION_KEY;
if (!secretKey) {
  throw new Error(
    `.env.local-dev 缺少 SECRET_ENCRYPTION_KEY：服务端密钥加密（AES-GCM）依赖它，不能留空。生成方式：node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`,
  );
}

for (const [key, value] of Object.entries(DEFAULTS)) {
  if (!process.env[key]) process.env[key] = value;
}

// 本地开发必须真打日志：不设置 XIAOLUO_MODE 的容器/worker 会把错误吞成静默重试
process.env.XIAOLUO_MODE = process.env.XIAOLUO_MODE || DEFAULTS.XIAOLUO_MODE;
