import type { SessionAccessScope } from "../core/workspace/index.js";

export type SessionMode = "ask" | "plan" | "code";
import type { PromptLanguage } from "../i18n.js";

export type SessionRunState =
  | "idle"
  | "running"
  | "waiting_approval"
  | "cancelling"
  | "cancelled"
  | "failed"
  | "stale_recovered";
export type SessionCancellationResult = "full" | "partial" | "unknown";
export type PendingPermissionResolution = "approved" | "denied" | "expired";

export type AuditEventType =
  | "user_input"
  | "user_command"
  | "approval_decision"
  | "agent_text"
  | "tool_start"
  | "tool_result"
  | "file_change"
  | "shell_exec"
  | "session_rebind"
  | "run_cancel"
  | "resume_recovery";

export interface SessionRecord {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly extraAllowedDirs: readonly string[];
  readonly cwd: string;
  readonly mode: SessionMode;
  readonly accessScope: SessionAccessScope;
  readonly codexThreadId: string | null;
  readonly rollingSummary: string | null;
  readonly runState: SessionRunState;
  readonly cancellationResult: SessionCancellationResult | null;
  readonly activeRunId: string | null;
  readonly staleRecovered: boolean;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SessionUpsertInput {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly extraAllowedDirs: readonly string[];
  readonly cwd: string;
  readonly mode: SessionMode;
  readonly accessScope?: SessionAccessScope;
  readonly codexThreadId?: string | null;
  readonly rollingSummary?: string | null;
  readonly runState?: SessionRunState;
  readonly cancellationResult?: SessionCancellationResult | null;
  readonly activeRunId?: string | null;
  readonly staleRecovered?: boolean;
  readonly lastError?: string | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface SessionPatch {
  readonly workspaceRoot?: string;
  readonly extraAllowedDirs?: readonly string[];
  readonly cwd?: string;
  readonly mode?: SessionMode;
  readonly accessScope?: SessionAccessScope;
  readonly codexThreadId?: string | null;
  readonly rollingSummary?: string | null;
  readonly runState?: SessionRunState;
  readonly cancellationResult?: SessionCancellationResult | null;
  readonly activeRunId?: string | null;
  readonly staleRecovered?: boolean;
  readonly lastError?: string | null;
  readonly updatedAt?: string;
}

export interface ChatBindingRecord {
  readonly chatId: string;
  readonly sessionId: string;
  readonly updatedAt: string;
}

export interface ChatBindingUpsertInput {
  readonly chatId: string;
  readonly sessionId: string;
  readonly updatedAt?: string;
}

export interface PendingPermissionRecord {
  readonly permissionId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly chatId: string;
  readonly userId: string;
  readonly sourceMessageId: string;
  readonly toolName: string;
  readonly summary: string;
  readonly expiresAt: string;
  readonly resolved: boolean;
  readonly resolution: PendingPermissionResolution | null;
  readonly resolvedAt: string | null;
  readonly createdAt: string;
}

export interface PendingPermissionCreateInput {
  readonly permissionId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly chatId: string;
  readonly userId: string;
  readonly sourceMessageId: string;
  readonly toolName: string;
  readonly summary: string;
  readonly expiresAt: string;
  readonly createdAt?: string;
}

export interface PendingPermissionFilter {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly chatId?: string;
  readonly userId?: string;
  readonly resolved?: boolean;
  readonly limit?: number;
}

export interface ChannelOffsetRecord {
  readonly channelKey: string;
  readonly currentOffset: number;
  readonly previousOffset: number;
  readonly updatedAt: string;
}

export interface ChannelOffsetUpsertInput {
  readonly channelKey: string;
  readonly currentOffset: number;
  readonly previousOffset?: number;
  readonly updatedAt?: string;
}

export interface TelegramUserAuthRecord {
  readonly userId: string;
  readonly latestChatId: string;
  readonly firstSeenAt: string;
  readonly verifiedAt: string | null;
  readonly preferredLanguage: PromptLanguage | null;
  readonly failedAttempts: number;
  readonly lastFailedAt: string | null;
  readonly bannedAt: string | null;
  readonly updatedAt: string;
}

export interface TelegramUserFirstSeenInput {
  readonly userId: string;
  readonly chatId: string;
  readonly firstSeenAt?: string;
}

export interface TelegramUserVerificationInput {
  readonly userId: string;
  readonly chatId: string;
  readonly verifiedAt?: string;
}

export interface TelegramUserFailedAttemptInput {
  readonly userId: string;
  readonly chatId: string;
  readonly failedAt?: string;
  readonly banThreshold: number;
}

export interface TelegramUserLanguagePreferenceInput {
  readonly userId: string;
  readonly chatId: string;
  readonly preferredLanguage: PromptLanguage;
  readonly selectedAt?: string;
}

export interface AuditLogRecord<TPayload = unknown> {
  readonly auditId: number;
  readonly sessionId: string | null;
  readonly chatId: string | null;
  readonly runId: string | null;
  readonly eventType: AuditEventType | string;
  readonly payload: TPayload | null;
  readonly createdAt: string;
}

export interface AuditLogCreateInput<TPayload = unknown> {
  readonly sessionId?: string | null;
  readonly chatId?: string | null;
  readonly runId?: string | null;
  readonly eventType: AuditEventType | string;
  readonly payload?: TPayload | null;
  readonly createdAt?: string;
}

export interface AuditLogFilter {
  readonly sessionId?: string;
  readonly chatId?: string;
  readonly runId?: string;
  readonly limit?: number;
}

export interface AuditLogEventLimit {
  readonly eventType: AuditEventType | string;
  readonly limit: number;
}

export interface SessionSummaryRecord {
  readonly summaryId: number;
  readonly sessionId: string;
  readonly summaryKind: string;
  readonly content: string;
  readonly createdAt: string;
}

export interface SessionSummaryCreateInput {
  readonly sessionId: string;
  readonly summaryKind?: string;
  readonly content: string;
  readonly createdAt?: string;
}

export interface SessionSummaryFilter {
  readonly sessionId: string;
  readonly limit?: number;
}

export interface AppliedMigrationRecord {
  readonly migrationId: string;
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
}

export interface SessionOverviewRecord {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly extraAllowedDirs: readonly string[];
  readonly cwd: string;
  readonly mode: SessionMode;
  readonly accessScope: SessionAccessScope;
  readonly runState: SessionRunState;
  readonly activeRunId: string | null;
  readonly updatedAt: string;
}

export interface CleanupPolicy {
  readonly approvalExpiryOlderThan?: string | Date;
  readonly approvalResolutionOlderThan?: string | Date;
  readonly maxSummariesPerSession?: number;
  readonly auditRowsOlderThan?: string | Date;
  readonly maxAuditRows?: number;
}

export interface CleanupResult {
  readonly deletedExpiredPermissions: number;
  readonly deletedResolvedPermissions: number;
  readonly deletedSummaryRows: number;
  readonly deletedAuditRows: number;
}

export interface SessionsRepository {
  get(sessionId: string): SessionRecord | null;
  list(): readonly SessionRecord[];
  listOverview(): readonly SessionOverviewRecord[];
  save(input: SessionUpsertInput): SessionRecord;
  update(sessionId: string, patch: SessionPatch): SessionRecord;
  delete(sessionId: string): boolean;
}

export interface ChatBindingsRepository {
  get(chatId: string): ChatBindingRecord | null;
  list(): readonly ChatBindingRecord[];
  save(input: ChatBindingUpsertInput): ChatBindingRecord;
  delete(chatId: string): boolean;
}

export interface PendingPermissionsRepository {
  get(permissionId: string): PendingPermissionRecord | null;
  list(filter?: PendingPermissionFilter): readonly PendingPermissionRecord[];
  create(input: PendingPermissionCreateInput): PendingPermissionRecord;
  expirePending(before: string, resolvedAt?: string): readonly string[];
  resolve(
    permissionId: string,
    resolution: PendingPermissionResolution,
    resolvedAt?: string
  ): PendingPermissionRecord | null;
  deleteExpired(before: string): number;
  deleteResolved(before: string): number;
}

export interface ChannelOffsetsRepository {
  get(channelKey: string): ChannelOffsetRecord | null;
  list(): readonly ChannelOffsetRecord[];
  save(input: ChannelOffsetUpsertInput): ChannelOffsetRecord;
}

export interface TelegramUserAuthRepository {
  get(userId: string): TelegramUserAuthRecord | null;
  findByChatId(chatId: string): TelegramUserAuthRecord | null;
  list(): readonly TelegramUserAuthRecord[];
  getOrCreateFirstSeen(input: TelegramUserFirstSeenInput): TelegramUserAuthRecord;
  markVerified(input: TelegramUserVerificationInput): TelegramUserAuthRecord;
  setPreferredLanguage(input: TelegramUserLanguagePreferenceInput): TelegramUserAuthRecord;
  recordFailedAttempt(input: TelegramUserFailedAttemptInput): TelegramUserAuthRecord;
}

export interface AuditLogsRepository {
  append<TPayload = unknown>(input: AuditLogCreateInput<TPayload>): AuditLogRecord<TPayload>;
  list(filter?: AuditLogFilter): readonly AuditLogRecord[];
  listRecentByEventType(sessionId: string, limits: readonly AuditLogEventLimit[]): readonly AuditLogRecord[];
  pruneOlderThan(before: string): number;
  pruneToMaxRows(maxRows: number): number;
}

export interface SessionSummariesRepository {
  append(input: SessionSummaryCreateInput): SessionSummaryRecord;
  list(filter: SessionSummaryFilter): readonly SessionSummaryRecord[];
  pruneToMaxPerSession(maxRowsPerSession: number): number;
}

export interface MigrationRepository {
  list(): readonly AppliedMigrationRecord[];
}

export interface BridgeStore {
  readonly databaseFilePath: string;
  readonly sessions: SessionsRepository;
  readonly chatBindings: ChatBindingsRepository;
  readonly pendingPermissions: PendingPermissionsRepository;
  readonly channelOffsets: ChannelOffsetsRepository;
  readonly telegramUserAuth: TelegramUserAuthRepository;
  readonly auditLogs: AuditLogsRepository;
  readonly sessionSummaries: SessionSummariesRepository;
  readonly migrations: MigrationRepository;
  withTransaction<T>(callback: (store: BridgeStore) => T): T;
  runCleanup(policy: CleanupPolicy): CleanupResult;
  close(): void;
}
