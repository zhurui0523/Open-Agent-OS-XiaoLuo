import { jsonError, requireUser } from "../../../lib/auth";
import { requireWorkspaceAccess } from "../../../lib/authorization";
import { mysqlExecute, mysqlNow, mysqlTransaction } from "../../../lib/mysql";
import { listUserWorkspaces } from "../../../lib/workspace-store";

function cleanName(value: unknown, fallback: string) {
  const name = typeof value === "string" ? value.trim().slice(0, 120) : "";
  return name || fallback;
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    return Response.json({ workspaces: await listUserWorkspaces(user.id) });
  } catch (error) {
    return jsonError(error, "读取工作区失败");
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as { name?: string };
    const name = cleanName(payload.name, "新的工作区");
    const workspaceId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const canvasId = crypto.randomUUID();
    await mysqlTransaction(async (connection) => {
      await connection.execute(
        `INSERT INTO xiaoluo_v2_workspaces
          (id, name, owner_id, status)
         VALUES (?, ?, ?, 'active')`,
        [workspaceId, name, user.id],
      );
      await connection.execute(
        `INSERT INTO xiaoluo_v2_workspace_members
          (workspace_id, user_id, role)
         VALUES (?, ?, 'owner')`,
        [workspaceId, user.id],
      );
      await connection.execute(
        `INSERT INTO xiaoluo_v2_projects
          (id, workspace_id, name, description, status, created_by)
         VALUES (?, ?, '默认项目', '', 'active', ?)`,
        [projectId, workspaceId, user.id],
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
      { workspace: { id: workspaceId, name }, projectId, canvasId },
      { status: 201 },
    );
  } catch (error) {
    return jsonError(error, "创建工作区失败");
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await requireUser(request);
    const payload = (await request.json()) as {
      id?: string;
      action?: "rename" | "archive" | "restore";
      name?: string;
    };
    if (!payload.id || !payload.action) {
      return Response.json({ error: "工作区参数无效" }, { status: 400 });
    }
    await requireWorkspaceAccess(user.id, payload.id, "manage");
    const now = mysqlNow();
    if (payload.action === "rename") {
      await mysqlExecute(
        `UPDATE xiaoluo_v2_workspaces
         SET name = ?, updated_at = ?
         WHERE id = ? AND status <> 'trashed'`,
        [cleanName(payload.name, "未命名工作区"), now, payload.id],
      );
    } else {
      await mysqlExecute(
        `UPDATE xiaoluo_v2_workspaces
         SET status = ?, deleted_at = NULL, updated_at = ?
         WHERE id = ?`,
        [payload.action === "archive" ? "archived" : "active", now, payload.id],
      );
    }
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error, "更新工作区失败");
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireUser(request);
    const id = new URL(request.url).searchParams.get("id")?.trim();
    if (!id) return Response.json({ error: "工作区 ID 必填" }, { status: 400 });
    await requireWorkspaceAccess(user.id, id, "manage");
    await mysqlExecute(
      `UPDATE xiaoluo_v2_workspaces
       SET status = 'trashed',
           deleted_at = CURRENT_TIMESTAMP(3),
           updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?`,
      [id],
    );
    return Response.json({ ok: true, recoverableDays: 30 });
  } catch (error) {
    return jsonError(error, "删除工作区失败");
  }
}
