import type { RowDataPacket } from "mysql2/promise";
import { getFileBucket } from "../../../../lib/asset-kernel";
import { mysqlRows } from "../../../../lib/mysql";
import { runtimeServiceReadiness } from "../../../../lib/server-runtime-config";

export async function GET() {
  const checks = {
    mysql: false,
    oss: false,
  };

  await Promise.all([
    (async () => {
      try {
        await mysqlRows<RowDataPacket>("SELECT 1 AS ok");
        checks.mysql = true;
      } catch {
        // The response intentionally omits infrastructure details and credentials.
      }
    })(),
    (async () => {
      try {
        const bucket = await getFileBucket();
        await bucket.health();
        checks.oss = true;
      } catch {
        // The response intentionally omits infrastructure details and credentials.
      }
    })(),
  ]);

  const ok = checks.mysql && checks.oss;
  const services = runtimeServiceReadiness();
  return Response.json(
    { ok, checks, services, time: new Date().toISOString() },
    { status: ok ? 200 : 503 },
  );
}
