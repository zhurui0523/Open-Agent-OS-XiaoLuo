import type { RowDataPacket } from "mysql2/promise";
import { getFileBucket } from "../../../../lib/asset-kernel";
import { jsonError, requireSystemAdmin } from "../../../../lib/auth";
import { mysqlRows } from "../../../../lib/mysql";
import { runtimeServiceReadiness } from "../../../../lib/server-runtime-config";

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

interface HeartbeatRow extends RowDataPacket {
  component: string;
  instanceId: string;
  status: string;
  detailJson: string;
  lastSeenAt: Date | string;
}

interface TrustMetricsRow extends RowDataPacket {
  publishers: number;
  pendingReviews: number;
  quarantinedReviews: number;
  trustedPackages: number;
}

export async function GET(request: Request) {
  try {
    await requireSystemAdmin(request);
    const [metrics, events, heartbeats, trustMetrics, oss] = await Promise.all([
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
      mysqlRows<HeartbeatRow>(
        `SELECT component, instance_id AS instanceId, status, detail_json AS detailJson,
                last_seen_at AS lastSeenAt
         FROM xiaoluo_v2_system_heartbeats
         ORDER BY last_seen_at DESC`,
      ),
      mysqlRows<TrustMetricsRow>(
        `SELECT
           (SELECT COUNT(*) FROM xiaoluo_v2_trusted_publishers WHERE status = 'approved') AS publishers,
           (SELECT COUNT(*) FROM xiaoluo_v2_package_reviews WHERE status = 'pending') AS pendingReviews,
           (SELECT COUNT(*) FROM xiaoluo_v2_package_reviews WHERE status = 'quarantined') AS quarantinedReviews,
           (SELECT COUNT(*) FROM xiaoluo_v2_packages WHERE trust_state = 'trusted') AS trustedPackages`,
      ),
      getFileBucket()
        .then((bucket) => bucket.healthcheck())
        .then(() => true)
        .catch(() => false),
    ]);
    return Response.json({
      metrics: metrics[0],
      dependencies: { mysql: true, oss },
      services: runtimeServiceReadiness(),
      trust: trustMetrics[0],
      heartbeats: heartbeats.map((heartbeat) => ({
        ...heartbeat,
        detail: JSON.parse(heartbeat.detailJson || "{}") as Record<string, unknown>,
        detailJson: undefined,
        lastSeenAt: new Date(heartbeat.lastSeenAt).toISOString(),
      })),
      events: events.map((event) => ({
        ...event,
        createdAt: new Date(event.createdAt).toISOString(),
      })),
    });
  } catch (error) {
    return jsonError(error, "读取系统运维状态失败");
  }
}
