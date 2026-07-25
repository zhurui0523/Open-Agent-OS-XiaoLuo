import type { PoolConnection, RowDataPacket } from "mysql2/promise";
import { mysqlNow, mysqlTransaction } from "./mysql";

export interface DomainEventInput {
  workspaceId?: string | null;
  actorUserId?: string | null;
  eventType: string;
  entityType: string;
  entityId: string;
  requestId?: string | null;
  detail?: Record<string, unknown>;
}

export function domainEventRows(input: DomainEventInput) {
  const eventId = crypto.randomUUID();
  const outboxId = crypto.randomUUID();
  const detailJson = JSON.stringify(input.detail ?? {});
  return {
    audit: {
      id: eventId,
      workspaceId: input.workspaceId ?? null,
      actorUserId: input.actorUserId ?? null,
      eventType: input.eventType,
      entityType: input.entityType,
      entityId: input.entityId,
      requestId: input.requestId ?? null,
      detailJson,
    },
    outbox: {
      id: outboxId,
      workspaceId: input.workspaceId ?? null,
      aggregateType: input.entityType,
      aggregateId: input.entityId,
      eventType: input.eventType,
      payloadJson: JSON.stringify({
        eventId,
        workspaceId: input.workspaceId ?? null,
        actorUserId: input.actorUserId ?? null,
        entityType: input.entityType,
        entityId: input.entityId,
        detail: input.detail ?? {},
        occurredAt: new Date().toISOString(),
      }),
    },
  };
}

interface OutboxRow extends RowDataPacket {
  id: string;
  workspaceId: string | null;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payloadJson: string;
  attempts: number;
}

async function appendEventRows(
  connection: PoolConnection,
  input: DomainEventInput,
) {
  const rows = domainEventRows(input);
  await connection.execute(
    `INSERT INTO xiaoluo_v2_audit_logs
       (id, workspace_id, actor_user_id, event_type, entity_type,
        entity_id, request_id, detail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      rows.audit.id,
      rows.audit.workspaceId,
      rows.audit.actorUserId,
      rows.audit.eventType,
      rows.audit.entityType,
      rows.audit.entityId,
      rows.audit.requestId,
      rows.audit.detailJson,
    ],
  );
  await connection.execute(
    `INSERT INTO xiaoluo_v2_outbox_events
       (id, workspace_id, aggregate_type, aggregate_id, event_type, payload_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      rows.outbox.id,
      rows.outbox.workspaceId,
      rows.outbox.aggregateType,
      rows.outbox.aggregateId,
      rows.outbox.eventType,
      rows.outbox.payloadJson,
    ],
  );
  return { eventId: rows.audit.id, outboxId: rows.outbox.id };
}

export function recordDomainEvent(input: DomainEventInput) {
  return mysqlTransaction((connection) => appendEventRows(connection, input));
}

export function runAuditedMutation<T>(
  input: DomainEventInput,
  operation: (connection: PoolConnection) => Promise<T>,
) {
  return mysqlTransaction(async (connection) => {
    const result = await operation(connection);
    await appendEventRows(connection, input);
    return result;
  });
}

export async function deliverOutboxBatch(
  deliver: (event: {
    id: string;
    type: string;
    aggregateType: string;
    aggregateId: string;
    payload: unknown;
  }) => Promise<void>,
  limit = 50,
) {
  const rows = await mysqlTransaction(async (connection) => {
    const [candidates] = await connection.query<OutboxRow[]>(
      `SELECT id, workspace_id AS workspaceId,
              aggregate_type AS aggregateType, aggregate_id AS aggregateId,
              event_type AS eventType, payload_json AS payloadJson, attempts
       FROM xiaoluo_v2_outbox_events
       WHERE status IN ('pending', 'failed') AND available_at <= CURRENT_TIMESTAMP(3)
       ORDER BY created_at
       LIMIT ?
       FOR UPDATE SKIP LOCKED`,
      [Math.max(1, Math.min(limit, 200))],
    );
    if (candidates.length) {
      const placeholders = candidates.map(() => "?").join(",");
      await connection.query(
        `UPDATE xiaoluo_v2_outbox_events
         SET status = 'processing', claimed_at = CURRENT_TIMESTAMP(3),
             attempts = attempts + 1
         WHERE id IN (${placeholders})`,
        candidates.map((event) => event.id),
      );
    }
    return candidates;
  });

  for (const row of rows) {
    try {
      await deliver({
        id: row.id,
        type: row.eventType,
        aggregateType: row.aggregateType,
        aggregateId: row.aggregateId,
        payload: JSON.parse(row.payloadJson),
      });
      await mysqlTransaction((connection) =>
        connection.execute(
          `UPDATE xiaoluo_v2_outbox_events
           SET status = 'published', published_at = CURRENT_TIMESTAMP(3),
               last_error = NULL
           WHERE id = ? AND status = 'processing'`,
          [row.id],
        ),
      );
    } catch (error) {
      const retryAt = mysqlNow(
        new Date(Date.now() + Math.min(60_000, 2 ** row.attempts * 1_000)),
      );
      await mysqlTransaction((connection) =>
        connection.execute(
          `UPDATE xiaoluo_v2_outbox_events
           SET status = 'failed', available_at = ?, last_error = ?
           WHERE id = ? AND status = 'processing'`,
          [
            retryAt,
            error instanceof Error ? error.message.slice(0, 2_000) : "unknown",
            row.id,
          ],
        ),
      );
    }
  }
  return rows.length;
}
