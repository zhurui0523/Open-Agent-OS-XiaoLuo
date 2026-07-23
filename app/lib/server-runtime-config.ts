export type DatabaseDriver = "d1" | "mysql";
export type StorageDriver = "r2" | "oss";

function driver<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`服务器环境变量 ${name} 未配置`);
  return value;
}

export function serverRuntimeConfig() {
  const databaseDriver = driver<DatabaseDriver>(
    process.env.DATABASE_DRIVER,
    ["d1", "mysql"],
    "d1",
  );
  const storageDriver = driver<StorageDriver>(
    process.env.STORAGE_DRIVER,
    ["r2", "oss"],
    "r2",
  );

  return {
    database: {
      driver: databaseDriver,
      mysql:
        databaseDriver === "mysql"
          ? {
              host: required("DB_HOST"),
              port: Number(process.env.DB_PORT ?? 3306),
              user: required("DB_USER"),
              password: required("DB_PASSWORD"),
              database: required("DB_NAME"),
            }
          : null,
    },
    storage: {
      driver: storageDriver,
      oss:
        storageDriver === "oss"
          ? {
              region: required("OSS_REGION"),
              accessKeyId: required("OSS_ACCESS_KEY_ID"),
              accessKeySecret: required("OSS_ACCESS_KEY_SECRET"),
              bucket: required("OSS_BUCKET"),
              endpoint: process.env.OSS_ENDPOINT?.trim() || null,
            }
          : null,
    },
  } as const;
}

export function redactedRuntimeSummary() {
  const config = serverRuntimeConfig();
  return {
    databaseDriver: config.database.driver,
    storageDriver: config.storage.driver,
    mysqlConfigured: Boolean(config.database.mysql),
    ossConfigured: Boolean(config.storage.oss),
  };
}
