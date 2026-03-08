import type { BridgeDatabase } from "./database.js";
import { mapChatBindingRow } from "./mappers.js";
import type { StoreClock } from "./shared.js";
import type {
  ChatBindingRecord,
  ChatBindingsRepository,
  ChatBindingUpsertInput
} from "./types.js";

export class SqliteChatBindingsRepository implements ChatBindingsRepository {
  readonly #database: BridgeDatabase;
  readonly #clock: StoreClock;

  constructor(database: BridgeDatabase, clock: StoreClock) {
    this.#database = database;
    this.#clock = clock;
  }

  get(chatId: string): ChatBindingRecord | null {
    const row = this.#database
      .prepare(
        `SELECT chat_id, session_id, updated_at
       FROM chat_bindings
       WHERE chat_id = ?`
      )
      .get(chatId) as Record<string, unknown> | undefined;

    return row ? mapChatBindingRow(row) : null;
  }

  list(): readonly ChatBindingRecord[] {
    const rows = this.#database
      .prepare(
        `SELECT chat_id, session_id, updated_at
       FROM chat_bindings
       ORDER BY updated_at DESC, chat_id ASC`
      )
      .all() as ReadonlyArray<Record<string, unknown>>;

    return rows.map(mapChatBindingRow);
  }

  save(input: ChatBindingUpsertInput): ChatBindingRecord {
    const updatedAt = input.updatedAt ?? this.#clock().toISOString();
    this.#database
      .prepare(
        `INSERT INTO chat_bindings (chat_id, session_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         session_id = excluded.session_id,
         updated_at = excluded.updated_at`
      )
      .run(input.chatId, input.sessionId, updatedAt);

    return {
      chatId: input.chatId,
      sessionId: input.sessionId,
      updatedAt
    };
  }

  delete(chatId: string): boolean {
    const result = this.#database
      .prepare("DELETE FROM chat_bindings WHERE chat_id = ?")
      .run(chatId) as {
      changes: number;
    };
    return result.changes > 0;
  }
}
