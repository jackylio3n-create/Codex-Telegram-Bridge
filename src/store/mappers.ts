import type {
  AuditLogRecord,
  ChannelOffsetRecord,
  ChatBindingRecord,
  PendingPermissionRecord,
  SessionOverviewRecord,
  SessionRecord,
  SessionSummaryRecord,
  TelegramUserAuthRecord
} from "./types.js";
import {
  integerToBoolean,
  parseJson,
  parseStringArray,
  toNullableStringValue,
  toNumberValue,
  toStringValue
} from "./sqlite-values.js";

export function mapSessionRow(row: Record<string, unknown>): SessionRecord {
  return {
    sessionId: toStringValue(row.session_id),
    workspaceRoot: toStringValue(row.workspace_root),
    extraAllowedDirs: parseStringArray(row.extra_allowed_dirs_json),
    cwd: toStringValue(row.cwd),
    mode: toStringValue(row.mode) as SessionRecord["mode"],
    accessScope: toStringValue(
      row.access_scope
    ) as SessionRecord["accessScope"],
    codexThreadId: toNullableStringValue(row.codex_thread_id),
    rollingSummary: toNullableStringValue(row.rolling_summary),
    runState: toStringValue(row.run_state) as SessionRecord["runState"],
    cancellationResult: toNullableStringValue(
      row.cancellation_result
    ) as SessionRecord["cancellationResult"],
    activeRunId: toNullableStringValue(row.active_run_id),
    staleRecovered: integerToBoolean(row.stale_recovered),
    lastError: toNullableStringValue(row.last_error),
    createdAt: toStringValue(row.created_at),
    updatedAt: toStringValue(row.updated_at)
  };
}

export function mapSessionOverviewRow(
  row: Record<string, unknown>
): SessionOverviewRecord {
  return {
    sessionId: toStringValue(row.session_id),
    workspaceRoot: toStringValue(row.workspace_root),
    extraAllowedDirs: parseStringArray(row.extra_allowed_dirs_json),
    cwd: toStringValue(row.cwd),
    mode: toStringValue(row.mode) as SessionOverviewRecord["mode"],
    accessScope: toStringValue(
      row.access_scope
    ) as SessionOverviewRecord["accessScope"],
    runState: toStringValue(row.run_state) as SessionOverviewRecord["runState"],
    activeRunId: toNullableStringValue(row.active_run_id),
    updatedAt: toStringValue(row.updated_at)
  };
}

export function mapChatBindingRow(
  row: Record<string, unknown>
): ChatBindingRecord {
  return {
    chatId: toStringValue(row.chat_id),
    sessionId: toStringValue(row.session_id),
    updatedAt: toStringValue(row.updated_at)
  };
}

export function mapPendingPermissionRow(
  row: Record<string, unknown>
): PendingPermissionRecord {
  return {
    permissionId: toStringValue(row.permission_id),
    sessionId: toStringValue(row.session_id),
    runId: toStringValue(row.run_id),
    chatId: toStringValue(row.chat_id),
    userId: toStringValue(row.user_id),
    sourceMessageId: toStringValue(row.source_message_id),
    toolName: toStringValue(row.tool_name),
    summary: toStringValue(row.summary),
    expiresAt: toStringValue(row.expires_at),
    resolved: integerToBoolean(row.resolved),
    resolution: toNullableStringValue(
      row.resolution
    ) as PendingPermissionRecord["resolution"],
    resolvedAt: toNullableStringValue(row.resolved_at),
    createdAt: toStringValue(row.created_at)
  };
}

export function mapChannelOffsetRow(
  row: Record<string, unknown>
): ChannelOffsetRecord {
  return {
    channelKey: toStringValue(row.channel_key),
    currentOffset: toNumberValue(row.current_offset),
    previousOffset: toNumberValue(row.previous_offset),
    updatedAt: toStringValue(row.updated_at)
  };
}

export function mapTelegramUserAuthRow(
  row: Record<string, unknown>
): TelegramUserAuthRecord {
  return {
    userId: toStringValue(row.user_id),
    latestChatId: toStringValue(row.latest_chat_id),
    firstSeenAt: toStringValue(row.first_seen_at),
    verifiedAt: toNullableStringValue(row.verified_at),
    preferredLanguage: toNullableStringValue(
      row.preferred_language
    ) as TelegramUserAuthRecord["preferredLanguage"],
    failedAttempts: toNumberValue(row.failed_attempts),
    lastFailedAt: toNullableStringValue(row.last_failed_at),
    bannedAt: toNullableStringValue(row.banned_at),
    updatedAt: toStringValue(row.updated_at)
  };
}

export function mapAuditLogRow(row: Record<string, unknown>): AuditLogRecord {
  return {
    auditId: toNumberValue(row.audit_id),
    sessionId: toNullableStringValue(row.session_id),
    chatId: toNullableStringValue(row.chat_id),
    runId: toNullableStringValue(row.run_id),
    eventType: toStringValue(row.event_type),
    payload: parseJson(row.payload_json),
    createdAt: toStringValue(row.created_at)
  };
}

export function mapSessionSummaryRow(
  row: Record<string, unknown>
): SessionSummaryRecord {
  return {
    summaryId: toNumberValue(row.summary_id),
    sessionId: toStringValue(row.session_id),
    summaryKind: toStringValue(row.summary_kind),
    content: toStringValue(row.content),
    createdAt: toStringValue(row.created_at)
  };
}
