import assert from "node:assert/strict";
import test from "node:test";
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

function createDependencies() {
  return {
    allowedUserIds: new Set(["456"]),
    store: {
      pendingPermissions: {
        get() {
          return null;
        }
      }
    },
    client: {
      async answerCallbackQuery() {
        throw new Error("answerCallbackQuery should not be called for plain message updates.");
      }
    },
    callbackReceivedText: "Received.",
    callbackStaleText: "Expired or already handled."
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
