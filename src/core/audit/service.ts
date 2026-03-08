import type { AuditLogRecord, AuditLogsRepository } from "../../store/types.js";
import type {
  AgentTextAuditPayload,
  ApprovalDecisionAuditPayload,
  AuditActorContext,
  FileChangeAuditPayload,
  ResumeRecoveryAuditPayload,
  RunCancelAuditPayload,
  SessionRebindAuditPayload,
  ShellExecAuditPayload,
  ToolResultAuditPayload,
  ToolStartAuditPayload,
  UserCommandAuditPayload,
  UserInputAuditPayload
} from "./types.js";

export interface AuditServiceOptions {
  readonly clock?: () => Date;
}

export class AuditService {
  readonly #auditLogs: AuditLogsRepository;
  readonly #clock: () => Date;

  constructor(
    auditLogs: AuditLogsRepository,
    options: AuditServiceOptions = {}
  ) {
    this.#auditLogs = auditLogs;
    this.#clock = options.clock ?? (() => new Date());
  }

  recordUserInput(
    context: AuditActorContext,
    payload: UserInputAuditPayload
  ): AuditLogRecord<UserInputAuditPayload> {
    return this.#append("user_input", context, payload);
  }

  recordUserCommand(
    context: AuditActorContext,
    payload: UserCommandAuditPayload
  ): AuditLogRecord<UserCommandAuditPayload> {
    return this.#append("user_command", context, payload);
  }

  recordApprovalDecision(
    context: AuditActorContext,
    payload: ApprovalDecisionAuditPayload
  ): AuditLogRecord<ApprovalDecisionAuditPayload> {
    return this.#append("approval_decision", context, payload);
  }

  recordAgentText(
    context: AuditActorContext,
    payload: AgentTextAuditPayload
  ): AuditLogRecord<AgentTextAuditPayload> {
    return this.#append("agent_text", context, payload);
  }

  recordToolStart(
    context: AuditActorContext,
    payload: ToolStartAuditPayload
  ): AuditLogRecord<ToolStartAuditPayload> {
    return this.#append("tool_start", context, payload);
  }

  recordToolResult(
    context: AuditActorContext,
    payload: ToolResultAuditPayload
  ): AuditLogRecord<ToolResultAuditPayload> {
    return this.#append("tool_result", context, payload);
  }

  recordFileChange(
    context: AuditActorContext,
    payload: FileChangeAuditPayload
  ): AuditLogRecord<FileChangeAuditPayload> {
    return this.#append("file_change", context, payload);
  }

  recordShellExec(
    context: AuditActorContext,
    payload: ShellExecAuditPayload
  ): AuditLogRecord<ShellExecAuditPayload> {
    return this.#append("shell_exec", context, payload);
  }

  recordSessionRebind(
    context: AuditActorContext,
    payload: SessionRebindAuditPayload
  ): AuditLogRecord<SessionRebindAuditPayload> {
    return this.#append("session_rebind", context, payload);
  }

  recordRunCancel(
    context: AuditActorContext,
    payload: RunCancelAuditPayload
  ): AuditLogRecord<RunCancelAuditPayload> {
    return this.#append("run_cancel", context, payload);
  }

  recordResumeRecovery(
    context: AuditActorContext,
    payload: ResumeRecoveryAuditPayload
  ): AuditLogRecord<ResumeRecoveryAuditPayload> {
    return this.#append("resume_recovery", context, payload);
  }

  listRecentSessionEvents(
    sessionId: string,
    limit = 20
  ): readonly AuditLogRecord[] {
    return this.#auditLogs.list({
      sessionId,
      limit
    });
  }

  #append<TPayload>(
    eventType: string,
    context: AuditActorContext,
    payload: TPayload
  ): AuditLogRecord<TPayload> {
    return this.#auditLogs.append({
      sessionId: context.sessionId ?? null,
      chatId: context.chatId ?? null,
      runId: context.runId ?? null,
      eventType,
      payload,
      createdAt: this.#clock().toISOString()
    });
  }
}
