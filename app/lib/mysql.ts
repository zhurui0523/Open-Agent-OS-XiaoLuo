import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from "mysql2/promise";
import { createPool } from "mysql2/promise";
import { serverRuntimeConfig } from "./server-runtime-config";

function createMysqlPool() {
  const { mysql } = serverRuntimeConfig().database;
  return createPool({
    host: mysql.host,
    port: mysql.port,
    user: mysql.user,
    password: mysql.password,
    database: mysql.database,
    charset: "utf8mb4",
    dateStrings: true,
    connectionLimit: 10,
    enableKeepAlive: true,
    waitForConnections: true,
    queueLimit: 0,
    connectTimeout: 8_000,
    disableEval: true,
    ssl:
      mysql.sslMode === "disabled"
        ? undefined
        : {
            rejectUnauthorized: mysql.sslMode === "required",
            ...(mysql.sslCa ? { ca: mysql.sslCa } : {}),
          },
  });
}

const poolKey = Symbol.for("xiaoluo.mysql.pool");

type MysqlGlobal = typeof globalThis & {
  [poolKey]?: Pool;
};

export async function getMysqlPool() {
  const runtime = globalThis as MysqlGlobal;
  runtime[poolKey] ??= createMysqlPool();
  return runtime[poolKey];
}

async function withMysqlPool<T>(operation: (database: Pool) => Promise<T>) {
  const database = createMysqlPool();
  try {
    return await operation(database);
  } finally {
    await database.end();
  }
}

export async function mysqlRows<T extends RowDataPacket>(
  sql: string,
  values: unknown[] = [],
) {
  return withMysqlPool(async (database) => {
    const [rows] = await database.execute<T[]>(sql, values as never);
    return rows;
  });
}

export async function mysqlExecute(
  sql: string,
  values: unknown[] = [],
) {
  return withMysqlPool(async (database) => {
    const [result] = await database.execute<ResultSetHeader>(
      sql,
      values as never,
    );
    return result;
  });
}

export async function mysqlTransaction<T>(
  operation: (connection: PoolConnection) => Promise<T>,
) {
  return withMysqlPool(async (database) => {
    const connection = await database.getConnection();
    try {
      await connection.beginTransaction();
      const result = await operation(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  });
}

export function mysqlNow(date = new Date()) {
  return date.toISOString().replace("T", " ").replace("Z", "");
}
