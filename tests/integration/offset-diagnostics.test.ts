import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildOffsetsCheck } from "../../src/doctor/checks/offsets.js";
import { createBridgeStore } from "../../src/store/index.js";

test("offset diagnostics fail when the polling offset row is missing", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "bridge-offsets-missing-"));
  const store = await createBridgeStore({
    databaseFilePath: join(tempDir, "bridge.sqlite3")
  });
  t.after(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  const check = buildOffsetsCheck(store, "telegram:getUpdates", 10_000);
  assert.equal(check.status, "error");
  assert.equal(check.summary, "Offset row telegram:getUpdates is missing.");
});

test("offset diagnostics warn on suspicious jumps but accept consistent rows", async (t) => {
  const tempDir = await mkdtemp(join(tmpdir(), "bridge-offsets-jump-"));
  const store = await createBridgeStore({
    databaseFilePath: join(tempDir, "bridge.sqlite3")
  });
  t.after(async () => {
    store.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  store.channelOffsets.save({
    channelKey: "telegram:getUpdates",
    currentOffset: 20_500,
    previousOffset: 100,
    updatedAt: "2026-03-06T14:00:00.000Z"
  });

  const check = buildOffsetsCheck(store, "telegram:getUpdates", 10_000);
  assert.equal(check.status, "warning");
  assert.equal(check.summary, "Suspicious offset jump detected.");
  assert.match(check.details.join("\n"), /jump=20400/);
});
