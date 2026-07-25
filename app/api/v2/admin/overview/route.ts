import type { RowDataPacket } from "mysql2/promise";
import { getFileBucket } from "../../../../lib/asset-kernel";
import { jsonError, requireUser } from "../../../../lib/auth";
import { mysqlRows } from "../../../../lib/mysql";

interface MetricsRow extends RowDataPacket {
  users: number;
  workspaces: number;
  canvases: number;
  assets: number;
  assetBytes: number;
  runningTasks: number;
  failedTasks: number;
}

interface EventRow extends RowDataPacket {
  eventType: string;
  entityId: string;
  createdAt: Date | string;
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    if (user.platformRole !== "system_admin") {
      return Response.json({ error: "仅系统管理员可访问" }, { status: 403 });
    }
    const [metrics, events, oss] = await Promise.all([
      mysqlRows<MetricsRow>(
        `SELECT
           (SELECT COUNT(*) FROM xiaoluo_v2_users) AS users,
           (SELECT COUNT(*) FROM xiaoluo_v2_workspaces WHERE status = 'active') AS workspaces,
           (SELECT COUNT(*) FROM xiaoluo_v2_canvases WHERE deleted_at IS NULL) AS canvases,
           (SELECT COUNT(*) FROM xiaoluo_v2_assets WHERE trashed_at IS NULL) AS assets,
           (SELECT COALESCE(SUM(size), 0) FROM xiaoluo_v2_assets WHERE trashed_at IS NULL) AS assetBytes,
           (
             SELECT COUNT(*) FROM xiaoluo_v2_generation_jobs
             WHERE status IN ('queued', 'submitted', 'running')
           ) AS runningTasks,
           (
             SELECT COUNT(*) FROM xiaoluo_v2_generation_jobs
             WHERE status = 'failed'
           ) AS failedTasks`,
      ),
      mysqlRows<EventRow>(
        `SELECT event_type AS eventType, entity_id AS entityId, created_at AS createdAt
         FROM xiaoluo_v2_audit_logs
         ORDER BY created_at DESC
         LIMIT 30`,
      ),
      getFileBucket()
        .then((bucket) => bucket.healthcheck())
        .then(() => true)
        .catch(() => false),
    ]);
    return Response.json({
      metrics: metrics[0],
      dependencies: { mysql: true, oss },
      events: events.map((event) => ({
        ...event,
        createdAt: new Date(event.createdAt).toISOString(),
      })),
    });
  } catch (error) {
    return jsonError(error, "读取系统运维状态失败");
  }
}
