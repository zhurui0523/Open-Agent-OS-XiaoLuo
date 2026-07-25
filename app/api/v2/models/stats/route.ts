import type { RowDataPacket } from "mysql2/promise";
import { jsonError, requireUser } from "../../../../lib/auth";
import { mysqlRows } from "../../../../lib/mysql";
import { requireRequestedWorkspace } from "../../../../lib/workspace-context";
import type { ModelUsageSummary, NodeKind } from "../../../../types";

interface UsageRow extends RowDataPacket {
  modality: NodeKind;
  totalCount: string | number;
  successCount: string | number;
  failureCount: string | number;
  retryCount: string | number;
  fallbackCount: string | number;
}

interface AuditRow extends RowDataPacket {
  id: string;
  connectionName: string | null;
  modelName: string;
  modality: NodeKind;
  status: string;
  attempts: number;
  fallbackUsed: number | boolean;
  latencyMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
}

function emptyUsage(): ModelUsageSummary {
  return {
    text: { total: 0, success: 0, failure: 0 },
    image: { total: 0, success: 0, failure: 0 },
    video: { total: 0, success: 0, failure: 0 },
    retryCount: 0,
    fallbackCount: 0,
  };
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const workspaceId = await requireRequestedWorkspace(
      request,
      user.id,
      "view",
    );
    const requestedDays = Number(
      new URL(request.url).searchParams.get("days") ?? 30,
    );
    const days = Number.isFinite(requestedDays)
      ? Math.max(1, Math.min(365, Math.trunc(requestedDays)))
      : 30;
    const [rows, recent] = await Promise.all([
      mysqlRows<UsageRow>(
        `SELECT
           modality,
           SUM(total_count) AS totalCount,
           SUM(success_count) AS successCount,
           SUM(failure_count) AS failureCount,
           SUM(retry_count) AS retryCount,
           SUM(fallback_count) AS fallbackCount
         FROM xiaoluo_v2_model_usage_stats
         WHERE workspace_id = ?
           AND usage_day >= DATE_SUB(CURRENT_DATE(), INTERVAL ? DAY)
         GROUP BY modality`,
        [workspaceId, days - 1],
      ),
      mysqlRows<AuditRow>(
        `SELECT
           audit.id,
           connection.name AS connectionName,
           audit.model_name AS modelName,
           audit.modality,
           audit.status,
           audit.attempts,
           audit.fallback_used AS fallbackUsed,
           audit.latency_ms AS latencyMs,
           audit.error_code AS errorCode,
           audit.error_message AS errorMessage,
           audit.created_at AS createdAt
         FROM xiaoluo_v2_model_execution_audits audit
         LEFT JOIN xiaoluo_v2_model_connections connection
           ON connection.id = audit.actual_connection_id
         WHERE audit.workspace_id = ?
         ORDER BY audit.created_at DESC
         LIMIT 20`,
        [workspaceId],
      ),
    ]);
    const usage = emptyUsage();
    for (const row of rows) {
      if (!["text", "image", "video"].includes(row.modality)) continue;
      usage[row.modality] = {
        total: Number(row.totalCount) || 0,
        success: Number(row.successCount) || 0,
        failure: Number(row.failureCount) || 0,
      };
      usage.retryCount += Number(row.retryCount) || 0;
      usage.fallbackCount += Number(row.fallbackCount) || 0;
    }
    return Response.json({
      days,
      usage,
      recent: recent.map((row) => ({
        ...row,
        fallbackUsed: Boolean(row.fallbackUsed),
      })),
      billing: null,
      note: "仅统计文本、图片、视频调用次数，不计算 Token、用量金额或第三方账单。",
    });
  } catch (error) {
    return jsonError(error, "读取模型调用统计失败");
  }
}
