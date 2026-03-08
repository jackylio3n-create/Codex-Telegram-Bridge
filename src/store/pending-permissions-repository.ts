import type { BridgeDatabase } from "./database.js";
import { mapPendingPermissionRow } from "./mappers.js";
import { createPendingPermissionRecord } from "./session-records.js";
import type { StoreClock } from "./shared.js";
import { booleanToInteger, toStringValue } from "./sqlite-values.js";
import type {
  PendingPermissionCreateInput,
  PendingPermissionFilter,
  PendingPermissionRecord,
  PendingPermissionResolution,
  PendingPermissionsRepository
} from "./types.js";

export class SqlitePendingPermissionsRepository implements PendingPermissionsRepository {
  readonly #database: BridgeDatabase;
  readonly #clock: StoreClock;

  constructor(database: BridgeDatabase, clock: StoreClock) {
    this.#database = database;
    this.#clock = clock;
  }

  get(permissionId: string): PendingPermissionRecord | null {
    const row = this.#database
      .prepare(
        `SELECT permission_id, session_id, run_id, chat_id, user_id, source_message_id,
              tool_name, summary, expires_at, resolved, resolution, resolved_at, created_at
       FROM pending_permissions
       WHERE permission_id = ?`
      )
      .get(permissionId) as Record<string, unknown> | undefined;

    return row ? mapPendingPermissionRow(row) : null;
  }

  list(
    filter: PendingPermissionFilter = {}
  ): readonly PendingPermissionRecord[] {
    const clauses: string[] = [];
    const values: Array<string | number> = [];

    if (filter.sessionId) {
      clauses.push("session_id = ?");
      values.push(filter.sessionId);
    }

    if (filter.runId) {
      clauses.push("run_id = ?");
      values.push(filter.runId);
    }

    if (filter.chatId) {
      clauses.push("chat_id = ?");
      values.push(filter.chatId);
    }

    if (filter.userId) {
      clauses.push("user_id = ?");
      values.push(filter.userId);
    }

    if (typeof filter.resolved === "boolean") {
      clauses.push("resolved = ?");
      values.push(booleanToInteger(filter.resolved));
    }

    const whereClause =
      clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limitClause = typeof filter.limit === "number" ? "LIMIT ?" : "";
    if (typeof filter.limit === "number") {
      values.push(filter.limit);
    }

    const rows = this.#database
      .prepare(
        `SELECT permission_id, session_id, run_id, chat_id, user_id, source_message_id,
              tool_name, summary, expires_at, resolved, resolution, resolved_at, created_at
       FROM pending_permissions
       ${whereClause}
       ORDER BY created_at DESC, permission_id ASC
       ${limitClause}`
      )
      .all(...values) as ReadonlyArray<Record<string, unknown>>;

    return rows.map(mapPendingPermissionRow);
  }

  create(input: PendingPermissionCreateInput): PendingPermissionRecord {
    const createdAt = input.createdAt ?? this.#clock().toISOString();
    const record = createPendingPermissionRecord(input, createdAt);
    this.#database
      .prepare(
        `INSERT INTO pending_permissions (
         permission_id, session_id, run_id, chat_id, user_id, source_message_id,
         tool_name, summary, expires_at, resolved, resolution, resolved_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?)`
      )
      .run(
        record.permissionId,
        record.sessionId,
        record.runId,
        record.chatId,
        record.userId,
        record.sourceMessageId,
        record.toolName,
        record.summary,
        record.expiresAt,
        record.createdAt
      );

    return record;
  }

  expirePending(
    before: string,
    resolvedAt = this.#clock().toISOString()
  ): readonly string[] {
    return this.#database.withTransaction(() => {
      const rows = this.#database
        .prepare(
          `SELECT permission_id
         FROM pending_permissions
         WHERE resolved = 0
           AND expires_at < ?
         ORDER BY expires_at ASC, permission_id ASC`
        )
        .all(before) as ReadonlyArray<Record<string, unknown>>;

      if (rows.length === 0) {
        return [] as const;
      }

      this.#database
        .prepare(
          `UPDATE pending_permissions
         SET resolved = 1,
             resolution = 'expired',
             resolved_at = ?
         WHERE resolved = 0
           AND expires_at < ?`
        )
        .run(resolvedAt, before);

      return rows.map((row) => toStringValue(row.permission_id));
    });
  }

  resolve(
    permissionId: string,
    resolution: PendingPermissionResolution,
    resolvedAt?: string
  ): PendingPermissionRecord | null {
    const existing = this.get(permissionId);
    if (!existing) {
      return null;
    }

    if (existing.resolved) {
      return existing;
    }

    const finalResolvedAt = resolvedAt ?? this.#clock().toISOString();
    this.#database
      .prepare(
        `UPDATE pending_permissions
       SET resolved = 1,
           resolution = ?,
           resolved_at = ?
       WHERE permission_id = ?`
      )
      .run(resolution, finalResolvedAt, permissionId);

    return {
      ...existing,
      resolved: true,
      resolution,
      resolvedAt: finalResolvedAt
    };
  }

  deleteExpired(before: string): number {
    const result = this.#database
      .prepare(
        `DELETE FROM pending_permissions
       WHERE resolved = 0
         AND expires_at < ?`
      )
      .run(before) as { changes: number };

    return result.changes;
  }

  deleteResolved(before: string): number {
    const result = this.#database
      .prepare(
        `DELETE FROM pending_permissions
       WHERE resolved = 1
         AND COALESCE(resolved_at, created_at) < ?`
      )
      .run(before) as { changes: number };

    return result.changes;
  }

  getRequired(permissionId: string): PendingPermissionRecord {
    const record = this.get(permissionId);
    if (!record) {
      throw new Error(`Pending permission not found: ${permissionId}`);
    }

    return record;
  }
}
