import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { AppConfig } from "../../src/config/index.js";
import { createLogger } from "../../src/logger/index.js";
import { BridgeRuntime, readBridgeRuntimeState } from "../../src/runtime/bridge/index.js";
import { hashVerificationPassword } from "../../src/security/verification-password.js";
import { createBridgeStore, type BridgeStore } from "../../src/store/index.js";
import type { TelegramMessage, TelegramUpdate } from "../../src/transport/telegram/types.js";

const fakeCodexPath = join(
  import.meta.dirname,
  "fixtures",
  process.platform === "win32" ? "fake-codex.ps1" : "fake-codex.sh"
);

test("bridge runtime processes a new session and a text run end-to-end", {
  skip: process.platform === "win32" ? "Requires Linux-style workspace paths." : false
}, async () => {
  const harness = await createHarness();

  try {
    harness.api.pushUpdate(createTextUpdate(1, "/new"));
    harness.api.pushUpdate(createTextUpdate(2, "hello from telegram"));

    const runtime = await harness.createRuntime();
    const runPromise = runtime.runUntilStopped();

    await waitFor(() => harness.api.editedMessages.some((entry) => entry.text.includes("Default answer")));
    await runtime.stop();
    await runPromise;

    assert.ok(harness.api.sentMessages.some((entry) => entry.text.includes("Created and bound session")));
    assert.ok(harness.api.sentMessages.some((entry) => entry.text.includes("Running Codex")));
    assert.ok(harness.api.editedMessages.some((entry) => entry.text.includes("Default answer")));
    assert.equal(harness.store.sessions.listOverview()[0]?.runState, "idle");

     const state = await readBridgeRuntimeState(harness.config.paths.stateFilePath);
     const sessionId = harness.store.sessions.listOverview()[0]?.sessionId;
     const auditRows = sessionId ? harness.store.auditLogs.list({ sessionId }) : [];
     const userInput = auditRows.find((entry) => entry.eventType === "user_input");
     const agentText = auditRows.find((entry) => entry.eventType === "agent_text");

     assert.equal(state?.status, "stopped");
     assert.equal(state?.activeRunCount, 0);
     assert.equal(state?.lastEvent?.includes(":") ?? false, false);
     assert.deepEqual(userInput?.payload, {
       contentType: "text",
       messageLength: "hello from telegram".length
     });
     assert.deepEqual(agentText?.payload, {
       messageLength: "Default answer".length
     });
   } finally {
     await harness.dispose();
   }
});

test("bridge runtime cancels an active run after /stop", {
  skip: process.platform === "win32" ? "Requires Linux-style workspace paths." : false
}, async () => {
  const harness = await createHarness();
  let runtime: BridgeRuntime | null = null;
  let runPromise: Promise<void> | null = null;
  try {
    harness.api.pushUpdate(createTextUpdate(1, "/new"));
    harness.api.pushUpdate(createTextUpdate(2, "start a long task"));
    harness.api.pushUpdate(createTextUpdate(3, "/stop"));

    runtime = await harness.createRuntime("cancel");
    runPromise = runtime.runUntilStopped();

    await waitFor(() => {
      return harness.api.sentMessages.some((entry) => entry.text.includes("Cancellation requested"))
        && harness.api.editedMessages.some((entry) => {
          return entry.text.includes("Run interrupted") || entry.text.includes("Run cancelled");
        });
    });
    await runtime.stop();
    await runPromise;

    assert.ok(harness.api.sentMessages.some((entry) => entry.text.includes("Cancellation requested")));
    assert.ok(harness.api.editedMessages.some((entry) => {
      return entry.text.includes("Run interrupted") || entry.text.includes("Run cancelled");
    }));
    assert.equal(harness.store.sessions.listOverview()[0]?.runState, "cancelled");
  } finally {
    if (runtime) {
      await runtime.stop();
    }
    if (runPromise) {
      await runPromise.catch(() => undefined);
    }
    await harness.dispose();
  }
});

test("bridge runtime downloads image input and cleans up temp files after the run", {
  skip: process.platform === "win32" ? "Requires Linux-style workspace paths." : false
}, async () => {
  const harness = await createHarness();

  try {
    harness.api.pushUpdate(createTextUpdate(1, "/new"));
    harness.api.pushUpdate({
      update_id: 2,
      message: {
        message_id: 2,
        date: 1_772_766_401,
        caption: "inspect this image",
        photo: [
          {
            file_id: "photo-small",
            width: 64,
            height: 64,
            file_size: 100
          },
          {
            file_id: "photo-large",
            width: 128,
            height: 128,
            file_size: 200
          }
        ],
        chat: {
          id: 1,
          type: "private"
        },
        from: {
          id: 1,
          is_bot: false,
          first_name: "Tester"
        }
      }
    });

    const runtime = await harness.createRuntime();
    const runPromise = runtime.runUntilStopped();

    await waitFor(() => harness.api.editedMessages.some((entry) => entry.text.includes("Default answer")));
    await runtime.stop();
    await runPromise;

    assert.equal(harness.api.downloadedFiles.length, 1);
    const tempEntries = await readdir(harness.config.paths.tempDir);
    assert.equal(tempEntries.filter((entry) => entry.startsWith("telegram-media-")).length, 0);
  } finally {
    await harness.dispose();
  }
});

test("bridge runtime stores runtime approvals and resumes after approval", {
  skip: process.platform === "win32" ? "Requires Linux-style workspace paths." : false
}, async () => {
  const harness = await createHarness();
  try {
    harness.api.pushUpdate(createTextUpdate(1, "/new"));
    harness.api.pushUpdate(createTextUpdate(2, "run something that needs approval"));

    const runtime = await harness.createRuntime("approval");
    const runPromise = runtime.runUntilStopped();

    await waitFor(() => harness.store.pendingPermissions.list({ resolved: false }).length === 1);
    const permission = harness.store.pendingPermissions.list({ resolved: false })[0];
    assert.ok(permission);
    assert.equal(permission.summary, "exec_command approval request");

    const approvalMessage = harness.api.sentMessages.find((entry) => entry.text.includes("Codex needs approval"));
    assert.ok(approvalMessage);
    assert.match(approvalMessage.text, /git status/);

    harness.api.pushUpdate(createApprovalCallbackUpdate(3, approvalMessage.messageId, permission.permissionId, "approve"));

    await waitFor(() => harness.api.editedMessages.some((entry) => entry.text.includes("Approved answer")));
    await runtime.stop();
    await runPromise;

    assert.equal(harness.store.pendingPermissions.get(permission.permissionId)?.resolution, "approved");
    assert.equal(harness.store.sessions.listOverview()[0]?.runState, "idle");
    assert.ok(harness.api.sentMessages.some((entry) => entry.text.includes("Approval granted")));
    assert.ok(harness.api.editedMessages.some((entry) => entry.text.includes("Approved answer")));
  } finally {
    await harness.dispose();
  }
});

test("bridge runtime stop does not access a closed owned store during shutdown", {
  skip: process.platform === "win32" ? "Requires Linux-style workspace paths." : false
}, async () => {
  const harness = await createHarness();

  try {
    harness.api.pushUpdate(createTextUpdate(1, "/new"));

    const runtime = await BridgeRuntime.create({
      config: harness.config,
      codexExecutablePath: fakeCodexPath,
      telegramFetchImplementation: harness.api.fetch.bind(harness.api),
      logger: createLogger({
        name: harness.config.appName,
        level: "error",
        console: false,
        filePath: harness.config.paths.logFilePath,
        redactValues: [
          harness.config.telegramBotToken,
          ...(harness.config.verificationPasswordHash ? [harness.config.verificationPasswordHash] : [])
        ]
      })
    });

    const runPromise = runtime.runUntilStopped();
    await waitFor(() => harness.api.sentMessages.some((entry) => entry.text.includes("Created and bound session")));
    await runtime.stop();
    await runPromise;

    const state = await readBridgeRuntimeState(harness.config.paths.stateFilePath);
    assert.equal(state?.status, "stopped");
  } finally {
    await harness.dispose();
  }
});

test("bridge runtime requires first-contact verification and bans after five wrong passwords", async () => {
  const harness = await createHarness({
    verificationPasswordHash: hashVerificationPassword("bridge-secret")
  });

  try {
    harness.api.pushUpdate(createTextUpdate(1, "/start"));
    harness.api.pushUpdate(createTextUpdate(2, "wrong-1"));
    harness.api.pushUpdate(createTextUpdate(3, "wrong-2"));
    harness.api.pushUpdate(createTextUpdate(4, "wrong-3"));
    harness.api.pushUpdate(createTextUpdate(5, "wrong-4"));
    harness.api.pushUpdate(createTextUpdate(6, "wrong-5"));
    harness.api.pushUpdate(createTextUpdate(7, "/new"));
    harness.api.pushUpdate({
      update_id: 8,
      message: {
        message_id: 8,
        date: 1_772_766_408,
        caption: "blocked image",
        photo: [
          {
            file_id: "photo-after-ban",
            width: 64,
            height: 64,
            file_size: 100
          }
        ],
        chat: {
          id: 1,
          type: "private"
        },
        from: {
          id: 1,
          is_bot: false,
          first_name: "Tester"
        }
      }
    });

    const runtime = await harness.createRuntime();
    const runPromise = runtime.runUntilStopped();

    await waitFor(() => harness.api.sentMessages.some((entry) => entry.text.includes("blocked locally")));
    await runtime.stop();
    await runPromise;

    assert.ok(harness.api.sentMessages.some((entry) => entry.text.includes("欢迎使用")));
    assert.ok(harness.api.sentMessages.some((entry) => entry.text.includes("Incorrect verification password")));
    assert.ok(harness.api.sentMessages.some((entry) => entry.text.includes("blocked locally")));
    assert.equal(harness.store.telegramUserAuth.get("1")?.failedAttempts, 5);
    assert.ok(harness.store.telegramUserAuth.get("1")?.bannedAt);
    assert.equal(harness.store.sessions.listOverview().length, 0);
    assert.equal(harness.api.downloadedFiles.length, 0);
    assert.equal(harness.api.sentMessages.some((entry) => entry.text.includes("Created and bound session")), false);
  } finally {
    await harness.dispose();
  }
});

test("bridge runtime blocks all bot usage until a verified user chooses a prompt language", async () => {
  const harness = await createHarness({
    verificationPasswordHash: hashVerificationPassword("bridge-secret")
  });
  let runtime: BridgeRuntime | null = null;
  let runPromise: Promise<void> | null = null;

  try {
    harness.api.pushUpdate(createTextUpdate(1, "bridge-secret"));
    harness.api.pushUpdate(createTextUpdate(2, "/new"));
    harness.api.pushUpdate({
      update_id: 3,
      message: {
        message_id: 3,
        date: 1_772_766_403,
        caption: "blocked before language choice",
        photo: [
          {
            file_id: "photo-before-language",
            width: 64,
            height: 64,
            file_size: 100
          }
        ],
        chat: {
          id: 1,
          type: "private"
        },
        from: {
          id: 1,
          is_bot: false,
          first_name: "Tester"
        }
      }
    });
    runtime = await harness.createRuntime();
    runPromise = runtime.runUntilStopped();

    await waitFor(() => harness.api.sentMessages.some((entry) => entry.text.includes("choose your prompt language")));
    await runtime.stop();
    await runPromise;

    assert.equal(harness.store.telegramUserAuth.get("1")?.preferredLanguage, null);
    assert.equal(harness.api.downloadedFiles.length, 0);
    assert.ok(harness.api.sentMessages.some((entry) => entry.text.includes("choose your prompt language")));
    assert.equal(harness.api.sentMessages.some((entry) => entry.text.includes("Created and bound session")), false);
  } finally {
    if (runtime) {
      await runtime.stop();
    }
    if (runPromise) {
      await runPromise.catch(() => undefined);
    }
    await harness.dispose();
  }
});

async function createHarness(): Promise<{
  readonly config: AppConfig;
  readonly store: BridgeStore;
  readonly api: FakeTelegramApi;
  createRuntime(scenario?: string): Promise<BridgeRuntime>;
  dispose(): Promise<void>;
}>;
async function createHarness(options: {
  readonly verificationPasswordHash?: string | null;
} = {}): Promise<{
  readonly config: AppConfig;
  readonly store: BridgeStore;
  readonly api: FakeTelegramApi;
  createRuntime(scenario?: string): Promise<BridgeRuntime>;
  dispose(): Promise<void>;
}> {
  const tempRoot = await mkdtemp(join(tmpdir(), "codex-telegram-bridge-runtime-"));
  const appHome = join(tempRoot, "app");
  await mkdir(appHome, { recursive: true });
  const workspaceRoot = join(tempRoot, "workspaces", "main");
  await mkdir(workspaceRoot, { recursive: true });

  const config: AppConfig = {
    appName: "codex-telegram-bridge",
    env: "test",
    codexHome: tempRoot,
    defaultWorkspaceRoot: workspaceRoot,
    telegramBotToken: "telegram-token",
    verificationPasswordHash: options.verificationPasswordHash ?? null,
    allowedTelegramUserIds: ["1"],
    ownerTelegramUserId: "1",
    ownerTelegramChatId: "1",
    logLevel: "error",
    secretEnvVarNames: [
      "CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN",
      "CODEX_TELEGRAM_BRIDGE_VERIFICATION_PASSWORD_HASH"
    ],
    paths: {
      appHome,
      dataDir: join(appHome, "data"),
      logsDir: join(appHome, "logs"),
      tempDir: join(appHome, "tmp"),
      runtimeDir: join(appHome, "run"),
      logFilePath: join(appHome, "logs", "bridge.log"),
      stateFilePath: join(appHome, "run", "runtime-state.json"),
      pidFilePath: join(appHome, "run", "bridge.pid")
    },
    defaults: {
      previewMaxLength: 1500,
      finalChunkMaxLength: 3600,
      offsetJumpWarningThreshold: 10_000,
      auditLevel: "minimal",
      includeRuntimeIdentifiers: false,
      maxAuditRows: 1000,
      maxSummariesPerSession: 10,
      resolvedApprovalRetentionDays: 7,
      expiredApprovalRetentionDays: 1
    }
  };

  const store = await createBridgeStore({
    databaseFilePath: join(appHome, "data", "bridge.sqlite3")
  });
  const api = new FakeTelegramApi();

  return {
    config,
    store,
    api,
    async createRuntime(scenario?: string) {
      return BridgeRuntime.create({
        config,
        store,
        codexExecutablePath: fakeCodexPath,
        ...(scenario
          ? {
              codexEnvironment: {
                FAKE_CODEX_SCENARIO: scenario
              }
            }
          : {}),
        telegramFetchImplementation: api.fetch.bind(api),
        logger: createLogger({
          name: config.appName,
          level: "error",
          console: false,
          filePath: config.paths.logFilePath,
          redactValues: [
            config.telegramBotToken,
            ...(config.verificationPasswordHash ? [config.verificationPasswordHash] : [])
          ]
        })
      });
    },
    async dispose() {
      store.close();
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(tempRoot, { recursive: true, force: true });
    }
  };
}

class FakeTelegramApi {
  readonly updates: TelegramUpdate[] = [];
  readonly sentMessages: Array<{ readonly chatId: string; readonly text: string; readonly messageId: number }> = [];
  readonly editedMessages: Array<{ readonly chatId: string; readonly text: string; readonly messageId: number }> = [];
  readonly downloadedFiles: string[] = [];
  #nextMessageId = 500;

  pushUpdate(update: TelegramUpdate): void {
    this.updates.push(update);
  }

  async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("/file/bot")) {
      const filePath = url.slice(url.lastIndexOf("/") + 1);
      this.downloadedFiles.push(filePath);
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }

    const method = url.slice(url.lastIndexOf("/") + 1);
    const payload = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};

    switch (method) {
      case "getUpdates":
        return this.#ok(this.updates.splice(0));
      case "sendMessage": {
        const message = this.#createMessage(payload);
        this.sentMessages.push({
          chatId: String(payload.chat_id),
          text: String(payload.text),
          messageId: message.message_id
        });
        return this.#ok(message);
      }
      case "editMessageText": {
        const message = this.#createMessage(payload, Number(payload.message_id));
        this.editedMessages.push({
          chatId: String(payload.chat_id),
          text: String(payload.text),
          messageId: message.message_id
        });
        return this.#ok(message);
      }
      case "answerCallbackQuery":
        return this.#ok(true);
      case "getFile":
        return this.#ok({
          file_id: payload.file_id,
          file_path: `${String(payload.file_id)}.jpg`,
          file_size: 3
        });
      default:
        throw new Error(`Unsupported Telegram method: ${method}`);
    }
  }

  #createMessage(payload: Record<string, unknown>, explicitMessageId?: number): TelegramMessage {
    return {
      message_id: explicitMessageId ?? this.#nextMessageId++,
      date: 1_772_766_400,
      text: String(payload.text),
      chat: {
        id: Number(payload.chat_id),
        type: "private"
      }
    };
  }

  #ok(result: unknown): Response {
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    });
  }
}

function createTextUpdate(updateId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_772_766_400 + updateId,
      text,
      chat: {
        id: 1,
        type: "private"
      },
      from: {
        id: 1,
        is_bot: false,
        first_name: "Tester"
      }
    }
  };
}

function createApprovalCallbackUpdate(
  updateId: number,
  messageId: number,
  permissionId: string,
  decision: "approve" | "deny"
): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      data: `${decision === "approve" ? "pa" : "pd"}:${permissionId}`,
      from: {
        id: 1,
        is_bot: false,
        first_name: "Tester"
      },
      message: {
        message_id: messageId,
        date: 1_772_766_400 + updateId,
        text: "approval request",
        chat: {
          id: 1,
          type: "private"
        },
        from: {
          id: 0,
          is_bot: true,
          first_name: "Bridge"
        }
      }
    }
  };
}


async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await delay(100);
  }

  throw new Error("Timed out waiting for runtime condition.");
}
