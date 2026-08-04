import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

function readEnvValue(filePath, key) {
  if (!existsSync(filePath)) return "";
  const prefix = `${key}=`;
  const line = readFileSync(filePath, "utf8")
    .split(/\r?\n/u)
    .find((entry) => entry.trimStart().startsWith(prefix));
  if (!line) return "";
  const value = line.trimStart().slice(prefix.length).trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

// Keep cloud credentials in the ignored .env.local file, but make the local
// desktop runtime use its project-scoped MySQL data. Existing environment
// variables are loaded first so OSS credentials never need to be duplicated.
if (existsSync(".env.local")) {
  process.loadEnvFile(".env.local");
}

// The project-scoped MySQL data was encrypted with the local-development
// secret key. Keep that key authoritative for the hybrid desktop runtime so a
// restart cannot silently switch to a different .env.local key and make every
// stored API credential unreadable.
const localDevelopmentSecretKey = readEnvValue(
  ".env.local-dev",
  "SECRET_ENCRYPTION_KEY",
);
if (!localDevelopmentSecretKey) {
  throw new Error(
    ".env.local-dev 缺少 SECRET_ENCRYPTION_KEY；请先运行本地环境配置脚本，不能用数据库密码代替模型密钥加密",
  );
}
process.env.SECRET_ENCRYPTION_KEY = localDevelopmentSecretKey;

const localMysqlPort = process.env.LOCAL_MYSQL_PORT?.trim() || "3306";
const localMysqlUser = process.env.LOCAL_MYSQL_USER?.trim() || "xiaoluo_local";
const localMysqlPassword =
  process.env.LOCAL_MYSQL_PASSWORD?.trim() || "XiaoLuoLocal_88886666";
const localMysqlDatabase =
  process.env.LOCAL_MYSQL_DATABASE?.trim() || "xiaoluo_intent_os";

Object.assign(process.env, {
  DB_HOST: "127.0.0.1",
  DB_PORT: localMysqlPort,
  DB_USER: localMysqlUser,
  DB_PASSWORD: localMysqlPassword,
  DB_NAME: localMysqlDatabase,
  DB_SSL: "false",
  DB_SSL_MODE: "disabled",
  DB_SSL_CA: "",
  DB_SSL_CA_BASE64: "",
  DATABASE_URL: `mysql://${encodeURIComponent(localMysqlUser)}:${encodeURIComponent(localMysqlPassword)}@127.0.0.1:${localMysqlPort}/${encodeURIComponent(localMysqlDatabase)}`,
  STORAGE_PROVIDER: "oss",
  STORAGE_DRIVER: "oss",
  FILE_STORAGE_PROVIDER: "oss",
  FILE_STORAGE_DRIVER: "oss",
});
