import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import {
  hashPassword,
  jsonError,
  requireSystemAdmin,
} from "../../../../lib/auth";
import { runAuditedMutation } from "../../../../lib/domain-events";
import { mysqlRows } from "../../../../lib/mysql";

interface UserListRow extends RowDataPacket {
  id: string;
  username: string;
  email: string;
  displayName: string;
  phoneLast4: string | null;
  platformRole: "system_admin" | "user";
  status: "active" | "disabled";
  textCount: number | string;
  imageCount: number | string;
  videoCount: number | string;
  storageBytes: number | string;
  createdAt: string;
}

interface UserTargetRow extends RowDataPacket {
  id: string;
  username: string;
  platformRole: "system_admin" | "user";
  status: "active" | "disabled";
}

function publicUser(row: UserListRow) {
  return {
    ...row,
    textCount: Number(row.textCount || 0),
    imageCount: Number(row.imageCount || 0),
    videoCount: Number(row.videoCount || 0),
    storageBytes: Number(row.storageBytes || 0),
  };
}

export async function GET(request: Request) {
  try {
    await requireSystemAdmin(request);
    const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
    const users = await mysqlRows<UserListRow>(
      `SELECT
         u.id,
         u.username,
         u.email,
         u.display_name AS displayName,
         u.phone_last4 AS phoneLast4,
         u.platform_role AS platformRole,
         u.status,
         (
           SELECT COUNT(*)
           FROM xiaoluo_v2_model_execution_audits mea
           WHERE mea.user_id = u.id AND mea.modality = 'text'
         ) AS textCount,
         (
           SELECT COUNT(*)
           FROM xiaoluo_v2_model_execution_audits mea
           WHERE mea.user_id = u.id AND mea.modality = 'image'
         ) AS imageCount,
         (
           SELECT COUNT(*)
           FROM xiaoluo_v2_model_execution_audits mea
           WHERE mea.user_id = u.id AND mea.modality = 'video'
         ) AS videoCount,
         (
           SELECT COALESCE(SUM(a.size), 0)
           FROM xiaoluo_v2_assets a
           INNER JOIN xiaoluo_v2_workspaces w ON w.id = a.workspace_id
           WHERE w.owner_id = u.id AND a.trashed_at IS NULL
         ) AS storageBytes,
         u.created_at AS createdAt
       FROM xiaoluo_v2_users u
       WHERE u.email NOT LIKE 'deleted+%@invalid.local'
         AND (
           ? = ''
           OR u.username LIKE ?
           OR u.email LIKE ?
           OR u.display_name LIKE ?
           OR u.phone_last4 = ?
         )
       ORDER BY
         CASE WHEN u.platform_role = 'system_admin' THEN 0 ELSE 1 END,
         u.created_at DESC
       LIMIT 200`,
      [
        query,
        `%${query}%`,
        `%${query}%`,
        `%${query}%`,
        query.slice(-4),
      ],
    );
    return Response.json({ users: users.map(publicUser) });
  } catch (error) {
    return jsonError(error, "读取用户列表失败");
  }
}

export async function PATCH(request: Request) {
  try {
    const admin = await requireSystemAdmin(request);
    const body = (await request.json()) as {
      userId?: string;
      status?: "active" | "disabled";
    };
    if (
      !body.userId ||
      (body.status !== "active" && body.status !== "disabled")
    ) {
      return Response.json({ error: "用户状态无效" }, { status: 400 });
    }
    if (body.userId === admin.id && body.status === "disabled") {
      return Response.json(
        { error: "系统管理员不能停用自己的账号" },
        { status: 409 },
      );
    }

    await runAuditedMutation(
      {
        actorUserId: admin.id,
        eventType: "admin.user.status_changed",
        entityType: "user",
        entityId: body.userId,
        detail: { status: body.status },
      },
      async (connection) => {
        const [result] = await connection.execute<ResultSetHeader>(
          `UPDATE xiaoluo_v2_users
           SET status = ?, updated_at = CURRENT_TIMESTAMP(3)
           WHERE id = ? AND platform_role = 'user'`,
          [body.status, body.userId],
        );
        if (!result.affectedRows) {
          throw new Response(
            JSON.stringify({ error: "用户不存在或不能修改系统管理员" }),
            {
              status: 404,
              headers: { "content-type": "application/json; charset=utf-8" },
            },
          );
        }
        if (body.status === "disabled") {
          await connection.execute(
            "DELETE FROM xiaoluo_v2_auth_sessions WHERE user_id = ?",
            [body.userId],
          );
        }
      },
    );
    return Response.json({ message: "用户状态已更新" });
  } catch (error) {
    return jsonError(error, "更新用户状态失败");
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireSystemAdmin(request);
    const body = (await request.json()) as {
      userId?: string;
      newPassword?: string;
    };
    if (!body.userId || !body.newPassword) {
      return Response.json({ error: "用户与新密码不能为空" }, { status: 400 });
    }
    if (body.newPassword.length < 6 || body.newPassword.length > 128) {
      return Response.json(
        { error: "密码长度必须为 6–128 位" },
        { status: 400 },
      );
    }
    const passwordHash = await hashPassword(body.newPassword);

    await runAuditedMutation(
      {
        actorUserId: admin.id,
        eventType: "admin.user.password_reset",
        entityType: "user",
        entityId: body.userId,
      },
      async (connection) => {
        const [result] = await connection.execute<ResultSetHeader>(
          `UPDATE xiaoluo_v2_users
           SET password_hash = ?,
               password_changed_at = CURRENT_TIMESTAMP(3),
               updated_at = CURRENT_TIMESTAMP(3)
           WHERE id = ? AND platform_role = 'user'`,
          [passwordHash, body.userId],
        );
        if (!result.affectedRows) {
          throw new Response(
            JSON.stringify({ error: "用户不存在或不能重置系统管理员密码" }),
            {
              status: 404,
              headers: { "content-type": "application/json; charset=utf-8" },
            },
          );
        }
        await connection.execute(
          "DELETE FROM xiaoluo_v2_auth_sessions WHERE user_id = ?",
          [body.userId],
        );
        await connection.execute(
          "DELETE FROM xiaoluo_v2_password_reset_tokens WHERE user_id = ?",
          [body.userId],
        );
      },
    );
    return Response.json({
      message: "密码已重置，该用户的所有登录会话已退出",
    });
  } catch (error) {
    return jsonError(error, "重置用户密码失败");
  }
}

export async function DELETE(request: Request) {
  try {
    const admin = await requireSystemAdmin(request);
    const body = (await request.json()) as { userId?: string };
    if (!body.userId) {
      return Response.json({ error: "用户不能为空" }, { status: 400 });
    }
    if (body.userId === admin.id) {
      return Response.json(
        { error: "系统管理员不能删除自己的账号" },
        { status: 409 },
      );
    }

    const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 20);
    const tombstoneUsername = `deleted_${suffix}`;
    const tombstoneEmail = `deleted+${suffix}@invalid.local`;
    const tombstonePassword = await hashPassword(
      `${crypto.randomUUID()}${crypto.randomUUID()}`,
    );

    await runAuditedMutation(
      {
        actorUserId: admin.id,
        eventType: "admin.user.deleted",
        entityType: "user",
        entityId: body.userId,
        detail: { deletionMode: "anonymized" },
      },
      async (connection) => {
        const [targets] = await connection.execute<UserTargetRow[]>(
          `SELECT id, username, platform_role AS platformRole, status
           FROM xiaoluo_v2_users
           WHERE id = ?
           LIMIT 1
           FOR UPDATE`,
          [body.userId],
        );
        const target = targets[0];
        if (!target || target.platformRole !== "user") {
          throw new Response(
            JSON.stringify({ error: "用户不存在或不能删除系统管理员" }),
            {
              status: 404,
              headers: { "content-type": "application/json; charset=utf-8" },
            },
          );
        }

        await connection.execute(
          `UPDATE xiaoluo_v2_users
           SET username = ?,
               email = ?,
               display_name = '已删除用户',
               password_hash = ?,
               phone_hash = NULL,
               phone_last4 = NULL,
               phone_verified_at = NULL,
               status = 'disabled',
               password_changed_at = CURRENT_TIMESTAMP(3),
               updated_at = CURRENT_TIMESTAMP(3)
           WHERE id = ?`,
          [tombstoneUsername, tombstoneEmail, tombstonePassword, body.userId],
        );
        await connection.execute(
          "DELETE FROM xiaoluo_v2_auth_sessions WHERE user_id = ?",
          [body.userId],
        );
        await connection.execute(
          "DELETE FROM xiaoluo_v2_password_reset_tokens WHERE user_id = ?",
          [body.userId],
        );
        await connection.execute(
          "DELETE FROM xiaoluo_v2_workspace_members WHERE user_id = ?",
          [body.userId],
        );
        await connection.execute(
          `UPDATE xiaoluo_v2_organization_members
           SET status = 'disabled', updated_at = CURRENT_TIMESTAMP(3)
           WHERE user_id = ?`,
          [body.userId],
        );
        await connection.execute(
          "DELETE FROM xiaoluo_v2_resource_permissions WHERE user_id = ?",
          [body.userId],
        );
      },
    );
    return Response.json({
      message: "用户已删除，身份信息已匿名化，历史资产与审计记录已保留",
    });
  } catch (error) {
    return jsonError(error, "删除用户失败");
  }
}
