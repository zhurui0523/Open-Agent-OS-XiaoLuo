import { and, asc, eq } from "drizzle-orm";
import { getDb } from "../../../../db";
import {
  assets,
  assetFolders,
  registryEvents,
} from "../../../../db/schema";
import type { FileSystemFolder } from "../../../types";
import { requireWorkspaceContext } from "../../../lib/cloud-context";
import { mysqlNow } from "../../../lib/mysql";

function errorResponse(error: unknown, status = 400) {
  if (error instanceof Response) return error;
  return Response.json(
    { error: error instanceof Error ? error.message : "文件夹操作失败" },
    { status },
  );
}

function cleanFolderName(value: string) {
  const name = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  if (!name) throw new Error("文件夹名称不能为空");
  return name.slice(0, 80);
}

function serializeFolder(
  row: typeof assetFolders.$inferSelect,
): FileSystemFolder {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parentId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function GET(request: Request) {
  try {
    const { home } = await requireWorkspaceContext(request);
    const db = await getDb();
    const rows = await db
      .select()
      .from(assetFolders)
      .where(eq(assetFolders.workspaceId, home.workspaceId))
      .orderBy(asc(assetFolders.name));
    return Response.json({ folders: rows.map(serializeFolder) });
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export async function POST(request: Request) {
  try {
    const { user, home } = await requireWorkspaceContext(request);
    const payload = (await request.json()) as {
      name?: string;
      parentId?: string | null;
    };
    const name = cleanFolderName(payload.name ?? "");
    const db = await getDb();
    const now = mysqlNow();
    const id = `folder_${crypto.randomUUID()}`;
    await db
      .insert(assetFolders)
      .values({
        id,
        workspaceId: home.workspaceId,
        name,
        parentId: payload.parentId || null,
        createdAt: now,
        updatedAt: now,
      });
    const [folder] = await db
      .select()
      .from(assetFolders)
      .where(
        and(
          eq(assetFolders.id, id),
          eq(assetFolders.workspaceId, home.workspaceId),
        ),
      )
      .limit(1);
    if (!folder) throw new Error("文件夹创建后无法读取");
    await db.insert(registryEvents).values({
      id: crypto.randomUUID(),
      workspaceId: home.workspaceId,
      actorUserId: user.id,
      eventType: "folder.created",
      entityId: folder.id,
      detailJson: JSON.stringify({ parentId: folder.parentId }),
    });
    return Response.json({ folder: serializeFolder(folder) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const { home } = await requireWorkspaceContext(request);
    const payload = (await request.json()) as { id?: string; name?: string };
    if (!payload.id) throw new Error("文件夹 ID 必填");
    const db = await getDb();
    await db
      .update(assetFolders)
      .set({
        name: cleanFolderName(payload.name ?? ""),
        updatedAt: mysqlNow(),
      })
      .where(
        and(
          eq(assetFolders.id, payload.id),
          eq(assetFolders.workspaceId, home.workspaceId),
        ),
      );
    const [folder] = await db
      .select()
      .from(assetFolders)
      .where(
        and(
          eq(assetFolders.id, payload.id),
          eq(assetFolders.workspaceId, home.workspaceId),
        ),
      )
      .limit(1);
    if (!folder) return errorResponse(new Error("文件夹不存在"), 404);
    return Response.json({ folder: serializeFolder(folder) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const { home } = await requireWorkspaceContext(request);
    const id = new URL(request.url).searchParams.get("id")?.trim();
    if (!id) throw new Error("文件夹 ID 必填");
    const db = await getDb();
    const [file] = await db
      .select({ id: assets.id })
      .from(assets)
      .where(
        and(
          eq(assets.folderId, id),
          eq(assets.workspaceId, home.workspaceId),
        ),
      )
      .limit(1);
    const [child] = await db
      .select({ id: assetFolders.id })
      .from(assetFolders)
      .where(
        and(
          eq(assetFolders.parentId, id),
          eq(assetFolders.workspaceId, home.workspaceId),
        ),
      )
      .limit(1);
    if (file || child) {
      return errorResponse(new Error("文件夹非空，请先移动其中内容"), 409);
    }
    const [folder] = await db
      .select({ id: assetFolders.id })
      .from(assetFolders)
      .where(
        and(
          eq(assetFolders.id, id),
          eq(assetFolders.workspaceId, home.workspaceId),
        ),
      )
      .limit(1);
    if (!folder) return errorResponse(new Error("文件夹不存在"), 404);
    await db
      .delete(assetFolders)
      .where(
        and(
          eq(assetFolders.id, id),
          eq(assetFolders.workspaceId, home.workspaceId),
        ),
      );
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
