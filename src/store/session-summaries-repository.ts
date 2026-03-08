import type { BridgeDatabase } from "./database.js";
import { mapSessionSummaryRow } from "./mappers.js";
import type { StoreClock } from "./shared.js";
import { toNumberValue } from "./sqlite-values.js";
import type {
  SessionSummariesRepository,
  SessionSummaryCreateInput,
  SessionSummaryFilter,
  SessionSummaryRecord
} from "./types.js";

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
    const result = this.#database
      .prepare(
        `INSERT INTO session_summaries (session_id, summary_kind, content, created_at)
       VALUES (?, ?, ?, ?)`
      )
      .run(input.sessionId, summaryKind, input.content, createdAt) as {
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
    const rows = this.#database
      .prepare(
        `SELECT summary_id, session_id, summary_kind, content, created_at
       FROM session_summaries
       WHERE session_id = ?
       ORDER BY created_at DESC, summary_id DESC
       LIMIT ?`
      )
      .all(filter.sessionId, filter.limit ?? 50) as ReadonlyArray<
      Record<string, unknown>
    >;

    return rows.map(mapSessionSummaryRow);
  }

  pruneToMaxPerSession(maxRowsPerSession: number): number {
    if (maxRowsPerSession < 1) {
      const result = this.#database
        .prepare("DELETE FROM session_summaries")
        .run() as { changes: number };
      return result.changes;
    }

    const result = this.#database
      .prepare(
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
      )
      .run(maxRowsPerSession) as { changes: number };

    return result.changes;
  }
}
