import type { RowDataPacket } from "mysql2/promise";
import { jsonError, requireSystemAdmin } from "../../../../../lib/auth";
import { runAuditedMutation } from "../../../../../lib/domain-events";
import {
  MAX_STORAGE_QUOTA_BYTES,
  resolveStorageQuotaBytes,
  storageIncreaseBytes,
} from "../../../../../lib/storage-quota";

type StorageAccountType =
  | "system_admin"
  | "ordinary_user"
  | "enterprise_admin"
  | "enterprise_member";

interface StorageTargetRow extends RowDataPacket {
  id: string;
  username: string;
  platformRole: "system_admin" | "user";
  storageQuotaBytes: number | string | null;
  accountType: StorageAccountType;
}

export async function POST(request: Request) {
  try {
    const admin = await requireSystemAdmin(request);
    const body = (await request.json()) as {
      userId?: string;
      increaseGiB?: unknown;
    };
    const userId = body.userId?.trim() ?? "";
    const increaseBytes = storageIncreaseBytes(body.increaseGiB);
    if (!userId || increaseBytes === null) {
      return Response.json(
        { error: "请选择用户，并输入 1–1024 GB 的整数容量" },
        { status: 400 },
      );
    }

    const auditDetail: Record<string, unknown> = { increaseBytes };
    const updated = await runAuditedMutation(
      {
        actorUserId: admin.id,
        eventType: "admin.user.storage_increased",
        entityType: "user",
        entityId: userId,
        detail: auditDetail,
      },
      async (connection) => {
        const [targets] = await connection.execute<StorageTargetRow[]>(
          `SELECT
             u.id,
             u.username,
             u.platform_role AS platformRole,
             u.storage_quota_bytes AS storageQuotaBytes,
             CASE
               WHEN u.platform_role = 'system_admin' THEN 'system_admin'
               WHEN EXISTS (
                 SELECT 1
                 FROM xiaoluo_v2_organization_members organization_admin
                 WHERE organization_admin.user_id = u.id
                   AND organization_admin.status = 'active'
                   AND organization_admin.role = 'admin'
               ) THEN 'enterprise_admin'
               WHEN EXISTS (
                 SELECT 1
                 FROM xiaoluo_v2_organization_members organization_member
                 WHERE organization_member.user_id = u.id
                   AND organization_member.status = 'active'
                   AND organization_member.role = 'member'
               ) THEN 'enterprise_member'
               ELSE 'ordinary_user'
             END AS accountType
           FROM xiaoluo_v2_users u
           WHERE u.id = ?
           LIMIT 1
           FOR UPDATE`,
          [userId],
        );
        const target = targets[0];
        if (!target || target.platformRole !== "user") {
          throw new Response(
            JSON.stringify({ error: "用户不存在或不能调整系统管理员空间" }),
            {
              status: 404,
              headers: { "content-type": "application/json; charset=utf-8" },
            },
          );
        }
        if (target.accountType === "enterprise_member") {
          throw new Response(
            JSON.stringify({ error: "企业成员不支持单独增加空间" }),
            {
              status: 409,
              headers: { "content-type": "application/json; charset=utf-8" },
            },
          );
        }

        const previousQuotaBytes = resolveStorageQuotaBytes(
          target.storageQuotaBytes,
        );
        const storageQuotaBytes = previousQuotaBytes + increaseBytes;
        if (storageQuotaBytes > MAX_STORAGE_QUOTA_BYTES) {
          throw new Response(
            JSON.stringify({ error: "用户总空间不能超过 100 TB" }),
            {
              status: 409,
              headers: { "content-type": "application/json; charset=utf-8" },
            },
          );
        }

        await connection.execute(
          `UPDATE xiaoluo_v2_users
           SET storage_quota_bytes = ?, updated_at = CURRENT_TIMESTAMP(3)
           WHERE id = ?`,
          [storageQuotaBytes, userId],
        );
        Object.assign(auditDetail, {
          username: target.username,
          accountType: target.accountType,
          previousQuotaBytes,
          storageQuotaBytes,
        });
        return { storageQuotaBytes };
      },
    );

    return Response.json({
      message: "用户空间已增加",
      storageQuotaBytes: updated.storageQuotaBytes,
    });
  } catch (error) {
    return jsonError(error, "增加用户空间失败");
  }
}
