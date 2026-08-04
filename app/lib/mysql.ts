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
    // Cloudflare Workers bind network I/O to the request that created it.
    // Never retain idle MySQL sockets for reuse by a later request.
    maxIdle: 0,
    idleTimeout: 1_000,
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

export async function getMysqlPool() {
  // A process-global pool is unsafe in the Workers runtime: its sockets are
  // created in one request context and throw when reused by another request.
  // A fresh pool with maxIdle=0 keeps all I/O scoped to the current request.
  return createMysqlPool();
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
