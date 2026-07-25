import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import {
  packageCapabilities,
  packages,
  packageVersions,
  packageReviews,
  publisherKeys,
  registryEvents,
  auditLogs,
  outboxEvents,
  trustedPublishers,
} from "../../../../db/schema";
import { requireUser } from "../../../lib/auth";
import {
  ManifestValidationError,
  parsePackagePayload,
} from "../../../lib/package-contract";
import { serializePackage } from "../../../lib/registry-serialization";
import { mysqlNow } from "../../../lib/mysql";
import { domainEventRows } from "../../../lib/domain-events";
import { requireRequestedWorkspace } from "../../../lib/workspace-context";
import {
  canonicalPackageManifest,
  packageManifestSha256,
  scanPackageManifest,
  verifyPackageSignature,
} from "../../../lib/package-trust";
import { packageSignaturesRequired } from "../../../lib/server-runtime-config";

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
      publisherKeyId?: string;
    };
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "manage",
      payload,
    );
    const manifest = parsePackagePayload(payload);
    const manifestJson = canonicalPackageManifest(manifest);
    const integritySha256 = packageManifestSha256(manifestJson);
    const signature = payload.signature?.trim() || null;
    const db = await getDb();
    const scan = scanPackageManifest(manifest);
    const publisherKeyId = payload.publisherKeyId?.trim() || null;
    const [publisherIdentity] = publisherKeyId
      ? await db
          .select({
            keyId: publisherKeys.id,
            keyStatus: publisherKeys.status,
            publicKeyPem: publisherKeys.publicKeyPem,
            expiresAt: publisherKeys.expiresAt,
            publisherId: trustedPublishers.id,
            publisherStatus: trustedPublishers.status,
          })
          .from(publisherKeys)
          .innerJoin(
            trustedPublishers,
            eq(trustedPublishers.id, publisherKeys.publisherId),
          )
          .where(eq(publisherKeys.id, publisherKeyId))
          .limit(1)
      : [];
    const keyExpired =
      Boolean(publisherIdentity?.expiresAt) &&
      new Date(publisherIdentity!.expiresAt!).getTime() <= Date.now();
    const signatureVerified = Boolean(
      signature &&
        publisherIdentity &&
        publisherIdentity.keyStatus === "active" &&
        publisherIdentity.publisherStatus === "approved" &&
        !keyExpired &&
        verifyPackageSignature({
          manifestJson,
          signature,
          publicKeyPem: publisherIdentity.publicKeyPem,
        }),
    );
    const workspaceDeclarativeSkill =
      manifest.type === "skill" &&
      manifest.runtime.type === "declarative" &&
      manifest.id.startsWith("user.skill.") &&
      (manifest.permissions ?? []).every((permission) =>
        ["models:list", "models:invoke"].includes(permission),
      );
    if (
      packageSignaturesRequired() &&
      !signatureVerified &&
      !workspaceDeclarativeSkill
    ) {
      return Response.json(
        { error: "当前服务器要求由可信发布者签名的 Package" },
        { status: 400 },
      );
    }
    const [existingReview] = await db
      .select()
      .from(packageReviews)
      .where(
        and(
          eq(packageReviews.packageKey, manifest.id),
          eq(packageReviews.version, manifest.version),
        ),
      )
      .limit(1);
    if (
      existingReview &&
      existingReview.manifestSha256 !== integritySha256
    ) {
      return Response.json(
        { error: "相同 Package 版本的 Manifest 已存在且摘要不同，请提升版本号" },
        { status: 409 },
      );
    }
    const automaticReviewStatus =
      scan.risk === "high"
        ? "quarantined"
        : signatureVerified ||
            (manifest.runtime.type === "declarative" && scan.risk === "low")
          ? "approved"
          : "pending";
    const reviewStatus =
      existingReview &&
      ["approved", "rejected", "quarantined", "revoked"].includes(
        existingReview.status,
      )
        ? existingReview.status
        : automaticReviewStatus;
    const reviewId =
      existingReview?.id ?? `package_review_${crypto.randomUUID()}`;
    const effectiveSignatureVerified =
      signatureVerified || existingReview?.signatureVerified === true;
    const trustState =
      reviewStatus === "approved"
        ? effectiveSignatureVerified
          ? "trusted"
          : "reviewed"
        : reviewStatus;
    const packageEnabled = reviewStatus === "approved";
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
    const existingCapabilityRows = existing
      ? await db
          .select({
            id: packageCapabilities.id,
            capabilityKey: packageCapabilities.capabilityKey,
          })
          .from(packageCapabilities)
          .where(eq(packageCapabilities.packageId, packageId))
      : [];
    const capabilityIds = new Map(
      existingCapabilityRows.map((item) => [item.capabilityKey, item.id]),
    );
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
      lifecycleState: packageEnabled ? "active" : reviewStatus,
      healthStatus:
        manifest.runtime.type === "declarative" ? "healthy" : "unchecked",
      integritySha256,
      signature: signature ?? existingReview?.signature ?? null,
      publisherId:
        publisherIdentity?.publisherId ?? existingReview?.publisherId ?? null,
      reviewId,
      trustState,
      enabled: packageEnabled,
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
      if (existingReview) {
        await tx
          .update(packageReviews)
          .set({
            publisherId:
              publisherIdentity?.publisherId ??
              existingReview.publisherId ??
              null,
            publisherKeyId:
              publisherIdentity?.keyId ??
              existingReview.publisherKeyId ??
              null,
            signature: signature ?? existingReview.signature,
            signatureVerified:
              effectiveSignatureVerified,
            status: reviewStatus,
            scanJson: JSON.stringify(scan),
            reason:
              reviewStatus === "quarantined"
                ? "自动扫描判定为高风险"
                : existingReview.reason,
            updatedAt: now,
          })
          .where(eq(packageReviews.id, reviewId));
      } else {
        await tx.insert(packageReviews).values({
          id: reviewId,
          packageKey: manifest.id,
          version: manifest.version,
          publisherId: publisherIdentity?.publisherId ?? null,
          publisherKeyId: publisherIdentity?.keyId ?? null,
          manifestSha256: integritySha256,
          signature,
          signatureVerified: effectiveSignatureVerified,
          status: reviewStatus,
          scanJson: JSON.stringify(scan),
          reason:
            reviewStatus === "approved"
              ? effectiveSignatureVerified
                ? "可信发布者签名与安全扫描通过"
                : "低风险声明式 Package 自动审核通过"
              : reviewStatus === "quarantined"
                ? "自动扫描判定为高风险"
                : "等待系统管理员审核",
          submittedBy: user.id,
          reviewedAt:
            reviewStatus === "approved" ? now : null,
          createdAt: now,
          updatedAt: now,
        });
      }
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
            id:
              capabilityIds.get(item.id) ??
              `capability_${crypto.randomUUID()}`,
            capabilityKey: item.id,
            packageId,
            title: item.title,
            description: item.description ?? "",
            modality: item.modality,
            contributionType: item.contributionType,
            inputSchemaJson: JSON.stringify(item.inputSchema ?? {}),
            outputSchemaJson: JSON.stringify(item.outputSchema ?? {}),
            uiSchemaJson: JSON.stringify(item.uiSchema ?? {}),
            portsJson: JSON.stringify(item.ports ?? []),
            modelRequirementsJson: JSON.stringify(
              item.modelRequirements ?? {
                required: manifest.runtime.type !== "remote-api",
              },
            ),
            executionMode:
              item.executionMode ??
              (manifest.runtime.type === "remote-api" ? "remote" : "model"),
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
            trustState,
            reviewStatus,
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
        review: {
          id: reviewId,
          status: reviewStatus,
          trustState,
          signatureVerified: effectiveSignatureVerified,
          scan,
        },
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
    const packageId = payload.id;
    const enabled = payload.enabled;
    const db = await getDb();
    if (enabled) {
      const [candidate] = await db
        .select({ trustState: packages.trustState })
        .from(packages)
        .where(
          and(
            eq(packages.id, packageId),
            eq(packages.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      if (
        !candidate ||
        !["trusted", "reviewed"].includes(candidate.trustState)
      ) {
        return Response.json(
          { error: "Package 尚未通过信任审核，不能启用" },
          { status: 403 },
        );
      }
    }
    const eventType = enabled ? "package.enabled" : "package.disabled";
    const domainRows = domainEventRows({
      workspaceId,
      actorUserId: user.id,
      eventType,
      entityType: "package",
      entityId: packageId,
      requestId: request.headers.get("x-request-id"),
      detail: { enabled },
    });
    await db.transaction(async (tx) => {
      await tx
        .update(packages)
        .set({
          enabled,
          lifecycleState: enabled ? "active" : "disabled",
          updatedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(
          and(
            eq(packages.id, packageId),
            eq(packages.workspaceId, workspaceId),
          ),
        );
      await tx.insert(registryEvents).values(
        audit(workspaceId, user.id, eventType, packageId, {}),
      );
      await tx.insert(auditLogs).values(domainRows.audit);
      await tx.insert(outboxEvents).values(domainRows.outbox);
    });
    const [updated] = await db
      .select()
      .from(packages)
      .where(
        and(
          eq(packages.id, packageId),
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
