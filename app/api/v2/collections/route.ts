import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../../../../db";
import {
  assetCollectionItems,
  assetCollections,
  assets,
} from "../../../../db/schema";
import { jsonError, requireUser } from "../../../lib/auth";
import { mysqlNow } from "../../../lib/mysql";
import { requireRequestedWorkspace } from "../../../lib/workspace-context";

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "view",
    );
    const db = await getDb();
    const collections = await db
      .select()
      .from(assetCollections)
      .where(eq(assetCollections.workspaceId, workspaceId));
    const items = collections.length
      ? await db
          .select()
          .from(assetCollectionItems)
          .where(
            inArray(
              assetCollectionItems.collectionId,
              collections.map((collection) => collection.id),
            ),
          )
      : [];
    return Response.json({
      collections: collections.map((collection) => ({
        ...collection,
        assetIds: items
          .filter((item) => item.collectionId === collection.id)
          .map((item) => item.assetId),
      })),
    });
  } catch (error) {
    return jsonError(error, "读取集合失败");
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      workspaceId?: string;
      name?: string;
      description?: string;
    };
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "edit",
      payload,
    );
    const name = payload.name?.trim().slice(0, 180);
    if (!name) return Response.json({ error: "集合名称不能为空" }, { status: 400 });
    const db = await getDb();
    const id = `collection_${crypto.randomUUID()}`;
    const now = mysqlNow();
    await db.insert(assetCollections).values({
      id,
      workspaceId,
      name,
      description: payload.description?.trim().slice(0, 2_000) ?? "",
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    });
    return Response.json({ collection: { id, name } }, { status: 201 });
  } catch (error) {
    return jsonError(error, "创建集合失败");
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      workspaceId?: string;
      collectionId?: string;
      assetId?: string;
      action?: "add" | "remove";
    };
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "edit",
      payload,
    );
    if (!payload.collectionId || !payload.assetId || !payload.action) {
      return Response.json({ error: "集合操作参数无效" }, { status: 400 });
    }
    const db = await getDb();
    const [owned] = await db
      .select({ id: assetCollections.id })
      .from(assetCollections)
      .innerJoin(
        assets,
        and(
          eq(assets.id, payload.assetId),
          eq(assets.workspaceId, workspaceId),
        ),
      )
      .where(
        and(
          eq(assetCollections.id, payload.collectionId),
          eq(assetCollections.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!owned) return Response.json({ error: "集合或资产不存在" }, { status: 404 });
    if (payload.action === "add") {
      await db
        .insert(assetCollectionItems)
        .values({
          collectionId: payload.collectionId,
          assetId: payload.assetId,
          createdAt: mysqlNow(),
        })
        .onDuplicateKeyUpdate({ set: { assetId: payload.assetId } });
    } else {
      await db
        .delete(assetCollectionItems)
        .where(
          and(
            eq(assetCollectionItems.collectionId, payload.collectionId),
            eq(assetCollectionItems.assetId, payload.assetId),
          ),
        );
    }
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error, "更新集合失败");
  }
}
