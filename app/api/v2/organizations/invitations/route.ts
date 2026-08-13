import type { RowDataPacket } from "mysql2/promise";
import { jsonError, requireUser } from "../../../../lib/auth";
import { mysqlRows, mysqlTransaction } from "../../../../lib/mysql";
import { removePersonalWorkspaces } from "../../../../lib/organization-member-exit";

interface IncomingInvitationRow extends RowDataPacket {
  id: string;
  organizationId: string;
  organizationName: string;
  role: "admin" | "member";
  invitedByName: string;
  invitedByUsername: string;
  expiresAt: string;
  createdAt: string;
}

interface InvitationDecisionRow extends RowDataPacket {
  id: string;
  organizationId: string;
  inviteeUserId: string | null;
  role: "admin" | "member";
  workspaceId: string | null;
  organizationStatus: "pending" | "active" | "rejected" | "disabled";
  acceptedAt: string | null;
  declinedAt: string | null;
  revokedAt: string | null;
  expired: number;
}

function conflict(message: string, status = 409) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const invitations = await mysqlRows<IncomingInvitationRow>(
      `SELECT
         invitation.id,
         invitation.organization_id AS organizationId,
         organization.name AS organizationName,
         invitation.role,
         inviter.display_name AS invitedByName,
         inviter.username AS invitedByUsername,
         invitation.expires_at AS expiresAt,
         invitation.created_at AS createdAt
       FROM xiaoluo_v2_organization_invitations invitation
       INNER JOIN xiaoluo_v2_organizations organization
         ON organization.id = invitation.organization_id
        AND organization.status = 'active'
       INNER JOIN xiaoluo_v2_users inviter
         ON inviter.id = invitation.invited_by
       WHERE invitation.invitee_user_id = ?
         AND invitation.accepted_at IS NULL
         AND invitation.declined_at IS NULL
         AND invitation.revoked_at IS NULL
         AND invitation.expires_at > CURRENT_TIMESTAMP(3)
       ORDER BY invitation.created_at DESC`,
      [user.id],
    );
    return Response.json({ invitations });
  } catch (error) {
    return jsonError(error, "读取企业邀请失败");
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await requireUser(request);
    const body = (await request.json()) as {
      invitationId?: string;
      action?: "accept" | "decline";
    };
    const invitationId = body.invitationId?.trim() ?? "";
    if (!invitationId || (body.action !== "accept" && body.action !== "decline")) {
      return Response.json({ error: "邀请操作无效" }, { status: 400 });
    }

    await mysqlTransaction(async (connection) => {
      const [rows] = await connection.execute<InvitationDecisionRow[]>(
        `SELECT
           invitation.id,
           invitation.organization_id AS organizationId,
           invitation.invitee_user_id AS inviteeUserId,
           invitation.role,
           organization.workspace_id AS workspaceId,
           organization.status AS organizationStatus,
           invitation.accepted_at AS acceptedAt,
           invitation.declined_at AS declinedAt,
           invitation.revoked_at AS revokedAt,
           invitation.expires_at <= CURRENT_TIMESTAMP(3) AS expired
         FROM xiaoluo_v2_organization_invitations invitation
         INNER JOIN xiaoluo_v2_organizations organization
           ON organization.id = invitation.organization_id
         WHERE invitation.id = ? AND invitation.invitee_user_id = ?
         LIMIT 1
         FOR UPDATE`,
        [invitationId, user.id],
      );
      const invitation = rows[0];
      if (!invitation) throw conflict("没有找到该企业邀请", 404);
      if (invitation.acceptedAt) throw conflict("该邀请已经接受");
      if (invitation.declinedAt) throw conflict("该邀请已经拒绝");
      if (invitation.revokedAt) throw conflict("该邀请已被撤销");
      if (Number(invitation.expired)) throw conflict("该邀请已经过期");
      if (invitation.organizationStatus !== "active") {
        throw conflict("该企业当前不可加入");
      }

      if (body.action === "decline") {
        await connection.execute(
          `UPDATE xiaoluo_v2_organization_invitations
           SET declined_at = CURRENT_TIMESTAMP(3)
           WHERE id = ?`,
          [invitationId],
        );
        return;
      }

      await connection.execute(
        `INSERT INTO xiaoluo_v2_organization_members
          (organization_id, user_id, role, status)
         VALUES (?, ?, ?, 'active')
         ON DUPLICATE KEY UPDATE role = VALUES(role), status = 'active'`,
        [invitation.organizationId, user.id, invitation.role],
      );
      if (invitation.workspaceId) {
        await connection.execute(
          `INSERT INTO xiaoluo_v2_workspace_members
            (workspace_id, user_id, role)
           VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE role = VALUES(role)`,
          [
            invitation.workspaceId,
            user.id,
            invitation.role === "admin" ? "admin" : "editor",
          ],
        );
      }
      // 企业成员共享企业管理员的空间，不存在自己的个人空间：
      // 加入企业即移除其原有个人工作区及其中内容
      await removePersonalWorkspaces(connection, user.id);
      await connection.execute(
        `UPDATE xiaoluo_v2_organization_invitations
         SET accepted_by = ?, accepted_at = CURRENT_TIMESTAMP(3)
         WHERE id = ?`,
        [user.id, invitationId],
      );
    });

    return Response.json({
      message: body.action === "accept" ? "已加入企业" : "已拒绝企业邀请",
    });
  } catch (error) {
    return jsonError(error, "处理企业邀请失败");
  }
}
