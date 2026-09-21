import type { RowDataPacket } from "mysql2/promise";
import { jsonError, requireUser } from "../../../../lib/auth";
import { requireOrganizationAccess } from "../../../../lib/organization-auth";
import { phoneLookupHash, sha256Hex } from "../../../../lib/phone-auth";
import { mysqlRows, mysqlTransaction } from "../../../../lib/mysql";
import { purgeEnterpriseMemberContent } from "../../../../lib/organization-member-exit";
import { ensureUserHome } from "../../../../lib/workspace-store";

interface MemberRow extends RowDataPacket {
  userId: string;
  username: string;
  displayName: string;
  email: string;
  phoneLast4: string | null;
  role: "admin" | "member";
  status: "active" | "disabled";
  textCount: number | string;
  imageCount: number | string;
  videoCount: number | string;
  audioCount: number | string;
  storageBytes: number | string;
  createdAt: string;
}

interface UserRow extends RowDataPacket {
  id: string;
  username: string;
  displayName: string;
  phoneHash: string | null;
  phoneLast4: string | null;
}

interface InvitationRow extends RowDataPacket {
  id: string;
  inviteeUserId: string;
  username: string;
  displayName: string;
  phoneLast4: string | null;
  role: "admin" | "member";
  expiresAt: string;
  createdAt: string;
}

interface AdminCountRow extends RowDataPacket {
  total: number;
}

interface MemberStateRow extends RowDataPacket {
  role: "admin" | "member";
  status: "active" | "disabled";
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const organizationId = new URL(request.url).searchParams.get("organizationId");
    if (!organizationId) {
      return Response.json({ error: "缺少企业 ID" }, { status: 400 });
    }
    const access = await requireOrganizationAccess(user.id, organizationId);
    const members = await mysqlRows<MemberRow>(
      `SELECT
         u.id AS userId,
         u.username,
         u.display_name AS displayName,
         u.email,
         u.phone_last4 AS phoneLast4,
         om.role,
         om.status,
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
           SELECT COUNT(*)
           FROM xiaoluo_v2_model_execution_audits mea
           WHERE mea.user_id = u.id AND mea.modality = 'audio'
         ) AS audioCount,
         (
           SELECT COALESCE(SUM(a.size), 0)
           FROM xiaoluo_v2_assets a
           INNER JOIN xiaoluo_v2_workspaces w ON w.id = a.workspace_id
           WHERE w.owner_id = u.id AND a.trashed_at IS NULL
         ) AS storageBytes,
         om.created_at AS createdAt
       FROM xiaoluo_v2_organization_members om
       INNER JOIN xiaoluo_v2_users u ON u.id = om.user_id
       WHERE om.organization_id = ?
       ORDER BY FIELD(om.role, 'admin', 'member'), om.created_at`,
      [organizationId],
    );
    const invitations =
      access.role === "admin"
        ? await mysqlRows<InvitationRow>(
            `SELECT
               invitation.id,
               invitation.invitee_user_id AS inviteeUserId,
               invitee.username,
               invitee.display_name AS displayName,
               invitee.phone_last4 AS phoneLast4,
               invitation.role,
               invitation.expires_at AS expiresAt,
               invitation.created_at AS createdAt
             FROM xiaoluo_v2_organization_invitations invitation
             INNER JOIN xiaoluo_v2_users invitee
               ON invitee.id = invitation.invitee_user_id
             WHERE invitation.organization_id = ?
               AND invitation.accepted_at IS NULL
               AND invitation.declined_at IS NULL
               AND invitation.revoked_at IS NULL
               AND invitation.expires_at > CURRENT_TIMESTAMP(3)
             ORDER BY invitation.created_at DESC`,
            [organizationId],
          )
        : [];
    // 数值字段统一转为 number，供前端“企业成员使用情况”展示
    const membersWithUsage = members.map((member) => ({
      ...member,
      textCount: Number(member.textCount || 0),
      imageCount: Number(member.imageCount || 0),
      videoCount: Number(member.videoCount || 0),
      audioCount: Number(member.audioCount || 0),
      storageBytes: Number(member.storageBytes || 0),
    }));
    return Response.json({ members: membersWithUsage, invitations });
  } catch (error) {
    return jsonError(error, "读取企业成员失败");
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireUser(request);
    const body = (await request.json()) as {
      organizationId?: string;
      identifier?: string;
      phone?: string;
      role?: "admin" | "member";
    };
    const organizationId = body.organizationId ?? "";
    const role = body.role === "admin" ? "admin" : "member";
    await requireOrganizationAccess(actor.id, organizationId, true);
    const identifier = (body.identifier ?? body.phone ?? "").trim();
    if (!identifier || identifier.length > 64) {
      return Response.json(
        { error: "请输入有效的用户名或手机号" },
        { status: 400 },
      );
    }
    const usernameOnly = identifier.startsWith("@");
    const username = identifier.replace(/^@/, "").toLowerCase();
    let phoneHash: string | null = null;
    if (!usernameOnly) {
      try {
        phoneHash = await phoneLookupHash(identifier);
      } catch {
        // A non-phone identifier is looked up as a username below.
      }
    }
    let users: UserRow[] = [];
    if (phoneHash) {
      users = await mysqlRows<UserRow>(
        `SELECT
           id,
           username,
           display_name AS displayName,
           phone_hash AS phoneHash,
           phone_last4 AS phoneLast4
         FROM xiaoluo_v2_users
         WHERE status = 'active' AND phone_hash = ?
         LIMIT 1`,
        [phoneHash],
      );
    }
    if (!users.length) {
      users = await mysqlRows<UserRow>(
        `SELECT
           id,
           username,
           display_name AS displayName,
           phone_hash AS phoneHash,
           phone_last4 AS phoneLast4
         FROM xiaoluo_v2_users
         WHERE status = 'active' AND username = ?
         LIMIT 1`,
        [username],
      );
    }
    const invitee = users[0];
    if (!invitee) {
      return Response.json(
        { error: "没有找到该用户名或手机号对应的已启用账户" },
        { status: 404 },
      );
    }
    if (invitee.id === actor.id) {
      return Response.json(
        { error: "你已经是该企业的管理员" },
        { status: 409 },
      );
    }
    const existingMembers = await mysqlRows<RowDataPacket>(
      `SELECT 1
       FROM xiaoluo_v2_organization_members
       WHERE organization_id = ? AND user_id = ?
       LIMIT 1`,
      [organizationId, invitee.id],
    );
    if (existingMembers.length) {
      return Response.json(
        { error: "该用户已在企业成员列表中" },
        { status: 409 },
      );
    }
    const pendingInvitations = await mysqlRows<RowDataPacket>(
      `SELECT 1
       FROM xiaoluo_v2_organization_invitations
       WHERE organization_id = ?
         AND invitee_user_id = ?
         AND accepted_at IS NULL
         AND declined_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > CURRENT_TIMESTAMP(3)
       LIMIT 1`,
      [organizationId, invitee.id],
    );
    if (pendingInvitations.length) {
      return Response.json(
        { error: "已向该用户发送邀请，请等待对方确认" },
        { status: 409 },
      );
    }
    const invitationId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await mysqlTransaction(async (connection) => {
      await connection.execute(
        `INSERT INTO xiaoluo_v2_organization_invitations
          (id, organization_id, invitee_user_id, phone_hash, phone_last4,
           role, token_hash, invited_by, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          invitationId,
          organizationId,
          invitee.id,
          invitee.phoneHash,
          invitee.phoneLast4,
          role,
          await sha256Hex(crypto.randomUUID()),
          actor.id,
          expiresAt,
        ],
      );
    });
    return Response.json(
      {
        message: "邀请已发送，等待对方确认",
        invitation: {
          id: invitationId,
          inviteeUserId: invitee.id,
          username: invitee.username,
          displayName: invitee.displayName,
          phoneLast4: invitee.phoneLast4,
          role,
          expiresAt: expiresAt.toISOString(),
        },
      },
      { status: 201 },
    );
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

export async function DELETE(request: Request) {
  try {
    const actor = await requireUser(request);
    const body = (await request.json()) as {
      organizationId?: string;
      userId?: string;
    };
    const organizationId = body.organizationId ?? "";
    const targetUserId = body.userId ?? "";
    if (!organizationId || !targetUserId) {
      return Response.json(
        { error: "缺少企业或成员信息" },
        { status: 400 },
      );
    }
    if (targetUserId === actor.id) {
      return Response.json(
        { error: "不能将自己移出企业" },
        { status: 409 },
      );
    }

    const access = await requireOrganizationAccess(
      actor.id,
      organizationId,
      true,
    );
    const removedUsers = await mysqlRows<RowDataPacket & { displayName: string }>(
      `SELECT display_name AS displayName FROM xiaoluo_v2_users WHERE id = ?`,
      [targetUserId],
    );
    await mysqlTransaction(async (connection) => {
      const [members] = await connection.execute<MemberStateRow[]>(
        `SELECT role, status
         FROM xiaoluo_v2_organization_members
         WHERE organization_id = ? AND user_id = ?
         LIMIT 1
         FOR UPDATE`,
        [organizationId, targetUserId],
      );
      const member = members[0];
      if (!member) {
        throw new Response(
          JSON.stringify({ error: "该用户不在企业成员列表中" }),
          {
            status: 404,
            headers: { "content-type": "application/json; charset=utf-8" },
          },
        );
      }
      if (member.status !== "disabled") {
        throw new Response(
          JSON.stringify({ error: "请先停用该成员，再将其移出企业" }),
          {
            status: 409,
            headers: { "content-type": "application/json; charset=utf-8" },
          },
        );
      }

      // 移除即清除其在企业期间产生的全部内容，转为普通用户后不再保留任何企业工作资产
      await purgeEnterpriseMemberContent(
        connection,
        organizationId,
        access.workspaceId ?? null,
        targetUserId,
      );
      if (access.workspaceId) {
        await connection.execute(
          `DELETE FROM xiaoluo_v2_workspace_members
           WHERE workspace_id = ? AND user_id = ?`,
          [access.workspaceId, targetUserId],
        );
      }
      await connection.execute(
        `DELETE FROM xiaoluo_v2_organization_members
         WHERE organization_id = ? AND user_id = ?`,
        [organizationId, targetUserId],
      );
    });
    // 转为普通用户后，为其重建一个全新的空个人空间
    await ensureUserHome(
      targetUserId,
      (removedUsers[0]?.displayName as string | undefined) ?? "用户",
    );

    return Response.json({ message: "成员已从企业中移除" });
  } catch (error) {
    return jsonError(error, "移除企业成员失败");
  }
}
