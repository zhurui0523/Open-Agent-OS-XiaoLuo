import type { RowDataPacket } from "mysql2/promise";
import {
  authCookieHeaders,
  currentSessionId,
  jsonError,
  refreshAuthSession,
  requireUser,
} from "../../../../lib/auth";
import { mysqlExecute, mysqlRows } from "../../../../lib/mysql";

interface SecurityRow extends RowDataPacket {
  allowMultipleSessions: number | boolean;
  sessionTtlDays: number;
}

const defaults = {
  allowMultipleSessions: true,
  sessionTtlDays: 30,
};

async function readSettings(userId: string) {
  const [row] = await mysqlRows<SecurityRow>(
    `SELECT
       allow_multiple_sessions AS allowMultipleSessions,
       session_ttl_days AS sessionTtlDays
     FROM xiaoluo_v2_user_security_settings
     WHERE user_id = ?
     LIMIT 1`,
    [userId],
  );
  return row
    ? {
        allowMultipleSessions: Boolean(row.allowMultipleSessions),
        sessionTtlDays: [7, 30, 90].includes(Number(row.sessionTtlDays))
          ? Number(row.sessionTtlDays)
          : 30,
      }
    : defaults;
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    return Response.json({ security: await readSettings(user.id) });
  } catch (error) {
    return jsonError(error, "读取安全设置失败");
  }
}

export async function PATCH(request: Request) {
  try {
    const user = await requireUser(request);
    const body = (await request.json()) as {
      allowMultipleSessions?: boolean;
      sessionTtlDays?: number;
    };
    const allowMultipleSessions = body.allowMultipleSessions !== false;
    const sessionTtlDays = Number(body.sessionTtlDays);
    if (![7, 30, 90].includes(sessionTtlDays)) {
      return Response.json(
        { error: "会话有效期只能选择 7、30 或 90 天" },
        { status: 400 },
      );
    }
    await mysqlExecute(
      `INSERT INTO xiaoluo_v2_user_security_settings
        (
          user_id, allow_multiple_sessions, session_ttl_days,
          created_at, updated_at
        )
       VALUES (?, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
       ON DUPLICATE KEY UPDATE
         allow_multiple_sessions = VALUES(allow_multiple_sessions),
         session_ttl_days = VALUES(session_ttl_days),
         updated_at = CURRENT_TIMESTAMP(3)`,
      [user.id, allowMultipleSessions, sessionTtlDays],
    );
    const sessionId = await currentSessionId(request);
    const expires = new Date(
      Date.now() + sessionTtlDays * 24 * 60 * 60 * 1000,
    );
    if (!allowMultipleSessions) {
      await mysqlExecute(
        `DELETE FROM xiaoluo_v2_auth_sessions
         WHERE user_id = ? AND id <> ?`,
        [user.id, sessionId ?? ""],
      );
    }
    if (sessionId) {
      await mysqlExecute(
        `UPDATE xiaoluo_v2_auth_sessions
         SET expires_at = ?, refresh_expires_at = ?
         WHERE user_id = ? AND id = ?`,
        [expires, expires, user.id, sessionId],
      );
    }
    const renewed = sessionId
      ? await refreshAuthSession(request, expires)
      : null;
    return Response.json(
      {
        security: { allowMultipleSessions, sessionTtlDays },
        message: "安全设置已保存",
      },
      renewed
        ? { headers: authCookieHeaders(renewed.pair, request) }
        : undefined,
    );
  } catch (error) {
    return jsonError(error, "保存安全设置失败");
  }
}
