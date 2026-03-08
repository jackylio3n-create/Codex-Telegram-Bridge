import type { BridgeDatabase } from "./database.js";
import { mapTelegramUserAuthRow } from "./mappers.js";
import type { StoreClock } from "./shared.js";
import type {
  TelegramUserAuthRecord,
  TelegramUserAuthRepository,
  TelegramUserFailedAttemptInput,
  TelegramUserFirstSeenInput,
  TelegramUserLanguagePreferenceInput,
  TelegramUserVerificationInput
} from "./types.js";

export class SqliteTelegramUserAuthRepository implements TelegramUserAuthRepository {
  readonly #database: BridgeDatabase;
  readonly #clock: StoreClock;

  constructor(database: BridgeDatabase, clock: StoreClock) {
    this.#database = database;
    this.#clock = clock;
  }

  get(userId: string): TelegramUserAuthRecord | null {
    const row = this.#database
      .prepare(
        `SELECT user_id, latest_chat_id, first_seen_at, verified_at, preferred_language, failed_attempts, last_failed_at, banned_at, updated_at
       FROM telegram_user_auth
       WHERE user_id = ?`
      )
      .get(userId) as Record<string, unknown> | undefined;

    return row ? mapTelegramUserAuthRow(row) : null;
  }

  findByChatId(chatId: string): TelegramUserAuthRecord | null {
    const row = this.#database
      .prepare(
        `SELECT user_id, latest_chat_id, first_seen_at, verified_at, preferred_language, failed_attempts, last_failed_at, banned_at, updated_at
       FROM telegram_user_auth
       WHERE latest_chat_id = ?
       ORDER BY updated_at DESC
       LIMIT 1`
      )
      .get(chatId) as Record<string, unknown> | undefined;

    return row ? mapTelegramUserAuthRow(row) : null;
  }

  list(): readonly TelegramUserAuthRecord[] {
    const rows = this.#database
      .prepare(
        `SELECT user_id, latest_chat_id, first_seen_at, verified_at, preferred_language, failed_attempts, last_failed_at, banned_at, updated_at
       FROM telegram_user_auth
       ORDER BY updated_at DESC, user_id ASC`
      )
      .all() as ReadonlyArray<Record<string, unknown>>;

    return rows.map(mapTelegramUserAuthRow);
  }

  getOrCreateFirstSeen(
    input: TelegramUserFirstSeenInput
  ): TelegramUserAuthRecord {
    const existing = this.get(input.userId);
    if (existing) {
      const updatedAt = input.firstSeenAt ?? this.#clock().toISOString();
      this.#database
        .prepare(
          `UPDATE telegram_user_auth
         SET latest_chat_id = ?,
             updated_at = ?
         WHERE user_id = ?`
        )
        .run(input.chatId, updatedAt, input.userId);

      return {
        ...existing,
        latestChatId: input.chatId,
        updatedAt
      };
    }

    const firstSeenAt = input.firstSeenAt ?? this.#clock().toISOString();
    this.#database
      .prepare(
        `INSERT INTO telegram_user_auth (
         user_id, latest_chat_id, first_seen_at, verified_at, preferred_language, failed_attempts, last_failed_at, banned_at, updated_at
       ) VALUES (?, ?, ?, NULL, NULL, 0, NULL, NULL, ?)`
      )
      .run(input.userId, input.chatId, firstSeenAt, firstSeenAt);

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

      this.#database
        .prepare(
          `UPDATE telegram_user_auth
         SET latest_chat_id = ?,
             verified_at = ?,
             failed_attempts = 0,
             last_failed_at = NULL,
             updated_at = ?
         WHERE user_id = ?`
        )
        .run(input.chatId, verifiedAt, verifiedAt, input.userId);

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

  setPreferredLanguage(
    input: TelegramUserLanguagePreferenceInput
  ): TelegramUserAuthRecord {
    return this.#database.withTransaction(() => {
      const existing = this.getOrCreateFirstSeen({
        userId: input.userId,
        chatId: input.chatId,
        ...(input.selectedAt ? { firstSeenAt: input.selectedAt } : {})
      });
      const selectedAt = input.selectedAt ?? this.#clock().toISOString();

      this.#database
        .prepare(
          `UPDATE telegram_user_auth
         SET latest_chat_id = ?,
             preferred_language = ?,
             updated_at = ?
         WHERE user_id = ?`
        )
        .run(input.chatId, input.preferredLanguage, selectedAt, input.userId);

      return {
        ...existing,
        latestChatId: input.chatId,
        preferredLanguage: input.preferredLanguage,
        updatedAt: selectedAt
      };
    });
  }

  recordFailedAttempt(
    input: TelegramUserFailedAttemptInput
  ): TelegramUserAuthRecord {
    if (input.banThreshold < 1) {
      throw new Error(
        `Ban threshold must be positive. Received: ${input.banThreshold}.`
      );
    }

    return this.#database.withTransaction(() => {
      const existing = this.getOrCreateFirstSeen({
        userId: input.userId,
        chatId: input.chatId,
        ...(input.failedAt ? { firstSeenAt: input.failedAt } : {})
      });
      const failedAt = input.failedAt ?? this.#clock().toISOString();
      const nextFailedAttempts = existing.verifiedAt
        ? 1
        : existing.failedAttempts + 1;
      const bannedAt =
        existing.bannedAt ??
        (nextFailedAttempts >= input.banThreshold ? failedAt : null);

      this.#database
        .prepare(
          `UPDATE telegram_user_auth
         SET latest_chat_id = ?,
             failed_attempts = ?,
             last_failed_at = ?,
             banned_at = ?,
             updated_at = ?
         WHERE user_id = ?`
        )
        .run(
          input.chatId,
          nextFailedAttempts,
          failedAt,
          bannedAt,
          failedAt,
          input.userId
        );

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
