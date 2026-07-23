import { eq, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import {
  packageCapabilities,
  packages,
  registryEvents,
} from "../../../../db/schema";
import {
  ManifestValidationError,
  parsePackagePayload,
} from "../../../lib/package-contract";
import { serializePackage } from "../../../lib/registry-serialization";

function errorResponse(error: unknown) {
  if (error instanceof ManifestValidationError) {
    return Response.json(
      { error: "Package Manifest 校验失败", issues: error.issues },
      { status: 400 },
    );
  }
  const message = error instanceof Error ? error.message : "Package operation failed";
  return Response.json({ error: message }, { status: 500 });
}

function audit(eventType: string, entityId: string, detail: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    eventType,
    entityId,
    detailJson: JSON.stringify(detail),
  };
}

export async function POST(request: Request) {
  try {
    const payload = await request.json();
    const manifest = parsePackagePayload(payload);
    const db = await getDb();
    const [existing] = await db
      .select()
      .from(packages)
      .where(eq(packages.id, manifest.id))
      .limit(1);
    const now = new Date().toISOString();
    const packageRow = {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description ?? "",
      packageType: manifest.type,
      runtimeType: manifest.runtime.type,
      runtimeUrl: manifest.runtime.entry ?? null,
      manifestJson: JSON.stringify(manifest),
      permissionsJson: JSON.stringify(manifest.permissions ?? []),
      enabled: true,
      updatedAt: now,
    };

    if (existing) {
      await db.update(packages).set(packageRow).where(eq(packages.id, manifest.id));
      await db
        .delete(packageCapabilities)
        .where(eq(packageCapabilities.packageId, manifest.id));
    } else {
      await db.insert(packages).values({
        ...packageRow,
        installedAt: now,
      });
    }

    const contributions = [
      ...(manifest.contributes?.skills ?? []).map((item) => ({
        ...item,
        contributionType: "skill",
      })),
      ...(manifest.contributes?.nodes ?? []).map((item) => ({
        ...item,
        contributionType: "node",
      })),
    ];
    if (contributions.length) {
      await db.insert(packageCapabilities).values(
        contributions.map((item) => ({
          id: item.id,
          packageId: manifest.id,
          title: item.title,
          description: item.description ?? "",
          modality: item.modality,
          contributionType: item.contributionType,
          inputSchemaJson: JSON.stringify(item.inputSchema ?? {}),
          outputSchemaJson: JSON.stringify(item.outputSchema ?? {}),
          uiSchemaJson: JSON.stringify(item.uiSchema ?? {}),
          enabled: true,
        })),
      );
    }
    await db.insert(registryEvents).values(
      audit(existing ? "package.updated" : "package.installed", manifest.id, {
        version: manifest.version,
        runtime: manifest.runtime.type,
      }),
    );

    const [saved] = await db
      .select()
      .from(packages)
      .where(eq(packages.id, manifest.id))
      .limit(1);
    return Response.json(
      {
        package: serializePackage(saved),
        action: existing ? "updated" : "installed",
      },
      { status: existing ? 200 : 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const payload = (await request.json()) as { id?: string; enabled?: boolean };
    if (!payload.id || typeof payload.enabled !== "boolean") {
      return Response.json({ error: "id 和 enabled 必填" }, { status: 400 });
    }
    const db = await getDb();
    const [updated] = await db
      .update(packages)
      .set({
        enabled: payload.enabled,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(packages.id, payload.id))
      .returning();
    if (!updated) {
      return Response.json({ error: "Package 不存在" }, { status: 404 });
    }
    await db.insert(registryEvents).values(
      audit(payload.enabled ? "package.enabled" : "package.disabled", payload.id, {}),
    );
    return Response.json({ package: serializePackage(updated) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id")?.trim();
    if (!id) return Response.json({ error: "id 必填" }, { status: 400 });
    const db = await getDb();
    const [existing] = await db
      .select({ id: packages.id, version: packages.version })
      .from(packages)
      .where(eq(packages.id, id))
      .limit(1);
    if (!existing) {
      return Response.json({ error: "Package 不存在" }, { status: 404 });
    }
    await db.delete(packageCapabilities).where(eq(packageCapabilities.packageId, id));
    await db.delete(packages).where(eq(packages.id, id));
    await db
      .insert(registryEvents)
      .values(audit("package.uninstalled", id, { version: existing.version }));
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
