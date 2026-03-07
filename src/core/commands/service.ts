import { randomUUID } from "node:crypto";
import { ApprovalService } from "../approval/index.js";
import { isSessionStateActiveForCommandGate } from "../session/index.js";
import type {
  CommandRejectedEffect,
  NormalizedApprovalDecision,
  NormalizedCommandRequest,
  NormalizedOutboundMessage,
  SessionActorSnapshot
} from "../types/index.js";
import {
  applyCwdChange,
  initializeNewSessionWorkspace,
  prepareAddDirConfirmation,
  type WorkspaceMutationOptions,
  type WorkspaceSessionState
} from "../workspace/index.js";
import type { InMemoryRoutingCore } from "../router/index.js";
import type { BridgeStore, ChatBindingRecord, PendingPermissionRecord, SessionRecord, SessionUpsertInput } from "../../store/types.js";
import type {
  AddDirCommandData,
  BindCommandData,
  CommandExecutionResult,
  CommandSessionView,
  CommandsServiceOptions,
  NewCommandData,
  PermCommandData,
  SessionsCommandData,
  StatusCommandData
} from "./types.js";

const ACTIVE_COMMAND_BLOCKLIST = new Set<NormalizedCommandRequest["command"]>([
  "bind",
  "new",
  "cwd",
  "mode",
  "adddir"
]);

type CommandsStore = Pick<BridgeStore, "sessions" | "chatBindings" | "pendingPermissions">;

interface ChatSessionContext {
  readonly binding: ChatBindingRecord | null;
  readonly session: SessionRecord | null;
  readonly actorSnapshot: SessionActorSnapshot | null;
}

type BoundSessionResolution<TData> =
  | {
      readonly ok: true;
      readonly context: {
        readonly binding: ChatBindingRecord;
        readonly session: SessionRecord;
        readonly actorSnapshot: SessionActorSnapshot | null;
      };
    }
  | {
      readonly ok: false;
      readonly result: CommandExecutionResult<TData>;
    };

export class CommandsService {
  readonly #store: CommandsStore;
  readonly #routing: InMemoryRoutingCore;
  readonly #approval: ApprovalService;
  readonly #defaultWorkspaceRoot: string;
  readonly #workspaceMutationOptions: WorkspaceMutationOptions;
  readonly #sessionIdFactory: () => string;

  constructor(
    store: CommandsStore,
    routing: InMemoryRoutingCore,
    approval: ApprovalService,
    options: CommandsServiceOptions
  ) {
    this.#store = store;
    this.#routing = routing;
    this.#approval = approval;
    this.#defaultWorkspaceRoot = options.defaultWorkspaceRoot;
    this.#workspaceMutationOptions = options.workspaceMutationOptions ?? {};
    this.#sessionIdFactory = options.sessionIdFactory ?? randomUUID;
  }

  async dispatch(command: NormalizedCommandRequest): Promise<CommandExecutionResult> {
    switch (command.command) {
      case "start":
        return this.#executeStart();
      case "help":
        return this.#executeHelp();
      case "status":
        return this.#executeStatus(command.envelope.chatId);
      case "sessions":
        return this.#executeSessions(command.envelope.chatId);
      case "new":
        return this.#executeNew(command);
      case "bind":
        return this.#executeBind(command);
      case "cwd":
        return this.#executeCwd(command as NormalizedCommandRequest & { readonly command: "cwd"; readonly path: string });
      case "adddir":
        return this.#executeAddDir(command as NormalizedCommandRequest & { readonly command: "adddir"; readonly path: string });
      case "mode":
        return this.#executeMode(command);
      case "stop":
        return this.#executeStop(command);
      case "perm":
        return this.#executePerm(command);
    }
  }

  async #executeStart(): Promise<CommandExecutionResult> {
    return {
      command: "start",
      status: "ok",
      message: "Codex + Telegram Bridge V1 is available. Use /new to create a session or /help to see commands."
    };
  }

  async #executeHelp(): Promise<CommandExecutionResult> {
    return {
      command: "help",
      status: "ok",
      message: [
        "Available commands:",
        "/new [cwd]",
        "/sessions",
        "/bind <session_id>",
        "/cwd <absolute_path>",
        "/adddir <absolute_path>",
        "/mode <ask|plan|code>",
        "/status",
        "/stop",
        "/perm [approve|deny <permission_id>]",
        "/help"
      ].join("\n")
    };
  }

  async #executeStatus(chatId: string): Promise<CommandExecutionResult<StatusCommandData>> {
    const context = this.#getChatSessionContext(chatId);
    const pendingApprovals = context.session
      ? this.#approval.listPendingPermissionsForSession(context.session.sessionId)
      : [];

    return {
      command: "status",
      status: "ok",
      message: context.binding && context.session
        ? `Bound to ${context.session.sessionId} (${context.actorSnapshot?.runState ?? context.session.runState}).`
        : "No session is currently bound.",
      data: {
        status: {
          binding: context.binding,
          session: context.session,
          actorSnapshot: context.actorSnapshot,
          pendingApprovals
        }
      }
    };
  }

  async #executeSessions(chatId: string): Promise<CommandExecutionResult<SessionsCommandData>> {
    const currentBinding = this.#store.chatBindings.get(chatId);
    const sessions = this.#store.sessions.listOverview().map((session): CommandSessionView => ({
      session,
      actorSnapshot: this.#routing.getSessionSnapshot(session.sessionId),
      isCurrentBinding: currentBinding?.sessionId === session.sessionId
    }));

    return {
      command: "sessions",
      status: "ok",
      message: sessions.length === 0
        ? "No sessions have been created yet."
        : sessions
            .map((entry) => {
              const prefix = entry.isCurrentBinding ? "* " : "- ";
              const state = entry.actorSnapshot?.runState ?? entry.session.runState;
              return `${prefix}${entry.session.sessionId} | ${entry.session.mode} | ${entry.session.cwd} | ${state}`;
            })
            .join("\n"),
      data: {
        sessions
      }
    };
  }

  async #executeNew(
    command: Extract<NormalizedCommandRequest, { readonly command: "new" }>
  ): Promise<CommandExecutionResult<NewCommandData>> {
    const activeRejection = this.#rejectIfActive<NewCommandData>(command.command, command.envelope.chatId);
    if (activeRejection) {
      return activeRejection;
    }

    const currentContext = this.#getChatSessionContext(command.envelope.chatId);
    const workspace = await initializeNewSessionWorkspace(
      {
        defaultWorkspaceRoot: this.#defaultWorkspaceRoot,
        currentBoundSession: currentContext.session
          ? { workspaceRoot: currentContext.session.workspaceRoot }
          : null,
        ...(command.requestedCwd ? { requestedCwd: command.requestedCwd } : {})
      },
      this.#workspaceMutationOptions
    );

    if (!workspace.ok) {
      return {
        command: "new",
        status: "rejected",
        message: "Rejected /new because the requested workspace context is invalid.",
        issues: workspace.issues
      };
    }

    const sessionId = command.targetSessionId ?? this.#sessionIdFactory();
    const routed = await this.#routing.dispatch({
      ...command,
      targetSessionId: sessionId
    });
    const rejected = this.#findCommandRejection(routed.effects);
    if (rejected) {
      return {
        command: "new",
        status: "rejected",
        message: rejected.text
      };
    }

    const saved = this.#store.sessions.save(this.#toSessionUpsertInput(sessionId, workspace.session));
    this.#store.chatBindings.save({
      chatId: command.envelope.chatId,
      sessionId
    });

    return {
      command: "new",
      status: "ok",
      message: `Created and bound session ${sessionId}.`,
      session: saved,
      issues: workspace.issues,
      data: {
        sessionId,
        bindingUpdated: true
      }
    };
  }

  async #executeBind(
    command: Extract<NormalizedCommandRequest, { readonly command: "bind" }>
  ): Promise<CommandExecutionResult<BindCommandData>> {
    const activeRejection = this.#rejectIfActive<BindCommandData>(command.command, command.envelope.chatId);
    if (activeRejection) {
      return activeRejection;
    }

    const session = this.#store.sessions.get(command.targetSessionId);
    if (!session) {
      return {
        command: "bind",
        status: "rejected",
        message: `Session "${command.targetSessionId}" does not exist.`
      };
    }

    this.#routing.registerSession(command.targetSessionId, this.#buildSessionActorSnapshot(session));
    const routed = await this.#routing.dispatch(command);
    const rejected = this.#findCommandRejection(routed.effects);
    if (rejected) {
      return {
        command: "bind",
        status: "rejected",
        message: rejected.text
      };
    }

    this.#store.chatBindings.save({
      chatId: command.envelope.chatId,
      sessionId: command.targetSessionId
    });

    return {
      command: "bind",
      status: "ok",
      message: `Bound chat to ${command.targetSessionId}.`,
      data: {
        sessionId: command.targetSessionId
      }
    };
  }

  async #executeCwd(
    command: NormalizedCommandRequest & { readonly command: "cwd"; readonly path: string }
  ): Promise<CommandExecutionResult> {
    const resolved = this.#requireBoundSession(command.command, command.envelope.chatId, {
      rejectWhenActive: true
    });
    if (!resolved.ok) {
      return resolved.result;
    }
    const { session } = resolved.context;

    const result = await applyCwdChange(
      this.#toWorkspaceSession(session),
      command.path,
      this.#workspaceMutationOptions
    );
    if (!result.ok) {
      return {
        command: "cwd",
        status: "rejected",
        message: `Rejected /cwd for ${command.path}.`,
        session,
        issues: result.issues
      };
    }

    const updated = this.#store.sessions.update(session.sessionId, {
      cwd: result.session.cwd
    });
    return {
      command: "cwd",
      status: "ok",
      message: `Updated cwd to ${result.session.cwd}.`,
      session: updated,
      issues: result.issues
    };
  }

  async #executeAddDir(
    command: NormalizedCommandRequest & { readonly command: "adddir"; readonly path: string }
  ): Promise<CommandExecutionResult<AddDirCommandData>> {
    const resolved = this.#requireBoundSession<AddDirCommandData>(command.command, command.envelope.chatId, {
      rejectWhenActive: true
    });
    if (!resolved.ok) {
      return resolved.result;
    }
    const { session } = resolved.context;

    const requested = await prepareAddDirConfirmation(
      this.#toWorkspaceSession(session),
      command.path,
      this.#workspaceMutationOptions
    );
    if (!requested.ok || !requested.confirmation) {
      return {
        command: "adddir",
        status: "rejected",
        message: `Rejected /adddir for ${command.path}.`,
        issues: requested.issues
      };
    }

    return {
      command: "adddir",
      status: "confirmation_required",
      message: requested.confirmation.summary,
      session,
      issues: requested.issues,
      data: {
        confirmation: requested.confirmation
      }
    };
  }

  async #executeMode(
    command: Extract<NormalizedCommandRequest, { readonly command: "mode" }>
  ): Promise<CommandExecutionResult> {
    const resolved = this.#requireBoundSession(command.command, command.envelope.chatId, {
      rejectWhenActive: true
    });
    if (!resolved.ok) {
      return resolved.result;
    }
    const { session } = resolved.context;

    const updated = this.#store.sessions.update(session.sessionId, {
      mode: command.mode
    });

    return {
      command: "mode",
      status: "ok",
      message: `Updated mode to ${command.mode}.`,
      session: updated
    };
  }

  async #executeStop(
    command: Extract<NormalizedCommandRequest, { readonly command: "stop" }>
  ): Promise<CommandExecutionResult> {
    this.#getChatSessionContext(command.envelope.chatId);
    const routed = await this.#routing.dispatch(command);
    const rejected = this.#findCommandRejection(routed.effects);
    if (rejected) {
      return {
        command: "stop",
        status: "rejected",
        message: rejected.text
      };
    }

    const context = this.#getChatSessionContext(command.envelope.chatId);

    return {
      command: "stop",
      status: "ok",
      message: "Cancellation requested for the currently bound session.",
      ...(context.session ? { session: context.session } : {})
    };
  }

  async #executePerm(
    command: Extract<NormalizedCommandRequest, { readonly command: "perm" }>
  ): Promise<CommandExecutionResult<PermCommandData>> {
    const parsed = this.#approval.parsePermCommand(command.args);
    if (parsed.kind === "invalid") {
      return {
        command: "perm",
        status: "rejected",
        message: parsed.message
      };
    }

    if (parsed.kind === "list") {
      const resolved = this.#requireBoundSession<PermCommandData>(command.command, command.envelope.chatId);
      if (!resolved.ok) {
        return resolved.result;
      }

      return {
        command: "perm",
        status: "ok",
        message: this.#approval.formatPermFallbackText(resolved.context.session.sessionId)
      };
    }

    const permission = this.#store.pendingPermissions.get(parsed.request.permissionId);
    if (!permission) {
      return {
        command: "perm",
        status: "rejected",
        message: "Expired or already handled."
      };
    }

    const resolution = this.#approval.resolveDecision({
      permissionId: permission.permissionId,
      decision: parsed.request.decision,
      chatId: command.envelope.chatId,
      userId: command.envelope.userId,
      sessionSnapshot: this.#ensureRoutingSessionSnapshot(permission.sessionId)
    });

    if (resolution.status === "approved" || resolution.status === "denied") {
      const inboundDecision: NormalizedApprovalDecision = {
        type: "approval_decision",
        sessionId: permission.sessionId,
        runId: permission.runId,
        permissionId: permission.permissionId,
        decision: parsed.request.decision,
        callbackQueryId: `perm:${permission.permissionId}`,
        envelope: {
          chatId: command.envelope.chatId,
          userId: command.envelope.userId,
          receivedAt: command.envelope.receivedAt,
          ...(command.envelope.messageId ? { messageId: command.envelope.messageId } : {})
        }
      };
      await this.#routing.dispatch(inboundDecision);
    }

    return {
      command: "perm",
      status: resolution.status === "approved" || resolution.status === "denied" ? "ok" : "rejected",
      message: resolution.message,
      data: {
        approvalResult: resolution
      }
    };
  }

  #rejectIfActive<TData>(
    command: NormalizedCommandRequest["command"],
    chatId: string
  ): CommandExecutionResult<TData> | null {
    if (!ACTIVE_COMMAND_BLOCKLIST.has(command)) {
      return null;
    }

    const context = this.#getChatSessionContext(chatId);
    if (!context.binding) {
      return null;
    }

    if (!context.actorSnapshot) {
      return null;
    }

    if (!isSessionStateActiveForCommandGate(context.actorSnapshot.runState)) {
      return null;
    }

    return {
      command,
      status: "rejected",
      message: `/${command} is blocked while the current bound session is active.`
    };
  }

  #requireBoundSession<TData>(
    command: NormalizedCommandRequest["command"],
    chatId: string,
    options: {
      readonly rejectWhenActive?: boolean;
    } = {}
  ): BoundSessionResolution<TData> {
    const context = this.#getChatSessionContext(chatId);
    if (!context.binding || !context.session) {
      return {
        ok: false,
        result: this.#missingBindingResult<TData>(command)
      };
    }

    if (options.rejectWhenActive && context.actorSnapshot && isSessionStateActiveForCommandGate(context.actorSnapshot.runState)) {
      return {
        ok: false,
        result: {
          command,
          status: "rejected",
          message: `/${command} is blocked while the current bound session is active.`
        }
      };
    }

    return {
      ok: true,
      context: {
        binding: context.binding,
        session: context.session,
        actorSnapshot: context.actorSnapshot
      }
    };
  }

  #findCommandRejection(effects: readonly NormalizedOutboundMessage[]): CommandRejectedEffect | null {
    return effects.find(isCommandRejectedEffect) ?? null;
  }

  #missingBindingResult<TData>(command: NormalizedCommandRequest["command"]): CommandExecutionResult<TData> {
    return {
      command,
      status: "rejected",
      message: `/${command} requires a bound session.`
    };
  }

  #getChatSessionContext(chatId: string): ChatSessionContext {
    const binding = this.#store.chatBindings.get(chatId);
    const session = binding ? this.#store.sessions.get(binding.sessionId) : null;
    const actorSnapshot = binding && session
      ? this.#ensureRoutingSnapshotForBinding(binding, session)
      : null;

    return {
      binding,
      session,
      actorSnapshot
    };
  }

  #ensureRoutingSnapshotForBinding(
    binding: ChatBindingRecord,
    session: SessionRecord
  ): SessionActorSnapshot {
    const actorSnapshot = this.#ensureRoutingSessionSnapshot(session.sessionId, session);
    if (!actorSnapshot) {
      throw new Error(`Failed to hydrate routing snapshot for session ${session.sessionId}.`);
    }

    this.#syncRoutingBinding(binding.chatId, session.sessionId);
    return actorSnapshot;
  }

  #ensureRoutingSessionSnapshot(
    sessionId: string,
    session = this.#store.sessions.get(sessionId)
  ): SessionActorSnapshot | null {
    const existingSnapshot = this.#routing.getSessionSnapshot(sessionId);
    if (existingSnapshot) {
      return existingSnapshot;
    }

    if (!session) {
      return null;
    }

    return this.#routing.registerSession(sessionId, this.#buildSessionActorSnapshot(session));
  }

  #syncRoutingBinding(chatId: string, sessionId: string): void {
    if (this.#routing.getChatBinding(chatId).sessionId === sessionId) {
      return;
    }

    this.#routing.bindChat(chatId, sessionId);
  }

  #buildSessionActorSnapshot(session: SessionRecord): SessionActorSnapshot {
    const currentRunId = this.#getPersistedCurrentRunId(session);
    const waitingPermissionId = session.runState === "waiting_approval" && currentRunId
      ? this.#store.pendingPermissions.list({
          sessionId: session.sessionId,
          runId: currentRunId,
          resolved: false,
          limit: 1
        })[0]?.permissionId ?? null
      : null;

    return {
      sessionId: session.sessionId,
      runState: session.runState,
      currentRunId,
      waitingPermissionId,
      cancellationResult: session.cancellationResult,
      queuedEventCount: 0,
      processedEventCount: 0,
      lastEventAt: session.updatedAt
    };
  }

  #getPersistedCurrentRunId(session: SessionRecord): string | null {
    return isSessionStateActiveForCommandGate(session.runState)
      ? session.activeRunId
      : null;
  }

  #toWorkspaceSession(session: SessionRecord): WorkspaceSessionState {
    return {
      workspaceRoot: session.workspaceRoot,
      extraAllowedDirs: session.extraAllowedDirs,
      cwd: session.cwd,
      mode: session.mode
    };
  }

  #toSessionUpsertInput(sessionId: string, session: WorkspaceSessionState): SessionUpsertInput {
    return {
      sessionId,
      workspaceRoot: session.workspaceRoot,
      extraAllowedDirs: session.extraAllowedDirs,
      cwd: session.cwd,
      mode: session.mode
    };
  }
}

export function createChatBindingRecord(chatId: string, sessionId: string, updatedAt: string): ChatBindingRecord {
  return {
    chatId,
    sessionId,
    updatedAt
  };
}

function isCommandRejectedEffect(effect: NormalizedOutboundMessage): effect is CommandRejectedEffect {
  return effect.type === "command_rejected";
}
