import { getFileBucket } from "../../../../lib/asset-kernel";
import { getMysqlPool } from "../../../../lib/mysql";

export async function GET() {
  const checks = {
    mysql: false,
    oss: false,
  };

  await Promise.all([
    (async () => {
      try {
        const database = await getMysqlPool();
        await database.query("SELECT 1");
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
