import type { RowDataPacket } from "mysql2/promise";
import { getFileBucket } from "../../../../lib/asset-kernel";
import { mysqlRows } from "../../../../lib/mysql";
import { runtimeServiceReadiness } from "../../../../lib/server-runtime-config";

function dependencyDiagnostic(error: unknown) {
  if (!error || typeof error !== "object") return "UNKNOWN";
  const record = error as {
    code?: unknown;
    message?: unknown;
    cause?: { code?: unknown; message?: unknown };
  };
  const code =
    typeof record.code === "string"
      ? record.code
      : typeof record.cause?.code === "string"
        ? record.cause.code
        : "UNKNOWN";
  const message =
    typeof record.message === "string"
      ? record.message
      : typeof record.cause?.message === "string"
        ? record.cause.message
        : "";
  return `${code}${message ? `: ${message.slice(0, 240)}` : ""}`;
}

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
      } catch (error) {
        console.error(
          `[readiness] MySQL unavailable: ${dependencyDiagnostic(error)}`,
        );
        // The response intentionally omits infrastructure details and credentials.
      }
    })(),
    (async () => {
      try {
        const bucket = await getFileBucket();
        await bucket.health();
        checks.oss = true;
      } catch (error) {
        console.error(
          `[readiness] OSS unavailable: ${dependencyDiagnostic(error)}`,
        );
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
