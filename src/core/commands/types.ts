import type { ApprovalRequestRecord, ApprovalResolutionResult } from "../approval/index.js";
import type { NormalizedCommandRequest, SessionActorSnapshot } from "../types/index.js";
import type { AddDirConfirmation, WorkspaceIssue, WorkspaceSessionState } from "../workspace/index.js";
import type { ChatBindingRecord, SessionOverviewRecord, SessionRecord } from "../../store/types.js";

export type BridgeCommandStatus = "ok" | "rejected" | "confirmation_required";

export interface CommandExecutionContext {
  readonly chatId: string;
  readonly userId: string;
  readonly receivedAt: string;
}

export interface CommandSessionView {
  readonly session: SessionOverviewRecord;
  readonly actorSnapshot: SessionActorSnapshot | null;
  readonly isCurrentBinding: boolean;
}

export interface CommandStatusView {
  readonly binding: ChatBindingRecord | null;
  readonly session: SessionRecord | null;
  readonly actorSnapshot: SessionActorSnapshot | null;
  readonly pendingApprovals: readonly ApprovalRequestRecord["permission"][];
}

export interface CommandExecutionResult<TData = unknown> {
  readonly command: NormalizedCommandRequest["command"];
  readonly status: BridgeCommandStatus;
  readonly message: string;
  readonly data?: TData;
  readonly session?: WorkspaceSessionState | SessionRecord;
  readonly issues?: readonly WorkspaceIssue[];
}

export interface CommandsServiceOptions {
  readonly defaultWorkspaceRoot: string;
  readonly sessionIdFactory?: () => string;
  readonly workspaceMutationOptions?: import("../workspace/index.js").WorkspaceMutationOptions;
}

export interface NewCommandData {
  readonly sessionId: string;
  readonly bindingUpdated: boolean;
}

export interface BindCommandData {
  readonly sessionId: string;
}

export interface SessionsCommandData {
  readonly sessions: readonly CommandSessionView[];
}

export interface StatusCommandData {
  readonly status: CommandStatusView;
}

export interface AddDirCommandData {
  readonly confirmation: AddDirConfirmation;
}

export interface PermCommandData {
  readonly approvalResult?: ApprovalResolutionResult;
}
