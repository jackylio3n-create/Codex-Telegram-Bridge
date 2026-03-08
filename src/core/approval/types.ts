import type { SessionActorSnapshot } from "../types/index.js";
import type { PendingPermissionRecord } from "../../store/types.js";
import type { TelegramInlineKeyboardMarkup } from "../../transport/telegram/types.js";

export type ApprovalDecision = "approve" | "deny";
export type ApprovalResolutionStatus =
  | "approved"
  | "denied"
  | "stale"
  | "missing";
export type ApprovalStaleReason =
  | "already_resolved"
  | "expired"
  | "chat_mismatch"
  | "user_mismatch"
  | "session_missing"
  | "run_mismatch"
  | "not_waiting";

export interface ApprovalRequestInput {
  readonly sessionId: string;
  readonly runId: string;
  readonly chatId: string;
  readonly userId: string;
  readonly sourceMessageId: string;
  readonly toolName: string;
  readonly summary: string;
  readonly ttlMs?: number;
}

export interface ApprovalRequestRecord {
  readonly permission: PendingPermissionRecord;
  readonly callbackData: {
    readonly approve: string;
    readonly deny: string;
  };
  readonly replyMarkup: TelegramInlineKeyboardMarkup;
}

export interface ApprovalDecisionInput {
  readonly permissionId: string;
  readonly decision: ApprovalDecision;
  readonly chatId: string;
  readonly userId: string;
  readonly sessionSnapshot: SessionActorSnapshot | null;
}

export interface ApprovalResolutionResult {
  readonly status: ApprovalResolutionStatus;
  readonly message: string;
  readonly reason?: ApprovalStaleReason;
  readonly permission?: PendingPermissionRecord;
}

export interface ApprovalExpiryResult {
  readonly expiredCount: number;
  readonly expiredPermissionIds: readonly string[];
}

export interface PermCommandDecisionRequest {
  readonly decision: ApprovalDecision;
  readonly permissionId: string;
}

export type PermCommandParseResult =
  | {
      readonly kind: "list";
    }
  | {
      readonly kind: "decision";
      readonly request: PermCommandDecisionRequest;
    }
  | {
      readonly kind: "invalid";
      readonly message: string;
    };
