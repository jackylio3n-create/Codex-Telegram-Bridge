import assert from "node:assert/strict";
import test from "node:test";
import { hashVerificationPassword } from "../../src/security/verification-password.js";
import { mapTelegramUpdateToInbound } from "../../src/transport/telegram/updates.js";

test("mapTelegramUpdateToInbound parses supported slash commands through shared command helpers", async () => {
  for (const testCase of [
    {
      text: "/bind session-1",
      assertInbound(inbound: Record<string, unknown>) {
        assert.equal(inbound.command, "bind");
        assert.equal(inbound.targetSessionId, "session-1");
      }
    },
    {
      text: "/new /workspace/app",
      assertInbound(inbound: Record<string, unknown>) {
        assert.equal(inbound.command, "new");
        assert.equal(inbound.requestedCwd, "/workspace/app");
      }
    },
    {
      text: "/cwd /workspace/logs",
      assertInbound(inbound: Record<string, unknown>) {
        assert.equal(inbound.command, "cwd");
        assert.equal(inbound.path, "/workspace/logs");
      }
    },
    {
      text: "/cd /workspace/tmp",
      assertInbound(inbound: Record<string, unknown>) {
        assert.equal(inbound.command, "cwd");
        assert.equal(inbound.path, "/workspace/tmp");
      }
    },
    {
      text: "/mode@bridge plan",
      assertInbound(inbound: Record<string, unknown>) {
        assert.equal(inbound.command, "mode");
        assert.equal(inbound.mode, "plan");
      }
    },
    {
      text: "/perm approve perm-1",
      assertInbound(inbound: Record<string, unknown>) {
        assert.equal(inbound.command, "perm");
        assert.deepEqual(inbound.args, ["approve", "perm-1"]);
      }
    },
    {
      text: "/prune 2",
      assertInbound(inbound: Record<string, unknown>) {
        assert.equal(inbound.command, "prune");
        assert.deepEqual(inbound.args, ["2"]);
      }
    },
    {
      text: "/clean 2",
      assertInbound(inbound: Record<string, unknown>) {
        assert.equal(inbound.command, "prune");
        assert.deepEqual(inbound.args, ["2"]);
      }
    },
    {
      text: "/reasoning xhigh",
      assertInbound(inbound: Record<string, unknown>) {
        assert.equal(inbound.command, "reasoning");
        assert.deepEqual(inbound.args, ["xhigh"]);
      }
    },
    {
      text: "/think xhigh",
      assertInbound(inbound: Record<string, unknown>) {
        assert.equal(inbound.command, "reasoning");
        assert.deepEqual(inbound.args, ["xhigh"]);
      }
    },
    {
      text: "/scope system",
      assertInbound(inbound: Record<string, unknown>) {
        assert.equal(inbound.command, "scope");
        assert.deepEqual(inbound.args, ["system"]);
      }
    },
    {
      text: "/stat",
      assertInbound(inbound: Record<string, unknown>) {
        assert.equal(inbound.command, "status");
      }
    },
    {
      text: "/sess",
      assertInbound(inbound: Record<string, unknown>) {
        assert.equal(inbound.command, "sessions");
      }
    },
    {
      text: "/allow /workspace/shared",
      assertInbound(inbound: Record<string, unknown>) {
        assert.equal(inbound.command, "adddir");
        assert.equal(inbound.path, "/workspace/shared");
      }
    }
  ]) {
    const result = await mapTelegramUpdateToInbound(
      createTextUpdate(1, testCase.text),
      createDependencies()
    );

    assert.equal(result.kind, "accepted");
    if (result.kind !== "accepted") {
      continue;
    }

    const inbound = result.envelope.inboundMessage;
    assert.equal(inbound.type, "command");
    testCase.assertInbound(inbound as Record<string, unknown>);
  }
});

test("mapTelegramUpdateToInbound uses the preferred photo helper for unsorted photo sizes", async () => {
  const result = await mapTelegramUpdateToInbound(
    {
      update_id: 1,
      message: {
        ...createBaseMessage(),
        caption: "diagram",
        photo: [
          {
            file_id: "large-area",
            width: 300,
            height: 300
          },
          {
            file_id: "preferred-by-weight",
            width: 100,
            height: 100,
            file_size: 100_001
          },
          {
            file_id: "small",
            width: 64,
            height: 64,
            file_size: 512
          }
        ]
      }
    },
    createDependencies()
  );

  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") {
    return;
  }

  const inbound = result.envelope.inboundMessage;
  assert.equal(inbound.type, "user_input");
  assert.equal(inbound.contentType, "image");
  assert.equal(inbound.telegramFileId, "preferred-by-weight");
  assert.equal(inbound.caption, "diagram");
});

test("mapTelegramUpdateToInbound sends a bilingual welcome for first-contact /start without counting a failure", async () => {
  const dependencies = createDependencies({
    verificationPasswordHash: hashVerificationPassword("bridge-secret")
  });

  const result = await mapTelegramUpdateToInbound(
    createTextUpdate(1, "/start"),
    dependencies
  );

  assert.equal(result.kind, "ignored");
  assert.equal(result.ignored.reason, "verification_required");
  assert.equal(dependencies.sentMessages.length, 1);
  assert.match(dependencies.sentMessages[0]?.text ?? "", /欢迎使用/);
  assert.match(dependencies.sentMessages[0]?.text ?? "", /Welcome/);
  assert.equal(dependencies.authState.get("456")?.failedAttempts ?? 0, 0);
});

test("mapTelegramUpdateToInbound verifies the first plain-text password and then requires a language choice", async () => {
  const dependencies = createDependencies({
    verificationPasswordHash: hashVerificationPassword("bridge-secret")
  });

  const result = await mapTelegramUpdateToInbound(
    createTextUpdate(1, "bridge-secret"),
    dependencies
  );

  assert.equal(result.kind, "ignored");
  assert.equal(result.ignored.reason, "language_required");
  assert.match(dependencies.sentMessages[0]?.text ?? "", /请选择提示语言|choose your prompt language/);
  assert.ok(dependencies.authState.get("456")?.verifiedAt);
  assert.equal(dependencies.authState.get("456")?.preferredLanguage, null);
});

test("mapTelegramUpdateToInbound stores the selected prompt language after verification", async () => {
  const dependencies = createDependencies({
    verificationPasswordHash: hashVerificationPassword("bridge-secret")
  });

  await mapTelegramUpdateToInbound(createTextUpdate(1, "bridge-secret"), dependencies);

  const result = await mapTelegramUpdateToInbound(
    {
      update_id: 2,
      callback_query: {
        id: "callback-lang",
        data: "lang:zh",
        from: {
          id: 456,
          is_bot: false,
          first_name: "Tester"
        },
        message: {
          ...createBaseMessage(),
          message_id: 2,
          text: "choose language"
        }
      }
    },
    dependencies
  );

  assert.equal(result.kind, "ignored");
  assert.equal(result.ignored.reason, "language_selected");
  assert.equal(dependencies.authState.get("456")?.preferredLanguage, "zh");
  assert.equal(dependencies.answeredCallbacks.at(-1)?.text, "语言已保存。");
  assert.equal(dependencies.sentMessages.at(-1)?.text, "后续提示将使用中文。");
});

test("mapTelegramUpdateToInbound bans a user after five incorrect passwords", async () => {
  const dependencies = createDependencies({
    verificationPasswordHash: hashVerificationPassword("bridge-secret")
  });

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const result = await mapTelegramUpdateToInbound(
      createTextUpdate(attempt, `wrong-${attempt}`),
      dependencies
    );

    assert.equal(result.kind, "ignored");
  }

  const authState = dependencies.authState.get("456");
  assert.equal(authState?.failedAttempts, 5);
  assert.ok(authState?.bannedAt);
  assert.match(dependencies.sentMessages.at(-1)?.text ?? "", /blocked locally/);

  const blocked = await mapTelegramUpdateToInbound(
    createTextUpdate(6, "bridge-secret"),
    dependencies
  );
  assert.equal(blocked.kind, "ignored");
  assert.equal(blocked.ignored.reason, "user_banned");
});

test("mapTelegramUpdateToInbound silently drops callbacks from banned users", async () => {
  const dependencies = createDependencies({
    verificationPasswordHash: hashVerificationPassword("bridge-secret")
  });

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await mapTelegramUpdateToInbound(
      createTextUpdate(attempt, `wrong-${attempt}`),
      dependencies
    );
  }

  const result = await mapTelegramUpdateToInbound(
    {
      update_id: 10,
      callback_query: {
        id: "callback-10",
        data: "pa:perm-1",
        from: {
          id: 456,
          is_bot: false,
          first_name: "Tester"
        },
        message: {
          ...createBaseMessage(),
          message_id: 10,
          text: "approval request"
        }
      }
    },
    dependencies
  );

  assert.equal(result.kind, "ignored");
  assert.equal(result.ignored.reason, "user_banned");
  assert.equal(dependencies.answeredCallbacks.length, 0);
});

function createDependencies(options: {
  readonly verificationPasswordHash?: string | null;
} = {}) {
  const authState = new InMemoryTelegramUserAuthRepository();
  const sentMessages: Array<{ readonly chatId: string; readonly text: string }> = [];
  const answeredCallbacks: Array<{ readonly callbackQueryId: string; readonly text?: string }> = [];

  return {
    allowedUserIds: new Set(["456"]),
    verificationPasswordHash: options.verificationPasswordHash ?? null,
    ownerUserId: null,
    ownerChatId: null,
    store: {
      pendingPermissions: {
        get() {
          return null;
        }
      },
      telegramUserAuth: authState
    },
    client: {
      async answerCallbackQuery(callbackQueryId: string, options?: { text?: string }) {
        answeredCallbacks.push({
          callbackQueryId,
          ...(options?.text ? { text: options.text } : {})
        });
        return true;
      },
      async sendMessage(chatId: string, text: string) {
        sentMessages.push({ chatId, text });
        return {
          messageId: sentMessages.length,
          rawMessage: {
            ...createBaseMessage(),
            message_id: sentMessages.length,
            text,
            chat: {
              id: Number(chatId),
              type: "private" as const
            }
          }
        };
      }
    },
    callbackReceivedText: "Received.",
    callbackStaleText: "Expired or already handled.",
    authState,
    sentMessages,
    answeredCallbacks
  };
}

function createTextUpdate(updateId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      ...createBaseMessage(),
      text
    }
  };
}

function createBaseMessage() {
  return {
    message_id: 99,
    date: 1_772_766_400,
    chat: {
      id: 123,
      type: "private" as const
    },
    from: {
      id: 456,
      is_bot: false,
      first_name: "Tester"
    }
  };
}

class InMemoryTelegramUserAuthRepository {
  readonly #records = new Map<string, {
    userId: string;
    latestChatId: string;
    firstSeenAt: string;
    verifiedAt: string | null;
    preferredLanguage: "zh" | "en" | null;
    failedAttempts: number;
    lastFailedAt: string | null;
    bannedAt: string | null;
    updatedAt: string;
  }>();

  get(userId: string) {
    return this.#records.get(userId) ?? null;
  }

  findByChatId(chatId: string) {
    return [...this.#records.values()].find((record) => record.latestChatId === chatId) ?? null;
  }

  list() {
    return [...this.#records.values()];
  }

  getOrCreateFirstSeen(input: { userId: string; chatId: string; firstSeenAt?: string }) {
    const existing = this.#records.get(input.userId);
    if (existing) {
      const updated = {
        ...existing,
        latestChatId: input.chatId
      };
      this.#records.set(input.userId, updated);
      return updated;
    }

    const firstSeenAt = input.firstSeenAt ?? new Date().toISOString();
    const created = {
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
    this.#records.set(input.userId, created);
    return created;
  }

  markVerified(input: { userId: string; chatId: string; verifiedAt?: string }) {
    const existing = this.getOrCreateFirstSeen({
      userId: input.userId,
      chatId: input.chatId,
      ...(input.verifiedAt ? { firstSeenAt: input.verifiedAt } : {})
    });
    const verifiedAt = input.verifiedAt ?? new Date().toISOString();
    const updated = {
      ...existing,
      latestChatId: input.chatId,
      verifiedAt,
      preferredLanguage: existing.preferredLanguage,
      failedAttempts: 0,
      lastFailedAt: null,
      updatedAt: verifiedAt
    };
    this.#records.set(input.userId, updated);
    return updated;
  }

  setPreferredLanguage(input: { userId: string; chatId: string; preferredLanguage: "zh" | "en"; selectedAt?: string }) {
    const existing = this.getOrCreateFirstSeen({
      userId: input.userId,
      chatId: input.chatId,
      ...(input.selectedAt ? { firstSeenAt: input.selectedAt } : {})
    });
    const selectedAt = input.selectedAt ?? new Date().toISOString();
    const updated = {
      ...existing,
      latestChatId: input.chatId,
      preferredLanguage: input.preferredLanguage,
      updatedAt: selectedAt
    };
    this.#records.set(input.userId, updated);
    return updated;
  }

  recordFailedAttempt(input: { userId: string; chatId: string; failedAt?: string; banThreshold: number }) {
    const existing = this.getOrCreateFirstSeen({
      userId: input.userId,
      chatId: input.chatId,
      ...(input.failedAt ? { firstSeenAt: input.failedAt } : {})
    });
    const failedAt = input.failedAt ?? new Date().toISOString();
    const failedAttempts = existing.failedAttempts + 1;
    const updated = {
      ...existing,
      latestChatId: input.chatId,
      preferredLanguage: existing.preferredLanguage,
      failedAttempts,
      lastFailedAt: failedAt,
      bannedAt: failedAttempts >= input.banThreshold ? failedAt : existing.bannedAt,
      updatedAt: failedAt
    };
    this.#records.set(input.userId, updated);
    return updated;
  }
}
