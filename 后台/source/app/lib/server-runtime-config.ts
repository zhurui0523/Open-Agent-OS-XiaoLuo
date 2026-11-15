export interface MysqlRuntimeConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  sslMode: "disabled" | "preferred" | "required";
  sslCa: string | null;
}

export interface OssRuntimeConfig {
  region: string;
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  endpoint: string | null;
}

export interface LocalStorageRuntimeConfig {
  root: string;
}

export interface RuntimeServiceReadiness {
  sms: {
    provider: string;
    configured: boolean;
    missing: string[];
  };
  scheduler: {
    configured: boolean;
  };
  isolatedWorker: {
    configured: boolean;
    endpointOrigin: string | null;
  };
  packageTrust: {
    signaturesRequired: boolean;
  };
}

/** MYSQL-PIVOT 显式本地部署：内置服务随附 runtime.env（本地 MySQL + 远程 OSS），
 * production 构建下放宽仅限云端部署的 TLS / 本地存储守卫 */
function hasRuntimeEnv() {
  return Boolean(process.env.XIAOLUO_RUNTIME_ENV?.trim());
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
  const mode =
    value === "disabled" || value === "preferred" || value === "required"
      ? value
      : process.env.NODE_ENV === "production"
        ? "required"
        : "preferred";
  if (
    process.env.NODE_ENV === "production" &&
    mode !== "required" &&
    !hasRuntimeEnv()
  ) {
    throw new Error("生产环境必须配置 DB_SSL_MODE=required");
  }
  return mode;
}

function mysqlSslCa(value: string | undefined) {
  const encoded = value?.trim();
  if (!encoded) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(encoded)) {
    throw new Error("DB_SSL_CA_BASE64 不是有效的 Base64");
  }
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const pem = new TextDecoder().decode(bytes);
    if (
      !pem.includes("-----BEGIN CERTIFICATE-----") ||
      !pem.includes("-----END CERTIFICATE-----")
    ) {
      throw new Error("missing PEM certificate markers");
    }
    return pem;
  } catch {
    throw new Error("DB_SSL_CA_BASE64 不是有效的 PEM 证书链");
  }
}

function storageDriver() {
  const driver =
    process.env.STORAGE_DRIVER?.trim().toLowerCase() || "oss";
  if (driver !== "oss" && driver !== "local") {
    throw new Error("STORAGE_DRIVER 只能是 oss 或 local");
  }
  if (
    process.env.NODE_ENV === "production" &&
    driver === "local" &&
    !hasRuntimeEnv()
  ) {
    throw new Error("生产环境不允许使用本地文件存储");
  }
  return driver;
}

export function packageSignaturesRequired() {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.REQUIRE_PACKAGE_SIGNATURES?.trim().toLowerCase() === "true"
  );
}

/**
 * The database remains MySQL-compatible in both modes. Local development uses
 * a project-scoped MySQL process and a project-scoped file directory; cloud
 * deployments switch only the environment values to managed MySQL and OSS.
 */
export function serverRuntimeConfig() {
  const driver = storageDriver();
  const database = {
    driver: "mysql" as const,
    mysql: {
      host: required("DB_HOST"),
      port: port(process.env.DB_PORT),
      user: required("DB_USER"),
      password: required("DB_PASSWORD"),
      database: required("DB_NAME"),
      sslMode: sslMode(process.env.DB_SSL_MODE),
      sslCa: mysqlSslCa(process.env.DB_SSL_CA_BASE64),
    } satisfies MysqlRuntimeConfig,
  };

  if (driver === "local") {
    return {
      database,
      storage: {
        driver: "local" as const,
        local: {
          root:
            process.env.LOCAL_STORAGE_ROOT?.trim() ||
            ".local-data/storage",
        } satisfies LocalStorageRuntimeConfig,
      },
    };
  }

  return {
    database,
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
  };
}

export function redactedRuntimeSummary() {
  const config = serverRuntimeConfig();
  const db = config.database;
  return {
    databaseDriver: db.driver,
    storageDriver: config.storage.driver,
    mysqlConfigured: db.driver === "mysql",
    ossConfigured: config.storage.driver === "oss",
    localStorageConfigured: config.storage.driver === "local",
    ...(db.driver === "mysql"
      ? { mysqlHost: db.mysql.host, mysqlDatabase: db.mysql.database }
      : {}),
    ...(config.storage.driver === "oss"
      ? {
          ossRegion: config.storage.oss.region,
          ossBucket: config.storage.oss.bucket,
        }
      : {
          localStorageRoot: config.storage.local.root,
        }),
  };
}

function configured(name: string) {
  return Boolean(process.env[name]?.trim());
}

function safeOrigin(value: string | undefined) {
  if (!value?.trim()) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function runtimeServiceReadiness(): RuntimeServiceReadiness {
  const smsProvider =
    process.env.SMS_PROVIDER?.trim().toLowerCase() ||
    (process.env.NODE_ENV === "production" ? "aliyun" : "development");
  const smsRequirements =
    smsProvider === "aliyun"
      ? [
          "ALIYUN_SMS_ACCESS_KEY_ID",
          "ALIYUN_SMS_ACCESS_KEY_SECRET",
          "ALIYUN_SMS_SIGN_NAME",
        ]
      : [];
  const hasSmsTemplate =
    configured("ALIYUN_SMS_TEMPLATE_CODE") ||
    (configured("ALIYUN_SMS_REGISTER_TEMPLATE_CODE") &&
      configured("ALIYUN_SMS_PASSWORD_RESET_TEMPLATE_CODE"));
  const smsMissing = smsRequirements.filter((name) => !configured(name));
  if (smsProvider === "aliyun" && !hasSmsTemplate) {
    smsMissing.push("ALIYUN_SMS_TEMPLATE_CODE");
  }

  const isolatedEndpoint = process.env.ISOLATED_WORKER_ENDPOINT?.trim();
  return {
    sms: {
      provider: smsProvider,
      configured:
        smsProvider === "development"
          ? process.env.NODE_ENV !== "production"
          : smsProvider === "aliyun" && smsMissing.length === 0,
      missing: smsMissing,
    },
    scheduler: {
      configured: configured("RUNTIME_WORKER_TOKEN"),
    },
    isolatedWorker: {
      configured:
        Boolean(safeOrigin(isolatedEndpoint)) &&
        configured("ISOLATED_WORKER_TOKEN"),
      endpointOrigin: safeOrigin(isolatedEndpoint),
    },
    packageTrust: {
      signaturesRequired: packageSignaturesRequired(),
    },
  };
}
