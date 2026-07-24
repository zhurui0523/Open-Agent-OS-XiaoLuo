import type { RowDataPacket } from "mysql2/promise";
import { jsonError, requireUser } from "../../../../lib/auth";
import { requireOrganizationAccess } from "../../../../lib/organization-auth";
import { phoneLookupHash } from "../../../../lib/phone-auth";
import { mysqlRows, mysqlTransaction } from "../../../../lib/mysql";

interface MemberRow extends RowDataPacket {
  userId: string;
  displayName: string;
  email: string;
  phoneLast4: string | null;
  role: "admin" | "member";
  status: "active" | "disabled";
  createdAt: string;
}

interface UserRow extends RowDataPacket {
  id: string;
}

interface AdminCountRow extends RowDataPacket {
  total: number;
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const organizationId = new URL(request.url).searchParams.get("organizationId");
    if (!organizationId) {
      return Response.json({ error: "缺少企业 ID" }, { status: 400 });
    }
    await requireOrganizationAccess(user.id, organizationId);
    const members = await mysqlRows<MemberRow>(
      `SELECT
         u.id AS userId,
         u.display_name AS displayName,
         u.email,
         u.phone_last4 AS phoneLast4,
         om.role,
         om.status,
         om.created_at AS createdAt
       FROM xiaoluo_v2_organization_members om
       INNER JOIN xiaoluo_v2_users u ON u.id = om.user_id
       WHERE om.organization_id = ?
       ORDER BY FIELD(om.role, 'admin', 'member'), om.created_at`,
      [organizationId],
    );
    return Response.json({ members });
  } catch (error) {
    return jsonError(error, "读取企业成员失败");
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireUser(request);
    const body = (await request.json()) as {
      organizationId?: string;
      phone?: string;
      role?: "admin" | "member";
    };
    const organizationId = body.organizationId ?? "";
    const role = body.role === "admin" ? "admin" : "member";
    const access = await requireOrganizationAccess(
      actor.id,
      organizationId,
      true,
    );
    const phoneHash = await phoneLookupHash(body.phone ?? "");
    const users = await mysqlRows<UserRow>(
      `SELECT id
       FROM xiaoluo_v2_users
       WHERE phone_hash = ? AND status = 'active'
       LIMIT 1`,
      [phoneHash],
    );
    const member = users[0];
    if (!member) {
      return Response.json(
        { error: "该手机号尚未注册，请先让用户完成注册" },
        { status: 404 },
      );
    }
    await mysqlTransaction(async (connection) => {
      await connection.execute(
        `INSERT INTO xiaoluo_v2_organization_members
          (organization_id, user_id, role, status)
         VALUES (?, ?, ?, 'active')
         ON DUPLICATE KEY UPDATE role = VALUES(role), status = 'active'`,
        [organizationId, member.id, role],
      );
      if (access.workspaceId) {
        await connection.execute(
          `INSERT INTO xiaoluo_v2_workspace_members
            (workspace_id, user_id, role)
           VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE role = VALUES(role)`,
          [
            access.workspaceId,
            member.id,
            role === "admin" ? "admin" : "editor",
          ],
        );
      }
    });
    return Response.json({ message: "企业成员已添加" }, { status: 201 });
  } catch (error) {
    return jsonError(error, "添加企业成员失败");
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = await requireUser(request);
    const body = (await request.json()) as {
      organizationId?: string;
      userId?: string;
      role?: "admin" | "member";
      status?: "active" | "disabled";
    };
    const organizationId = body.organizationId ?? "";
    const targetUserId = body.userId ?? "";
    const access = await requireOrganizationAccess(
      actor.id,
      organizationId,
      true,
    );
    if (
      (body.role && body.role !== "admin" && body.role !== "member") ||
      (body.status && body.status !== "active" && body.status !== "disabled")
    ) {
      return Response.json({ error: "成员状态无效" }, { status: 400 });
    }
    await mysqlTransaction(async (connection) => {
      if (body.role === "member" || body.status === "disabled") {
        const [counts] = await connection.execute<AdminCountRow[]>(
          `SELECT COUNT(*) AS total
           FROM xiaoluo_v2_organization_members
           WHERE organization_id = ?
             AND role = 'admin'
             AND status = 'active'
             AND user_id <> ?`,
          [organizationId, targetUserId],
        );
        if (Number(counts[0]?.total ?? 0) < 1) {
          throw new Response(
            JSON.stringify({ error: "企业必须至少保留一名启用的管理员" }),
            {
              status: 409,
              headers: { "content-type": "application/json; charset=utf-8" },
            },
          );
        }
      }
      await connection.execute(
        `UPDATE xiaoluo_v2_organization_members
         SET role = COALESCE(?, role),
             status = COALESCE(?, status)
         WHERE organization_id = ? AND user_id = ?`,
        [
          body.role ?? null,
          body.status ?? null,
          organizationId,
          targetUserId,
        ],
      );
      if (access.workspaceId) {
        if (body.status === "disabled") {
          await connection.execute(
            `DELETE FROM xiaoluo_v2_workspace_members
             WHERE workspace_id = ? AND user_id = ?`,
            [access.workspaceId, targetUserId],
          );
        } else if (body.role) {
          await connection.execute(
            `UPDATE xiaoluo_v2_workspace_members
             SET role = ?
             WHERE workspace_id = ? AND user_id = ?`,
            [
              body.role === "admin" ? "admin" : "editor",
              access.workspaceId,
              targetUserId,
            ],
          );
        }
      }
    });
    return Response.json({ message: "成员权限已更新" });
  } catch (error) {
    return jsonError(error, "更新企业成员失败");
  }
}

