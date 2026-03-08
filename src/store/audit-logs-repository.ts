import type { BridgeDatabase } from "./database.js";
import { normalizeAuditLogEventLimits } from "./audit-limits.js";
import { mapAuditLogRow } from "./mappers.js";
import type { StoreClock } from "./shared.js";
import { serializeJson, toNumberValue } from "./sqlite-values.js";
import type {
  AuditLogCreateInput,
  AuditLogEventLimit,
  AuditLogFilter,
  AuditLogRecord,
  AuditLogsRepository
} from "./types.js";

export class SqliteAuditLogsRepository implements AuditLogsRepository {
  readonly #database: BridgeDatabase;
  readonly #clock: StoreClock;

  constructor(database: BridgeDatabase, clock: StoreClock) {
    this.#database = database;
    this.#clock = clock;
  }

  append<TPayload = unknown>(
    input: AuditLogCreateInput<TPayload>
  ): AuditLogRecord<TPayload> {
    const createdAt = input.createdAt ?? this.#clock().toISOString();
    const result = this.#database
      .prepare(
        `INSERT INTO audit_logs (session_id, chat_id, run_id, event_type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.sessionId ?? null,
        input.chatId ?? null,
        input.runId ?? null,
        input.eventType,
        serializeJson(input.payload),
        createdAt
      ) as { lastInsertRowid: number; changes: number };

    return {
      auditId: toNumberValue(result.lastInsertRowid),
      sessionId: input.sessionId ?? null,
      chatId: input.chatId ?? null,
      runId: input.runId ?? null,
      eventType: input.eventType,
      payload: input.payload ?? null,
      createdAt
    };
  }

  list(filter: AuditLogFilter = {}): readonly AuditLogRecord[] {
    const clauses: string[] = [];
    const values: Array<string | number> = [];

    if (filter.sessionId) {
      clauses.push("session_id = ?");
      values.push(filter.sessionId);
    }

    if (filter.chatId) {
      clauses.push("chat_id = ?");
      values.push(filter.chatId);
    }

    if (filter.runId) {
      clauses.push("run_id = ?");
      values.push(filter.runId);
    }

    const whereClause =
      clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limitClause = filter.limit ? "LIMIT ?" : "";
    if (filter.limit) {
      values.push(filter.limit);
    }

    const rows = this.#database
      .prepare(
        `SELECT audit_id, session_id, chat_id, run_id, event_type, payload_json, created_at
       FROM audit_logs
       ${whereClause}
       ORDER BY created_at DESC, audit_id DESC
       ${limitClause}`
      )
      .all(...values) as ReadonlyArray<Record<string, unknown>>;

    return rows.map(mapAuditLogRow);
  }

  listRecentByEventType(
    sessionId: string,
    limits: readonly AuditLogEventLimit[]
  ): readonly AuditLogRecord[] {
    const normalizedLimits = normalizeAuditLogEventLimits(limits);
    if (normalizedLimits.length === 0) {
      return [];
    }

    const valuesClause = normalizedLimits.map(() => "(?, ?)").join(", ");
    const values: Array<string | number> = [];

    for (const entry of normalizedLimits) {
      values.push(entry.eventType, entry.limit);
    }
    values.push(sessionId);

    const rows = this.#database
      .prepare(
        `WITH event_limits(event_type, max_rows) AS (
         VALUES ${valuesClause}
       )
       SELECT audit_id, session_id, chat_id, run_id, event_type, payload_json, created_at
       FROM (
         SELECT logs.audit_id,
                logs.session_id,
                logs.chat_id,
                logs.run_id,
                logs.event_type,
                logs.payload_json,
                logs.created_at,
                ROW_NUMBER() OVER (
                  PARTITION BY logs.event_type
                  ORDER BY logs.created_at DESC, logs.audit_id DESC
                ) AS row_number,
                event_limits.max_rows AS max_rows
         FROM audit_logs AS logs
         INNER JOIN event_limits
           ON event_limits.event_type = logs.event_type
         WHERE logs.session_id = ?
       )
       WHERE row_number <= max_rows
       ORDER BY created_at DESC, audit_id DESC`
      )
      .all(...values) as ReadonlyArray<Record<string, unknown>>;

    return rows.map(mapAuditLogRow);
  }

  pruneOlderThan(before: string): number {
    const result = this.#database
      .prepare(
        `DELETE FROM audit_logs
       WHERE created_at < ?`
      )
      .run(before) as { changes: number };

    return result.changes;
  }

  pruneToMaxRows(maxRows: number): number {
    if (maxRows < 1) {
      const result = this.#database.prepare("DELETE FROM audit_logs").run() as {
        changes: number;
      };
      return result.changes;
    }

    const result = this.#database
      .prepare(
        `DELETE FROM audit_logs
       WHERE audit_id IN (
         SELECT audit_id
         FROM audit_logs
         ORDER BY created_at DESC, audit_id DESC
         LIMIT -1 OFFSET ?
       )`
      )
      .run(maxRows) as { changes: number };

    return result.changes;
  }
}
