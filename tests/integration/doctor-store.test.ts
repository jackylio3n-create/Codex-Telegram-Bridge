import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildOffsetsCheck } from "../../src/doctor/checks/offsets.js";
import { buildRunsCheck } from "../../src/doctor/checks/runs.js";
import { createBridgeStore, type BridgeStore } from "../../src/store/index.js";

test("store-backed diagnostics warn on suspicious offset jumps", async () => {
  const harness = await createStoreHarness();

  try {
    harness.store.channelOffsets.save({
      channelKey: "telegram:getUpdates",
      currentOffset: 15_500,
      previousOffset: 100
    });

    const check = buildOffsetsCheck(
      harness.store,
      "telegram:getUpdates",
      10_000
    );
    assert.equal(check.status, "warning");
    assert.match(check.summary, /Suspicious offset jump/);
  } finally {
    await harness.dispose();
  }
});

test("store-backed diagnostics flag waiting approval sessions without unresolved permissions", async () => {
  const harness = await createStoreHarness();

  try {
    harness.store.sessions.save({
      sessionId: "session-diagnostics",
      workspaceRoot: "/workspaces/main",
      extraAllowedDirs: [],
      cwd: "/workspaces/main",
      mode: "code",
      runState: "waiting_approval",
      activeRunId: "run-missing"
    });

    const check = buildRunsCheck(harness.store);
    assert.equal(check.status, "error");
    assert.ok(
      check.details.some((detail) =>
        detail.includes("waiting_approval has no unresolved approval")
      )
    );
  } finally {
    await harness.dispose();
  }
});

async function createStoreHarness(): Promise<{
  readonly store: BridgeStore;
  dispose(): Promise<void>;
}> {
  const tempRoot = await mkdtemp(
    join(tmpdir(), "codex-telegram-bridge-doctor-")
  );
  const store = await createBridgeStore({
    databaseFilePath: join(tempRoot, "bridge.sqlite3")
  });

  return {
    store,
    async dispose() {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  };
}
