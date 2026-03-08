import test from "node:test";
import assert from "node:assert/strict";
import { TelegramBotClient } from "../../src/transport/telegram/client.js";
import { TelegramPreviewPublisher } from "../../src/transport/telegram/preview.js";

function createFakeTelegramFetch() {
  const sentMessages: Array<{
    readonly chatId: string;
    readonly text: string;
    readonly messageId: number;
  }> = [];
  const editedMessages: Array<{
    readonly chatId: string;
    readonly text: string;
    readonly messageId: number;
  }> = [];
  let nextMessageId = 100;

  const ok = (result: unknown) =>
    new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    });

  const fetchImplementation: typeof fetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = url.slice(url.lastIndexOf("/") + 1);
    const payload = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};

    switch (method) {
      case "sendMessage": {
        const messageId = nextMessageId++;
        sentMessages.push({
          chatId: String(payload.chat_id),
          text: String(payload.text),
          messageId
        });
        return ok({
          message_id: messageId,
          date: 1_772_766_400,
          text: String(payload.text),
          chat: {
            id: Number(payload.chat_id),
            type: "private"
          }
        });
      }
      case "editMessageText": {
        const messageId = Number(payload.message_id);
        editedMessages.push({
          chatId: String(payload.chat_id),
          text: String(payload.text),
          messageId
        });
        return ok({
          message_id: messageId,
          date: 1_772_766_400,
          text: String(payload.text),
          chat: {
            id: Number(payload.chat_id),
            type: "private"
          }
        });
      }
      default:
        throw new Error(`Unsupported Telegram method: ${method}`);
    }
  };

  return {
    fetchImplementation,
    sentMessages,
    editedMessages
  };
}

test("finalizePreview does not resend when the preview already matches the final text", async () => {
  const fakeFetch = createFakeTelegramFetch();
  const client = new TelegramBotClient({
    botToken: "test-token",
    fetchImplementation: fakeFetch.fetchImplementation
  });
  const publisher = new TelegramPreviewPublisher(client, {
    previewCapabilityMode: "edit",
    previewMaxLength: 1500,
    finalChunkMaxLength: 3600
  });

  const initialHandle = await publisher.beginPreview("123", "Running Codex...");
  const updatedHandle = await publisher.updatePreview(initialHandle, "hello");
  const result = await publisher.finalizePreview(updatedHandle, "hello");

  assert.equal(fakeFetch.sentMessages.length, 1);
  assert.equal(fakeFetch.editedMessages.length, 1);
  assert.deepEqual(
    fakeFetch.sentMessages.map((message) => message.text),
    ["Running Codex..."]
  );
  assert.deepEqual(
    fakeFetch.editedMessages.map((message) => message.text),
    ["hello"]
  );
  assert.deepEqual(result.sentMessageIds, [100]);
});

test("updatePreview skips editMessageText when the preview text is unchanged", async () => {
  const fakeFetch = createFakeTelegramFetch();
  const client = new TelegramBotClient({
    botToken: "test-token",
    fetchImplementation: fakeFetch.fetchImplementation
  });
  const publisher = new TelegramPreviewPublisher(client, {
    previewCapabilityMode: "edit",
    previewMaxLength: 1500,
    finalChunkMaxLength: 3600
  });

  const initialHandle = await publisher.beginPreview("123", "Running Codex...");
  const onceUpdatedHandle = await publisher.updatePreview(
    initialHandle,
    "hello"
  );
  const twiceUpdatedHandle = await publisher.updatePreview(
    onceUpdatedHandle,
    "hello"
  );

  assert.equal(fakeFetch.sentMessages.length, 1);
  assert.equal(fakeFetch.editedMessages.length, 1);
  assert.equal(twiceUpdatedHandle.previewText, "hello");
});
