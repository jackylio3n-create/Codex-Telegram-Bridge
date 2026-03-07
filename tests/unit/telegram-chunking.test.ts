import test from "node:test";
import assert from "node:assert/strict";
import {
  chunkTelegramText,
  createTelegramPreviewText
} from "../../src/transport/telegram/chunking.js";

test("chunkTelegramText prefers splitting on a newline near the limit", () => {
  const text = "alpha beta\ncharlie delta\necho";
  const chunks = chunkTelegramText(text, { maxLength: 16 });

  assert.equal(chunks.length, 3);
  assert.equal(chunks[0]?.text, "alpha beta\n");
  assert.equal(chunks[1]?.text, "charlie delta\n");
  assert.equal(chunks[2]?.text, "echo");
});

test("chunkTelegramText throws when max length is not positive", () => {
  assert.throws(() => chunkTelegramText("hello", { maxLength: 0 }), /must be positive/);
});

test("createTelegramPreviewText truncates and appends an ellipsis", () => {
  const preview = createTelegramPreviewText("hello world   ", 8);
  assert.equal(preview, "hello...");
});
