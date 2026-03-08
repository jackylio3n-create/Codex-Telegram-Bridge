import { randomBytes } from "node:crypto";
import type { PromptLanguage } from "../../i18n.js";
import { selectText } from "../../i18n.js";
import type { PendingPermissionRecord, PendingPermissionsRepository } from "../../store/types.js";
import type { SessionActorSnapshot } from "../types/index.js";
import type {
  ApprovalDecision,
  ApprovalDecisionInput,
  ApprovalExpiryResult,
  ApprovalRequestInput,
  ApprovalRequestRecord,
  ApprovalResolutionResult,
  ApprovalStaleReason,
  PermCommandParseResult
} from "./types.js";

const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1000;

export interface ApprovalServiceOptions {
  readonly clock?: () => Date;
  readonly defaultApprovalTtlMs?: number;
}

export class ApprovalService {
  readonly #pendingPermissions: PendingPermissionsRepository;
  readonly #clock: () => Date;
  readonly #defaultApprovalTtlMs: number;

  constructor(
    pendingPermissions: PendingPermissionsRepository,
    options: ApprovalServiceOptions = {}
  ) {
    this.#pendingPermissions = pendingPermissions;
    this.#clock = options.clock ?? (() => new Date());
    this.#defaultApprovalTtlMs = options.defaultApprovalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
  }

  createPendingApproval(
    input: ApprovalRequestInput,
    language: PromptLanguage = "en"
  ): ApprovalRequestRecord {
    const createdAt = this.#clock();
    const permissionId = createOpaquePermissionId();
    const expiresAt = new Date(createdAt.getTime() + (input.ttlMs ?? this.#defaultApprovalTtlMs));
    const permission = this.#pendingPermissions.create({
      permissionId,
      sessionId: input.sessionId,
      runId: input.runId,
      chatId: input.chatId,
      userId: input.userId,
      sourceMessageId: input.sourceMessageId,
      toolName: input.toolName,
      summary: input.summary,
      expiresAt: expiresAt.toISOString(),
      createdAt: createdAt.toISOString()
    });

    return {
      permission,
      callbackData: {
        approve: formatApprovalCallbackData("approve", permission.permissionId),
        deny: formatApprovalCallbackData("deny", permission.permissionId)
      },
      replyMarkup: buildApprovalInlineKeyboard(permission.permissionId, language)
    };
  }

  listPendingPermissionsForSession(sessionId: string): readonly PendingPermissionRecord[] {
    return this.#pendingPermissions.list({
      sessionId,
      resolved: false
    });
  }

  parsePermCommand(
    args: readonly string[] | undefined,
    language: PromptLanguage = "en"
  ): PermCommandParseResult {
    if (!args || args.length === 0) {
      return { kind: "list" };
    }

    if (args.length !== 2) {
      return {
        kind: "invalid",
        message: localize(language,
          "用法：/perm 或 /perm <approve|deny> <permission_id>。",
          "Usage: /perm or /perm <approve|deny> <permission_id>."
        )
      };
    }

    const decisionToken = args[0]?.trim().toLowerCase();
    const permissionId = args[1]?.trim() ?? "";

    if ((decisionToken !== "approve" && decisionToken !== "deny") || permissionId === "") {
      return {
        kind: "invalid",
        message: localize(language,
          "用法：/perm approve <permission_id> 或 /perm deny <permission_id>。",
          "Usage: /perm approve <permission_id> or /perm deny <permission_id>."
        )
      };
    }

    return {
      kind: "decision",
      request: {
        decision: decisionToken,
        permissionId
      }
    };
  }

  formatPermFallbackText(sessionId: string, language: PromptLanguage = "en"): string {
    const pending = this.listPendingPermissionsForSession(sessionId);
    if (pending.length === 0) {
      return localize(language, "当前会话没有待审批项。", "No pending approvals for this session.");
    }

    const lines = [
      localize(language, "待审批项：", "Pending approvals:")
    ];

    for (const permission of pending) {
      lines.push(`- ${permission.permissionId} | ${permission.toolName} | ${permission.summary}`);
      lines.push(`  /perm approve ${permission.permissionId}`);
      lines.push(`  /perm deny ${permission.permissionId}`);
    }

    return lines.join("\n");
  }

  resolveDecision(
    input: ApprovalDecisionInput,
    language: PromptLanguage = "en"
  ): ApprovalResolutionResult {
    const permission = this.#pendingPermissions.get(input.permissionId);
    if (!permission) {
      return {
        status: "missing",
        message: localize(language, "已过期或已处理。", "Expired or already handled.")
      };
    }

    const now = this.#clock();
    const nowIso = now.toISOString();
    const staleReason = this.#resolveStaleReason(permission, input, now.getTime());
    if (staleReason) {
      if (staleReason === "expired" && !permission.resolved) {
        this.#pendingPermissions.resolve(permission.permissionId, "expired", nowIso);
      }

      return {
        status: "stale",
        message: localize(language, "已过期或已处理。", "Expired or already handled."),
        reason: staleReason,
        permission
      };
    }

    const resolution = input.decision === "approve" ? "approved" : "denied";
    const resolved = this.#pendingPermissions.resolve(permission.permissionId, resolution, nowIso);

    if (!resolved) {
      return {
        status: "missing",
        message: localize(language, "已过期或已处理。", "Expired or already handled.")
      };
    }

    return {
      status: input.decision === "approve" ? "approved" : "denied",
      message: input.decision === "approve"
        ? localize(language, "已批准。", "Approval granted.")
        : localize(language, "已拒绝。", "Approval denied."),
      permission: resolved
    };
  }

  expirePendingApprovals(now = this.#clock()): ApprovalExpiryResult {
    const nowIso = now.toISOString();
    const expiredPermissionIds = this.#pendingPermissions.expirePending(nowIso, nowIso);

    return {
      expiredCount: expiredPermissionIds.length,
      expiredPermissionIds
    };
  }

  #resolveStaleReason(
    permission: PendingPermissionRecord,
    input: ApprovalDecisionInput,
    nowTimestamp: number
  ): ApprovalStaleReason | null {
    if (permission.resolved) {
      return "already_resolved";
    }

    if (Date.parse(permission.expiresAt) < nowTimestamp) {
      return "expired";
    }

    if (permission.chatId !== input.chatId) {
      return "chat_mismatch";
    }

    if (permission.userId !== input.userId) {
      return "user_mismatch";
    }

    if (!input.sessionSnapshot) {
      return "session_missing";
    }

    if (input.sessionSnapshot.runState !== "waiting_approval") {
      return "not_waiting";
    }

    if (input.sessionSnapshot.waitingPermissionId !== permission.permissionId) {
      return "not_waiting";
    }

    if (input.sessionSnapshot.currentRunId !== permission.runId) {
      return "run_mismatch";
    }

    return null;
  }
}

export function buildApprovalInlineKeyboard(
  permissionId: string,
  language: PromptLanguage = "en"
) {
  return {
    inline_keyboard: [
      [
        {
          text: localize(language, "批准", "Approve"),
          callback_data: formatApprovalCallbackData("approve", permissionId)
        },
        {
          text: localize(language, "拒绝", "Deny"),
          callback_data: formatApprovalCallbackData("deny", permissionId)
        }
      ]
    ]
  } as const;
}

export function formatApprovalCallbackData(
  decision: ApprovalDecision,
  permissionId: string
): string {
  return `${decision === "approve" ? "pa" : "pd"}:${permissionId}`;
}

function createOpaquePermissionId(): string {
  return randomBytes(9).toString("base64url");
}

function localize(language: PromptLanguage, zh: string, en: string): string {
  return selectText(language, zh, en);
}
