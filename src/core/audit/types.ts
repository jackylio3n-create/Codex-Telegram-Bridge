import type { SessionCancellationResult } from "../../store/types.js";

export interface AuditActorContext {
  readonly sessionId?: string | null;
  readonly chatId?: string | null;
  readonly runId?: string | null;
}

export interface UserInputAuditPayload {
  readonly contentType: "text" | "image";
  readonly preview: string;
  readonly viaDocument?: boolean;
}

export interface UserCommandAuditPayload {
  readonly command: string;
  readonly args?: readonly string[];
  readonly status?: string;
}

export interface ApprovalDecisionAuditPayload {
  readonly permissionId: string;
  readonly decision: "approve" | "deny";
  readonly resolutionStatus: string;
}

export interface AgentTextAuditPayload {
  readonly preview: string;
  readonly messageLength: number;
}

export interface ToolStartAuditPayload {
  readonly toolName: string;
  readonly summary?: string;
  readonly permissionId?: string;
}

export interface ToolResultAuditPayload {
  readonly toolName: string;
  readonly status: "success" | "error";
  readonly detail?: string;
}

export interface FileChangeAuditPayload {
  readonly changeType: "cwd" | "adddir" | "workspace_root";
  readonly previousPath?: string | null;
  readonly nextPath: string;
}

export interface ShellExecAuditPayload {
  readonly commandPreview: string;
  readonly exitCode: number | null;
}

export interface SessionRebindAuditPayload {
  readonly previousSessionId: string | null;
  readonly nextSessionId: string;
  readonly reason: "bind" | "new";
}

export interface RunCancelAuditPayload {
  readonly phase: "requested" | "completed";
  readonly cancellationResult?: SessionCancellationResult | null;
}

export interface ResumeRecoveryAuditPayload {
  readonly previousThreadId: string | null;
  readonly nextThreadId: string | null;
  readonly usedSummarySeed: boolean;
  readonly reason: string;
}
