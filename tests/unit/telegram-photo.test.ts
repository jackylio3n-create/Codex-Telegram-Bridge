import test from "node:test";
import assert from "node:assert/strict";
import { pickPreferredPhotoSize } from "../../src/transport/telegram/photo.js";

test("pickPreferredPhotoSize selects the largest candidate without requiring sorted input", () => {
  const preferred = pickPreferredPhotoSize([
    {
      file_id: "small",
      width: 320,
      height: 240,
      file_size: 12_000
    },
    {
      file_id: "best",
      width: 1280,
      height: 720,
      file_size: 180_000
    },
    {
      file_id: "medium",
      width: 640,
      height: 480,
      file_size: 60_000
    }
  ]);

  assert.equal(preferred.file_id, "best");
});
