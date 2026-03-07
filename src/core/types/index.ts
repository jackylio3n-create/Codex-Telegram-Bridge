export type SessionRunState =
  | "idle"
  | "running"
  | "waiting_approval"
  | "cancelling"
  | "cancelled"
  | "failed"
  | "stale_recovered";

export type CancellationResult = "full" | "partial" | "unknown";
export type SessionMode = "ask" | "plan" | "code";
export type ApprovalDecision = "approve" | "deny";
export type RoutingSeverity = "info" | "warning" | "error";
export type SessionEventRejectionReason =
  | "run_already_active"
  | "run_not_active"
  | "run_id_mismatch"
  | "permission_mismatch"
  | "not_waiting_for_approval"
  | "not_cancellable";

export interface EventEnvelope {
  readonly chatId: string;
  readonly userId: string;
  readonly messageId?: string;
  readonly receivedAt: string;
}

export interface TextUserInput {
  readonly type: "user_input";
  readonly contentType: "text";
  readonly envelope: EventEnvelope;
  readonly text: string;
}

export interface ImageUserInput {
  readonly type: "user_input";
  readonly contentType: "image";
  readonly envelope: EventEnvelope;
  readonly telegramFileId: string;
  readonly mimeType?: string;
  readonly viaDocument: boolean;
  readonly caption?: string;
}

export type NormalizedUserInput = TextUserInput | ImageUserInput;

export interface BaseCommandRequest {
  readonly type: "command";
  readonly envelope: EventEnvelope;
}

export interface BindCommandRequest extends BaseCommandRequest {
  readonly command: "bind";
  readonly targetSessionId: string;
}

export interface NewCommandRequest extends BaseCommandRequest {
  readonly command: "new";
  readonly requestedCwd?: string;
  readonly targetSessionId?: string;
}

export interface PathCommandRequest extends BaseCommandRequest {
  readonly command: "cwd" | "adddir";
  readonly path: string;
}

export interface ModeCommandRequest extends BaseCommandRequest {
  readonly command: "mode";
  readonly mode: SessionMode;
}

export interface StatusCommandRequest extends BaseCommandRequest {
  readonly command: "status";
  readonly args?: readonly string[];
}

export interface HelpCommandRequest extends BaseCommandRequest {
  readonly command: "help";
  readonly args?: readonly string[];
}

export interface StopCommandRequest extends BaseCommandRequest {
  readonly command: "stop";
  readonly args?: readonly string[];
}

export interface SessionsCommandRequest extends BaseCommandRequest {
  readonly command: "sessions";
  readonly args?: readonly string[];
}

export interface StartCommandRequest extends BaseCommandRequest {
  readonly command: "start";
  readonly args?: readonly string[];
}

export interface PermCommandRequest extends BaseCommandRequest {
  readonly command: "perm";
  readonly args?: readonly string[];
}

export type NormalizedCommandRequest =
  | BindCommandRequest
  | NewCommandRequest
  | PathCommandRequest
  | ModeCommandRequest
  | StatusCommandRequest
  | HelpCommandRequest
  | StopCommandRequest
  | SessionsCommandRequest
  | StartCommandRequest
  | PermCommandRequest;

export type BoundCommandRequest =
  | PathCommandRequest
  | ModeCommandRequest
  | StatusCommandRequest
  | HelpCommandRequest
  | SessionsCommandRequest
  | StartCommandRequest
  | PermCommandRequest;

export interface NormalizedApprovalDecision {
  readonly type: "approval_decision";
  readonly envelope: EventEnvelope;
  readonly sessionId: string;
  readonly runId: string;
  readonly permissionId: string;
  readonly decision: ApprovalDecision;
  readonly callbackQueryId: string;
}

export type NormalizedInboundMessage =
  | NormalizedUserInput
  | NormalizedCommandRequest
  | NormalizedApprovalDecision;

export interface SessionActorSnapshot {
  readonly sessionId: string;
  readonly runState: SessionRunState;
  readonly currentRunId: string | null;
  readonly waitingPermissionId: string | null;
  readonly cancellationResult: CancellationResult | null;
  readonly queuedEventCount: number;
  readonly processedEventCount: number;
  readonly lastEventAt: string | null;
}

export interface ChatBindingSnapshot {
  readonly chatId: string;
  readonly sessionId: string | null;
}

export interface ChatFeedbackEffect {
  readonly type: "chat_feedback";
  readonly chatId: string;
  readonly severity: RoutingSeverity;
  readonly text: string;
  readonly sessionId?: string;
}

export interface CommandRejectedEffect {
  readonly type: "command_rejected";
  readonly chatId: string;
  readonly command: NormalizedCommandRequest["command"];
  readonly reason:
    | "active_session_blocked"
    | "missing_binding"
    | "missing_session"
    | "duplicate_session"
    | "approval_session_missing";
  readonly text: string;
  readonly sessionId?: string;
}

export interface ChatBindingChangedEffect {
  readonly type: "chat_binding_changed";
  readonly chatId: string;
  readonly previousSessionId: string | null;
  readonly nextSessionId: string;
  readonly reason: "bind" | "new";
}

export interface SessionCreatedEffect {
  readonly type: "session_created";
  readonly chatId: string;
  readonly sessionId: string;
}

export interface SessionEventQueuedEffect {
  readonly type: "session_event_queued";
  readonly sessionId: string;
  readonly eventKind: SessionEvent["kind"];
}

export interface SessionStateChangedEffect {
  readonly type: "session_state_changed";
  readonly sessionId: string;
  readonly eventKind: SessionEvent["kind"];
  readonly previousState: SessionRunState;
  readonly nextState: SessionRunState;
  readonly runId: string | null;
  readonly cancellationResult: CancellationResult | null;
}

export interface SessionEventRejectedEffect {
  readonly type: "session_event_rejected";
  readonly sessionId: string;
  readonly eventKind: SessionEvent["kind"];
  readonly reason: SessionEventRejectionReason;
  readonly runId: string | null;
  readonly permissionId: string | null;
  readonly text: string;
}

export type NormalizedOutboundMessage =
  | ChatFeedbackEffect
  | CommandRejectedEffect
  | ChatBindingChangedEffect
  | SessionCreatedEffect
  | SessionEventQueuedEffect
  | SessionStateChangedEffect
  | SessionEventRejectedEffect;

export interface SessionCreatedEvent {
  readonly kind: "session_created";
  readonly chatId: string;
  readonly sessionId: string;
  readonly createdAt: string;
}

export interface SessionBoundEvent {
  readonly kind: "session_bound";
  readonly chatId: string;
  readonly sessionId: string;
  readonly boundAt: string;
}

export interface UserInputReceivedEvent {
  readonly kind: "user_input_received";
  readonly input: NormalizedUserInput;
}

export interface CommandReceivedEvent {
  readonly kind: "command_received";
  readonly command: BoundCommandRequest;
}

export interface RunStartedEvent {
  readonly kind: "run_started";
  readonly runId: string;
  readonly startedAt: string;
}

export interface ApprovalRequestedEvent {
  readonly kind: "approval_requested";
  readonly runId: string;
  readonly permissionId: string;
  readonly requestedAt: string;
}

export interface ApprovalResolvedEvent {
  readonly kind: "approval_resolved";
  readonly runId: string;
  readonly permissionId: string;
  readonly decision: ApprovalDecision;
  readonly resolvedAt: string;
}

export interface CancelRequestedEvent {
  readonly kind: "cancel_requested";
  readonly requestedAt: string;
}

export interface RunCompletedEvent {
  readonly kind: "run_completed";
  readonly runId: string;
  readonly completedAt: string;
}

export interface RunFailedEvent {
  readonly kind: "run_failed";
  readonly runId: string;
  readonly failedAt: string;
}

export interface RunCancelledEvent {
  readonly kind: "run_cancelled";
  readonly runId: string;
  readonly cancelledAt: string;
  readonly cancellationResult: CancellationResult;
}

export interface StaleRecoveredEvent {
  readonly kind: "stale_recovered";
  readonly recoveredAt: string;
}

export type SessionEvent =
  | SessionCreatedEvent
  | SessionBoundEvent
  | UserInputReceivedEvent
  | CommandReceivedEvent
  | RunStartedEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | CancelRequestedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunCancelledEvent
  | StaleRecoveredEvent;

export interface SessionActorDispatchResult {
  readonly snapshot: SessionActorSnapshot;
  readonly effects: readonly NormalizedOutboundMessage[];
  readonly accepted: boolean;
}

export interface RoutingDispatchResult {
  readonly binding: ChatBindingSnapshot;
  readonly sessionSnapshot: SessionActorSnapshot | null;
  readonly effects: readonly NormalizedOutboundMessage[];
}

export interface RoutingCoreOptions {
  readonly sessionIdFactory?: () => string;
}
