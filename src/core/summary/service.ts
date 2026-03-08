import type {
  AuditLogRecord,
  AuditLogEventLimit,
  AuditLogsRepository,
  PendingPermissionRecord,
  PendingPermissionsRepository,
  SessionRecord,
  SessionSummariesRepository,
  SessionsRepository
} from "../../store/types.js";
import type { RollingSummaryResult, RollingSummarySnapshot } from "./types.js";

const SUMMARY_PENDING_APPROVAL_LIMIT = 5;
const SUMMARY_AUDIT_SECTIONS = [
  { eventType: "approval_decision", snapshotKey: "recentApprovalDecisions", limit: 5 },
  { eventType: "user_command", snapshotKey: "recentCommands", limit: 5 },
  { eventType: "file_change", snapshotKey: "recentBoundaryChanges", limit: 5 },
  { eventType: "run_cancel", snapshotKey: "recentRunCancels", limit: 2 },
  { eventType: "resume_recovery", snapshotKey: "recentResumeRecoveries", limit: 2 }
] as const;
const SUMMARY_AUDIT_EVENT_LIMITS = SUMMARY_AUDIT_SECTIONS.map(({ eventType, limit }) => ({
  eventType,
  limit
})) as readonly AuditLogEventLimit[];
const SUMMARY_TRIGGER_EVENT_TYPES = new Set(
  [...SUMMARY_AUDIT_EVENT_LIMITS.map((entry) => entry.eventType), "agent_text"]
);

type SummaryAuditSection = typeof SUMMARY_AUDIT_SECTIONS[number];
type SummaryAuditSectionKey = SummaryAuditSection["snapshotKey"];
type SummaryAuditCollections = Record<SummaryAuditSectionKey, string[]>;

export interface SummaryServiceOptions {
  readonly clock?: () => Date;
}

export class SummaryService {
  readonly #sessions: SessionsRepository;
  readonly #pendingPermissions: PendingPermissionsRepository;
  readonly #auditLogs: AuditLogsRepository;
  readonly #sessionSummaries: SessionSummariesRepository;
  readonly #clock: () => Date;

  constructor(
    store: Pick<{
      readonly sessions: SessionsRepository;
      readonly pendingPermissions: PendingPermissionsRepository;
      readonly auditLogs: AuditLogsRepository;
      readonly sessionSummaries: SessionSummariesRepository;
    }, "sessions" | "pendingPermissions" | "auditLogs" | "sessionSummaries">,
    options: SummaryServiceOptions = {}
  ) {
    this.#sessions = store.sessions;
    this.#pendingPermissions = store.pendingPermissions;
    this.#auditLogs = store.auditLogs;
    this.#sessionSummaries = store.sessionSummaries;
    this.#clock = options.clock ?? (() => new Date());
  }

  shouldRefreshForAuditEvent(eventType: string): boolean {
    return SUMMARY_TRIGGER_EVENT_TYPES.has(eventType);
  }

  buildRollingSummary(sessionId: string): RollingSummaryResult {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const pendingPermissions = this.#pendingPermissions.list({
      sessionId,
      resolved: false,
      limit: SUMMARY_PENDING_APPROVAL_LIMIT
    });
    const auditEvents = this.#auditLogs.listRecentByEventType(sessionId, SUMMARY_AUDIT_EVENT_LIMITS);
    const recentAudit = collectRecentAuditSections(auditEvents);

    const snapshot: RollingSummarySnapshot = {
      sessionId: session.sessionId,
      mode: session.mode,
      workspaceRoot: session.workspaceRoot,
      extraAllowedDirs: [...session.extraAllowedDirs],
      cwd: session.cwd,
      runState: session.runState,
      activeRunId: session.activeRunId,
      codexThreadId: session.codexThreadId,
      lastError: session.lastError,
      staleRecovered: session.staleRecovered,
      pendingApprovals: formatPendingApprovals(pendingPermissions),
      recentApprovalDecisions: recentAudit.recentApprovalDecisions,
      recentCommands: recentAudit.recentCommands,
      recentBoundaryChanges: recentAudit.recentBoundaryChanges,
      recentRuntimeOutcomes: [
        ...recentAudit.recentRunCancels,
        ...recentAudit.recentResumeRecoveries
      ]
    };

    return {
      snapshot,
      content: formatRollingSummary(snapshot)
    };
  }

  refreshRollingSummary(sessionId: string): RollingSummaryResult {
    const summary = this.buildRollingSummary(sessionId);
    const refreshedAt = this.#clock().toISOString();
    this.#sessionSummaries.append({
      sessionId,
      summaryKind: "rolling",
      content: summary.content,
      createdAt: refreshedAt
    });
    this.#sessions.update(sessionId, {
      rollingSummary: summary.content,
      updatedAt: refreshedAt
    });

    return summary;
  }

  buildRecoverySeedText(sessionId: string): string {
    const summary = this.buildRollingSummary(sessionId);
    return summary.content;
  }
}

function formatRollingSummary(snapshot: RollingSummarySnapshot): string {
  const sections = [
    "Session",
    `- Session ID: ${snapshot.sessionId}`,
    `- Mode: ${snapshot.mode}`,
    `- Workspace root: ${snapshot.workspaceRoot}`,
    `- Extra allowed dirs: ${formatList(snapshot.extraAllowedDirs)}`,
    `- Cwd: ${snapshot.cwd}`,
    `- Run state: ${snapshot.runState}`,
    `- Active run ID: ${snapshot.activeRunId ?? "none"}`,
    `- Codex thread ID: ${snapshot.codexThreadId ?? "none"}`,
    `- Last error: ${snapshot.lastError ? "present" : "none"}`,
    `- Stale recovered: ${snapshot.staleRecovered ? "yes" : "no"}`,
    "",
    "Pending Approvals",
    ...toSectionLines(snapshot.pendingApprovals),
    "",
    "Recent Approval Decisions",
    ...toSectionLines(snapshot.recentApprovalDecisions),
    "",
    "Recent Commands",
    ...toSectionLines(snapshot.recentCommands),
    "",
    "Recent Boundary Changes",
    ...toSectionLines(snapshot.recentBoundaryChanges),
    "",
    "Recent Runtime Outcomes",
    ...toSectionLines(snapshot.recentRuntimeOutcomes)
  ];

  return sections.join("\n");
}

function toSectionLines(entries: readonly string[]): readonly string[] {
  return entries.length > 0 ? entries.map((entry) => `- ${entry}`) : ["- none"];
}

function formatList(entries: readonly string[]): string {
  return entries.length > 0 ? entries.join(", ") : "none";
}

function formatPendingApprovals(records: readonly PendingPermissionRecord[]): readonly string[] {
  return records
    .slice(0, SUMMARY_PENDING_APPROVAL_LIMIT)
    .map((record) => `${record.permissionId} | ${record.toolName} | expires ${record.expiresAt}`);
}

function collectRecentAuditSections(records: readonly AuditLogRecord[]): {
  readonly recentApprovalDecisions: readonly string[];
  readonly recentCommands: readonly string[];
  readonly recentBoundaryChanges: readonly string[];
  readonly recentRunCancels: readonly string[];
  readonly recentResumeRecoveries: readonly string[];
} {
  const collected = createSummaryAuditCollections();
  const sectionByEventType = new Map<string, SummaryAuditSection>(
    SUMMARY_AUDIT_SECTIONS.map((section) => [section.eventType, section])
  );

  for (const record of records) {
    const section = sectionByEventType.get(record.eventType);
    if (!section) {
      continue;
    }

    const entries = collected[section.snapshotKey];
    if (entries.length >= section.limit) {
      continue;
    }

    entries.push(formatAuditEvent(record));
    if (haveCollectedAllSummaryAuditSections(collected)) {
      break;
    }
  }

  return {
    recentApprovalDecisions: collected.recentApprovalDecisions,
    recentCommands: collected.recentCommands,
    recentBoundaryChanges: collected.recentBoundaryChanges,
    recentRunCancels: collected.recentRunCancels,
    recentResumeRecoveries: collected.recentResumeRecoveries
  };
}

function createSummaryAuditCollections(): SummaryAuditCollections {
  return {
    recentApprovalDecisions: [],
    recentCommands: [],
    recentBoundaryChanges: [],
    recentRunCancels: [],
    recentResumeRecoveries: []
  };
}

function haveCollectedAllSummaryAuditSections(collected: SummaryAuditCollections): boolean {
  return SUMMARY_AUDIT_SECTIONS.every((section) => collected[section.snapshotKey].length >= section.limit);
}

function formatAuditEvent(record: AuditLogRecord): string {
  return `${record.createdAt} | ${record.eventType} | ${formatAuditPayload(record.payload)}`;
}

function formatAuditPayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "no payload";
  }

  const entries = Object.entries(payload as Record<string, unknown>).map(([key, value]) => {
    if (Array.isArray(value)) {
      return `${key}=${value.join(",")}`;
    }

    return `${key}=${value === null ? "null" : String(value)}`;
  });

  return entries.join("; ");
}
