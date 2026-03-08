import { BridgeDatabase } from "./database.js";
import { listAppliedMigrations } from "./migrations.js";
import type {
  AuditLogEventLimit,
  AppliedMigrationRecord,
  AuditLogCreateInput,
  AuditLogFilter,
  AuditLogRecord,
  AuditLogsRepository,
  ChannelOffsetRecord,
  ChannelOffsetsRepository,
  ChannelOffsetUpsertInput,
  ChatBindingRecord,
  ChatBindingsRepository,
  ChatBindingUpsertInput,
  MigrationRepository,
  PendingPermissionCreateInput,
  PendingPermissionFilter,
  PendingPermissionRecord,
  PendingPermissionResolution,
  PendingPermissionsRepository,
  SessionPatch,
  SessionOverviewRecord,
  SessionRecord,
  SessionsRepository,
  SessionSummariesRepository,
  SessionSummaryCreateInput,
  SessionSummaryFilter,
  SessionSummaryRecord,
  SessionUpsertInput,
  TelegramUserAuthRecord,
  TelegramUserAuthRepository,
  TelegramUserFailedAttemptInput,
  TelegramUserFirstSeenInput,
  TelegramUserLanguagePreferenceInput,
  TelegramUserVerificationInput
} from "./types.js";

export type StoreClock = () => Date;

export class SqliteSessionsRepository implements SessionsRepository {
  readonly #database: BridgeDatabase;
  readonly #clock: StoreClock;

  constructor(database: BridgeDatabase, clock: StoreClock) {
    this.#database = database;
    this.#clock = clock;
  }

  get(sessionId: string): SessionRecord | null {
    const row = this.#database.prepare(
      `SELECT session_id, workspace_root, extra_allowed_dirs_json, cwd, mode, codex_thread_id,
              access_scope, rolling_summary, run_state, cancellation_result, active_run_id, stale_recovered,
              last_error, created_at, updated_at
       FROM sessions
       WHERE session_id = ?`
    ).get(sessionId) as Record<string, unknown> | undefined;

    return row ? mapSessionRow(row) : null;
  }

  list(): readonly SessionRecord[] {
    const rows = this.#database.prepare(
      `SELECT session_id, workspace_root, extra_allowed_dirs_json, cwd, mode, codex_thread_id,
              access_scope, rolling_summary, run_state, cancellation_result, active_run_id, stale_recovered,
              last_error, created_at, updated_at
       FROM sessions
       ORDER BY updated_at DESC, session_id ASC`
    ).all() as ReadonlyArray<Record<string, unknown>>;

    return rows.map(mapSessionRow);
  }

  listOverview(): readonly SessionOverviewRecord[] {
    const rows = this.#database.prepare(
      `SELECT session_id, workspace_root, extra_allowed_dirs_json, cwd, mode, access_scope, run_state, active_run_id, updated_at
       FROM sessions
       ORDER BY updated_at DESC, session_id ASC`
    ).all() as ReadonlyArray<Record<string, unknown>>;

    return rows.map(mapSessionOverviewRow);
  }

  save(input: SessionUpsertInput): SessionRecord {
    const existing = this.get(input.sessionId);
    const createdAt = input.createdAt ?? existing?.createdAt ?? this.#now();
    const updatedAt = input.updatedAt ?? this.#now();
    const record = createSessionRecord(input, existing, createdAt, updatedAt);

    this.#persistSessionRecord(record);
    return record;
  }

  update(sessionId: string, patch: SessionPatch): SessionRecord {
    const existing = this.getRequired(sessionId);
    const updatedAt = patch.updatedAt ?? this.#now();
    const record = createSessionRecord({
      sessionId: existing.sessionId,
      workspaceRoot: patch.workspaceRoot ?? existing.workspaceRoot,
      extraAllowedDirs: patch.extraAllowedDirs ?? existing.extraAllowedDirs,
      cwd: patch.cwd ?? existing.cwd,
      mode: patch.mode ?? existing.mode,
      accessScope: patch.accessScope ?? existing.accessScope,
      codexThreadId: getNullableSessionValue(patch, "codexThreadId", existing.codexThreadId),
      rollingSummary: getNullableSessionValue(patch, "rollingSummary", existing.rollingSummary),
      runState: patch.runState ?? existing.runState,
      cancellationResult: getNullableSessionValue(patch, "cancellationResult", existing.cancellationResult),
      activeRunId: getNullableSessionValue(patch, "activeRunId", existing.activeRunId),
      staleRecovered: patch.staleRecovered ?? existing.staleRecovered,
      lastError: getNullableSessionValue(patch, "lastError", existing.lastError),
      createdAt: existing.createdAt,
      updatedAt
    }, existing, existing.createdAt, updatedAt);

    this.#persistSessionRecord(record);
    return record;
  }

  delete(sessionId: string): boolean {
    const result = this.#database.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId) as {
      changes: number;
    };
    return result.changes > 0;
  }

  getRequired(sessionId: string): SessionRecord {
    const record = this.get(sessionId);
    if (!record) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return record;
  }

  #persistSessionRecord(record: SessionRecord): void {
    this.#database.prepare(
      `INSERT INTO sessions (
         session_id, workspace_root, extra_allowed_dirs_json, cwd, mode, access_scope, codex_thread_id,
         rolling_summary, run_state, cancellation_result, active_run_id, stale_recovered,
         last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         workspace_root = excluded.workspace_root,
         extra_allowed_dirs_json = excluded.extra_allowed_dirs_json,
         cwd = excluded.cwd,
         mode = excluded.mode,
         access_scope = excluded.access_scope,
         codex_thread_id = excluded.codex_thread_id,
         rolling_summary = excluded.rolling_summary,
         run_state = excluded.run_state,
         cancellation_result = excluded.cancellation_result,
         active_run_id = excluded.active_run_id,
         stale_recovered = excluded.stale_recovered,
         last_error = excluded.last_error,
         updated_at = excluded.updated_at`
    ).run(
      record.sessionId,
      record.workspaceRoot,
      serializeStringArray(record.extraAllowedDirs),
      record.cwd,
      record.mode,
      record.accessScope,
      record.codexThreadId,
      record.rollingSummary,
      record.runState,
      record.cancellationResult,
      record.activeRunId,
      booleanToInteger(record.staleRecovered),
      record.lastError,
      record.createdAt,
      record.updatedAt
    );
  }

  #now(): string {
    return this.#clock().toISOString();
  }
}

export class SqliteChatBindingsRepository implements ChatBindingsRepository {
  readonly #database: BridgeDatabase;
  readonly #clock: StoreClock;

  constructor(database: BridgeDatabase, clock: StoreClock) {
    this.#database = database;
    this.#clock = clock;
  }

  get(chatId: string): ChatBindingRecord | null {
    const row = this.#database.prepare(
      `SELECT chat_id, session_id, updated_at
       FROM chat_bindings
       WHERE chat_id = ?`
    ).get(chatId) as Record<string, unknown> | undefined;

    return row ? mapChatBindingRow(row) : null;
  }

  list(): readonly ChatBindingRecord[] {
    const rows = this.#database.prepare(
      `SELECT chat_id, session_id, updated_at
       FROM chat_bindings
       ORDER BY updated_at DESC, chat_id ASC`
    ).all() as ReadonlyArray<Record<string, unknown>>;

    return rows.map(mapChatBindingRow);
  }

  save(input: ChatBindingUpsertInput): ChatBindingRecord {
    const updatedAt = input.updatedAt ?? this.#clock().toISOString();
    this.#database.prepare(
      `INSERT INTO chat_bindings (chat_id, session_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         session_id = excluded.session_id,
         updated_at = excluded.updated_at`
    ).run(input.chatId, input.sessionId, updatedAt);

    return {
      chatId: input.chatId,
      sessionId: input.sessionId,
      updatedAt
    };
  }

  delete(chatId: string): boolean {
    const result = this.#database.prepare("DELETE FROM chat_bindings WHERE chat_id = ?").run(chatId) as {
      changes: number;
    };
    return result.changes > 0;
  }
}

export class SqlitePendingPermissionsRepository implements PendingPermissionsRepository {
  readonly #database: BridgeDatabase;
  readonly #clock: StoreClock;

  constructor(database: BridgeDatabase, clock: StoreClock) {
    this.#database = database;
    this.#clock = clock;
  }

  get(permissionId: string): PendingPermissionRecord | null {
    const row = this.#database.prepare(
      `SELECT permission_id, session_id, run_id, chat_id, user_id, source_message_id,
              tool_name, summary, expires_at, resolved, resolution, resolved_at, created_at
       FROM pending_permissions
       WHERE permission_id = ?`
    ).get(permissionId) as Record<string, unknown> | undefined;

    return row ? mapPendingPermissionRow(row) : null;
  }

  list(filter: PendingPermissionFilter = {}): readonly PendingPermissionRecord[] {
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

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limitClause = typeof filter.limit === "number" ? "LIMIT ?" : "";
    if (typeof filter.limit === "number") {
      values.push(filter.limit);
    }
    const rows = this.#database.prepare(
      `SELECT permission_id, session_id, run_id, chat_id, user_id, source_message_id,
              tool_name, summary, expires_at, resolved, resolution, resolved_at, created_at
       FROM pending_permissions
       ${whereClause}
       ORDER BY created_at DESC, permission_id ASC
       ${limitClause}`
    ).all(...values) as ReadonlyArray<Record<string, unknown>>;

    return rows.map(mapPendingPermissionRow);
  }

  create(input: PendingPermissionCreateInput): PendingPermissionRecord {
    const createdAt = input.createdAt ?? this.#clock().toISOString();
    const record = createPendingPermissionRecord(input, createdAt);
    this.#database.prepare(
      `INSERT INTO pending_permissions (
         permission_id, session_id, run_id, chat_id, user_id, source_message_id,
         tool_name, summary, expires_at, resolved, resolution, resolved_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?)`
    ).run(
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

  expirePending(before: string, resolvedAt = this.#clock().toISOString()): readonly string[] {
    return this.#database.withTransaction(() => {
      const rows = this.#database.prepare(
        `SELECT permission_id
         FROM pending_permissions
         WHERE resolved = 0
           AND expires_at < ?
         ORDER BY expires_at ASC, permission_id ASC`
      ).all(before) as ReadonlyArray<Record<string, unknown>>;

      if (rows.length === 0) {
        return [] as const;
      }

      this.#database.prepare(
        `UPDATE pending_permissions
         SET resolved = 1,
             resolution = 'expired',
             resolved_at = ?
         WHERE resolved = 0
           AND expires_at < ?`
      ).run(resolvedAt, before);

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
    this.#database.prepare(
      `UPDATE pending_permissions
       SET resolved = 1,
           resolution = ?,
           resolved_at = ?
       WHERE permission_id = ?`
    ).run(resolution, finalResolvedAt, permissionId);

    return {
      ...existing,
      resolved: true,
      resolution,
      resolvedAt: finalResolvedAt
    };
  }

  deleteExpired(before: string): number {
    const result = this.#database.prepare(
      `DELETE FROM pending_permissions
       WHERE resolved = 0
         AND expires_at < ?`
    ).run(before) as { changes: number };

    return result.changes;
  }

  deleteResolved(before: string): number {
    const result = this.#database.prepare(
      `DELETE FROM pending_permissions
       WHERE resolved = 1
         AND COALESCE(resolved_at, created_at) < ?`
    ).run(before) as { changes: number };

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

export class SqliteChannelOffsetsRepository implements ChannelOffsetsRepository {
  readonly #database: BridgeDatabase;
  readonly #clock: StoreClock;

  constructor(database: BridgeDatabase, clock: StoreClock) {
    this.#database = database;
    this.#clock = clock;
  }

  get(channelKey: string): ChannelOffsetRecord | null {
    const row = this.#database.prepare(
      `SELECT channel_key, current_offset, previous_offset, updated_at
       FROM channel_offsets
       WHERE channel_key = ?`
    ).get(channelKey) as Record<string, unknown> | undefined;

    return row ? mapChannelOffsetRow(row) : null;
  }

  list(): readonly ChannelOffsetRecord[] {
    const rows = this.#database.prepare(
      `SELECT channel_key, current_offset, previous_offset, updated_at
       FROM channel_offsets
       ORDER BY channel_key ASC`
    ).all() as ReadonlyArray<Record<string, unknown>>;

    return rows.map(mapChannelOffsetRow);
  }

  save(input: ChannelOffsetUpsertInput): ChannelOffsetRecord {
    const existing = this.get(input.channelKey);
    const previousOffset = input.previousOffset ?? existing?.currentOffset ?? input.currentOffset;
    const updatedAt = input.updatedAt ?? this.#clock().toISOString();

    this.#database.prepare(
      `INSERT INTO channel_offsets (channel_key, current_offset, previous_offset, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(channel_key) DO UPDATE SET
         current_offset = excluded.current_offset,
         previous_offset = excluded.previous_offset,
         updated_at = excluded.updated_at`
    ).run(input.channelKey, input.currentOffset, previousOffset, updatedAt);

    return {
      channelKey: input.channelKey,
      currentOffset: input.currentOffset,
      previousOffset,
      updatedAt
    };
  }
}

export class SqliteTelegramUserAuthRepository implements TelegramUserAuthRepository {
  readonly #database: BridgeDatabase;
  readonly #clock: StoreClock;

  constructor(database: BridgeDatabase, clock: StoreClock) {
    this.#database = database;
    this.#clock = clock;
  }

  get(userId: string): TelegramUserAuthRecord | null {
    const row = this.#database.prepare(
      `SELECT user_id, latest_chat_id, first_seen_at, verified_at, preferred_language, failed_attempts, last_failed_at, banned_at, updated_at
       FROM telegram_user_auth
       WHERE user_id = ?`
    ).get(userId) as Record<string, unknown> | undefined;

    return row ? mapTelegramUserAuthRow(row) : null;
  }

  findByChatId(chatId: string): TelegramUserAuthRecord | null {
    const row = this.#database.prepare(
      `SELECT user_id, latest_chat_id, first_seen_at, verified_at, preferred_language, failed_attempts, last_failed_at, banned_at, updated_at
       FROM telegram_user_auth
       WHERE latest_chat_id = ?
       ORDER BY updated_at DESC
       LIMIT 1`
    ).get(chatId) as Record<string, unknown> | undefined;

    return row ? mapTelegramUserAuthRow(row) : null;
  }

  list(): readonly TelegramUserAuthRecord[] {
    const rows = this.#database.prepare(
      `SELECT user_id, latest_chat_id, first_seen_at, verified_at, preferred_language, failed_attempts, last_failed_at, banned_at, updated_at
       FROM telegram_user_auth
       ORDER BY updated_at DESC, user_id ASC`
    ).all() as ReadonlyArray<Record<string, unknown>>;

    return rows.map(mapTelegramUserAuthRow);
  }

  getOrCreateFirstSeen(input: TelegramUserFirstSeenInput): TelegramUserAuthRecord {
    const existing = this.get(input.userId);
    if (existing) {
      const updatedAt = input.firstSeenAt ?? this.#clock().toISOString();
      this.#database.prepare(
        `UPDATE telegram_user_auth
         SET latest_chat_id = ?,
             updated_at = ?
         WHERE user_id = ?`
      ).run(input.chatId, updatedAt, input.userId);

      return {
        ...existing,
        latestChatId: input.chatId,
        updatedAt
      };
    }

    const firstSeenAt = input.firstSeenAt ?? this.#clock().toISOString();
    this.#database.prepare(
      `INSERT INTO telegram_user_auth (
         user_id, latest_chat_id, first_seen_at, verified_at, preferred_language, failed_attempts, last_failed_at, banned_at, updated_at
       ) VALUES (?, ?, ?, NULL, NULL, 0, NULL, NULL, ?)`
    ).run(input.userId, input.chatId, firstSeenAt, firstSeenAt);

    return {
      userId: input.userId,
      latestChatId: input.chatId,
      firstSeenAt,
      verifiedAt: null,
      preferredLanguage: null,
      failedAttempts: 0,
      lastFailedAt: null,
      bannedAt: null,
      updatedAt: firstSeenAt
    };
  }

  markVerified(input: TelegramUserVerificationInput): TelegramUserAuthRecord {
    return this.#database.withTransaction(() => {
      const existing = this.getOrCreateFirstSeen({
        userId: input.userId,
        chatId: input.chatId,
        ...(input.verifiedAt ? { firstSeenAt: input.verifiedAt } : {})
      });
      const verifiedAt = input.verifiedAt ?? this.#clock().toISOString();

      this.#database.prepare(
        `UPDATE telegram_user_auth
         SET latest_chat_id = ?,
             verified_at = ?,
             failed_attempts = 0,
             last_failed_at = NULL,
             updated_at = ?
         WHERE user_id = ?`
      ).run(input.chatId, verifiedAt, verifiedAt, input.userId);

      return {
        ...existing,
        latestChatId: input.chatId,
        verifiedAt,
        preferredLanguage: existing.preferredLanguage,
        failedAttempts: 0,
        lastFailedAt: null,
        updatedAt: verifiedAt
      };
    });
  }

  setPreferredLanguage(input: TelegramUserLanguagePreferenceInput): TelegramUserAuthRecord {
    return this.#database.withTransaction(() => {
      const existing = this.getOrCreateFirstSeen({
        userId: input.userId,
        chatId: input.chatId,
        ...(input.selectedAt ? { firstSeenAt: input.selectedAt } : {})
      });
      const selectedAt = input.selectedAt ?? this.#clock().toISOString();

      this.#database.prepare(
        `UPDATE telegram_user_auth
         SET latest_chat_id = ?,
             preferred_language = ?,
             updated_at = ?
         WHERE user_id = ?`
      ).run(input.chatId, input.preferredLanguage, selectedAt, input.userId);

      return {
        ...existing,
        latestChatId: input.chatId,
        preferredLanguage: input.preferredLanguage,
        updatedAt: selectedAt
      };
    });
  }

  recordFailedAttempt(input: TelegramUserFailedAttemptInput): TelegramUserAuthRecord {
    if (input.banThreshold < 1) {
      throw new Error(`Ban threshold must be positive. Received: ${input.banThreshold}.`);
    }

    return this.#database.withTransaction(() => {
      const existing = this.getOrCreateFirstSeen({
        userId: input.userId,
        chatId: input.chatId,
        ...(input.failedAt ? { firstSeenAt: input.failedAt } : {})
      });
      const failedAt = input.failedAt ?? this.#clock().toISOString();
      const nextFailedAttempts = existing.verifiedAt ? 1 : existing.failedAttempts + 1;
      const bannedAt = existing.bannedAt ?? (nextFailedAttempts >= input.banThreshold ? failedAt : null);

      this.#database.prepare(
        `UPDATE telegram_user_auth
         SET latest_chat_id = ?,
             failed_attempts = ?,
             last_failed_at = ?,
             banned_at = ?,
             updated_at = ?
         WHERE user_id = ?`
      ).run(input.chatId, nextFailedAttempts, failedAt, bannedAt, failedAt, input.userId);

      return {
        ...existing,
        latestChatId: input.chatId,
        verifiedAt: existing.verifiedAt,
        preferredLanguage: existing.preferredLanguage,
        failedAttempts: nextFailedAttempts,
        lastFailedAt: failedAt,
        bannedAt,
        updatedAt: failedAt
      };
    });
  }
}

export class SqliteAuditLogsRepository implements AuditLogsRepository {
  readonly #database: BridgeDatabase;
  readonly #clock: StoreClock;

  constructor(database: BridgeDatabase, clock: StoreClock) {
    this.#database = database;
    this.#clock = clock;
  }

  append<TPayload = unknown>(input: AuditLogCreateInput<TPayload>): AuditLogRecord<TPayload> {
    const createdAt = input.createdAt ?? this.#clock().toISOString();
    const result = this.#database.prepare(
      `INSERT INTO audit_logs (session_id, chat_id, run_id, event_type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
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

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limitClause = filter.limit ? "LIMIT ?" : "";
    if (filter.limit) {
      values.push(filter.limit);
    }

    const rows = this.#database.prepare(
      `SELECT audit_id, session_id, chat_id, run_id, event_type, payload_json, created_at
       FROM audit_logs
       ${whereClause}
       ORDER BY created_at DESC, audit_id DESC
       ${limitClause}`
    ).all(...values) as ReadonlyArray<Record<string, unknown>>;

    return rows.map(mapAuditLogRow);
  }

  listRecentByEventType(sessionId: string, limits: readonly AuditLogEventLimit[]): readonly AuditLogRecord[] {
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

    const rows = this.#database.prepare(
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
    ).all(...values) as ReadonlyArray<Record<string, unknown>>;

    return rows.map(mapAuditLogRow);
  }

  pruneOlderThan(before: string): number {
    const result = this.#database.prepare(
      `DELETE FROM audit_logs
       WHERE created_at < ?`
    ).run(before) as { changes: number };

    return result.changes;
  }

  pruneToMaxRows(maxRows: number): number {
    if (maxRows < 1) {
      const result = this.#database.prepare("DELETE FROM audit_logs").run() as { changes: number };
      return result.changes;
    }

    const result = this.#database.prepare(
      `DELETE FROM audit_logs
       WHERE audit_id IN (
         SELECT audit_id
         FROM audit_logs
         ORDER BY created_at DESC, audit_id DESC
         LIMIT -1 OFFSET ?
       )`
    ).run(maxRows) as { changes: number };

    return result.changes;
  }
}

export class SqliteSessionSummariesRepository implements SessionSummariesRepository {
  readonly #database: BridgeDatabase;
  readonly #clock: StoreClock;

  constructor(database: BridgeDatabase, clock: StoreClock) {
    this.#database = database;
    this.#clock = clock;
  }

  append(input: SessionSummaryCreateInput): SessionSummaryRecord {
    const summaryKind = input.summaryKind ?? "rolling";
    const createdAt = input.createdAt ?? this.#clock().toISOString();
    const result = this.#database.prepare(
      `INSERT INTO session_summaries (session_id, summary_kind, content, created_at)
       VALUES (?, ?, ?, ?)`
    ).run(input.sessionId, summaryKind, input.content, createdAt) as {
      lastInsertRowid: number;
      changes: number;
    };

    return {
      summaryId: toNumberValue(result.lastInsertRowid),
      sessionId: input.sessionId,
      summaryKind,
      content: input.content,
      createdAt
    };
  }

  list(filter: SessionSummaryFilter): readonly SessionSummaryRecord[] {
    const rows = this.#database.prepare(
      `SELECT summary_id, session_id, summary_kind, content, created_at
       FROM session_summaries
       WHERE session_id = ?
       ORDER BY created_at DESC, summary_id DESC
       LIMIT ?`
    ).all(filter.sessionId, filter.limit ?? 50) as ReadonlyArray<Record<string, unknown>>;

    return rows.map(mapSessionSummaryRow);
  }

  pruneToMaxPerSession(maxRowsPerSession: number): number {
    if (maxRowsPerSession < 1) {
      const result = this.#database.prepare("DELETE FROM session_summaries").run() as { changes: number };
      return result.changes;
    }

    const result = this.#database.prepare(
      `DELETE FROM session_summaries
       WHERE summary_id IN (
         SELECT summary_id
         FROM (
           SELECT summary_id,
                  ROW_NUMBER() OVER (
                    PARTITION BY session_id
                    ORDER BY created_at DESC, summary_id DESC
                  ) AS row_number
           FROM session_summaries
         )
         WHERE row_number > ?
       )`
    ).run(maxRowsPerSession) as { changes: number };

    const deletedRows = result.changes;
    return deletedRows;
  }
}

export class SqliteMigrationRepository implements MigrationRepository {
  readonly #database: BridgeDatabase;

  constructor(database: BridgeDatabase) {
    this.#database = database;
  }

  list(): readonly AppliedMigrationRecord[] {
    return listAppliedMigrations(this.#database);
  }
}

function mapSessionRow(row: Record<string, unknown>): SessionRecord {
  return {
    sessionId: toStringValue(row.session_id),
    workspaceRoot: toStringValue(row.workspace_root),
    extraAllowedDirs: parseStringArray(row.extra_allowed_dirs_json),
    cwd: toStringValue(row.cwd),
    mode: toStringValue(row.mode) as SessionRecord["mode"],
    accessScope: toStringValue(row.access_scope) as SessionRecord["accessScope"],
    codexThreadId: toNullableStringValue(row.codex_thread_id),
    rollingSummary: toNullableStringValue(row.rolling_summary),
    runState: toStringValue(row.run_state) as SessionRecord["runState"],
    cancellationResult: toNullableStringValue(row.cancellation_result) as SessionRecord["cancellationResult"],
    activeRunId: toNullableStringValue(row.active_run_id),
    staleRecovered: integerToBoolean(row.stale_recovered),
    lastError: toNullableStringValue(row.last_error),
    createdAt: toStringValue(row.created_at),
    updatedAt: toStringValue(row.updated_at)
  };
}

function mapSessionOverviewRow(row: Record<string, unknown>): SessionOverviewRecord {
  return {
    sessionId: toStringValue(row.session_id),
    workspaceRoot: toStringValue(row.workspace_root),
    extraAllowedDirs: parseStringArray(row.extra_allowed_dirs_json),
    cwd: toStringValue(row.cwd),
    mode: toStringValue(row.mode) as SessionOverviewRecord["mode"],
    accessScope: toStringValue(row.access_scope) as SessionOverviewRecord["accessScope"],
    runState: toStringValue(row.run_state) as SessionOverviewRecord["runState"],
    activeRunId: toNullableStringValue(row.active_run_id),
    updatedAt: toStringValue(row.updated_at)
  };
}

function mapChatBindingRow(row: Record<string, unknown>): ChatBindingRecord {
  return {
    chatId: toStringValue(row.chat_id),
    sessionId: toStringValue(row.session_id),
    updatedAt: toStringValue(row.updated_at)
  };
}

function mapPendingPermissionRow(row: Record<string, unknown>): PendingPermissionRecord {
  return {
    permissionId: toStringValue(row.permission_id),
    sessionId: toStringValue(row.session_id),
    runId: toStringValue(row.run_id),
    chatId: toStringValue(row.chat_id),
    userId: toStringValue(row.user_id),
    sourceMessageId: toStringValue(row.source_message_id),
    toolName: toStringValue(row.tool_name),
    summary: toStringValue(row.summary),
    expiresAt: toStringValue(row.expires_at),
    resolved: integerToBoolean(row.resolved),
    resolution: toNullableStringValue(row.resolution) as PendingPermissionRecord["resolution"],
    resolvedAt: toNullableStringValue(row.resolved_at),
    createdAt: toStringValue(row.created_at)
  };
}

function mapChannelOffsetRow(row: Record<string, unknown>): ChannelOffsetRecord {
  return {
    channelKey: toStringValue(row.channel_key),
    currentOffset: toNumberValue(row.current_offset),
    previousOffset: toNumberValue(row.previous_offset),
    updatedAt: toStringValue(row.updated_at)
  };
}

function mapTelegramUserAuthRow(row: Record<string, unknown>): TelegramUserAuthRecord {
  return {
    userId: toStringValue(row.user_id),
    latestChatId: toStringValue(row.latest_chat_id),
    firstSeenAt: toStringValue(row.first_seen_at),
    verifiedAt: toNullableStringValue(row.verified_at),
    preferredLanguage: toNullableStringValue(row.preferred_language) as TelegramUserAuthRecord["preferredLanguage"],
    failedAttempts: toNumberValue(row.failed_attempts),
    lastFailedAt: toNullableStringValue(row.last_failed_at),
    bannedAt: toNullableStringValue(row.banned_at),
    updatedAt: toStringValue(row.updated_at)
  };
}

function mapAuditLogRow(row: Record<string, unknown>): AuditLogRecord {
  return {
    auditId: toNumberValue(row.audit_id),
    sessionId: toNullableStringValue(row.session_id),
    chatId: toNullableStringValue(row.chat_id),
    runId: toNullableStringValue(row.run_id),
    eventType: toStringValue(row.event_type),
    payload: parseJson(row.payload_json),
    createdAt: toStringValue(row.created_at)
  };
}

function mapSessionSummaryRow(row: Record<string, unknown>): SessionSummaryRecord {
  return {
    summaryId: toNumberValue(row.summary_id),
    sessionId: toStringValue(row.session_id),
    summaryKind: toStringValue(row.summary_kind),
    content: toStringValue(row.content),
    createdAt: toStringValue(row.created_at)
  };
}

function createSessionRecord(
  input: SessionUpsertInput,
  existing: SessionRecord | null,
  createdAt: string,
  updatedAt: string
): SessionRecord {
  return {
    sessionId: input.sessionId,
    workspaceRoot: input.workspaceRoot,
    extraAllowedDirs: [...input.extraAllowedDirs],
    cwd: input.cwd,
    mode: input.mode,
    accessScope: input.accessScope ?? existing?.accessScope ?? "workspace",
    codexThreadId: getNullableSessionValue(input, "codexThreadId", existing?.codexThreadId ?? null),
    rollingSummary: getNullableSessionValue(input, "rollingSummary", existing?.rollingSummary ?? null),
    runState: input.runState ?? existing?.runState ?? "idle",
    cancellationResult: getNullableSessionValue(input, "cancellationResult", existing?.cancellationResult ?? null),
    activeRunId: getNullableSessionValue(input, "activeRunId", existing?.activeRunId ?? null),
    staleRecovered: input.staleRecovered ?? existing?.staleRecovered ?? false,
    lastError: getNullableSessionValue(input, "lastError", existing?.lastError ?? null),
    createdAt,
    updatedAt
  };
}

function getNullableSessionValue<
  TNullableValue extends string | boolean | null
>(
  input: SessionPatch | SessionUpsertInput,
  key: "codexThreadId" | "rollingSummary" | "cancellationResult" | "activeRunId" | "lastError",
  fallback: TNullableValue | null
): TNullableValue | null {
  return Object.prototype.hasOwnProperty.call(input, key)
    ? ((input as Record<string, TNullableValue | null | undefined>)[key] ?? null)
    : fallback;
}

function createPendingPermissionRecord(
  input: PendingPermissionCreateInput,
  createdAt: string
): PendingPermissionRecord {
  return {
    permissionId: input.permissionId,
    sessionId: input.sessionId,
    runId: input.runId,
    chatId: input.chatId,
    userId: input.userId,
    sourceMessageId: input.sourceMessageId,
    toolName: input.toolName,
    summary: input.summary,
    expiresAt: input.expiresAt,
    resolved: false,
    resolution: null,
    resolvedAt: null,
    createdAt
  };
}

function serializeStringArray(values: readonly string[]): string {
  return JSON.stringify(Array.from(values));
}

function parseStringArray(value: unknown): readonly string[] {
  const raw = toStringValue(value);
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("Expected JSON string array.");
  }

  return parsed;
}

function serializeJson(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  return JSON.stringify(value);
}

function parseJson(value: unknown): unknown | null {
  if (value === null || value === undefined) {
    return null;
  }

  return JSON.parse(toStringValue(value)) as unknown;
}

function toStringValue(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`Expected string SQLite value, received ${typeof value}.`);
  }

  return value;
}

function toNullableStringValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return toStringValue(value);
}

function toNumberValue(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  throw new Error(`Expected numeric SQLite value, received ${typeof value}.`);
}

function integerToBoolean(value: unknown): boolean {
  const numericValue = toNumberValue(value);
  return numericValue !== 0;
}

function booleanToInteger(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

function normalizeAuditLogEventLimits(limits: readonly AuditLogEventLimit[]): readonly AuditLogEventLimit[] {
  const normalized = new Map<string, number>();

  for (const entry of limits) {
    if (entry.limit < 1) {
      continue;
    }

    normalized.set(entry.eventType, entry.limit);
  }

  return Array.from(normalized, ([eventType, limit]) => ({
    eventType,
    limit
  }));
}
