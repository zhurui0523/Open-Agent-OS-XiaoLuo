import type { RowDataPacket } from "mysql2/promise";
import { jsonError, requireUser } from "../../../lib/auth";
import { requireCanvasAccess } from "../../../lib/authorization";
import {
  appendCanvasCollaborationEvent,
  cleanCollaborationSessionId,
  cleanSelectedNodeIds,
  leaveCanvasPresence,
  removeStaleCanvasPresence,
  resolveCanvasMentions,
} from "../../../lib/canvas-collaboration";
import {
  mysqlExecute,
  mysqlRows,
  mysqlTransaction,
} from "../../../lib/mysql";

interface PresenceRow extends RowDataPacket {
  userId: string;
  username: string;
  displayName: string;
  sessionId: string;
  cursorX: number | null;
  cursorY: number | null;
  selectedNodeIdsJson: string;
  clientRevision: number;
  lastSeenAt: string;
}

interface CommentRow extends RowDataPacket {
  id: string;
  nodeId: string | null;
  authorUserId: string;
  username: string;
  displayName: string;
  content: string;
  mentionsJson: string;
  status: "open" | "resolved";
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface EventRow extends RowDataPacket {
  sequence: number;
  id: string;
  actorUserId: string;
  username: string;
  displayName: string;
  sessionId: string | null;
  eventType: string;
  payloadJson: string;
  canvasRevision: number | null;
  createdAt: string;
}

interface RevisionRow extends RowDataPacket {
  revision: number;
}

function positiveInteger(value: string | null) {
  const parsed = Number(value ?? 0);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function json(value: string, fallback: unknown) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const url = new URL(request.url);
    const canvasId = url.searchParams.get("canvasId")?.trim() ?? "";
    const sessionId = cleanCollaborationSessionId(
      url.searchParams.get("sessionId"),
    );
    const after = positiveInteger(url.searchParams.get("after"));
    if (!canvasId) {
      return Response.json({ error: "缺少 canvasId" }, { status: 400 });
    }
    const access = await requireCanvasAccess(user.id, canvasId, "view");
    await removeStaleCanvasPresence(canvasId);
    const [presence, comments, events, revisions] = await Promise.all([
      mysqlRows<PresenceRow>(
        `SELECT p.user_id AS userId, u.username, u.display_name AS displayName,
                p.session_id AS sessionId, p.cursor_x AS cursorX,
                p.cursor_y AS cursorY,
                p.selected_node_ids_json AS selectedNodeIdsJson,
                p.client_revision AS clientRevision,
                p.last_seen_at AS lastSeenAt
         FROM xiaoluo_v2_canvas_presence p
         INNER JOIN xiaoluo_v2_users u ON u.id = p.user_id
         WHERE p.canvas_id = ?
           AND p.last_seen_at >= DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 45 SECOND)
         ORDER BY p.last_seen_at DESC
         LIMIT 100`,
        [canvasId],
      ),
      mysqlRows<CommentRow>(
        `SELECT c.id, c.node_id AS nodeId, c.author_user_id AS authorUserId,
                u.username, u.display_name AS displayName, c.content,
                c.mentions_json AS mentionsJson, c.status,
                c.resolved_at AS resolvedAt, c.created_at AS createdAt,
                c.updated_at AS updatedAt
         FROM xiaoluo_v2_canvas_comments c
         INNER JOIN xiaoluo_v2_users u ON u.id = c.author_user_id
         WHERE c.canvas_id = ?
         ORDER BY (c.status = 'open') DESC, c.updated_at DESC
         LIMIT 200`,
        [canvasId],
      ),
      mysqlRows<EventRow>(
        `SELECT e.sequence, e.id, e.actor_user_id AS actorUserId,
                u.username, u.display_name AS displayName,
                e.session_id AS sessionId, e.event_type AS eventType,
                e.payload_json AS payloadJson,
                e.canvas_revision AS canvasRevision,
                e.created_at AS createdAt
         FROM xiaoluo_v2_canvas_collaboration_events e
         INNER JOIN xiaoluo_v2_users u ON u.id = e.actor_user_id
         WHERE e.canvas_id = ? AND e.sequence > ?
         ORDER BY e.sequence ASC
         LIMIT 200`,
        [canvasId, after],
      ),
      mysqlRows<RevisionRow>(
        `SELECT revision FROM xiaoluo_v2_canvases
         WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
        [canvasId],
      ),
    ]);
    return Response.json({
      access: {
        allowed: true,
        workspaceId: access.workspaceId,
        role: access.role,
      },
      self: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        sessionId,
      },
      canvasRevision: revisions[0]?.revision ?? 0,
      presence: presence.map((item) => ({
        ...item,
        selectedNodeIds: json(item.selectedNodeIdsJson, []),
      })),
      comments: comments.map((item) => ({
        ...item,
        mentions: json(item.mentionsJson, []),
      })),
      events: events.map((item) => ({
        ...item,
        payload: json(item.payloadJson, {}),
      })),
      cursor: events.at(-1)?.sequence ?? after,
      polledAt: new Date().toISOString(),
    });
  } catch (error) {
    return jsonError(error, "读取协作状态失败");
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const body = (await request.json()) as {
      canvasId?: string;
      sessionId?: string;
      action?: "heartbeat" | "leave" | "comment.create" | "comment.resolve";
      cursor?: { x?: unknown; y?: unknown } | null;
      selectedNodeIds?: unknown;
      clientRevision?: unknown;
      nodeId?: string | null;
      content?: string;
      commentId?: string;
    };
    const canvasId = body.canvasId?.trim() ?? "";
    const sessionId = cleanCollaborationSessionId(body.sessionId);
    if (!canvasId || !sessionId || !body.action) {
      return Response.json(
        { error: "canvasId、sessionId 和 action 必填" },
        { status: 400 },
      );
    }
    const access = await requireCanvasAccess(user.id, canvasId, "view");

    if (body.action === "heartbeat") {
      const cursor =
        body.cursor &&
        typeof body.cursor.x === "number" &&
        Number.isFinite(body.cursor.x) &&
        typeof body.cursor.y === "number" &&
        Number.isFinite(body.cursor.y)
          ? { x: body.cursor.x, y: body.cursor.y }
          : null;
      const selectedNodeIds = cleanSelectedNodeIds(body.selectedNodeIds);
      const clientRevision =
        typeof body.clientRevision === "number" &&
        Number.isSafeInteger(body.clientRevision) &&
        body.clientRevision >= 0
          ? body.clientRevision
          : 0;
      await mysqlExecute(
        `INSERT INTO xiaoluo_v2_canvas_presence
          (canvas_id, workspace_id, user_id, session_id, cursor_x, cursor_y,
           selected_node_ids_json, client_revision, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
         ON DUPLICATE KEY UPDATE
           cursor_x = VALUES(cursor_x),
           cursor_y = VALUES(cursor_y),
           selected_node_ids_json = VALUES(selected_node_ids_json),
           client_revision = VALUES(client_revision),
           state = 'active',
           last_seen_at = CURRENT_TIMESTAMP(3)`,
        [
          canvasId,
          access.workspaceId,
          user.id,
          sessionId,
          cursor?.x ?? null,
          cursor?.y ?? null,
          JSON.stringify(selectedNodeIds),
          clientRevision,
        ],
      );
      return Response.json({ ok: true, heartbeatAt: new Date().toISOString() });
    }

    if (body.action === "leave") {
      await leaveCanvasPresence({
        canvasId,
        workspaceId: access.workspaceId,
        userId: user.id,
        sessionId,
      });
      return Response.json({ ok: true });
    }

    if (body.action === "comment.create") {
      const content = body.content?.trim().slice(0, 2_000) ?? "";
      if (!content) {
        return Response.json({ error: "评论内容不能为空" }, { status: 400 });
      }
      const mentions = await resolveCanvasMentions(
        access.workspaceId,
        content,
      );
      const commentId = `comment_${crypto.randomUUID()}`;
      await mysqlTransaction(async (connection) => {
        await connection.execute(
          `INSERT INTO xiaoluo_v2_canvas_comments
            (id, canvas_id, workspace_id, node_id, author_user_id, content,
             mentions_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            commentId,
            canvasId,
            access.workspaceId,
            body.nodeId?.trim().slice(0, 120) || null,
            user.id,
            content,
            JSON.stringify(mentions),
          ],
        );
        await appendCanvasCollaborationEvent(
          {
            canvasId,
            workspaceId: access.workspaceId,
            actorUserId: user.id,
            sessionId,
            eventType: "comment.created",
            payload: {
              commentId,
              nodeId: body.nodeId?.trim().slice(0, 120) || null,
              mentions: mentions.map((item) => item.userId),
            },
          },
          connection,
        );
      });
      return Response.json({ ok: true, commentId }, { status: 201 });
    }

    await requireCanvasAccess(user.id, canvasId, "edit");
    const commentId = body.commentId?.trim() ?? "";
    if (!commentId) {
      return Response.json({ error: "commentId 必填" }, { status: 400 });
    }
    await mysqlTransaction(async (connection) => {
      const [result] = await connection.execute(
        `UPDATE xiaoluo_v2_canvas_comments
         SET status = 'resolved', resolved_by = ?,
             resolved_at = CURRENT_TIMESTAMP(3),
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id = ? AND canvas_id = ? AND status = 'open'`,
        [user.id, commentId, canvasId],
      );
      if (!("affectedRows" in result) || Number(result.affectedRows) !== 1) {
        throw new Response(JSON.stringify({ error: "评论不存在或已解决" }), {
          status: 404,
          headers: { "content-type": "application/json; charset=utf-8" },
        });
      }
      await appendCanvasCollaborationEvent(
        {
          canvasId,
          workspaceId: access.workspaceId,
          actorUserId: user.id,
          sessionId,
          eventType: "comment.resolved",
          payload: { commentId },
        },
        connection,
      );
    });
    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error, "更新协作状态失败");
  }
}
