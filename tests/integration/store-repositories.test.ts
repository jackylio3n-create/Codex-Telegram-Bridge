import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBridgeStore, type BridgeStore } from "../../src/store/index.js";

test("sessions.save and sessions.update return the persisted record shape without extra lookups", async () => {
  const harness = await createStoreHarness();

  try {
    const created = harness.store.sessions.save({
      sessionId: "session-1",
      workspaceRoot: "/workspaces/main",
      extraAllowedDirs: ["/workspaces/shared"],
      cwd: "/workspaces/main",
      mode: "code",
      createdAt: "2026-03-06T12:00:00.000Z",
      updatedAt: "2026-03-06T12:00:00.000Z"
    });

    assert.equal(created.runState, "idle");
    assert.equal(created.codexThreadId, null);
    assert.deepEqual(created.extraAllowedDirs, ["/workspaces/shared"]);

    const updated = harness.store.sessions.update("session-1", {
      cwd: "/workspaces/shared",
      rollingSummary: "summary",
      updatedAt: "2026-03-06T12:05:00.000Z"
    });

    assert.equal(updated.cwd, "/workspaces/shared");
    assert.equal(updated.rollingSummary, "summary");
    assert.equal(updated.createdAt, "2026-03-06T12:00:00.000Z");
    assert.equal(updated.updatedAt, "2026-03-06T12:05:00.000Z");
    assert.equal(harness.store.sessions.get("session-1")?.cwd, "/workspaces/shared");
  } finally {
    await harness.dispose();
  }
});

test("sessions.update snapshots updatedAt once when no explicit timestamp is provided", async () => {
  let clockCalls = 0;
  const harness = await createStoreHarness({
    clock: () => {
      clockCalls += 1;
      return new Date("2026-03-06T12:05:00.000Z");
    }
  });

  try {
    harness.store.sessions.save({
      sessionId: "session-1",
      workspaceRoot: "/workspaces/main",
      extraAllowedDirs: [],
      cwd: "/workspaces/main",
      mode: "code",
      accessScope: "workspace",
      createdAt: "2026-03-06T12:00:00.000Z",
      updatedAt: "2026-03-06T12:00:00.000Z"
    });
    const clockCallsBeforeUpdate = clockCalls;

    const updated = harness.store.sessions.update("session-1", {
      cwd: "/workspaces/next"
    });

    assert.equal(clockCalls - clockCallsBeforeUpdate, 1);
    assert.equal(updated.updatedAt, "2026-03-06T12:05:00.000Z");
  } finally {
    await harness.dispose();
  }
});

test("sessions.listOverview returns lightweight rows ordered without hydrating rolling summaries", async () => {
  const harness = await createStoreHarness();

  try {
    harness.store.sessions.save({
      sessionId: "session-1",
      workspaceRoot: "/workspaces/main",
      extraAllowedDirs: ["/workspaces/shared"],
      cwd: "/workspaces/main",
      mode: "code",
      rollingSummary: "summary-1",
      runState: "running",
      activeRunId: "run-1",
      createdAt: "2026-03-06T12:00:00.000Z",
      updatedAt: "2026-03-06T12:00:00.000Z"
    });
    harness.store.sessions.save({
      sessionId: "session-2",
      workspaceRoot: "/workspaces/alt",
      extraAllowedDirs: [],
      cwd: "/workspaces/alt",
      mode: "plan",
      rollingSummary: "summary-2",
      runState: "idle",
      activeRunId: null,
      createdAt: "2026-03-06T12:01:00.000Z",
      updatedAt: "2026-03-06T12:02:00.000Z"
    });

    const overview = harness.store.sessions.listOverview();

    assert.deepEqual(
      overview.map((entry) => ({
        sessionId: entry.sessionId,
        workspaceRoot: entry.workspaceRoot,
        cwd: entry.cwd,
        mode: entry.mode,
        runState: entry.runState,
        activeRunId: entry.activeRunId
      })),
      [
        {
          sessionId: "session-2",
          workspaceRoot: "/workspaces/alt",
          cwd: "/workspaces/alt",
          mode: "plan",
          runState: "idle",
          activeRunId: null
        },
        {
          sessionId: "session-1",
          workspaceRoot: "/workspaces/main",
          cwd: "/workspaces/main",
          mode: "code",
          runState: "running",
          activeRunId: "run-1"
        }
      ]
    );
    assert.equal("rollingSummary" in (overview[0] as Record<string, unknown>), false);
  } finally {
    await harness.dispose();
  }
});

test("pending permission create and resolve return updated records while preserving stored state", async () => {
  const harness = await createStoreHarness();

  try {
    harness.store.sessions.save({
      sessionId: "session-1",
      workspaceRoot: "/workspaces/main",
      extraAllowedDirs: [],
      cwd: "/workspaces/main",
      mode: "code",
      createdAt: "2026-03-06T12:00:00.000Z",
      updatedAt: "2026-03-06T12:00:00.000Z"
    });

    const created = harness.store.pendingPermissions.create({
      permissionId: "perm-1",
      sessionId: "session-1",
      runId: "run-1",
      chatId: "chat-1",
      userId: "user-1",
      sourceMessageId: "message-1",
      toolName: "shell_command",
      summary: "Review command",
      expiresAt: "2026-03-06T12:10:00.000Z",
      createdAt: "2026-03-06T12:00:00.000Z"
    });

    assert.equal(created.resolved, false);
    assert.equal(created.resolution, null);

    const resolved = harness.store.pendingPermissions.resolve(
      "perm-1",
      "approved",
      "2026-03-06T12:01:00.000Z"
    );

    assert.equal(resolved?.resolved, true);
    assert.equal(resolved?.resolution, "approved");
    assert.equal(resolved?.resolvedAt, "2026-03-06T12:01:00.000Z");
    assert.equal(harness.store.pendingPermissions.get("perm-1")?.resolution, "approved");
  } finally {
    await harness.dispose();
  }
});

test("pending permission list supports descending limits for recent rows", async () => {
  const harness = await createStoreHarness();

  try {
    harness.store.sessions.save({
      sessionId: "session-1",
      workspaceRoot: "/workspaces/main",
      extraAllowedDirs: [],
      cwd: "/workspaces/main",
      mode: "code",
      createdAt: "2026-03-06T12:00:00.000Z",
      updatedAt: "2026-03-06T12:00:00.000Z"
    });

    for (const [permissionId, createdAt] of [
      ["perm-1", "2026-03-06T12:00:00.000Z"],
      ["perm-2", "2026-03-06T12:01:00.000Z"],
      ["perm-3", "2026-03-06T12:02:00.000Z"]
    ] as const) {
      harness.store.pendingPermissions.create({
        permissionId,
        sessionId: "session-1",
        runId: "run-1",
        chatId: "chat-1",
        userId: "user-1",
        sourceMessageId: `message-${permissionId}`,
        toolName: "shell_command",
        summary: permissionId,
        expiresAt: "2026-03-06T12:10:00.000Z",
        createdAt
      });
    }

    const recent = harness.store.pendingPermissions.list({
      sessionId: "session-1",
      resolved: false,
      limit: 2
    });

    assert.deepEqual(
      recent.map((record) => record.permissionId),
      ["perm-3", "perm-2"]
    );
  } finally {
    await harness.dispose();
  }
});

test("telegram user auth tracks first contact, resets on verify, and bans after threshold", async () => {
  const harness = await createStoreHarness();

  try {
    const firstSeen = harness.store.telegramUserAuth.getOrCreateFirstSeen({
      userId: "user-1",
      chatId: "chat-1",
      firstSeenAt: "2026-03-06T12:00:00.000Z"
    });
    assert.equal(firstSeen.failedAttempts, 0);
    assert.equal(firstSeen.verifiedAt, null);
    assert.equal(firstSeen.preferredLanguage, null);

    const failed = harness.store.telegramUserAuth.recordFailedAttempt({
      userId: "user-1",
      chatId: "chat-1",
      failedAt: "2026-03-06T12:01:00.000Z",
      banThreshold: 5
    });
    assert.equal(failed.failedAttempts, 1);
    assert.equal(failed.bannedAt, null);

    const verified = harness.store.telegramUserAuth.markVerified({
      userId: "user-1",
      chatId: "chat-1",
      verifiedAt: "2026-03-06T12:02:00.000Z"
    });
    assert.equal(verified.failedAttempts, 0);
    assert.equal(verified.lastFailedAt, null);
    assert.equal(verified.verifiedAt, "2026-03-06T12:02:00.000Z");

    const localized = harness.store.telegramUserAuth.setPreferredLanguage({
      userId: "user-1",
      chatId: "chat-1",
      preferredLanguage: "zh",
      selectedAt: "2026-03-06T12:02:30.000Z"
    });
    assert.equal(localized.preferredLanguage, "zh");
    assert.equal(harness.store.telegramUserAuth.findByChatId("chat-1")?.userId, "user-1");

    harness.store.telegramUserAuth.getOrCreateFirstSeen({
      userId: "user-2",
      chatId: "chat-2",
      firstSeenAt: "2026-03-06T12:03:00.000Z"
    });

    let banned = harness.store.telegramUserAuth.get("user-2");
    for (const [index, failedAt] of [
      "2026-03-06T12:04:00.000Z",
      "2026-03-06T12:05:00.000Z",
      "2026-03-06T12:06:00.000Z",
      "2026-03-06T12:07:00.000Z",
      "2026-03-06T12:08:00.000Z"
    ].entries()) {
      banned = harness.store.telegramUserAuth.recordFailedAttempt({
        userId: "user-2",
        chatId: "chat-2",
        failedAt,
        banThreshold: 5
      });
      assert.equal(banned.failedAttempts, index + 1);
    }

    assert.equal(banned?.bannedAt, "2026-03-06T12:08:00.000Z");
    assert.equal(harness.store.telegramUserAuth.list().length, 2);
  } finally {
    await harness.dispose();
  }
});

test("audit logs listRecentByEventType applies per-type limits in one ordered result set", async () => {
  const harness = await createStoreHarness();

  try {
    harness.store.sessions.save({
      sessionId: "session-1",
      workspaceRoot: "/workspaces/main",
      extraAllowedDirs: [],
      cwd: "/workspaces/main",
      mode: "code",
      createdAt: "2026-03-06T12:00:00.000Z",
      updatedAt: "2026-03-06T12:00:00.000Z"
    });

    harness.store.auditLogs.append({
      sessionId: "session-1",
      eventType: "user_command",
      payload: { note: "command-1" },
      createdAt: "2026-03-06T12:01:00.000Z"
    });
    harness.store.auditLogs.append({
      sessionId: "session-1",
      eventType: "approval_decision",
      payload: { note: "approval-1" },
      createdAt: "2026-03-06T12:02:00.000Z"
    });
    harness.store.auditLogs.append({
      sessionId: "session-1",
      eventType: "user_command",
      payload: { note: "command-2" },
      createdAt: "2026-03-06T12:03:00.000Z"
    });
    harness.store.auditLogs.append({
      sessionId: "session-1",
      eventType: "approval_decision",
      payload: { note: "approval-2" },
      createdAt: "2026-03-06T12:04:00.000Z"
    });
    harness.store.auditLogs.append({
      sessionId: "session-1",
      eventType: "tool_result",
      payload: { note: "ignored" },
      createdAt: "2026-03-06T12:05:00.000Z"
    });

    const records = harness.store.auditLogs.listRecentByEventType("session-1", [
      { eventType: "approval_decision", limit: 1 },
      { eventType: "user_command", limit: 2 }
    ]);

    assert.deepEqual(
      records.map((record) => ({
        eventType: record.eventType,
        createdAt: record.createdAt,
        note: (record.payload as { note?: string } | null)?.note ?? null
      })),
      [
        {
          eventType: "approval_decision",
          createdAt: "2026-03-06T12:04:00.000Z",
          note: "approval-2"
        },
        {
          eventType: "user_command",
          createdAt: "2026-03-06T12:03:00.000Z",
          note: "command-2"
        },
        {
          eventType: "user_command",
          createdAt: "2026-03-06T12:01:00.000Z",
          note: "command-1"
        }
      ]
    );
  } finally {
    await harness.dispose();
  }
});

test("pending permission expirePending marks only expired unresolved rows and returns their ids", async () => {
  const harness = await createStoreHarness();

  try {
    harness.store.sessions.save({
      sessionId: "session-1",
      workspaceRoot: "/workspaces/main",
      extraAllowedDirs: [],
      cwd: "/workspaces/main",
      mode: "code",
      createdAt: "2026-03-06T12:00:00.000Z",
      updatedAt: "2026-03-06T12:00:00.000Z"
    });

    harness.store.pendingPermissions.create({
      permissionId: "perm-expired",
      sessionId: "session-1",
      runId: "run-1",
      chatId: "chat-1",
      userId: "user-1",
      sourceMessageId: "message-1",
      toolName: "shell_command",
      summary: "Expired command",
      expiresAt: "2026-03-06T12:09:00.000Z",
      createdAt: "2026-03-06T12:00:00.000Z"
    });
    harness.store.pendingPermissions.create({
      permissionId: "perm-future",
      sessionId: "session-1",
      runId: "run-2",
      chatId: "chat-1",
      userId: "user-1",
      sourceMessageId: "message-2",
      toolName: "shell_command",
      summary: "Future command",
      expiresAt: "2026-03-06T12:11:00.000Z",
      createdAt: "2026-03-06T12:00:00.000Z"
    });

    const expiredIds = harness.store.pendingPermissions.expirePending(
      "2026-03-06T12:10:00.000Z",
      "2026-03-06T12:10:00.000Z"
    );

    assert.deepEqual(expiredIds, ["perm-expired"]);
    assert.equal(harness.store.pendingPermissions.get("perm-expired")?.resolution, "expired");
    assert.equal(harness.store.pendingPermissions.get("perm-expired")?.resolvedAt, "2026-03-06T12:10:00.000Z");
    assert.equal(harness.store.pendingPermissions.get("perm-future")?.resolved, false);
  } finally {
    await harness.dispose();
  }
});

test("session summaries pruneToMaxPerSession keeps only the latest rows per session", async () => {
  const harness = await createStoreHarness();

  try {
    harness.store.sessions.save({
      sessionId: "session-1",
      workspaceRoot: "/workspaces/main",
      extraAllowedDirs: [],
      cwd: "/workspaces/main",
      mode: "code",
      createdAt: "2026-03-06T12:00:00.000Z",
      updatedAt: "2026-03-06T12:00:00.000Z"
    });
    harness.store.sessions.save({
      sessionId: "session-2",
      workspaceRoot: "/workspaces/main",
      extraAllowedDirs: [],
      cwd: "/workspaces/main",
      mode: "code",
      createdAt: "2026-03-06T12:00:00.000Z",
      updatedAt: "2026-03-06T12:00:00.000Z"
    });

    for (const [sessionId, createdAt] of [
      ["session-1", "2026-03-06T12:00:00.000Z"],
      ["session-1", "2026-03-06T12:01:00.000Z"],
      ["session-1", "2026-03-06T12:02:00.000Z"],
      ["session-2", "2026-03-06T12:03:00.000Z"],
      ["session-2", "2026-03-06T12:04:00.000Z"],
      ["session-2", "2026-03-06T12:05:00.000Z"]
    ] as const) {
      harness.store.sessionSummaries.append({
        sessionId,
        content: `${sessionId}-${createdAt}`,
        createdAt
      });
    }

    const deleted = harness.store.sessionSummaries.pruneToMaxPerSession(2);

    assert.equal(deleted, 2);
    assert.deepEqual(
      harness.store.sessionSummaries.list({ sessionId: "session-1", limit: 10 }).map((entry) => entry.content),
      [
        "session-1-2026-03-06T12:02:00.000Z",
        "session-1-2026-03-06T12:01:00.000Z"
      ]
    );
    assert.deepEqual(
      harness.store.sessionSummaries.list({ sessionId: "session-2", limit: 10 }).map((entry) => entry.content),
      [
        "session-2-2026-03-06T12:05:00.000Z",
        "session-2-2026-03-06T12:04:00.000Z"
      ]
    );
  } finally {
    await harness.dispose();
  }
});

test("store runCleanup prunes historical approvals, audit rows, and summaries together", async () => {
  const harness = await createStoreHarness();

  try {
    harness.store.sessions.save({
      sessionId: "session-1",
      workspaceRoot: "/workspaces/main",
      extraAllowedDirs: [],
      cwd: "/workspaces/main",
      mode: "code",
      createdAt: "2026-03-06T12:00:00.000Z",
      updatedAt: "2026-03-06T12:00:00.000Z"
    });

    harness.store.pendingPermissions.create({
      permissionId: "perm-expired-old",
      sessionId: "session-1",
      runId: "run-1",
      chatId: "chat-1",
      userId: "user-1",
      sourceMessageId: "message-1",
      toolName: "exec_command",
      summary: "expired old",
      expiresAt: "2026-03-01T12:00:00.000Z",
      createdAt: "2026-03-01T12:00:00.000Z"
    });
    harness.store.pendingPermissions.create({
      permissionId: "perm-resolved-old",
      sessionId: "session-1",
      runId: "run-2",
      chatId: "chat-1",
      userId: "user-1",
      sourceMessageId: "message-2",
      toolName: "exec_command",
      summary: "resolved old",
      expiresAt: "2026-03-04T12:00:00.000Z",
      createdAt: "2026-03-04T12:00:00.000Z"
    });
    harness.store.pendingPermissions.resolve("perm-resolved-old", "approved", "2026-03-04T13:00:00.000Z");
    harness.store.pendingPermissions.create({
      permissionId: "perm-resolved-new",
      sessionId: "session-1",
      runId: "run-3",
      chatId: "chat-1",
      userId: "user-1",
      sourceMessageId: "message-3",
      toolName: "exec_command",
      summary: "resolved new",
      expiresAt: "2026-03-06T12:00:00.000Z",
      createdAt: "2026-03-06T12:00:00.000Z"
    });
    harness.store.pendingPermissions.resolve("perm-resolved-new", "denied", "2026-03-06T12:30:00.000Z");

    harness.store.auditLogs.append({
      sessionId: "session-1",
      eventType: "user_command",
      payload: { note: "audit-1" },
      createdAt: "2026-03-06T12:01:00.000Z"
    });
    harness.store.auditLogs.append({
      sessionId: "session-1",
      eventType: "user_command",
      payload: { note: "audit-2" },
      createdAt: "2026-03-06T12:02:00.000Z"
    });
    harness.store.auditLogs.append({
      sessionId: "session-1",
      eventType: "user_command",
      payload: { note: "audit-3" },
      createdAt: "2026-03-06T12:03:00.000Z"
    });

    harness.store.sessionSummaries.append({
      sessionId: "session-1",
      content: "summary-1",
      createdAt: "2026-03-06T12:01:00.000Z"
    });
    harness.store.sessionSummaries.append({
      sessionId: "session-1",
      content: "summary-2",
      createdAt: "2026-03-06T12:02:00.000Z"
    });
    harness.store.sessionSummaries.append({
      sessionId: "session-1",
      content: "summary-3",
      createdAt: "2026-03-06T12:03:00.000Z"
    });

    const cleanup = harness.store.runCleanup({
      approvalExpiryOlderThan: "2026-03-05T00:00:00.000Z",
      approvalResolutionOlderThan: "2026-03-05T00:00:00.000Z",
      maxAuditRows: 2,
      maxSummariesPerSession: 1
    });

    assert.deepEqual(cleanup, {
      deletedExpiredPermissions: 1,
      deletedResolvedPermissions: 1,
      deletedSummaryRows: 2,
      deletedAuditRows: 1
    });
    assert.deepEqual(
      harness.store.pendingPermissions.list().map((entry) => entry.permissionId).sort(),
      ["perm-resolved-new"]
    );
    assert.deepEqual(
      harness.store.auditLogs.list({ sessionId: "session-1" }).map((entry) => {
        return (entry.payload as { note?: string } | null)?.note ?? null;
      }),
      ["audit-3", "audit-2"]
    );
    assert.deepEqual(
      harness.store.sessionSummaries.list({ sessionId: "session-1", limit: 10 }).map((entry) => entry.content),
      ["summary-3"]
    );
  } finally {
    await harness.dispose();
  }
});

async function createStoreHarness(options: {
  readonly clock?: () => Date;
} = {}): Promise<{
  readonly store: BridgeStore;
  dispose(): Promise<void>;
}> {
  const tempRoot = await mkdtemp(join(tmpdir(), "codex-telegram-bridge-store-"));
  const store = await createBridgeStore({
    databaseFilePath: join(tempRoot, "bridge.sqlite3"),
    ...(options.clock ? { clock: options.clock } : {})
  });

  return {
    store,
    async dispose() {
      store.close();
      await rm(tempRoot, { recursive: true, force: true });
    }
  };
}
