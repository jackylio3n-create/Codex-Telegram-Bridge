export type CodexRuntimeMode = "ask" | "plan" | "code";
export type CodexRuntimeSandboxMode = "read-only" | "workspace-write";
export type CodexRuntimeApprovalPolicy = "on-request";
export type CodexCancellationResult = "full" | "partial" | "unknown";

export interface CodexModePolicy {
  readonly mode: CodexRuntimeMode;
  readonly sandbox: CodexRuntimeSandboxMode;
  readonly approval: CodexRuntimeApprovalPolicy;
}

export interface CodexRuntimeContext {
  readonly cwd: string;
  readonly extraWritableRoots: readonly string[];
  readonly mode: CodexRuntimeMode;
}

export interface CodexLoginStatus {
  readonly available: boolean;
  readonly loggedIn: boolean;
  readonly provider: string | null;
  readonly rawOutput: string;
}

export interface CodexUsage {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
}

export interface CodexThreadStartedEvent {
  readonly kind: "thread_started";
  readonly threadId: string;
  readonly rawType: string;
}

export interface CodexTurnStartedEvent {
  readonly kind: "turn_started";
  readonly rawType: string;
}

export interface CodexAgentMessageEvent {
  readonly kind: "agent_message";
  readonly itemId: string | null;
  readonly text: string;
  readonly rawType: string;
}

export interface CodexApprovalRequestEvent {
  readonly kind: "approval_request";
  readonly callId: string;
  readonly approvalId: string | null;
  readonly turnId: string | null;
  readonly command: readonly string[];
  readonly cwd: string;
  readonly reason: string | null;
  readonly summary: string;
  readonly rawType: string;
}

export interface CodexExecCommandBeginEvent {
  readonly kind: "exec_command_begin";
  readonly callId: string;
  readonly turnId: string | null;
  readonly command: readonly string[];
  readonly cwd: string;
  readonly source: string | null;
  readonly rawType: string;
}

export interface CodexExecCommandEndEvent {
  readonly kind: "exec_command_end";
  readonly callId: string;
  readonly turnId: string | null;
  readonly command: readonly string[];
  readonly cwd: string;
  readonly source: string | null;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly aggregatedOutput: string;
  readonly status: string | null;
  readonly rawType: string;
}

export interface CodexPatchApplyBeginEvent {
  readonly kind: "patch_apply_begin";
  readonly callId: string;
  readonly turnId: string | null;
  readonly changedPaths: readonly string[];
  readonly rawType: string;
}

export interface CodexTurnCompletedEvent {
  readonly kind: "turn_completed";
  readonly usage: CodexUsage | null;
  readonly rawType: string;
}

export interface CodexRawJsonEvent {
  readonly kind: "raw_json";
  readonly rawType: string;
  readonly payload: Record<string, unknown>;
}

export interface CodexRawStdoutEvent {
  readonly kind: "raw_stdout";
  readonly text: string;
}

export interface CodexStderrEvent {
  readonly kind: "stderr";
  readonly text: string;
}

export type CodexNormalizedEvent =
  | CodexThreadStartedEvent
  | CodexTurnStartedEvent
  | CodexAgentMessageEvent
  | CodexApprovalRequestEvent
  | CodexExecCommandBeginEvent
  | CodexExecCommandEndEvent
  | CodexPatchApplyBeginEvent
  | CodexTurnCompletedEvent
  | CodexRawJsonEvent
  | CodexRawStdoutEvent
  | CodexStderrEvent;

export interface CodexStartRunOptions {
  readonly executablePath?: string;
  readonly prompt: string;
  readonly runtimeContext: CodexRuntimeContext;
  readonly images?: readonly string[];
  readonly resumeThreadId?: string | null;
  readonly rollingSummary?: string | null;
  readonly skipGitRepoCheck?: boolean;
  readonly onEvent?: (event: CodexNormalizedEvent) => void;
}

export interface CodexCancelOutcome {
  readonly requestedAt: string;
  readonly result: CodexCancellationResult;
  readonly exited: boolean;
}

export interface CodexRunResult {
  readonly threadId: string | null;
  readonly finalMessage: string | null;
  readonly exitCode: number | null;
  readonly startedFresh: boolean;
  readonly staleRecovered: boolean;
  readonly usedSummarySeed: boolean;
  readonly cancelOutcome: CodexCancelOutcome | null;
  readonly events: readonly CodexNormalizedEvent[];
}

export interface CodexRunController {
  readonly completion: Promise<CodexRunResult>;
  cancel(): Promise<CodexCancelOutcome>;
}
