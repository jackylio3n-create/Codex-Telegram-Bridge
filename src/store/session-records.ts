import type {
  PendingPermissionCreateInput,
  PendingPermissionRecord,
  SessionPatch,
  SessionRecord,
  SessionUpsertInput
} from "./types.js";

export function createSessionRecord(
  input: SessionUpsertInput,
  existing: SessionRecord | null,
  createdAt: string,
  updatedAt: string
): SessionRecord {
  return {
    sessionId: input.sessionId,
    workspaceRoot: input.workspaceRoot,
    extraAllowedDirs: [...input.extraAllowedDirs],
    cwd: input.cwd,
    mode: input.mode,
    accessScope: input.accessScope ?? existing?.accessScope ?? "workspace",
    codexThreadId: getNullableSessionValue(
      input,
      "codexThreadId",
      existing?.codexThreadId ?? null
    ),
    rollingSummary: getNullableSessionValue(
      input,
      "rollingSummary",
      existing?.rollingSummary ?? null
    ),
    runState: input.runState ?? existing?.runState ?? "idle",
    cancellationResult: getNullableSessionValue(
      input,
      "cancellationResult",
      existing?.cancellationResult ?? null
    ),
    activeRunId: getNullableSessionValue(
      input,
      "activeRunId",
      existing?.activeRunId ?? null
    ),
    staleRecovered: input.staleRecovered ?? existing?.staleRecovered ?? false,
    lastError: getNullableSessionValue(
      input,
      "lastError",
      existing?.lastError ?? null
    ),
    createdAt,
    updatedAt
  };
}

export function getNullableSessionValue<
  TNullableValue extends string | boolean | null
>(
  input: SessionPatch | SessionUpsertInput,
  key:
    | "codexThreadId"
    | "rollingSummary"
    | "cancellationResult"
    | "activeRunId"
    | "lastError",
  fallback: TNullableValue | null
): TNullableValue | null {
  return Object.prototype.hasOwnProperty.call(input, key)
    ? ((input as Record<string, TNullableValue | null | undefined>)[key] ??
        null)
    : fallback;
}

export function createPendingPermissionRecord(
  input: PendingPermissionCreateInput,
  createdAt: string
): PendingPermissionRecord {
  return {
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
    createdAt
  };
}
