import type { RowDataPacket } from "mysql2/promise";
import { jsonError, requireUser } from "../../../../lib/auth";
import { mysqlRows } from "../../../../lib/mysql";
import { resolveStorageQuotaBytes } from "../../../../lib/storage-quota";

interface UsageRow extends RowDataPacket {
  textCount: number | string;
  imageCount: number | string;
  videoCount: number | string;
  audioCount: number | string;
  storageBytes: number | string;
  storageQuotaBytes: number | string | null;
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const rows = await mysqlRows<UsageRow>(
      `SELECT
         (
           SELECT COUNT(*)
           FROM xiaoluo_v2_model_execution_audits mea
           WHERE mea.user_id = ? AND mea.modality = 'text'
         ) AS textCount,
         (
           SELECT COUNT(*)
           FROM xiaoluo_v2_model_execution_audits mea
           WHERE mea.user_id = ? AND mea.modality = 'image'
         ) AS imageCount,
         (
           SELECT COUNT(*)
           FROM xiaoluo_v2_model_execution_audits mea
           WHERE mea.user_id = ? AND mea.modality = 'video'
         ) AS videoCount,
         (
           SELECT COUNT(*)
           FROM xiaoluo_v2_model_execution_audits mea
           WHERE mea.user_id = ? AND mea.modality = 'audio'
         ) AS audioCount,
         (
           SELECT COALESCE(SUM(a.size), 0)
           FROM xiaoluo_v2_assets a
           INNER JOIN xiaoluo_v2_workspaces w ON w.id = a.workspace_id
           WHERE w.owner_id = ? AND a.trashed_at IS NULL
         ) AS storageBytes,
         (
           SELECT storage_quota_bytes
           FROM xiaoluo_v2_users quota_user
           WHERE quota_user.id = ?
           LIMIT 1
         ) AS storageQuotaBytes`,
      [user.id, user.id, user.id, user.id, user.id, user.id],
    );
    const row = rows[0];
    const usedBytes = Number(row?.storageBytes ?? 0);
    const quotaBytes = resolveStorageQuotaBytes(row?.storageQuotaBytes);
    return Response.json({
      usage: {
        text: Number(row?.textCount ?? 0),
        image: Number(row?.imageCount ?? 0),
        video: Number(row?.videoCount ?? 0),
        audio: Number(row?.audioCount ?? 0),
      },
      storage: {
        usedBytes,
        quotaBytes,
        remainingBytes: Math.max(0, quotaBytes - usedBytes),
        usedPercent:
          quotaBytes > 0
            ? Math.min(100, Number(((usedBytes / quotaBytes) * 100).toFixed(2)))
            : 0,
      },
    });
  } catch (error) {
    return jsonError(error, "读取个人用量失败");
  }
}
