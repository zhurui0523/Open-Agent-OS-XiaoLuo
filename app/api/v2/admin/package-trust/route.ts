import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import {
  auditLogs,
  outboxEvents,
  packageCapabilities,
  packageReviews,
  packages,
  publisherKeys,
  trustedPublishers,
} from "../../../../../db/schema";
import { jsonError, requireSystemAdmin } from "../../../../lib/auth";
import { domainEventRows } from "../../../../lib/domain-events";
import { mysqlNow } from "../../../../lib/mysql";
import { publisherKeyFingerprint } from "../../../../lib/package-trust";

const publisherSlugPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/;

function auditRows(
  request: Request,
  actorUserId: string,
  eventType: string,
  entityType: string,
  entityId: string,
  detail: Record<string, unknown>,
) {
  return domainEventRows({
    actorUserId,
    eventType,
    entityType,
    entityId,
    requestId: request.headers.get("x-request-id"),
    detail,
  });
}
export async function GET(request: Request) {
  try {
    await requireSystemAdmin(request);
    const db = await getDb();
    const [publishers, keys, reviews] = await Promise.all([
      db.select().from(trustedPublishers).orderBy(desc(trustedPublishers.createdAt)),
      db
        .select({
          id: publisherKeys.id,
          publisherId: publisherKeys.publisherId,
          algorithm: publisherKeys.algorithm,
          fingerprintSha256: publisherKeys.fingerprintSha256,
          status: publisherKeys.status,
          expiresAt: publisherKeys.expiresAt,
          revokedAt: publisherKeys.revokedAt,
          createdAt: publisherKeys.createdAt,
        })
        .from(publisherKeys)
        .orderBy(desc(publisherKeys.createdAt)),
      db
        .select({
          id: packageReviews.id,
          packageKey: packageReviews.packageKey,
          version: packageReviews.version,
          publisherId: packageReviews.publisherId,
          manifestSha256: packageReviews.manifestSha256,
          signatureVerified: packageReviews.signatureVerified,
          status: packageReviews.status,
          scanJson: packageReviews.scanJson,
          reason: packageReviews.reason,
          createdAt: packageReviews.createdAt,
          updatedAt: packageReviews.updatedAt,
        })
        .from(packageReviews)
        .orderBy(desc(packageReviews.createdAt))
        .limit(300),
    ]);
    return Response.json({
      publishers,
      keys,
      reviews: reviews.map((review) => ({
        ...review,
        scan: JSON.parse(review.scanJson) as unknown,
        scanJson: undefined,
      })),
    });
  } catch (error) {
    return jsonError(error, "读取 Package 信任中心失败");
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireSystemAdmin(request);
    const body = (await request.json()) as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "";
    const db = await getDb();
    const now = mysqlNow();

    if (action === "publisher.create") {
      const slug =
        typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
      const displayName =
        typeof body.displayName === "string" ? body.displayName.trim() : "";
      if (!publisherSlugPattern.test(slug) || !displayName) {
        return Response.json(
          { error: "发布者 slug 或显示名称无效" },
          { status: 400 },
        );
      }
      const id = `publisher_${crypto.randomUUID()}`;
      const rows = auditRows(
        request,
        admin.id,
        "publisher.created",
        "publisher",
        id,
        { slug },
      );
      await db.transaction(async (tx) => {
        await tx.insert(trustedPublishers).values({
          id,
          slug,
          displayName,
          website: typeof body.website === "string" ? body.website.trim() : null,
          contactEmail:
            typeof body.contactEmail === "string"
              ? body.contactEmail.trim().toLowerCase()
              : null,
          status: "pending",
          createdBy: admin.id,
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(auditLogs).values(rows.audit);
        await tx.insert(outboxEvents).values(rows.outbox);
      });
      return Response.json({ id, status: "pending" }, { status: 201 });
    }

    if (action === "publisher.review") {
      const publisherId =
        typeof body.publisherId === "string" ? body.publisherId.trim() : "";
      const status =
        body.status === "approved" ||
        body.status === "suspended" ||
        body.status === "revoked"
          ? body.status
          : null;
      if (!publisherId || !status) {
        return Response.json({ error: "发布者审核参数无效" }, { status: 400 });
      }
      const rows = auditRows(
        request,
        admin.id,
        `publisher.${status}`,
        "publisher",
        publisherId,
        { reason: body.reason ?? null },
      );
      await db.transaction(async (tx) => {
        await tx
          .update(trustedPublishers)
          .set({
            status,
            reviewedBy: admin.id,
            reviewedAt: now,
            reason: typeof body.reason === "string" ? body.reason.trim() : null,
            updatedAt: now,
          })
          .where(eq(trustedPublishers.id, publisherId));
        if (status !== "approved") {
          const affected = await tx
            .select({ id: packages.id })
            .from(packages)
            .where(eq(packages.publisherId, publisherId));
          if (affected.length) {
            for (const item of affected) {
              await tx
                .update(packageCapabilities)
                .set({ enabled: false })
                .where(eq(packageCapabilities.packageId, item.id));
            }
          }
          await tx
            .update(packages)
            .set({
              enabled: false,
              trustState: status,
              lifecycleState: status,
              updatedAt: now,
            })
            .where(eq(packages.publisherId, publisherId));
        }
        await tx.insert(auditLogs).values(rows.audit);
        await tx.insert(outboxEvents).values(rows.outbox);
      });
      return Response.json({ id: publisherId, status });
    }

    if (action === "key.add") {
      const publisherId =
        typeof body.publisherId === "string" ? body.publisherId.trim() : "";
      const publicKeyPem =
        typeof body.publicKeyPem === "string" ? body.publicKeyPem.trim() : "";
      if (!publisherId || !publicKeyPem) {
        return Response.json({ error: "发布者和公钥必填" }, { status: 400 });
      }
      let fingerprintSha256 = "";
      try {
        fingerprintSha256 = publisherKeyFingerprint(publicKeyPem);
      } catch {
        return Response.json(
          { error: "公钥必须是有效的 ECDSA P-256 SPKI PEM" },
          { status: 400 },
        );
      }
      const id = `publisher_key_${crypto.randomUUID()}`;
      const rows = auditRows(
        request,
        admin.id,
        "publisher.key_added",
        "publisher_key",
        id,
        { publisherId, fingerprintSha256 },
      );
      await db.transaction(async (tx) => {
        await tx.insert(publisherKeys).values({
          id,
          publisherId,
          publicKeyPem,
          fingerprintSha256,
          status: "active",
          expiresAt:
            typeof body.expiresAt === "string" && body.expiresAt
              ? mysqlNow(new Date(body.expiresAt))
              : null,
          createdAt: now,
        });
        await tx.insert(auditLogs).values(rows.audit);
        await tx.insert(outboxEvents).values(rows.outbox);
      });
      return Response.json({ id, fingerprintSha256 }, { status: 201 });
    }

    if (action === "key.revoke") {
      const keyId = typeof body.keyId === "string" ? body.keyId.trim() : "";
      if (!keyId) return Response.json({ error: "keyId 必填" }, { status: 400 });
      const rows = auditRows(
        request,
        admin.id,
        "publisher.key_revoked",
        "publisher_key",
        keyId,
        {},
      );
      await db.transaction(async (tx) => {
        await tx
          .update(publisherKeys)
          .set({ status: "revoked", revokedAt: now })
          .where(eq(publisherKeys.id, keyId));
        await tx.insert(auditLogs).values(rows.audit);
        await tx.insert(outboxEvents).values(rows.outbox);
      });
      return Response.json({ id: keyId, status: "revoked" });
    }

    if (action === "review.update") {
      const reviewId =
        typeof body.reviewId === "string" ? body.reviewId.trim() : "";
      const status =
        body.status === "approved" ||
        body.status === "rejected" ||
        body.status === "quarantined" ||
        body.status === "revoked"
          ? body.status
          : null;
      if (!reviewId || !status) {
        return Response.json({ error: "Package 审核参数无效" }, { status: 400 });
      }
      const [review] = await db
        .select()
        .from(packageReviews)
        .where(eq(packageReviews.id, reviewId))
        .limit(1);
      if (!review) {
        return Response.json({ error: "Package 审核记录不存在" }, { status: 404 });
      }
      const enabled = status === "approved";
      const trustState = enabled
        ? review.signatureVerified
          ? "trusted"
          : "reviewed"
        : status;
      const rows = auditRows(
        request,
        admin.id,
        `package.review_${status}`,
        "package_review",
        reviewId,
        { packageKey: review.packageKey, version: review.version },
      );
      await db.transaction(async (tx) => {
        await tx
          .update(packageReviews)
          .set({
            status,
            reason: typeof body.reason === "string" ? body.reason.trim() : null,
            reviewedBy: admin.id,
            reviewedAt: now,
            updatedAt: now,
          })
          .where(eq(packageReviews.id, reviewId));
        const affected = await tx
          .select({ id: packages.id })
          .from(packages)
          .where(eq(packages.reviewId, reviewId));
        for (const item of affected) {
          await tx
            .update(packageCapabilities)
            .set({ enabled })
            .where(eq(packageCapabilities.packageId, item.id));
        }
        await tx
          .update(packages)
          .set({
            enabled,
            trustState,
            lifecycleState: enabled ? "active" : status,
            updatedAt: now,
          })
          .where(eq(packages.reviewId, reviewId));
        await tx.insert(auditLogs).values(rows.audit);
        await tx.insert(outboxEvents).values(rows.outbox);
      });
      return Response.json({ id: reviewId, status, trustState });
    }

    return Response.json({ error: "不支持的信任中心操作" }, { status: 400 });
  } catch (error) {
    return jsonError(error, "更新 Package 信任中心失败");
  }
}
