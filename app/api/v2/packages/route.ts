import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import {
  packageCapabilities,
  packages,
  packageVersions,
  registryEvents,
  auditLogs,
  outboxEvents,
} from "../../../../db/schema";
import { requireUser, sha256 } from "../../../lib/auth";
import {
  ManifestValidationError,
  parsePackagePayload,
} from "../../../lib/package-contract";
import { serializePackage } from "../../../lib/registry-serialization";
import { mysqlNow } from "../../../lib/mysql";
import { domainEventRows } from "../../../lib/domain-events";
import { requireRequestedWorkspace } from "../../../lib/workspace-context";

function errorResponse(error: unknown) {
  if (error instanceof Response) return error;
  if (error instanceof ManifestValidationError) {
    return Response.json(
      { error: "Package Manifest 校验失败", issues: error.issues },
      { status: 400 },
    );
  }
  const message =
    error instanceof Error ? error.message : "Package operation failed";
  return Response.json({ error: message }, { status: 500 });
}

function audit(
  workspaceId: string,
  actorUserId: string,
  eventType: string,
  entityId: string,
  detail: Record<string, unknown>,
) {
  return {
    id: crypto.randomUUID(),
    workspaceId,
    actorUserId,
    eventType,
    entityId,
    detailJson: JSON.stringify(detail),
  };
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      workspaceId?: string;
      manifest?: unknown;
      signature?: string;
    };
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "manage",
      payload,
    );
    const manifest = parsePackagePayload(payload);
    const manifestJson = JSON.stringify(manifest);
    const integritySha256 = await sha256(manifestJson);
    const signature = payload.signature?.trim() || null;
    if (
      process.env.REQUIRE_PACKAGE_SIGNATURES === "true" &&
      !signature
    ) {
      return Response.json(
        { error: "当前服务器要求 Package 签名" },
        { status: 400 },
      );
    }

    const db = await getDb();
    const [existing] = await db
      .select()
      .from(packages)
      .where(
        and(
          eq(packages.workspaceId, workspaceId),
          eq(packages.packageKey, manifest.id),
        ),
      )
      .limit(1);
    const packageId = existing?.id ?? `package_${crypto.randomUUID()}`;
    const now = mysqlNow();
    const packageRow = {
      packageKey: manifest.id,
      workspaceId,
      createdBy: existing?.createdBy ?? user.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description ?? "",
      packageType: manifest.type,
      runtimeType: manifest.runtime.type,
      runtimeUrl: manifest.runtime.entry ?? null,
      manifestJson,
      permissionsJson: JSON.stringify(manifest.permissions ?? []),
      lifecycleState: "active",
      healthStatus:
        manifest.runtime.type === "declarative" ? "healthy" : "unchecked",
      integritySha256,
      signature,
      enabled: true,
      updatedAt: now,
    };

    const contributions = [
      ...(manifest.contributes?.skills ?? []).map((item) => ({
        ...item,
        contributionType: "skill",
      })),
      ...(manifest.contributes?.agents ?? []).map((item) => ({
        ...item,
        contributionType: "agent",
      })),
      ...(manifest.contributes?.workflows ?? []).map((item) => ({
        ...item,
        contributionType: "workflow",
      })),
      ...(manifest.contributes?.nodes ?? []).map((item) => ({
        ...item,
        contributionType: "node",
      })),
    ];
    const domainInput = {
      workspaceId,
      actorUserId: user.id,
      eventType: existing ? "package.upgraded" : "package.installed",
      entityType: "package",
      entityId: packageId,
      requestId: request.headers.get("x-request-id"),
      detail: { packageKey: manifest.id, version: manifest.version },
    };
    const domainRows = domainEventRows(domainInput);
    await db.transaction(async (tx) => {
      if (existing) {
        await tx
          .update(packages)
          .set(packageRow)
          .where(
            and(
              eq(packages.id, packageId),
              eq(packages.workspaceId, workspaceId),
            ),
          );
        await tx
          .delete(packageCapabilities)
          .where(eq(packageCapabilities.packageId, packageId));
      } else {
        await tx.insert(packages).values({
          id: packageId,
          ...packageRow,
          installedAt: now,
        });
      }
      const [version] = await tx
        .select({ id: packageVersions.id })
        .from(packageVersions)
        .where(
          and(
            eq(packageVersions.packageId, packageId),
            eq(packageVersions.version, manifest.version),
          ),
        )
        .limit(1);
      if (!version) {
        await tx.insert(packageVersions).values({
          id: `package_version_${crypto.randomUUID()}`,
          packageId,
          version: manifest.version,
          manifestJson,
          permissionsJson: JSON.stringify(manifest.permissions ?? []),
          integritySha256,
          signature,
          installedBy: user.id,
          installedAt: now,
        });
      }
      if (contributions.length) {
        await tx.insert(packageCapabilities).values(
          contributions.map((item) => ({
            id: `capability_${crypto.randomUUID()}`,
            capabilityKey: item.id,
            packageId,
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
      await tx.insert(registryEvents).values(
        audit(
          workspaceId,
          user.id,
          existing ? "package.updated" : "package.installed",
          packageId,
          {
            packageKey: manifest.id,
            version: manifest.version,
            runtime: manifest.runtime.type,
            integritySha256,
          },
        ),
      );
      await tx.insert(auditLogs).values(domainRows.audit);
      await tx.insert(outboxEvents).values(domainRows.outbox);
    });
    const [saved] = await db
      .select()
      .from(packages)
      .where(
        and(
          eq(packages.id, packageId),
          eq(packages.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!saved) throw new Error("Package 安装后无法读取");
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
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      id?: string;
      enabled?: boolean;
      workspaceId?: string;
    };
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "manage",
      payload,
    );
    if (!payload.id || typeof payload.enabled !== "boolean") {
      return Response.json({ error: "id 和 enabled 必填" }, { status: 400 });
    }
    const db = await getDb();
    const eventType = payload.enabled ? "package.enabled" : "package.disabled";
    const domainRows = domainEventRows({
      workspaceId,
      actorUserId: user.id,
      eventType,
      entityType: "package",
      entityId: payload.id,
      requestId: request.headers.get("x-request-id"),
      detail: { enabled: payload.enabled },
    });
    await db.transaction(async (tx) => {
      await tx
        .update(packages)
        .set({
          enabled: payload.enabled,
          lifecycleState: payload.enabled ? "active" : "disabled",
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(
          and(
            eq(packages.id, payload.id),
            eq(packages.workspaceId, workspaceId),
          ),
        );
      await tx.insert(registryEvents).values(
        audit(workspaceId, user.id, eventType, payload.id, {}),
      );
      await tx.insert(auditLogs).values(domainRows.audit);
      await tx.insert(outboxEvents).values(domainRows.outbox);
    });
    const [updated] = await db
      .select()
      .from(packages)
      .where(
        and(
          eq(packages.id, payload.id),
          eq(packages.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!updated) {
      return Response.json({ error: "Package 不存在" }, { status: 404 });
    }
    return Response.json({ package: serializePackage(updated) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireUser(request);
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "manage",
    );
    const id = new URL(request.url).searchParams.get("id")?.trim();
    if (!id) return Response.json({ error: "id 必填" }, { status: 400 });
    const db = await getDb();
    const [existing] = await db
      .select()
      .from(packages)
      .where(and(eq(packages.id, id), eq(packages.workspaceId, workspaceId)))
      .limit(1);
    if (!existing) {
      return Response.json({ error: "Package 不存在" }, { status: 404 });
    }
    const detail = {
      packageKey: existing.packageKey,
      version: existing.version,
      retainedHistory: true,
    };
    const domainRows = domainEventRows({
      workspaceId,
      actorUserId: user.id,
      eventType: "package.uninstalled",
      entityType: "package",
      entityId: id,
      requestId: request.headers.get("x-request-id"),
      detail,
    });
    await db.transaction(async (tx) => {
      await tx
        .update(packages)
        .set({
          enabled: false,
          lifecycleState: "uninstalled",
          updatedAt: mysqlNow(),
        })
        .where(and(eq(packages.id, id), eq(packages.workspaceId, workspaceId)));
      await tx
        .update(packageCapabilities)
        .set({ enabled: false })
        .where(eq(packageCapabilities.packageId, id));
      await tx.insert(registryEvents).values(
        audit(workspaceId, user.id, "package.uninstalled", id, detail),
      );
      await tx.insert(auditLogs).values(domainRows.audit);
      await tx.insert(outboxEvents).values(domainRows.outbox);
    });
    return Response.json({ ok: true, retainedHistory: true });
  } catch (error) {
    return errorResponse(error);
  }
}
