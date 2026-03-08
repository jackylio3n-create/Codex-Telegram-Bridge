import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { TelegramBotClient } from "../../src/transport/telegram/client.js";
import { TelegramPollingService } from "../../src/transport/telegram/polling.js";

test("telegram polling stop aborts an in-flight getUpdates request", async () => {
  let aborted = false;

  const client = new TelegramBotClient({
    botToken: "token",
    fetchImplementation: async (_input, init) => {
      const signal = init?.signal;
      await new Promise<never>((_resolve, reject) => {
        if (signal?.aborted) {
          aborted = true;
          reject(createAbortError());
          return;
        }

        signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(createAbortError());
          },
          { once: true }
        );
      });
    }
  });

  const polling = new TelegramPollingService(
    client,
    {
      channelOffsets: {
        get() {
          return null;
        },
        save() {
          throw new Error("save should not be called for an aborted poll.");
        }
      },
      pendingPermissions: {
        get() {
          return null;
        }
      },
      telegramUserAuth: {
        get() {
          return null;
        },
        findByChatId() {
          return null;
        },
        list() {
          return [];
        },
        getOrCreateFirstSeen() {
          throw new Error(
            "getOrCreateFirstSeen should not be called for an aborted poll."
          );
        },
        markVerified() {
          throw new Error(
            "markVerified should not be called for an aborted poll."
          );
        },
        setPreferredLanguage() {
          throw new Error(
            "setPreferredLanguage should not be called for an aborted poll."
          );
        },
        recordFailedAttempt() {
          throw new Error(
            "recordFailedAttempt should not be called for an aborted poll."
          );
        }
      }
    },
    {
      botToken: "token",
      allowedUserIds: ["1"],
      tempDirectoryPath: "/tmp"
    }
  );

  const pollPromise = polling.pollOnce(() => undefined);
  await delay(25);
  polling.stop();

  await assert.rejects(pollPromise, (error: unknown) => {
    assert.ok(aborted);
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AbortError");
    return true;
  });
});

function createAbortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
