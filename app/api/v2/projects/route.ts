import type { RowDataPacket } from "mysql2/promise";
import { jsonError, requireUser } from "../../../lib/auth";
import {
  requireProjectAccess,
  requireWorkspaceAccess,
} from "../../../lib/authorization";
import { mysqlExecute, mysqlRows, mysqlTransaction } from "../../../lib/mysql";

interface ProjectRow extends RowDataPacket {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  status: "active" | "archived" | "trashed";
  createdAt: string;
  updatedAt: string;
}

function clean(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const workspaceId = new URL(request.url).searchParams
      .get("workspaceId")
      ?.trim();
    if (!workspaceId) {
      return Response.json({ error: "workspaceId 必填" }, { status: 400 });
    }
    await requireWorkspaceAccess(user.id, workspaceId, "view");
    const projects = await mysqlRows<ProjectRow>(
      `SELECT
         id,
         workspace_id AS workspaceId,
         name,
         description,
         status,
         created_at AS createdAt,
         updated_at AS updatedAt
       FROM xiaoluo_v2_projects
       WHERE workspace_id = ?
       ORDER BY
         CASE status WHEN 'active' THEN 0 WHEN 'archived' THEN 1 ELSE 2 END,
         updated_at DESC`,
      [workspaceId],
    );
    return Response.json({ projects });
  } catch (error) {
    return jsonError(error, "读取项目失败");
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
    if (!payload.workspaceId) {
      return Response.json({ error: "workspaceId 必填" }, { status: 400 });
    }
    await requireWorkspaceAccess(user.id, payload.workspaceId, "edit");
    const workspaceId = payload.workspaceId;
    const projectId = crypto.randomUUID();
    const canvasId = crypto.randomUUID();
    const name = clean(payload.name, 160) || "新的项目";
    await mysqlTransaction(async (connection) => {
      await connection.execute(
        `INSERT INTO xiaoluo_v2_projects
          (id, workspace_id, name, description, status, created_by)
         VALUES (?, ?, ?, ?, 'active', ?)`,
        [
          projectId,
          workspaceId,
          name,
          clean(payload.description, 2_000),
          user.id,
        ],
      );
      await connection.execute(
        `INSERT INTO xiaoluo_v2_canvases
          (id, project_id, title, viewport_json, created_by)
         VALUES (?, ?, '灵境画布', ?, ?)`,
        [
          canvasId,
          projectId,
          JSON.stringify({ x: 0, y: 0, zoom: 92 }),
          user.id,
        ],
      );
    });
    return Response.json(
      { project: { id: projectId, name }, canvasId },
      { status: 201 },
    );
  } catch (error) {
    return jsonError(error, "创建项目失败");
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      id?: string;
      action?: "update" | "archive" | "restore";
      name?: string;
      description?: string;
    };
    if (!payload.id || !payload.action) {
      return Response.json({ error: "项目参数无效" }, { status: 400 });
    }
    await requireProjectAccess(user.id, payload.id, "manage");
    if (payload.action === "update") {
      await mysqlExecute(
        `UPDATE xiaoluo_v2_projects
         SET name = COALESCE(NULLIF(?, ''), name),
             description = COALESCE(?, description),
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND status <> 'trashed'`,
        [
          clean(payload.name, 160),
          payload.description === undefined
            ? null
            : clean(payload.description, 2_000),
          payload.id,
        ],
      );
    } else {
      await mysqlExecute(
        `UPDATE xiaoluo_v2_projects
         SET status = ?, deleted_at = NULL, updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?`,
        [payload.action === "archive" ? "archived" : "active", payload.id],
      );
    }
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error, "更新项目失败");
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireUser(request);
    const id = new URL(request.url).searchParams.get("id")?.trim();
    if (!id) return Response.json({ error: "项目 ID 必填" }, { status: 400 });
    await requireProjectAccess(user.id, id, "manage");
    await mysqlExecute(
      `UPDATE xiaoluo_v2_projects
       SET status = 'trashed',
           deleted_at = CURRENT_TIMESTAMP(3),
           updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?`,
      [id],
    );
    return Response.json({ ok: true, recoverableDays: 30 });
  } catch (error) {
    return jsonError(error, "删除项目失败");
  }
}
