import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../db";
import {
  packageAvailabilities,
  packages,
  registryEvents,
} from "../../../../../db/schema";
import { requireUser } from "../../../../lib/auth";
import { scheduleCapabilityMirrorExport } from "../../../../lib/capability-mirror";
import { mysqlNow } from "../../../../lib/mysql";
import { packageAccessScope } from "../../../../lib/registry-access";
import { requireRequestedWorkspace } from "../../../../lib/workspace-context";

function errorResponse(error: unknown, status = 400) {
  if (error instanceof Response) return error;
  return Response.json(
    {
      error:
        error instanceof Error ? error.message : "可用 Skill 操作失败",
    },
    { status },
  );
}

export async function DELETE(request: Request) {
  scheduleCapabilityMirrorExport(); // CAPABILITY-MIRROR：本次变更 debounce 快照到 OSS
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      workspaceId?: string;
      packageId?: string;
    };
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "view",
      payload,
    );
    const packageId = payload.packageId?.trim().slice(0, 120);
    if (!packageId) {
      return errorResponse(new Error("packageId 必填"));
    }

    const db = await getDb();
    const [availability] = await db
      .select({
        id: packageAvailabilities.id,
        packageName: packages.name,
        packageKey: packages.packageKey,
        packageType: packages.packageType,
        sourceWorkspaceId: packages.workspaceId,
      })
      .from(packageAvailabilities)
      .innerJoin(packages, eq(packages.id, packageAvailabilities.packageId))
      .where(
        and(
          eq(packageAvailabilities.packageId, packageId),
          eq(packageAvailabilities.workspaceId, workspaceId),
          eq(packageAvailabilities.userId, user.id),
        ),
      )
      .limit(1);
    if (!availability) {
      return errorResponse(new Error("该 Skill 不在你的可用列表中"), 404);
    }

    await db.transaction(async (tx) => {
      await tx
        .delete(packageAvailabilities)
        .where(eq(packageAvailabilities.id, availability.id));
      await tx.insert(registryEvents).values({
        id: crypto.randomUUID(),
        workspaceId,
        actorUserId: user.id,
        eventType: "package.availability.removed",
        entityId: packageId,
        detailJson: JSON.stringify({
          packageKey: availability.packageKey,
          packageType: availability.packageType,
          sourceWorkspaceId: availability.sourceWorkspaceId,
        }),
      });
    });

    return Response.json({
      status: "removed",
      package: { id: packageId, name: availability.packageName },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  scheduleCapabilityMirrorExport(); // CAPABILITY-MIRROR：本次变更 debounce 快照到 OSS
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      workspaceId?: string;
      packageId?: string;
    };
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "view",
      payload,
    );
    const packageId = payload.packageId?.trim().slice(0, 120);
    if (!packageId) {
      return errorResponse(new Error("packageId 必填"));
    }

    const db = await getDb();
    const [sourcePackage] = await db
      .select()
      .from(packages)
      .where(eq(packages.id, packageId))
      .limit(1);
    if (!sourcePackage || sourcePackage.packageType !== "skill") {
      return errorResponse(new Error("共享 Skill 不存在"), 404);
    }
    if (
      !sourcePackage.enabled ||
      sourcePackage.lifecycleState !== "active" ||
      !["trusted", "reviewed"].includes(sourcePackage.trustState)
    ) {
      return errorResponse(new Error("该共享 Skill 当前不可用"), 409);
    }

    let manifest: unknown = null;
    try {
      manifest = JSON.parse(sourcePackage.manifestJson) as unknown;
    } catch {
      return errorResponse(new Error("共享 Skill Manifest 无效"), 409);
    }
    if (packageAccessScope(manifest) !== "marketplace") {
      return errorResponse(new Error("该 Skill 未开放共享"), 403);
    }

    // Packages already owned by this workspace are naturally available and
    // do not need an extra relation row.
    if (sourcePackage.workspaceId === workspaceId) {
      return Response.json({
        status: "available",
        alreadyAvailable: true,
        package: { id: sourcePackage.id, name: sourcePackage.name },
      });
    }

    const [existing] = await db
      .select({ id: packageAvailabilities.id })
      .from(packageAvailabilities)
      .where(
        and(
          eq(packageAvailabilities.packageId, sourcePackage.id),
          eq(packageAvailabilities.workspaceId, workspaceId),
          eq(packageAvailabilities.userId, user.id),
        ),
      )
      .limit(1);
    if (existing) {
      return Response.json({
        status: "available",
        alreadyAvailable: true,
        package: { id: sourcePackage.id, name: sourcePackage.name },
      });
    }

    const availabilityId = `available_${crypto.randomUUID()}`;
    const now = mysqlNow();
    await db.transaction(async (tx) => {
      await tx
        .insert(packageAvailabilities)
        .values({
          id: availabilityId,
          packageId: sourcePackage.id,
          workspaceId,
          userId: user.id,
          createdAt: now,
        })
        .onDuplicateKeyUpdate({
          set: { packageId: sourcePackage.id },
        });
      await tx.insert(registryEvents).values({
        id: crypto.randomUUID(),
        workspaceId,
        actorUserId: user.id,
        eventType: "package.availability.added",
        entityId: sourcePackage.id,
        detailJson: JSON.stringify({
          packageKey: sourcePackage.packageKey,
          packageType: sourcePackage.packageType,
          sourceWorkspaceId: sourcePackage.workspaceId,
        }),
      });
    });

    return Response.json(
      {
        status: "available",
        alreadyAvailable: false,
        package: { id: sourcePackage.id, name: sourcePackage.name },
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
