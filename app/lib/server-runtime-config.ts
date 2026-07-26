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
  if (process.env.NODE_ENV === "production" && mode !== "required") {
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

export function packageSignaturesRequired() {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.REQUIRE_PACKAGE_SIGNATURES?.trim().toLowerCase() === "true"
  );
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
        sslCa: mysqlSslCa(process.env.DB_SSL_CA_BASE64),
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
