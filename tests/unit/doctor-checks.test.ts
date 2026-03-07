import test from "node:test";
import assert from "node:assert/strict";
import { buildApprovalsCheck } from "../../src/doctor/checks/approvals.js";
import { buildOffsetsCheck } from "../../src/doctor/checks/offsets.js";
import { buildRunsCheck } from "../../src/doctor/checks/runs.js";
import type {
  AppliedMigrationRecord,
  AuditLogFilter,
  AuditLogEventLimit,
  AuditLogRecord,
  BridgeStore,
  ChannelOffsetRecord,
  ChannelOffsetUpsertInput,
  ChatBindingRecord,
  ChatBindingUpsertInput,
  CleanupPolicy,
  CleanupResult,
  PendingPermissionCreateInput,
  PendingPermissionFilter,
  PendingPermissionRecord,
  PendingPermissionResolution,
  SessionPatch,
  SessionRecord,
  SessionSummaryCreateInput,
  SessionSummaryFilter,
  SessionSummaryRecord,
  SessionUpsertInput
} from "../../src/store/types.js";

function createStore(seed: {
  readonly sessions?: readonly SessionRecord[];
  readonly pendingPermissions?: readonly PendingPermissionRecord[];
  readonly channelOffsets?: readonly ChannelOffsetRecord[];
} = {}): BridgeStore {
  const sessions = new Map((seed.sessions ?? []).map((record) => [record.sessionId, record] as const));
  const pendingPermissions = new Map(
    (seed.pendingPermissions ?? []).map((record) => [record.permissionId, record] as const)
  );
  const offsets = new Map((seed.channelOffsets ?? []).map((record) => [record.channelKey, record] as const));

  return {
    databaseFilePath: ":memory:",
    sessions: {
      get(sessionId: string) {
        return sessions.get(sessionId) ?? null;
      },
      list() {
        return [...sessions.values()];
      },
      listOverview() {
        return [...sessions.values()].map((record) => ({
          sessionId: record.sessionId,
          workspaceRoot: record.workspaceRoot,
          extraAllowedDirs: record.extraAllowedDirs,
          cwd: record.cwd,
          mode: record.mode,
          runState: record.runState,
          activeRunId: record.activeRunId,
          updatedAt: record.updatedAt
        }));
      },
      save(input: SessionUpsertInput) {
        const record: SessionRecord = {
          sessionId: input.sessionId,
          workspaceRoot: input.workspaceRoot,
          extraAllowedDirs: input.extraAllowedDirs,
          cwd: input.cwd,
          mode: input.mode,
          codexThreadId: input.codexThreadId ?? null,
          rollingSummary: input.rollingSummary ?? null,
          runState: input.runState ?? "idle",
          cancellationResult: input.cancellationResult ?? null,
          activeRunId: input.activeRunId ?? null,
          staleRecovered: input.staleRecovered ?? false,
          lastError: input.lastError ?? null,
          createdAt: input.createdAt ?? "2026-03-06T10:00:00.000Z",
          updatedAt: input.updatedAt ?? "2026-03-06T10:00:00.000Z"
        };
        sessions.set(record.sessionId, record);
        return record;
      },
      update(sessionId: string, patch: SessionPatch) {
        const existing = sessions.get(sessionId);
        if (!existing) {
          throw new Error(`Missing session ${sessionId}`);
        }

        const updated: SessionRecord = {
          ...existing,
          ...patch,
          extraAllowedDirs: patch.extraAllowedDirs ?? existing.extraAllowedDirs,
          updatedAt: patch.updatedAt ?? existing.updatedAt
        };
        sessions.set(sessionId, updated);
        return updated;
      },
      delete(sessionId: string) {
        return sessions.delete(sessionId);
      }
    },
    chatBindings: {
      get() {
        return null;
      },
      list() {
        return [] as const;
      },
      save(input: ChatBindingUpsertInput) {
        return {
          chatId: input.chatId,
          sessionId: input.sessionId,
          updatedAt: input.updatedAt ?? "2026-03-06T10:00:00.000Z"
        } satisfies ChatBindingRecord;
      },
      delete() {
        return false;
      }
    },
    pendingPermissions: {
      get(permissionId: string) {
        return pendingPermissions.get(permissionId) ?? null;
      },
      list(filter: PendingPermissionFilter = {}) {
        return [...pendingPermissions.values()].filter((record) => {
          return (
            (filter.sessionId === undefined || record.sessionId === filter.sessionId) &&
            (filter.runId === undefined || record.runId === filter.runId) &&
            (filter.chatId === undefined || record.chatId === filter.chatId) &&
            (filter.userId === undefined || record.userId === filter.userId) &&
            (filter.resolved === undefined || record.resolved === filter.resolved)
          );
        });
      },
      create(input: PendingPermissionCreateInput) {
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
          createdAt: input.createdAt ?? "2026-03-06T10:00:00.000Z"
        };
        pendingPermissions.set(record.permissionId, record);
        return record;
      },
      expirePending(before: string, resolvedAt = before) {
        const expiredPermissionIds: string[] = [];

        for (const [permissionId, record] of pendingPermissions.entries()) {
          if (record.resolved || Date.parse(record.expiresAt) >= Date.parse(before)) {
            continue;
          }

          expiredPermissionIds.push(permissionId);
          pendingPermissions.set(permissionId, {
            ...record,
            resolved: true,
            resolution: "expired",
            resolvedAt
          });
        }

        return expiredPermissionIds;
      },
      resolve(permissionId: string, resolution: PendingPermissionResolution, resolvedAt?: string) {
        const existing = pendingPermissions.get(permissionId);
        if (!existing) {
          return null;
        }

        const updated: PendingPermissionRecord = {
          ...existing,
          resolved: true,
          resolution,
          resolvedAt: resolvedAt ?? existing.resolvedAt
        };
        pendingPermissions.set(permissionId, updated);
        return updated;
      },
      deleteExpired() {
        return 0;
      },
      deleteResolved() {
        return 0;
      }
    },
    channelOffsets: {
      get(channelKey: string) {
        return offsets.get(channelKey) ?? null;
      },
      list() {
        return [...offsets.values()];
      },
      save(input: ChannelOffsetUpsertInput) {
        const record: ChannelOffsetRecord = {
          channelKey: input.channelKey,
          currentOffset: input.currentOffset,
          previousOffset: input.previousOffset ?? input.currentOffset,
          updatedAt: input.updatedAt ?? "2026-03-06T10:00:00.000Z"
        };
        offsets.set(record.channelKey, record);
        return record;
      }
    },
    auditLogs: {
      append<TPayload = unknown>() {
        return {
          auditId: 1,
          sessionId: null,
          chatId: null,
          runId: null,
          eventType: "user_input",
          payload: null as TPayload | null,
          createdAt: "2026-03-06T10:00:00.000Z"
        } satisfies AuditLogRecord<TPayload>;
      },
      list(_filter?: AuditLogFilter) {
        return [] as readonly AuditLogRecord[];
      },
      listRecentByEventType(_sessionId: string, _limits: readonly AuditLogEventLimit[]) {
        return [] as readonly AuditLogRecord[];
      },
      pruneOlderThan() {
        return 0;
      },
      pruneToMaxRows() {
        return 0;
      }
    },
    sessionSummaries: {
      append(input: SessionSummaryCreateInput) {
        return {
          summaryId: 1,
          sessionId: input.sessionId,
          summaryKind: input.summaryKind ?? "rolling",
          content: input.content,
          createdAt: input.createdAt ?? "2026-03-06T10:00:00.000Z"
        } satisfies SessionSummaryRecord;
      },
      list(_filter: SessionSummaryFilter) {
        return [] as readonly SessionSummaryRecord[];
      },
      pruneToMaxPerSession() {
        return 0;
      }
    },
    migrations: {
      list() {
        return [] as readonly AppliedMigrationRecord[];
      }
    },
    withTransaction<T>(callback: (store: BridgeStore) => T): T {
      return callback(this);
    },
    runCleanup(_policy: CleanupPolicy): CleanupResult {
      return {
        deletedExpiredPermissions: 0,
        deletedResolvedPermissions: 0,
        deletedSummaryRows: 0,
        deletedAuditRows: 0
      };
    },
    close() {}
  };
}

test("buildOffsetsCheck reports missing offset rows as an error", () => {
  const check = buildOffsetsCheck(createStore(), "telegram:getUpdates", 10_000);
  assert.equal(check.status, "error");
  assert.match(check.summary, /missing/i);
});

test("buildOffsetsCheck warns on suspicious offset jumps", () => {
  const check = buildOffsetsCheck(
    createStore({
      channelOffsets: [
        {
          channelKey: "telegram:getUpdates",
          currentOffset: 12_345,
          previousOffset: 1,
          updatedAt: "2026-03-06T10:00:00.000Z"
        }
      ]
    }),
    "telegram:getUpdates",
    10_000
  );

  assert.equal(check.status, "warning");
  assert.ok(check.details.some((detail) => detail.includes("jump=12344")));
});

test("buildApprovalsCheck warns when unresolved approvals are already stale", () => {
  const check = buildApprovalsCheck(
    createStore({
      pendingPermissions: [
        {
          permissionId: "perm-old",
          sessionId: "session-1",
          runId: "run-1",
          chatId: "chat-1",
          userId: "user-1",
          sourceMessageId: "msg-1",
          toolName: "shell",
          summary: "old permission",
          expiresAt: "2026-03-06T09:59:00.000Z",
          resolved: false,
          resolution: null,
          resolvedAt: null,
          createdAt: "2026-03-06T09:50:00.000Z"
        }
      ]
    }),
    new Date("2026-03-06T10:00:00.000Z")
  );

  assert.equal(check.status, "warning");
  assert.match(check.summary, /stale unresolved approval/i);
});

test("buildRunsCheck errors when waiting_approval has no unresolved permission for its run", () => {
  const check = buildRunsCheck(
    createStore({
      sessions: [
        {
          sessionId: "session-run",
          workspaceRoot: "/workspace",
          extraAllowedDirs: [],
          cwd: "/workspace",
          mode: "code",
          codexThreadId: null,
          rollingSummary: null,
          runState: "waiting_approval",
          cancellationResult: null,
          activeRunId: "run-1",
          staleRecovered: false,
          lastError: null,
          createdAt: "2026-03-06T10:00:00.000Z",
          updatedAt: "2026-03-06T10:00:00.000Z"
        }
      ]
    })
  );

  assert.equal(check.status, "error");
  assert.ok(check.details.some((detail) => detail.includes("no unresolved approval")));
});

test("buildRunsCheck warns when terminal state keeps an active run id", () => {
  const check = buildRunsCheck(
    createStore({
      sessions: [
        {
          sessionId: "session-terminal",
          workspaceRoot: "/workspace",
          extraAllowedDirs: [],
          cwd: "/workspace",
          mode: "code",
          codexThreadId: null,
          rollingSummary: null,
          runState: "cancelled",
          cancellationResult: "partial",
          activeRunId: "run-terminal",
          staleRecovered: false,
          lastError: null,
          createdAt: "2026-03-06T10:00:00.000Z",
          updatedAt: "2026-03-06T10:00:00.000Z"
        }
      ]
    })
  );

  assert.equal(check.status, "warning");
  assert.ok(check.details.some((detail) => detail.includes("terminal run_state=cancelled")));
});

test("buildRunsCheck reads unresolved approvals once and reuses them across sessions", () => {
  const store = createStore({
    sessions: [
      {
        sessionId: "session-a",
        workspaceRoot: "/workspace",
        extraAllowedDirs: [],
        cwd: "/workspace",
        mode: "code",
        codexThreadId: null,
        rollingSummary: null,
        runState: "waiting_approval",
        cancellationResult: null,
        activeRunId: "run-a",
        staleRecovered: false,
        lastError: null,
        createdAt: "2026-03-06T10:00:00.000Z",
        updatedAt: "2026-03-06T10:00:00.000Z"
      },
      {
        sessionId: "session-b",
        workspaceRoot: "/workspace",
        extraAllowedDirs: [],
        cwd: "/workspace",
        mode: "code",
        codexThreadId: null,
        rollingSummary: null,
        runState: "running",
        cancellationResult: null,
        activeRunId: "run-b",
        staleRecovered: false,
        lastError: null,
        createdAt: "2026-03-06T10:00:00.000Z",
        updatedAt: "2026-03-06T10:00:00.000Z"
      }
    ],
    pendingPermissions: [
      {
        permissionId: "perm-a",
        sessionId: "session-a",
        runId: "run-a",
        chatId: "chat-a",
        userId: "user-a",
        sourceMessageId: "msg-a",
        toolName: "shell",
        summary: "approval a",
        expiresAt: "2026-03-06T10:05:00.000Z",
        resolved: false,
        resolution: null,
        resolvedAt: null,
        createdAt: "2026-03-06T10:00:00.000Z"
      },
      {
        permissionId: "perm-b",
        sessionId: "session-b",
        runId: "run-b",
        chatId: "chat-b",
        userId: "user-b",
        sourceMessageId: "msg-b",
        toolName: "shell",
        summary: "approval b",
        expiresAt: "2026-03-06T10:05:00.000Z",
        resolved: false,
        resolution: null,
        resolvedAt: null,
        createdAt: "2026-03-06T10:00:00.000Z"
      }
    ]
  });
  let listCalls = 0;
  const baseList = store.pendingPermissions.list.bind(store.pendingPermissions);
  store.pendingPermissions.list = (filter?: PendingPermissionFilter) => {
    listCalls += 1;
    return baseList(filter);
  };

  const check = buildRunsCheck(store);

  assert.equal(check.status, "warning");
  assert.equal(listCalls, 1);
  assert.ok(check.details.some((detail) => detail.includes("running still has 1 unresolved approval")));
});
