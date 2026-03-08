import type { BridgeDatabase } from "./database.js";
import { mapSessionOverviewRow, mapSessionRow } from "./mappers.js";
import {
  createSessionRecord,
  getNullableSessionValue
} from "./session-records.js";
import type { StoreClock } from "./shared.js";
import { booleanToInteger, serializeStringArray } from "./sqlite-values.js";
import type {
  SessionPatch,
  SessionRecord,
  SessionsRepository,
  SessionUpsertInput
} from "./types.js";

export class SqliteSessionsRepository implements SessionsRepository {
  readonly #database: BridgeDatabase;
  readonly #clock: StoreClock;

  constructor(database: BridgeDatabase, clock: StoreClock) {
    this.#database = database;
    this.#clock = clock;
  }

  get(sessionId: string): SessionRecord | null {
    const row = this.#database
      .prepare(
        `SELECT session_id, workspace_root, extra_allowed_dirs_json, cwd, mode, codex_thread_id,
              access_scope, rolling_summary, run_state, cancellation_result, active_run_id, stale_recovered,
              last_error, created_at, updated_at
       FROM sessions
       WHERE session_id = ?`
      )
      .get(sessionId) as Record<string, unknown> | undefined;

    return row ? mapSessionRow(row) : null;
  }

  list(): readonly SessionRecord[] {
    const rows = this.#database
      .prepare(
        `SELECT session_id, workspace_root, extra_allowed_dirs_json, cwd, mode, codex_thread_id,
              access_scope, rolling_summary, run_state, cancellation_result, active_run_id, stale_recovered,
              last_error, created_at, updated_at
       FROM sessions
       ORDER BY updated_at DESC, session_id ASC`
      )
      .all() as ReadonlyArray<Record<string, unknown>>;

    return rows.map(mapSessionRow);
  }

  listOverview() {
    const rows = this.#database
      .prepare(
        `SELECT session_id, workspace_root, extra_allowed_dirs_json, cwd, mode, access_scope, run_state, active_run_id, updated_at
       FROM sessions
       ORDER BY updated_at DESC, session_id ASC`
      )
      .all() as ReadonlyArray<Record<string, unknown>>;

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
    const record = createSessionRecord(
      {
        sessionId: existing.sessionId,
        workspaceRoot: patch.workspaceRoot ?? existing.workspaceRoot,
        extraAllowedDirs: patch.extraAllowedDirs ?? existing.extraAllowedDirs,
        cwd: patch.cwd ?? existing.cwd,
        mode: patch.mode ?? existing.mode,
        accessScope: patch.accessScope ?? existing.accessScope,
        codexThreadId: getNullableSessionValue(
          patch,
          "codexThreadId",
          existing.codexThreadId
        ),
        rollingSummary: getNullableSessionValue(
          patch,
          "rollingSummary",
          existing.rollingSummary
        ),
        runState: patch.runState ?? existing.runState,
        cancellationResult: getNullableSessionValue(
          patch,
          "cancellationResult",
          existing.cancellationResult
        ),
        activeRunId: getNullableSessionValue(
          patch,
          "activeRunId",
          existing.activeRunId
        ),
        staleRecovered: patch.staleRecovered ?? existing.staleRecovered,
        lastError: getNullableSessionValue(
          patch,
          "lastError",
          existing.lastError
        ),
        createdAt: existing.createdAt,
        updatedAt
      },
      existing,
      existing.createdAt,
      updatedAt
    );

    this.#persistSessionRecord(record);
    return record;
  }

  delete(sessionId: string): boolean {
    const result = this.#database
      .prepare("DELETE FROM sessions WHERE session_id = ?")
      .run(sessionId) as {
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
    this.#database
      .prepare(
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
      )
      .run(
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
