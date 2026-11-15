import type { RowDataPacket } from "mysql2/promise";
import {
  clearAuthCookieHeaders,
  currentSessionId,
  jsonError,
  requireUser,
} from "../../../../lib/auth";
import { mysqlExecute, mysqlRows } from "../../../../lib/mysql";

interface SessionRow extends RowDataPacket {
  id: string;
  deviceName: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

function maskedIp(value: string | null) {
  if (!value || value === "本地网络") return value ?? "未知网络";
  if (value.includes(".")) {
    const parts = value.split(".");
    if (parts.length === 4) return `${parts.slice(0, 3).join(".")}.*`;
  }
  if (value.includes(":")) return `${value.split(":").slice(0, 3).join(":")}::…`;
  return "未知网络";
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const sessionId = await currentSessionId(request);
    await mysqlExecute(
      `DELETE FROM xiaoluo_v2_auth_sessions
       WHERE user_id = ?
         AND COALESCE(refresh_expires_at, expires_at) <= CURRENT_TIMESTAMP(3)`,
      [user.id],
    );
    const rows = await mysqlRows<SessionRow>(
      `SELECT
         id,
         device_name AS deviceName,
         ip_address AS ipAddress,
         created_at AS createdAt,
         last_seen_at AS lastSeenAt,
         COALESCE(refresh_expires_at, expires_at) AS expiresAt
       FROM xiaoluo_v2_auth_sessions
       WHERE user_id = ?
       ORDER BY last_seen_at DESC`,
      [user.id],
    );
    return Response.json({
      sessions: rows.map((row) => ({
        id: row.id,
        deviceName: row.deviceName ?? "未知设备",
        ipAddress: maskedIp(row.ipAddress),
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
        expiresAt: row.expiresAt,
        current: row.id === sessionId,
      })),
    });
  } catch (error) {
    return jsonError(error, "读取登录设备失败");
  }
}

export async function DELETE(request: Request) {
  try {
    const user = await requireUser(request);
    const body = (await request.json()) as {
      sessionId?: string;
      allOthers?: boolean;
    };
    const sessionId = await currentSessionId(request);
    if (body.allOthers) {
      await mysqlExecute(
        `DELETE FROM xiaoluo_v2_auth_sessions
         WHERE user_id = ? AND id <> ?`,
        [user.id, sessionId ?? ""],
      );
      return Response.json({ message: "其他设备已全部退出" });
    }
    if (!body.sessionId) {
      return Response.json({ error: "请选择要退出的设备" }, { status: 400 });
    }
    const [target] = await mysqlRows<SessionRow>(
      `SELECT
         id,
         device_name AS deviceName,
         ip_address AS ipAddress,
         created_at AS createdAt,
         last_seen_at AS lastSeenAt,
         COALESCE(refresh_expires_at, expires_at) AS expiresAt
       FROM xiaoluo_v2_auth_sessions
       WHERE id = ? AND user_id = ?
       LIMIT 1`,
      [body.sessionId, user.id],
    );
    if (!target) {
      return Response.json({ error: "登录设备不存在" }, { status: 404 });
    }
    await mysqlExecute(
      "DELETE FROM xiaoluo_v2_auth_sessions WHERE id = ? AND user_id = ?",
      [body.sessionId, user.id],
    );
    const isCurrent = target.id === sessionId;
    return Response.json(
      { message: isCurrent ? "当前设备已退出" : "设备已退出", current: isCurrent },
      isCurrent
        ? { headers: clearAuthCookieHeaders(request) }
        : undefined,
    );
  } catch (error) {
    return jsonError(error, "退出设备失败");
  }
}
