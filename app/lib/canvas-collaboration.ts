import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { mysqlExecute, mysqlRows, mysqlTransaction } from "./mysql";

export type CanvasCollaborationEventType =
  | "canvas.updated"
  | "comment.created"
  | "comment.resolved"
  | "presence.left"
  | "permission.revoked";

export interface CanvasCollaborationEventInput {
  canvasId: string;
  workspaceId: string;
  actorUserId: string;
  sessionId?: string | null;
  eventType: CanvasCollaborationEventType;
  payload?: Record<string, unknown>;
  canvasRevision?: number | null;
}

export function cleanCollaborationSessionId(value: unknown) {
  return typeof value === "string"
    ? value.trim().replace(/[^a-zA-Z0-9:_-]/g, "").slice(0, 80)
    : "";
}

export function cleanSelectedNodeIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, 100);
}

export async function appendCanvasCollaborationEvent(
  input: CanvasCollaborationEventInput,
  connection?: PoolConnection,
) {
  const values = [
    `collab_${crypto.randomUUID()}`,
    input.canvasId,
    input.workspaceId,
    input.actorUserId,
    input.sessionId ?? null,
    input.eventType,
    JSON.stringify(input.payload ?? {}),
    input.canvasRevision ?? null,
  ];
  const sql = `INSERT INTO xiaoluo_v2_canvas_collaboration_events
    (id, canvas_id, workspace_id, actor_user_id, session_id, event_type,
     payload_json, canvas_revision)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
  if (connection) {
    await connection.execute(sql, values);
    return;
  }
  await mysqlExecute(sql, values);
}

interface MentionRow extends RowDataPacket {
  userId: string;
  username: string;
}

export async function resolveCanvasMentions(
  workspaceId: string,
  content: string,
) {
  const requested = Array.from(
    new Set(
      Array.from(content.matchAll(/@([a-zA-Z0-9_]{3,32})/g)).map(
        (match) => match[1].toLowerCase(),
      ),
    ),
  ).slice(0, 20);
  if (!requested.length) return [];
  const placeholders = requested.map(() => "?").join(",");
  return mysqlRows<MentionRow>(
    `SELECT u.id AS userId, u.username
     FROM xiaoluo_v2_workspace_members wm
     INNER JOIN xiaoluo_v2_users u ON u.id = wm.user_id
     WHERE wm.workspace_id = ?
       AND LOWER(u.username) IN (${placeholders})
       AND u.status = 'active'`,
    [workspaceId, ...requested],
  );
}

export function removeStaleCanvasPresence(canvasId: string) {
  return mysqlExecute(
    `DELETE FROM xiaoluo_v2_canvas_presence
     WHERE canvas_id = ?
       AND last_seen_at < DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 2 MINUTE)`,
    [canvasId],
  );
}

export function leaveCanvasPresence(input: {
  canvasId: string;
  workspaceId: string;
  userId: string;
  sessionId: string;
}) {
  return mysqlTransaction(async (connection) => {
    await connection.execute(
      `DELETE FROM xiaoluo_v2_canvas_presence
       WHERE canvas_id = ? AND user_id = ? AND session_id = ?`,
      [input.canvasId, input.userId, input.sessionId],
    );
    await appendCanvasCollaborationEvent(
      {
        canvasId: input.canvasId,
        workspaceId: input.workspaceId,
        actorUserId: input.userId,
        sessionId: input.sessionId,
        eventType: "presence.left",
      },
      connection,
    );
  });
}
