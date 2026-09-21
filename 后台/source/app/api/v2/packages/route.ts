import { and, desc, eq, sql } from "drizzle-orm";
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
import { requireUser, type AuthUser } from "../../../lib/auth";
import {
  ManifestValidationError,
  parsePackagePayload,
  type XiaoLuoPackageManifest,
} from "../../../lib/package-contract";
import { serializePackage } from "../../../lib/registry-serialization";
import { mysqlNow } from "../../../lib/mysql";
import { domainEventRows } from "../../../lib/domain-events";
import { requireRequestedWorkspace } from "../../../lib/workspace-context";
import { requireWorkspaceAccess } from "../../../lib/authorization";
import {
  canonicalPackageManifest,
  normalizeRuntimeEntryForTrustScan,
  packageManifestSha256,
  scanPackageManifest,
  verifyPackageSignature,
} from "../../../lib/package-trust";
import { packageSignaturesRequired } from "../../../lib/server-runtime-config";
import { packageAccessScope } from "../../../lib/registry-access";
import {
  canRefreshGeneratedSourceManifest,
  packageInstallSourceFromDetailJson,
  packageInstallSourceFromScanJson,
} from "../../../lib/package-version-policy";
import {
  MEDIA_PLUGIN_TYPES,
  normalizeMediaPluginTypes,
} from "../../../lib/media-plugin";
import { scheduleCapabilityMirrorExport } from "../../../lib/capability-mirror";

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

export async function installPackage(
  request: Request,
  options: {
    allowUnsignedGithubImport?: boolean;
    allowUnsignedSourceImport?: boolean;
    authenticatedUser?: AuthUser;
    authorizedWorkspaceId?: string;
  } = {},
) {
  try {
    // Imported packages can spend several minutes in the isolated build
    // stage. Reusing the principal verified by the import route prevents a
    // short-lived access token from expiring between build completion and the
    // atomic database install transaction.
    const user = options.authenticatedUser ?? (await requireUser(request));
    const payload = (await request.json()) as {
      workspaceId?: string;
      targetPackageId?: string;
      manifest?: unknown;
      signature?: string;
      publisherKeyId?: string;
      source?: {
        kind?: unknown;
        artifactKey?: unknown;
        archiveSha256?: unknown;
        repository?: unknown;
        commit?: unknown;
        generatedManifest?: unknown;
        executionReady?: unknown;
      };
    };
    const manifest = parsePackagePayload(payload);
    let workspaceId = options.authorizedWorkspaceId
      ? options.authorizedWorkspaceId
      : await requireRequestedWorkspace(
          request,
          user.id,
          manifest.type === "skill" || manifest.type === "plugin"
            ? "view"
            : "manage",
          payload,
        );
    if (
      options.authorizedWorkspaceId &&
      payload.workspaceId &&
      payload.workspaceId !== options.authorizedWorkspaceId
    ) {
      return Response.json(
        { error: "安装目标工作区与已授权工作区不一致" },
        { status: 403 },
      );
    }
    const requestedAccessScope = packageAccessScope(manifest);
    if (manifest.type === "skill" || manifest.type === "plugin") {
      if (
        requestedAccessScope !== "personal" &&
        requestedAccessScope !== "marketplace"
      ) {
        return Response.json(
          {
            error:
              "安装 Skill 或插件时只能选择“私有”或“共享”可见范围",
          },
          { status: 400 },
        );
      }
    }
    const manifestJson = canonicalPackageManifest(manifest);
    const integritySha256 = packageManifestSha256(manifestJson);
    const signature = payload.signature?.trim() || null;
    const source =
      payload.source &&
      ["archive", "github"].includes(String(payload.source.kind))
        ? {
            kind: String(payload.source.kind) as "archive" | "github",
            artifactKey:
              typeof payload.source.artifactKey === "string"
                ? payload.source.artifactKey.slice(0, 500)
                : null,
            archiveSha256:
              typeof payload.source.archiveSha256 === "string"
                ? payload.source.archiveSha256.slice(0, 64)
                : null,
            repository:
              typeof payload.source.repository === "string"
                ? payload.source.repository.slice(0, 300)
                : null,
            commit:
              typeof payload.source.commit === "string"
                ? payload.source.commit.slice(0, 64)
                : null,
            generatedManifest: payload.source.generatedManifest === true,
            executionReady: payload.source.executionReady !== false,
          }
        : null;
    const db = await getDb();
    const targetPackageId = payload.targetPackageId?.trim().slice(0, 120);
    let existing: typeof packages.$inferSelect | undefined;
    if (targetPackageId) {
      if (user.platformRole !== "system_admin") {
        return Response.json(
          { error: "只有系统管理员可以修改其他用户共享的 Skill" },
          { status: 403 },
        );
      }
      const [targetPackage] = await db
        .select()
        .from(packages)
        .where(eq(packages.id, targetPackageId))
        .limit(1);
      if (!targetPackage || targetPackage.packageType !== "skill") {
        return Response.json({ error: "目标共享 Skill 不存在" }, { status: 404 });
      }
      if (
        manifest.type !== "skill" ||
        targetPackage.packageKey !== manifest.id
      ) {
        return Response.json(
          { error: "修改内容与目标 Skill 不匹配" },
          { status: 409 },
        );
      }
      existing = targetPackage;
      workspaceId = targetPackage.workspaceId;
    } else {
      [existing] = await db
        .select()
        .from(packages)
        .where(
          and(
            eq(packages.workspaceId, workspaceId),
            eq(packages.packageKey, manifest.id),
          ),
        )
        .limit(1);
      if (
        !existing &&
        (manifest.type === "skill" || manifest.type === "plugin")
      ) {
        // Personal Skill/plugin installs are account-owned. Older builds could
        // create several personal workspaces during concurrent bootstrap, so
        // reuse the user's existing record instead of creating an invisible
        // duplicate in whichever workspace won the current request.
        [existing] = await db
          .select()
          .from(packages)
          .where(
            and(
              eq(packages.packageKey, manifest.id),
              eq(packages.createdBy, user.id),
            ),
          )
          .orderBy(
            sql`CASE WHEN ${packages.lifecycleState} = 'uninstalled' THEN 1 ELSE 0 END`,
            desc(packages.updatedAt),
          )
          .limit(1);
        if (existing) workspaceId = existing.workspaceId;
      }
    }
    const runtimeEntryForTrustScan = normalizeRuntimeEntryForTrustScan(
      manifest.runtime.entry,
      request.url,
    );
    const scan = scanPackageManifest({
      ...manifest,
      runtime: {
        ...manifest.runtime,
        entry: runtimeEntryForTrustScan,
      },
    });
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
      !workspaceDeclarativeSkill &&
      !(
        (options.allowUnsignedGithubImport && source?.kind === "github") ||
        (options.allowUnsignedSourceImport && source?.generatedManifest)
      )
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
    const previousSourceEvents = existing
      ? await db
          .select({ detailJson: registryEvents.detailJson })
          .from(registryEvents)
          .where(
            and(
              eq(registryEvents.workspaceId, workspaceId),
              eq(registryEvents.entityId, existing.id),
            ),
          )
          .orderBy(desc(registryEvents.createdAt))
          .limit(20)
      : [];
    const existingInstallSource =
      packageInstallSourceFromScanJson(existingReview?.scanJson) ??
      previousSourceEvents
        .map((event) => packageInstallSourceFromDetailJson(event.detailJson))
        .find((candidate) => candidate !== null) ??
      null;
    const manifestChanged = Boolean(
      existingReview && existingReview.manifestSha256 !== integritySha256,
    );
    const generatedSourceRefresh =
      manifestChanged &&
      canRefreshGeneratedSourceManifest({
        existingSource: existingInstallSource,
        incomingSource: source,
      });
    const restoresExistingManifest = Boolean(
      existing &&
        existing.createdBy === user.id &&
        existing.integritySha256 === integritySha256,
    );
    if (
      manifestChanged &&
      !generatedSourceRefresh &&
      !restoresExistingManifest
    ) {
      return Response.json(
        { error: "相同 Package 版本的 Manifest 已存在且摘要不同，请提升版本号" },
        { status: 409 },
      );
    }
    const reviewScan = source ? { ...scan, installSource: source } : scan;
    const automaticReviewStatus =
      scan.risk === "high"
        ? "quarantined"
        : signatureVerified ||
            (manifest.runtime.type === "declarative" && scan.risk === "low") ||
            manifest.runtime.type === "sandbox-ui"
          ? "approved"
          : "pending";
    let previousCriticalIssues: string[] = [];
    try {
      const previousScan = JSON.parse(existingReview?.scanJson ?? "{}") as {
        issues?: Array<{ code?: string; severity?: string }>;
      };
      previousCriticalIssues = (previousScan.issues ?? [])
        .filter((issue) => issue.severity === "critical")
        .map((issue) => issue.code ?? "");
    } catch {
      previousCriticalIssues = [];
    }
    const recoverableInternalRuntimeQuarantine =
      existingReview?.status === "quarantined" &&
      automaticReviewStatus === "approved" &&
      previousCriticalIssues.length > 0 &&
      previousCriticalIssues.every(
        (code) => code === "undeclared-runtime-origin",
      );
    const reviewStatus =
      existingReview &&
      ["approved", "rejected", "quarantined", "revoked"].includes(
        existingReview.status,
      ) &&
      !recoverableInternalRuntimeQuarantine
        ? existingReview.status
        : automaticReviewStatus;
    const reviewId =
      existingReview?.id ?? `package_review_${crypto.randomUUID()}`;
    const effectiveSignatureVerified = manifestChanged
      ? signatureVerified
      : signatureVerified || existingReview?.signatureVerified === true;
    const trustState =
      reviewStatus === "approved"
        ? effectiveSignatureVerified
          ? "trusted"
          : "reviewed"
        : reviewStatus;
    const packageEnabled =
      reviewStatus === "approved" && source?.executionReady !== false;
    if (
      existing &&
      (manifest.type === "skill" || manifest.type === "plugin") &&
      existing.createdBy !== user.id &&
      user.platformRole !== "system_admin"
    ) {
      return Response.json(
        { error: "不能修改其他用户创建的 Skill 或插件" },
        { status: 403 },
      );
    }
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
      lifecycleState:
        source?.executionReady === false
          ? "source_pending_build"
          : packageEnabled
            ? "active"
            : reviewStatus,
      healthStatus:
        source?.executionReady === false
          ? "build_required"
          : manifest.runtime.type === "declarative"
            ? "healthy"
            : "unchecked",
      integritySha256,
      signature: manifestChanged
        ? signature
        : signature ?? existingReview?.signature ?? null,
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
      detail: {
        packageKey: manifest.id,
        version: manifest.version,
        ...(source ? { source } : {}),
      },
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
            signatureVerified:
              effectiveSignatureVerified,
            status: reviewStatus,
            manifestSha256: integritySha256,
            signature: manifestChanged
              ? signature
              : signature ?? existingReview.signature,
            scanJson: JSON.stringify(reviewScan),
            reason:
              generatedSourceRefresh
                ? "同一 GitHub Commit 的系统自动适配 Manifest 已安全更新"
                : reviewStatus === "quarantined"
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
          scanJson: JSON.stringify(reviewScan),
          reason:
            reviewStatus === "approved"
              ? effectiveSignatureVerified
                ? "可信发布者签名与安全扫描通过"
                : manifest.runtime.type === "sandbox-ui"
                  ? "受限沙盒插件安全扫描通过"
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
      if (version) {
        await tx
          .update(packageVersions)
          .set({
            manifestJson,
            permissionsJson: JSON.stringify(manifest.permissions ?? []),
            integritySha256,
            signature,
            installedBy: user.id,
            installedAt: now,
          })
          .where(eq(packageVersions.id, version.id));
      } else {
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
            ...(source ? { source } : {}),
          },
        ),
      );
      await tx.insert(auditLogs).values(domainRows.audit);
      await tx.insert(outboxEvents).values(domainRows.outbox);
    });
    scheduleCapabilityMirrorExport(); // CAPABILITY-MIRROR：安装事务提交后调度快照
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

export async function POST(request: Request) {
  return installPackage(request);
}

export async function PATCH(request: Request) {
  scheduleCapabilityMirrorExport(); // CAPABILITY-MIRROR：本次变更 debounce 快照到 OSS
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      id?: string;
      enabled?: boolean;
      accessScope?: "personal" | "marketplace";
      assetTypes?: unknown;
      workspaceId?: string;
    };
    const requestedWorkspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "view",
      payload,
    );
    const updatesEnabled = typeof payload.enabled === "boolean";
    const updatesAccessScope =
      payload.accessScope === "personal" ||
      payload.accessScope === "marketplace";
    const assetTypesPayload = Array.isArray(payload.assetTypes)
      ? payload.assetTypes
      : null;
    const updatesAssetTypes = assetTypesPayload !== null;
    if (!payload.id || (!updatesEnabled && !updatesAccessScope && !updatesAssetTypes)) {
      return Response.json(
        { error: "id 必填，并且至少提供 enabled 或 accessScope" },
        { status: 400 },
      );
    }
    if (payload.accessScope !== undefined && !updatesAccessScope) {
      return Response.json(
        { error: "accessScope 只支持 personal 或 marketplace" },
        { status: 400 },
      );
    }
    if (
      payload.assetTypes !== undefined &&
      (!updatesAssetTypes ||
        assetTypesPayload?.some(
          (value) =>
            typeof value !== "string" ||
            !MEDIA_PLUGIN_TYPES.includes(value as (typeof MEDIA_PLUGIN_TYPES)[number]),
        ))
    ) {
      return Response.json(
        { error: "assetTypes 只支持 image、video、audio" },
        { status: 400 },
      );
    }
    const packageId = payload.id;
    const db = await getDb();
    const [candidate] = await db
      .select()
      .from(packages)
      .where(eq(packages.id, packageId))
      .limit(1);
    if (
      !candidate ||
      (candidate.workspaceId !== requestedWorkspaceId &&
        candidate.createdBy !== user.id &&
        user.platformRole !== "system_admin")
    ) {
      return Response.json({ error: "Package 不存在" }, { status: 404 });
    }
    const targetWorkspaceId = candidate.workspaceId;
    if (
      updatesAccessScope &&
      !["skill", "plugin"].includes(candidate.packageType)
    ) {
      return Response.json(
        { error: "只有 Skill 和插件可以修改私有/共享状态" },
        { status: 400 },
      );
    }
    if (updatesAssetTypes && candidate.packageType !== "plugin") {
      return Response.json(
        { error: "只有插件可以修改适用类型" },
        { status: 400 },
      );
    }
    const canManageOwnExtension =
      ["skill", "plugin"].includes(candidate.packageType) &&
      candidate.createdBy === user.id;
    if (
      (updatesAccessScope || updatesAssetTypes) &&
      user.platformRole !== "system_admin" &&
      !canManageOwnExtension
    ) {
      return Response.json(
        { error: "只能修改自己创建或安装的扩展" },
        { status: 403 },
      );
    }
    if (user.platformRole !== "system_admin" && !canManageOwnExtension) {
      await requireWorkspaceAccess(user.id, targetWorkspaceId, "manage");
    }
    let autoApproveSandboxReviewId: string | null = null;
    let createAutoApproveSandboxReview = false;
    let autoApproveSandboxScanJson: string | null = null;
    if (updatesEnabled && payload.enabled) {
      if (!["trusted", "reviewed"].includes(candidate.trustState)) {
        if (
          candidate.packageType === "plugin" &&
          candidate.runtimeType === "sandbox-ui" &&
          candidate.healthStatus !== "build_required" &&
          candidate.lifecycleState !== "source_pending_build"
        ) {
          const manifest = JSON.parse(
            candidate.manifestJson,
          ) as XiaoLuoPackageManifest;
          const runtimeEntry = manifest.runtime.entry ?? "";
          const runtimeEntryForTrustScan =
            normalizeRuntimeEntryForTrustScan(runtimeEntry, request.url) ??
            runtimeEntry;
          const internalRuntimeEntry =
            runtimeEntryForTrustScan !== runtimeEntry
              ? runtimeEntryForTrustScan
              : runtimeEntry.startsWith("/api/v2/packages/runtime/static/")
                ? runtimeEntry
                : null;
          const scan = scanPackageManifest({
            ...manifest,
            runtime: {
              ...manifest.runtime,
              entry: runtimeEntryForTrustScan,
            },
          });
          const [review] = await db
            .select()
            .from(packageReviews)
            .where(
              candidate.reviewId
                ? eq(packageReviews.id, candidate.reviewId)
                : and(
                    eq(packageReviews.packageKey, candidate.packageKey),
                    eq(packageReviews.version, candidate.version),
                  ),
            )
            .limit(1);
          let previousCriticalIssues: string[] = [];
          try {
            const previousScan = JSON.parse(review?.scanJson ?? "{}") as {
              issues?: Array<{ code?: string; severity?: string }>;
            };
            previousCriticalIssues = (previousScan.issues ?? [])
              .filter((issue) => issue.severity === "critical")
              .map((issue) => issue.code ?? "");
          } catch {
            previousCriticalIssues = [];
          }
          const reviewCanBeRecovered =
            !review ||
            review.status === "pending" ||
            (review.status === "quarantined" &&
              Boolean(internalRuntimeEntry) &&
              previousCriticalIssues.every(
                (code) => code === "undeclared-runtime-origin",
              ));
          if (reviewCanBeRecovered && scan.risk !== "high") {
            autoApproveSandboxReviewId =
              review?.id ?? `package_review_${crypto.randomUUID()}`;
            createAutoApproveSandboxReview = !review;
            autoApproveSandboxScanJson = JSON.stringify(scan);
          }
        }
      }
      if (
        !["trusted", "reviewed"].includes(candidate.trustState) &&
        !autoApproveSandboxReviewId
      ) {
        return Response.json(
          { error: "Package 尚未通过信任审核，不能启用" },
          { status: 403 },
        );
      }
    }
    let nextManifestJson = candidate.manifestJson;
    const currentManifest = JSON.parse(
      candidate.manifestJson,
    ) as Record<string, unknown>;
    const previousAccessScope = packageAccessScope(
      currentManifest,
    );
    const previousAssetTypes = normalizeMediaPluginTypes(
      currentManifest.assetTypes,
    );
    if (updatesAccessScope || updatesAssetTypes) {
      const manifest = { ...currentManifest };
      const currentAccess =
        manifest.access &&
        typeof manifest.access === "object" &&
        !Array.isArray(manifest.access)
          ? (manifest.access as Record<string, unknown>)
          : {};
      if (updatesAccessScope) {
        manifest.access = {
          ...currentAccess,
          scope: payload.accessScope,
        };
      }
      if (updatesAssetTypes) {
        manifest.assetTypes = normalizeMediaPluginTypes(payload.assetTypes);
      }
      nextManifestJson = JSON.stringify(manifest);
    }
    const eventType = updatesAssetTypes
      ? "package.settings.updated"
      : updatesAccessScope
      ? "package.visibility.updated"
      : payload.enabled
        ? "package.enabled"
        : "package.disabled";
    const detail = {
      ...(updatesEnabled ? { enabled: payload.enabled } : {}),
      ...(autoApproveSandboxReviewId ? { autoReviewed: true } : {}),
      ...(updatesAccessScope
        ? {
            previousAccessScope,
            accessScope: payload.accessScope,
          }
        : {}),
      ...(updatesAssetTypes
        ? {
            previousAssetTypes,
            assetTypes: normalizeMediaPluginTypes(payload.assetTypes),
          }
        : {}),
    };
    const domainRows = domainEventRows({
      workspaceId: targetWorkspaceId,
      actorUserId: user.id,
      eventType,
      entityType: "package",
      entityId: packageId,
      requestId: request.headers.get("x-request-id"),
      detail,
    });
    await db.transaction(async (tx) => {
      if (autoApproveSandboxReviewId) {
        const reviewedAt = mysqlNow();
        const reviewValues = {
          status: "approved" as const,
          scanJson: autoApproveSandboxScanJson ?? "{}",
          reason: "受限沙盒插件在添加到画布时自动审核通过",
          reviewedBy: user.id,
          reviewedAt,
          updatedAt: reviewedAt,
        };
        if (createAutoApproveSandboxReview) {
          await tx.insert(packageReviews).values({
            id: autoApproveSandboxReviewId,
            packageKey: candidate.packageKey,
            version: candidate.version,
            publisherId: candidate.publisherId,
            publisherKeyId: null,
            manifestSha256: candidate.integritySha256,
            signature: candidate.signature,
            signatureVerified: false,
            status: "approved",
            scanJson: autoApproveSandboxScanJson ?? "{}",
            reason: reviewValues.reason,
            submittedBy: candidate.createdBy,
            reviewedBy: user.id,
            reviewedAt,
            createdAt: reviewedAt,
            updatedAt: reviewedAt,
          });
        } else {
          await tx
            .update(packageReviews)
            .set(reviewValues)
            .where(eq(packageReviews.id, autoApproveSandboxReviewId));
        }
      }
      if (updatesEnabled && (updatesAccessScope || updatesAssetTypes)) {
        await tx
          .update(packages)
          .set({
            enabled: payload.enabled,
            lifecycleState: payload.enabled ? "active" : "disabled",
            ...(autoApproveSandboxReviewId
              ? {
                  trustState: "reviewed",
                  reviewId: autoApproveSandboxReviewId,
                }
              : {}),
            manifestJson: nextManifestJson,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          })
          .where(
            and(
              eq(packages.id, packageId),
              eq(packages.workspaceId, targetWorkspaceId),
            ),
          );
      } else if (updatesEnabled) {
        await tx
          .update(packages)
          .set({
            enabled: payload.enabled,
            lifecycleState: payload.enabled ? "active" : "disabled",
            ...(autoApproveSandboxReviewId
              ? {
                  trustState: "reviewed",
                  reviewId: autoApproveSandboxReviewId,
                }
              : {}),
            updatedAt: sql`CURRENT_TIMESTAMP`,
          })
          .where(
            and(
              eq(packages.id, packageId),
              eq(packages.workspaceId, targetWorkspaceId),
            ),
          );
      } else {
        await tx
          .update(packages)
          .set({
            manifestJson: nextManifestJson,
            updatedAt: sql`CURRENT_TIMESTAMP`,
          })
          .where(
            and(
              eq(packages.id, packageId),
              eq(packages.workspaceId, targetWorkspaceId),
            ),
          );
      }
      if (updatesEnabled) {
        await tx
          .update(packageCapabilities)
          .set({ enabled: payload.enabled })
          .where(eq(packageCapabilities.packageId, packageId));
      }
      await tx.insert(registryEvents).values(
        audit(targetWorkspaceId, user.id, eventType, packageId, detail),
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
          eq(packages.workspaceId, targetWorkspaceId),
        ),
      )
      .limit(1);
    if (!updated) {
      return Response.json({ error: "Package 不存在" }, { status: 404 });
    }
    return Response.json({
      package: serializePackage(updated, {
        userId: user.id,
        platformRole: user.platformRole,
      }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  scheduleCapabilityMirrorExport(); // CAPABILITY-MIRROR：本次变更 debounce 快照到 OSS
  try {
    const user = await requireUser(request);
    const requestedWorkspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "view",
    );
    const id = new URL(request.url).searchParams.get("id")?.trim();
    if (!id) return Response.json({ error: "id 必填" }, { status: 400 });
    const db = await getDb();
    const [existing] = await db
      .select()
      .from(packages)
      .where(eq(packages.id, id))
      .limit(1);
    if (
      !existing ||
      (existing.workspaceId !== requestedWorkspaceId &&
        existing.createdBy !== user.id &&
        user.platformRole !== "system_admin")
    ) {
      return Response.json({ error: "Package 不存在" }, { status: 404 });
    }
    const targetWorkspaceId = existing.workspaceId;
    const canDeleteOwnExtension =
      (existing.packageType === "skill" ||
        existing.packageType === "plugin") &&
      existing.createdBy === user.id;
    if (user.platformRole !== "system_admin" && !canDeleteOwnExtension) {
      await requireWorkspaceAccess(user.id, targetWorkspaceId, "manage");
    }
    const detail = {
      packageKey: existing.packageKey,
      version: existing.version,
      retainedHistory: true,
    };
    const domainRows = domainEventRows({
      workspaceId: targetWorkspaceId,
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
        .where(
          and(
            eq(packages.id, id),
            eq(packages.workspaceId, targetWorkspaceId),
          ),
        );
      await tx
        .update(packageCapabilities)
        .set({ enabled: false })
        .where(eq(packageCapabilities.packageId, id));
      await tx.insert(registryEvents).values(
        audit(targetWorkspaceId, user.id, "package.uninstalled", id, detail),
      );
      await tx.insert(auditLogs).values(domainRows.audit);
      await tx.insert(outboxEvents).values(domainRows.outbox);
    });
    return Response.json({ ok: true, retainedHistory: true });
  } catch (error) {
    return errorResponse(error);
  }
}
