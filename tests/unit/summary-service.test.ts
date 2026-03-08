import assert from "node:assert/strict";
import test from "node:test";
import { SummaryService } from "../../src/core/summary/service.js";
import type {
  AuditLogFilter,
  AuditLogEventLimit,
  AuditLogRecord,
  PendingPermissionFilter,
  PendingPermissionRecord,
  SessionPatch,
  SessionRecord,
  SessionSummaryCreateInput
} from "../../src/store/types.js";

class InMemorySessionsRepository {
  readonly #records = new Map<string, SessionRecord>();

  constructor(records: readonly SessionRecord[]) {
    for (const record of records) {
      this.#records.set(record.sessionId, record);
    }
  }

  get(sessionId: string): SessionRecord | null {
    return this.#records.get(sessionId) ?? null;
  }

  update(sessionId: string, patch: SessionPatch): SessionRecord {
    const existing = this.get(sessionId);
    if (!existing) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const updated: SessionRecord = {
      ...existing,
      ...patch,
      updatedAt: patch.updatedAt ?? existing.updatedAt
    };
    this.#records.set(sessionId, updated);
    return updated;
  }
}

class InMemoryPendingPermissionsRepository {
  readonly #records: readonly PendingPermissionRecord[];
  lastFilter: PendingPermissionFilter | null = null;

  constructor(records: readonly PendingPermissionRecord[]) {
    this.#records = records;
  }

  list(
    filter: PendingPermissionFilter = {}
  ): readonly PendingPermissionRecord[] {
    this.lastFilter = filter;
    const filtered = this.#records
      .filter((record) => {
        return (
          (filter.sessionId === undefined ||
            record.sessionId === filter.sessionId) &&
          (filter.resolved === undefined || record.resolved === filter.resolved)
        );
      })
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) ||
          left.permissionId.localeCompare(right.permissionId)
      );

    return typeof filter.limit === "number"
      ? filtered.slice(0, filter.limit)
      : filtered;
  }
}

class InMemoryAuditLogsRepository {
  readonly #records: readonly AuditLogRecord[];
  lastFilter: AuditLogFilter | null = null;
  lastSessionId: string | null = null;
  lastEventLimits: readonly AuditLogEventLimit[] | null = null;

  constructor(records: readonly AuditLogRecord[]) {
    this.#records = records;
  }

  list(filter: AuditLogFilter = {}): readonly AuditLogRecord[] {
    this.lastFilter = filter;
    return this.#records.filter(
      (record) =>
        filter.sessionId === undefined || record.sessionId === filter.sessionId
    );
  }

  listRecentByEventType(
    sessionId: string,
    limits: readonly AuditLogEventLimit[]
  ): readonly AuditLogRecord[] {
    this.lastSessionId = sessionId;
    this.lastEventLimits = limits;
    const selected: AuditLogRecord[] = [];

    for (const entry of limits) {
      if (entry.limit < 1) {
        continue;
      }

      selected.push(
        ...this.#records
          .filter(
            (record) =>
              record.sessionId === sessionId &&
              record.eventType === entry.eventType
          )
          .sort(
            (left, right) =>
              right.createdAt.localeCompare(left.createdAt) ||
              right.auditId - left.auditId
          )
          .slice(0, entry.limit)
      );
    }

    return selected.sort(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        right.auditId - left.auditId
    );
  }
}

class InMemorySessionSummariesRepository {
  readonly appended: SessionSummaryCreateInput[] = [];

  append(input: SessionSummaryCreateInput) {
    this.appended.push(input);
    return {
      summaryId: this.appended.length,
      sessionId: input.sessionId,
      summaryKind: input.summaryKind ?? "rolling",
      content: input.content,
      createdAt: input.createdAt ?? "unknown"
    };
  }
}

test("SummaryService builds sections with one audit scan and unresolved approvals only", () => {
  const sessions = new InMemorySessionsRepository([
    createSessionRecord("session-1")
  ]);
  const pendingPermissions = new InMemoryPendingPermissionsRepository([
    createPendingPermissionRecord(
      "perm-new",
      false,
      "2026-03-06T10:02:00.000Z"
    ),
    createPendingPermissionRecord(
      "perm-old",
      false,
      "2026-03-06T10:01:00.000Z"
    ),
    createPendingPermissionRecord(
      "perm-resolved",
      true,
      "2026-03-06T10:03:00.000Z"
    )
  ]);
  const auditLogs = new InMemoryAuditLogsRepository([
    createAuditLog("session-1", "run_cancel", "2026-03-06T10:09:00.000Z", {
      note: "cancel-1"
    }),
    createAuditLog("session-1", "resume_recovery", "2026-03-06T10:08:00.000Z", {
      note: "resume-1"
    }),
    createAuditLog(
      "session-1",
      "approval_decision",
      "2026-03-06T10:07:00.000Z",
      { note: "approval-1" }
    ),
    createAuditLog("session-1", "user_command", "2026-03-06T10:06:00.000Z", {
      note: "command-1"
    }),
    createAuditLog("session-1", "file_change", "2026-03-06T10:05:00.000Z", {
      note: "file-1"
    }),
    createAuditLog("session-1", "run_cancel", "2026-03-06T10:04:00.000Z", {
      note: "cancel-2"
    }),
    createAuditLog("session-1", "resume_recovery", "2026-03-06T10:03:00.000Z", {
      note: "resume-2"
    }),
    createAuditLog(
      "session-1",
      "approval_decision",
      "2026-03-06T10:02:00.000Z",
      { note: "approval-2" }
    )
  ]);
  const service = new SummaryService({
    sessions: sessions as never,
    pendingPermissions: pendingPermissions as never,
    auditLogs: auditLogs as never,
    sessionSummaries: new InMemorySessionSummariesRepository() as never
  });

  const result = service.buildRollingSummary("session-1");

  assert.deepEqual(pendingPermissions.lastFilter, {
    sessionId: "session-1",
    resolved: false,
    limit: 5
  });
  assert.equal(auditLogs.lastSessionId, "session-1");
  assert.deepEqual(auditLogs.lastEventLimits, [
    { eventType: "approval_decision", limit: 5 },
    { eventType: "user_command", limit: 5 },
    { eventType: "file_change", limit: 5 },
    { eventType: "run_cancel", limit: 2 },
    { eventType: "resume_recovery", limit: 2 }
  ]);
  assert.deepEqual(result.snapshot.pendingApprovals, [
    "perm-new | shell_command | expires 2026-03-06T10:02:00.000Z",
    "perm-old | shell_command | expires 2026-03-06T10:01:00.000Z"
  ]);
  assert.deepEqual(result.snapshot.recentApprovalDecisions, [
    "2026-03-06T10:07:00.000Z | approval_decision | note=approval-1",
    "2026-03-06T10:02:00.000Z | approval_decision | note=approval-2"
  ]);
  assert.deepEqual(result.snapshot.recentRuntimeOutcomes, [
    "2026-03-06T10:09:00.000Z | run_cancel | note=cancel-1",
    "2026-03-06T10:04:00.000Z | run_cancel | note=cancel-2",
    "2026-03-06T10:08:00.000Z | resume_recovery | note=resume-1",
    "2026-03-06T10:03:00.000Z | resume_recovery | note=resume-2"
  ]);
});

test("SummaryService refreshRollingSummary reuses a single timestamp", () => {
  const now = new Date("2026-03-06T11:00:00.000Z");
  let clockCalls = 0;
  const sessions = new InMemorySessionsRepository([
    createSessionRecord("session-1")
  ]);
  const sessionSummaries = new InMemorySessionSummariesRepository();
  const service = new SummaryService(
    {
      sessions: sessions as never,
      pendingPermissions: new InMemoryPendingPermissionsRepository([]) as never,
      auditLogs: new InMemoryAuditLogsRepository([]) as never,
      sessionSummaries: sessionSummaries as never
    },
    {
      clock: () => {
        clockCalls += 1;
        return now;
      }
    }
  );

  service.refreshRollingSummary("session-1");

  assert.equal(clockCalls, 1);
  assert.equal(sessionSummaries.appended[0]?.createdAt, now.toISOString());
  assert.equal(sessions.get("session-1")?.updatedAt, now.toISOString());
});

function createSessionRecord(sessionId: string): SessionRecord {
  return {
    sessionId,
    workspaceRoot: "/workspaces/main",
    extraAllowedDirs: [],
    cwd: "/workspaces/main",
    mode: "code",
    codexThreadId: null,
    rollingSummary: null,
    runState: "idle",
    cancellationResult: null,
    activeRunId: null,
    staleRecovered: false,
    lastError: null,
    createdAt: "2026-03-06T09:00:00.000Z",
    updatedAt: "2026-03-06T09:00:00.000Z"
  };
}

function createPendingPermissionRecord(
  permissionId: string,
  resolved: boolean,
  expiresAt: string
): PendingPermissionRecord {
  return {
    permissionId,
    sessionId: "session-1",
    runId: "run-1",
    chatId: "chat-1",
    userId: "user-1",
    sourceMessageId: "message-1",
    toolName: "shell_command",
    summary: `${permissionId} summary`,
    expiresAt,
    resolved,
    resolution: resolved ? "approved" : null,
    resolvedAt: resolved ? "2026-03-06T10:04:00.000Z" : null,
    createdAt: expiresAt
  };
}

function createAuditLog(
  sessionId: string,
  eventType: string,
  createdAt: string,
  payload: Record<string, unknown>
): AuditLogRecord {
  return {
    auditId: Math.floor(Date.parse(createdAt) / 1000),
    sessionId,
    chatId: "chat-1",
    runId: "run-1",
    eventType,
    payload,
    createdAt
  };
}
