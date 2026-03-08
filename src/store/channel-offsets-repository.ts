import type { BridgeDatabase } from "./database.js";
import { mapChannelOffsetRow } from "./mappers.js";
import type { StoreClock } from "./shared.js";
import type {
  ChannelOffsetRecord,
  ChannelOffsetsRepository,
  ChannelOffsetUpsertInput
} from "./types.js";

export class SqliteChannelOffsetsRepository implements ChannelOffsetsRepository {
  readonly #database: BridgeDatabase;
  readonly #clock: StoreClock;

  constructor(database: BridgeDatabase, clock: StoreClock) {
    this.#database = database;
    this.#clock = clock;
  }

  get(channelKey: string): ChannelOffsetRecord | null {
    const row = this.#database
      .prepare(
        `SELECT channel_key, current_offset, previous_offset, updated_at
       FROM channel_offsets
       WHERE channel_key = ?`
      )
      .get(channelKey) as Record<string, unknown> | undefined;

    return row ? mapChannelOffsetRow(row) : null;
  }

  list(): readonly ChannelOffsetRecord[] {
    const rows = this.#database
      .prepare(
        `SELECT channel_key, current_offset, previous_offset, updated_at
       FROM channel_offsets
       ORDER BY channel_key ASC`
      )
      .all() as ReadonlyArray<Record<string, unknown>>;

    return rows.map(mapChannelOffsetRow);
  }

  save(input: ChannelOffsetUpsertInput): ChannelOffsetRecord {
    const existing = this.get(input.channelKey);
    const previousOffset =
      input.previousOffset ?? existing?.currentOffset ?? input.currentOffset;
    const updatedAt = input.updatedAt ?? this.#clock().toISOString();

    this.#database
      .prepare(
        `INSERT INTO channel_offsets (channel_key, current_offset, previous_offset, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(channel_key) DO UPDATE SET
         current_offset = excluded.current_offset,
         previous_offset = excluded.previous_offset,
         updated_at = excluded.updated_at`
      )
      .run(input.channelKey, input.currentOffset, previousOffset, updatedAt);

    return {
      channelKey: input.channelKey,
      currentOffset: input.currentOffset,
      previousOffset,
      updatedAt
    };
  }
}
