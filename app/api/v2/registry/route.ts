import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import {
  modelConnections,
  packageCapabilities,
  packages,
  registryEvents,
} from "../../../../db/schema";
import {
  serializeCapability,
  serializeEvent,
  serializeModel,
  serializePackage,
} from "../../../lib/registry-serialization";

function routeError(error: unknown) {
  const message = error instanceof Error ? error.message : "Registry unavailable";
  if (message.includes("no such table")) {
    return "注册表正在初始化，请稍后刷新。";
  }
  return message;
}

export async function GET() {
  try {
    const db = await getDb();
    const [packageRows, capabilityRows, modelRows, eventRows] =
      await Promise.all([
        db.select().from(packages).orderBy(desc(packages.updatedAt)),
        db.select().from(packageCapabilities),
        db
          .select()
          .from(modelConnections)
          .where(eq(modelConnections.enabled, true))
          .orderBy(desc(modelConnections.updatedAt)),
        db.select().from(registryEvents).orderBy(desc(registryEvents.createdAt)).limit(20),
      ]);
    const packageMap = new Map(packageRows.map((row) => [row.id, row]));

    return Response.json({
      packages: packageRows.map(serializePackage),
      capabilities: capabilityRows.flatMap((row) => {
        const owner = packageMap.get(row.packageId);
        return owner
          ? [
              serializeCapability(
                row,
                owner.version,
                owner.packageType,
                owner.enabled,
              ),
            ]
          : [];
      }),
      models: modelRows.map(serializeModel),
      events: eventRows.map(serializeEvent),
    });
  } catch (error) {
    return Response.json({ error: routeError(error) }, { status: 500 });
  }
}
