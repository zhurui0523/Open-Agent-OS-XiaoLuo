export interface MysqlRuntimeConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  sslMode: "disabled" | "preferred" | "required";
}

export interface OssRuntimeConfig {
  region: string;
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  endpoint: string | null;
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`服务器环境变量 ${name} 未配置`);
  }
  return value;
}

function port(value: string | undefined) {
  const parsed = Number(value ?? 3306);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error("服务器环境变量 DB_PORT 不是有效端口");
  }
  return parsed;
}

function sslMode(value: string | undefined): MysqlRuntimeConfig["sslMode"] {
  if (value === "disabled" || value === "preferred" || value === "required") {
    return value;
  }
  return "preferred";
}

/**
 * XiaoLuo AI OS is a connected web service. Local development still talks to
 * the remote MySQL and OSS services; there is intentionally no local business
 * data fallback.
 */
export function serverRuntimeConfig() {
  return {
    database: {
      driver: "mysql" as const,
      mysql: {
        host: required("DB_HOST"),
        port: port(process.env.DB_PORT),
        user: required("DB_USER"),
        password: required("DB_PASSWORD"),
        database: required("DB_NAME"),
        sslMode: sslMode(process.env.DB_SSL_MODE),
      } satisfies MysqlRuntimeConfig,
    },
    storage: {
      driver: "oss" as const,
      oss: {
        region: required("OSS_REGION"),
        accessKeyId: required("OSS_ACCESS_KEY_ID"),
        accessKeySecret: required("OSS_ACCESS_KEY_SECRET"),
        bucket: required("OSS_BUCKET"),
        endpoint: process.env.OSS_ENDPOINT?.trim() || null,
      } satisfies OssRuntimeConfig,
    },
  } as const;
}

export function redactedRuntimeSummary() {
  const config = serverRuntimeConfig();
  return {
    databaseDriver: config.database.driver,
    storageDriver: config.storage.driver,
    mysqlConfigured: true,
    ossConfigured: true,
    mysqlHost: config.database.mysql.host,
    mysqlDatabase: config.database.mysql.database,
    ossRegion: config.storage.oss.region,
    ossBucket: config.storage.oss.bucket,
  };
}
