import type {
  ApprovalRequestRecord,
  ApprovalResolutionResult
} from "../approval/index.js";
import type {
  NormalizedCommandRequest,
  SessionActorSnapshot
} from "../types/index.js";
import type { PromptLanguage } from "../../i18n.js";
import type {
  AddDirConfirmation,
  SessionAccessScope,
  WorkspaceMutationOptions,
  WorkspaceIssue,
  WorkspaceSessionState
} from "../workspace/index.js";
import type {
  ChatBindingRecord,
  SessionOverviewRecord,
  SessionRecord
} from "../../store/types.js";

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
  readonly workspaceMutationOptions?: WorkspaceMutationOptions;
  readonly statusTextProvider?: () => Promise<string> | string;
  readonly reasoningConfigService?: {
    readonly supportedValues: readonly string[];
    getCurrentEffort(): Promise<string | null> | string | null;
    setCurrentEffort(value: string): Promise<void> | void;
  };
  readonly languageResolver?: (userId: string) => PromptLanguage;
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

export interface PruneCommandData {
  readonly keepCount: number;
  readonly keptSessionIds: readonly string[];
  readonly deletedSessionIds: readonly string[];
  readonly skippedBoundCount: number;
  readonly skippedActiveCount: number;
}

export interface ReasoningCommandData {
  readonly currentEffort: string | null;
  readonly supportedValues: readonly string[];
}

export interface ScopeCommandData {
  readonly currentScope: SessionAccessScope;
}
