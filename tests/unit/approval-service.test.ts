import test from "node:test";
import assert from "node:assert/strict";
import { ApprovalService } from "../../src/core/approval/service.js";
import type {
  PendingPermissionCreateInput,
  PendingPermissionFilter,
  PendingPermissionRecord,
  PendingPermissionResolution
} from "../../src/store/types.js";

class InMemoryPendingPermissionsRepository {
  readonly #records = new Map<string, PendingPermissionRecord>();
  public listCalls = 0;
  public resolveCalls = 0;
  public expirePendingCalls = 0;

  get(permissionId: string): PendingPermissionRecord | null {
    return this.#records.get(permissionId) ?? null;
  }

  list(
    filter: PendingPermissionFilter = {}
  ): readonly PendingPermissionRecord[] {
    this.listCalls += 1;
    return [...this.#records.values()].filter((record) => {
      return (
        (filter.sessionId === undefined ||
          record.sessionId === filter.sessionId) &&
        (filter.runId === undefined || record.runId === filter.runId) &&
        (filter.chatId === undefined || record.chatId === filter.chatId) &&
        (filter.userId === undefined || record.userId === filter.userId) &&
        (filter.resolved === undefined || record.resolved === filter.resolved)
      );
    });
  }

  create(input: PendingPermissionCreateInput): PendingPermissionRecord {
    const record: PendingPermissionRecord = {
      permissionId: input.permissionId,
      sessionId: input.sessionId,
      runId: input.runId,
      chatId: input.chatId,
      userId: input.userId,
      sourceMessageId: input.sourceMessageId,
      toolName: input.toolName,
      summary: input.summary,
      expiresAt: input.expiresAt,
      resolved: false,
      resolution: null,
      resolvedAt: null,
      createdAt: input.createdAt ?? input.expiresAt
    };
    this.#records.set(record.permissionId, record);
    return record;
  }

  expirePending(before: string, resolvedAt = before): readonly string[] {
    this.expirePendingCalls += 1;
    const expiredPermissionIds: string[] = [];

    for (const [permissionId, record] of this.#records.entries()) {
      if (
        record.resolved ||
        Date.parse(record.expiresAt) >= Date.parse(before)
      ) {
        continue;
      }

      expiredPermissionIds.push(permissionId);
      this.#records.set(permissionId, {
        ...record,
        resolved: true,
        resolution: "expired",
        resolvedAt
      });
    }

    return expiredPermissionIds;
  }

  resolve(
    permissionId: string,
    resolution: PendingPermissionResolution,
    resolvedAt?: string
  ): PendingPermissionRecord | null {
    this.resolveCalls += 1;
    const existing = this.#records.get(permissionId);
    if (!existing) {
      return null;
    }

    const updated: PendingPermissionRecord = {
      ...existing,
      resolved: true,
      resolution,
      resolvedAt: resolvedAt ?? existing.resolvedAt
    };
    this.#records.set(permissionId, updated);
    return updated;
  }

  deleteExpired(): number {
    return 0;
  }

  deleteResolved(): number {
    return 0;
  }
}

test("ApprovalService marks expired approvals as stale and resolves them to expired", () => {
  const now = new Date("2026-03-06T10:00:00.000Z");
  const repo = new InMemoryPendingPermissionsRepository();
  repo.create({
    permissionId: "perm-expired",
    sessionId: "session-1",
    runId: "run-1",
    chatId: "chat-1",
    userId: "user-1",
    sourceMessageId: "msg-1",
    toolName: "shell",
    summary: "expired approval",
    expiresAt: "2026-03-06T09:59:00.000Z",
    createdAt: "2026-03-06T09:50:00.000Z"
  });

  const service = new ApprovalService(repo, {
    clock: () => now
  });

  const result = service.resolveDecision({
    permissionId: "perm-expired",
    decision: "approve",
    chatId: "chat-1",
    userId: "user-1",
    sessionSnapshot: {
      sessionId: "session-1",
      runState: "waiting_approval",
      currentRunId: "run-1",
      waitingPermissionId: "perm-expired",
      cancellationResult: null,
      queuedEventCount: 0,
      processedEventCount: 0,
      lastEventAt: null
    }
  });

  assert.equal(result.status, "stale");
  assert.equal(result.reason, "expired");
  assert.equal(repo.get("perm-expired")?.resolution, "expired");
  assert.equal(repo.get("perm-expired")?.resolved, true);
});

test("ApprovalService rejects approvals from the wrong chat without resolving them", () => {
  const now = new Date("2026-03-06T10:00:00.000Z");
  const repo = new InMemoryPendingPermissionsRepository();
  repo.create({
    permissionId: "perm-chat",
    sessionId: "session-2",
    runId: "run-2",
    chatId: "chat-2",
    userId: "user-2",
    sourceMessageId: "msg-2",
    toolName: "shell",
    summary: "chat mismatch",
    expiresAt: "2026-03-06T10:05:00.000Z",
    createdAt: "2026-03-06T10:00:00.000Z"
  });

  const service = new ApprovalService(repo, {
    clock: () => now
  });

  const result = service.resolveDecision({
    permissionId: "perm-chat",
    decision: "deny",
    chatId: "chat-other",
    userId: "user-2",
    sessionSnapshot: {
      sessionId: "session-2",
      runState: "waiting_approval",
      currentRunId: "run-2",
      waitingPermissionId: "perm-chat",
      cancellationResult: null,
      queuedEventCount: 0,
      processedEventCount: 0,
      lastEventAt: null
    }
  });

  assert.equal(result.status, "stale");
  assert.equal(result.reason, "chat_mismatch");
  assert.equal(repo.get("perm-chat")?.resolved, false);
});

test("ApprovalService approves a valid decision when snapshot matches run and permission", () => {
  const now = new Date("2026-03-06T10:00:00.000Z");
  const repo = new InMemoryPendingPermissionsRepository();
  repo.create({
    permissionId: "perm-ok",
    sessionId: "session-3",
    runId: "run-3",
    chatId: "chat-3",
    userId: "user-3",
    sourceMessageId: "msg-3",
    toolName: "shell",
    summary: "approve me",
    expiresAt: "2026-03-06T10:05:00.000Z",
    createdAt: "2026-03-06T10:00:00.000Z"
  });

  const service = new ApprovalService(repo, {
    clock: () => now
  });

  const result = service.resolveDecision({
    permissionId: "perm-ok",
    decision: "approve",
    chatId: "chat-3",
    userId: "user-3",
    sessionSnapshot: {
      sessionId: "session-3",
      runState: "waiting_approval",
      currentRunId: "run-3",
      waitingPermissionId: "perm-ok",
      cancellationResult: null,
      queuedEventCount: 0,
      processedEventCount: 0,
      lastEventAt: null
    }
  });

  assert.equal(result.status, "approved");
  assert.equal(repo.get("perm-ok")?.resolved, true);
  assert.equal(repo.get("perm-ok")?.resolution, "approved");
});

test("ApprovalService uses a single clock snapshot while resolving an approval", () => {
  const timestamps = [
    new Date("2026-03-06T10:00:00.000Z"),
    new Date("2026-03-06T10:00:01.000Z")
  ];
  let clockCalls = 0;
  const repo = new InMemoryPendingPermissionsRepository();
  repo.create({
    permissionId: "perm-once",
    sessionId: "session-4",
    runId: "run-4",
    chatId: "chat-4",
    userId: "user-4",
    sourceMessageId: "msg-4",
    toolName: "shell",
    summary: "single clock",
    expiresAt: "2026-03-06T10:05:00.000Z",
    createdAt: "2026-03-06T09:59:00.000Z"
  });

  const service = new ApprovalService(repo, {
    clock: () => timestamps[clockCalls++] ?? timestamps[timestamps.length - 1]!
  });

  const result = service.resolveDecision({
    permissionId: "perm-once",
    decision: "approve",
    chatId: "chat-4",
    userId: "user-4",
    sessionSnapshot: {
      sessionId: "session-4",
      runState: "waiting_approval",
      currentRunId: "run-4",
      waitingPermissionId: "perm-once",
      cancellationResult: null,
      queuedEventCount: 0,
      processedEventCount: 0,
      lastEventAt: null
    }
  });

  assert.equal(result.status, "approved");
  assert.equal(clockCalls, 1);
  assert.equal(repo.get("perm-once")?.resolvedAt, "2026-03-06T10:00:00.000Z");
});

test("ApprovalService expires pending approvals through the repository batch path", () => {
  const now = new Date("2026-03-06T10:00:00.000Z");
  const repo = new InMemoryPendingPermissionsRepository();
  repo.create({
    permissionId: "perm-expire-1",
    sessionId: "session-5",
    runId: "run-5",
    chatId: "chat-5",
    userId: "user-5",
    sourceMessageId: "msg-5",
    toolName: "shell",
    summary: "already expired",
    expiresAt: "2026-03-06T09:59:00.000Z",
    createdAt: "2026-03-06T09:50:00.000Z"
  });
  repo.create({
    permissionId: "perm-expire-2",
    sessionId: "session-5",
    runId: "run-5",
    chatId: "chat-5",
    userId: "user-5",
    sourceMessageId: "msg-6",
    toolName: "shell",
    summary: "still pending",
    expiresAt: "2026-03-06T10:05:00.000Z",
    createdAt: "2026-03-06T09:55:00.000Z"
  });

  const service = new ApprovalService(repo, {
    clock: () => now
  });

  const result = service.expirePendingApprovals();

  assert.deepEqual(result.expiredPermissionIds, ["perm-expire-1"]);
  assert.equal(result.expiredCount, 1);
  assert.equal(repo.expirePendingCalls, 1);
  assert.equal(repo.listCalls, 0);
  assert.equal(repo.resolveCalls, 0);
  assert.equal(repo.get("perm-expire-1")?.resolution, "expired");
  assert.equal(repo.get("perm-expire-2")?.resolved, false);
});
