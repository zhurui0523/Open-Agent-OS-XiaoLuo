import type { RowDataPacket } from "mysql2/promise";
import { getFileBucket } from "../../../../lib/asset-kernel";
import { mysqlRows } from "../../../../lib/mysql";

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
  return Response.json(
    { ok, checks, time: new Date().toISOString() },
    { status: ok ? 200 : 503 },
  );
}
