import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBridgeStore, type BridgeStore } from "../../src/store/index.js";

test("sessions repository returns a merged record after update", async () => {
  const harness = await createStoreHarness();

  try {
    const created = harness.store.sessions.save({
      sessionId: "session-1",
      workspaceRoot: "/workspaces/main",
      extraAllowedDirs: ["/workspaces/shared"],
      cwd: "/workspaces/main",
      mode: "code",
      codexThreadId: "thread-1",
      rollingSummary: "seed summary",
      runState: "running",
      activeRunId: "run-1",
      staleRecovered: true,
      lastError: "none",
      createdAt: "2026-03-06T10:00:00.000Z",
      updatedAt: "2026-03-06T10:00:00.000Z"
    });

    const updated = harness.store.sessions.update("session-1", {
      cwd: "/workspaces/shared",
      updatedAt: "2026-03-06T10:05:00.000Z"
    });

    assert.equal(updated.sessionId, "session-1");
    assert.equal(updated.cwd, "/workspaces/shared");
    assert.deepEqual(updated.extraAllowedDirs, ["/workspaces/shared"]);
    assert.equal(updated.codexThreadId, "thread-1");
    assert.equal(updated.rollingSummary, "seed summary");
    assert.equal(updated.runState, "running");
    assert.equal(updated.activeRunId, "run-1");
    assert.equal(updated.staleRecovered, true);
    assert.equal(updated.createdAt, created.createdAt);
    assert.equal(updated.updatedAt, "2026-03-06T10:05:00.000Z");
    assert.deepEqual(harness.store.sessions.get("session-1"), updated);
  } finally {
    await harness.dispose();
  }
});

test("sessions repository accepts explicit nulls for nullable fields", async () => {
  const harness = await createStoreHarness();

  try {
    harness.store.sessions.save({
      sessionId: "session-2",
      workspaceRoot: "/workspaces/main",
      extraAllowedDirs: [],
      cwd: "/workspaces/main",
      mode: "code",
      codexThreadId: "thread-2",
      rollingSummary: "seed summary",
      runState: "running",
      cancellationResult: "partial",
      activeRunId: "run-2",
      lastError: "boom",
      createdAt: "2026-03-06T11:00:00.000Z",
      updatedAt: "2026-03-06T11:00:00.000Z"
    });

    const cleared = harness.store.sessions.update("session-2", {
      codexThreadId: null,
      rollingSummary: null,
      cancellationResult: null,
      activeRunId: null,
      lastError: null,
      updatedAt: "2026-03-06T11:05:00.000Z"
    });

    assert.equal(cleared.codexThreadId, null);
    assert.equal(cleared.rollingSummary, null);
    assert.equal(cleared.cancellationResult, null);
    assert.equal(cleared.activeRunId, null);
    assert.equal(cleared.lastError, null);
    assert.deepEqual(harness.store.sessions.get("session-2"), cleared);
  } finally {
    await harness.dispose();
  }
});

async function createStoreHarness(): Promise<{
  readonly store: BridgeStore;
  dispose(): Promise<void>;
}> {
  const tempRoot = await mkdtemp(join(tmpdir(), "codex-telegram-bridge-store-"));
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
