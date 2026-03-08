import { randomUUID } from "node:crypto";
import type { PromptLanguage } from "../../i18n.js";
import { selectText } from "../../i18n.js";
import { ApprovalService } from "../approval/index.js";
import {
  buildPersistedSessionActorSnapshot,
  isSessionStateActiveForCommandGate,
  toWorkspaceSessionState
} from "../session/index.js";
import type {
  CommandRejectedEffect,
  NormalizedApprovalDecision,
  NormalizedCommandRequest,
  NormalizedOutboundMessage,
  SessionActorSnapshot
} from "../types/index.js";
import {
  applyAccessScopeChange,
  applyCwdChange,
  initializeNewSessionWorkspace,
  prepareAddDirConfirmation,
  type SessionAccessScope,
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
  PruneCommandData,
  ReasoningCommandData,
  ScopeCommandData,
  SessionsCommandData,
  StatusCommandData
} from "./types.js";

const ACTIVE_COMMAND_BLOCKLIST = new Set<NormalizedCommandRequest["command"]>([
  "bind",
  "new",
  "cwd",
  "mode",
  "adddir",
  "scope"
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
  readonly #statusTextProvider: (() => Promise<string> | string) | null;
  readonly #reasoningConfigService: CommandsServiceOptions["reasoningConfigService"] | null;
  readonly #languageResolver: (userId: string) => PromptLanguage;

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
    this.#statusTextProvider = options.statusTextProvider ?? null;
    this.#reasoningConfigService = options.reasoningConfigService ?? null;
    this.#languageResolver = options.languageResolver ?? (() => "en");
  }

  async dispatch(command: NormalizedCommandRequest): Promise<CommandExecutionResult> {
    switch (command.command) {
      case "start":
        return this.#executeStart(command.envelope.userId);
      case "help":
        return this.#executeHelp(command.envelope.userId);
      case "status":
        return this.#executeStatus(command.envelope.chatId, command.envelope.userId);
      case "sessions":
        return this.#executeSessions(command.envelope.chatId, command.envelope.userId);
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
      case "prune":
        return this.#executePrune(command);
      case "reasoning":
        return this.#executeReasoning(command);
      case "scope":
        return this.#executeScope(command);
    }
  }

  async #executeStart(userId: string): Promise<CommandExecutionResult> {
    return {
      command: "start",
      status: "ok",
      message: this.#t(
        userId,
        "Codex + Telegram Bridge 已可用。使用 /new 创建会话，或使用 /help 查看命令。",
        "Codex + Telegram Bridge is available. Use /new to create a session or /help to see commands."
      )
    };
  }

  async #executeHelp(userId: string): Promise<CommandExecutionResult> {
    return {
      command: "help",
      status: "ok",
      message: this.#t(
        userId,
        [
          "可用命令：",
          "/new [cwd] - 创建并绑定一个新 session，可选设置初始 cwd。",
          "/sess - 列出所有 session，并标出当前绑定项。兼容 /sessions。",
          "/bind <session_id> - 把当前聊天绑定到已有 session。",
          "/cd <absolute_path> - 修改当前 session 的 cwd。兼容 /cwd。",
          "/allow <absolute_path> - 为当前 session 增加额外允许目录。兼容 /adddir。",
          "/mode <ask|plan|code> - 切换当前 session 的运行模式。",
          "/scope [workspace|system] - 查看或切换当前 session 的访问范围。",
          "/think [minimal|low|medium|high|xhigh] - 查看或修改 Codex reasoning effort。兼容 /reasoning。",
          "/clean [keep_count] - 清理未绑定且非活动态的旧 session。兼容 /prune。",
          "/stat - 查看当前绑定 session 或 Codex 状态摘要。兼容 /status。",
          "/stop - 取消当前 session 的活动运行。",
          "/perm [approve|deny <permission_id>] - 查看或处理待审批项。",
          "/help - 显示这份命令说明。"
        ].join("\n"),
        [
          "Available commands:",
          "/new [cwd] - Create and bind a new session, optionally setting the initial cwd.",
          "/sess - List all sessions and mark the current binding. Alias: /sessions.",
          "/bind <session_id> - Bind this chat to an existing session.",
          "/cd <absolute_path> - Update the current session cwd. Alias: /cwd.",
          "/allow <absolute_path> - Add an extra allowed directory to the current session. Alias: /adddir.",
          "/mode <ask|plan|code> - Change the current session mode.",
          "/scope [workspace|system] - Show or change the current session access scope.",
          "/think [minimal|low|medium|high|xhigh] - Show or change the Codex reasoning effort. Alias: /reasoning.",
          "/clean [keep_count] - Prune old inactive unbound sessions. Alias: /prune.",
          "/stat - Show the current bound session or Codex status summary. Alias: /status.",
          "/stop - Cancel the active run for the current session.",
          "/perm [approve|deny <permission_id>] - List or resolve pending approvals.",
          "/help - Show this command reference."
        ].join("\n")
      )
    };
  }

  async #executeStatus(chatId: string, userId: string): Promise<CommandExecutionResult<StatusCommandData>> {
    if (this.#statusTextProvider) {
      return {
        command: "status",
        status: "ok",
        message: await Promise.resolve(this.#statusTextProvider())
      };
    }

    const context = this.#getChatSessionContext(chatId);
    const pendingApprovals = context.session
      ? this.#approval.listPendingPermissionsForSession(context.session.sessionId)
      : [];

    return {
      command: "status",
      status: "ok",
      message: context.binding && context.session
        ? this.#t(
            userId,
            `当前绑定到 ${context.session.sessionId}（${context.actorSnapshot?.runState ?? context.session.runState}）。`,
            `Bound to ${context.session.sessionId} (${context.actorSnapshot?.runState ?? context.session.runState}).`
          )
        : this.#t(userId, "当前没有绑定会话。", "No session is currently bound."),
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

  async #executeSessions(chatId: string, userId: string): Promise<CommandExecutionResult<SessionsCommandData>> {
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
        ? this.#t(userId, "还没有创建任何会话。", "No sessions have been created yet.")
        : sessions
            .map((entry) => {
              const prefix = entry.isCurrentBinding ? "* " : "- ";
              const state = entry.actorSnapshot?.runState ?? entry.session.runState;
              return `${prefix}${entry.session.sessionId} | ${entry.session.mode} | ${entry.session.accessScope} | ${entry.session.cwd} | ${state}`;
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
    const activeRejection = this.#rejectIfActive<NewCommandData>(command.command, command.envelope.chatId, command.envelope.userId);
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
        message: this.#t(
          command.envelope.userId,
          "已拒绝 /new：请求的工作区上下文无效。",
          "Rejected /new because the requested workspace context is invalid."
        ),
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
      message: this.#t(
        command.envelope.userId,
        `已创建并绑定会话 ${sessionId}。`,
        `Created and bound session ${sessionId}.`
      ),
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
    const activeRejection = this.#rejectIfActive<BindCommandData>(command.command, command.envelope.chatId, command.envelope.userId);
    if (activeRejection) {
      return activeRejection;
    }

    const session = this.#store.sessions.get(command.targetSessionId);
    if (!session) {
      return {
        command: "bind",
        status: "rejected",
        message: this.#t(
          command.envelope.userId,
          `会话“${command.targetSessionId}”不存在。`,
          `Session "${command.targetSessionId}" does not exist.`
        )
      };
    }

    this.#routing.registerSession(command.targetSessionId, buildPersistedSessionActorSnapshot(this.#store, session));
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
      message: this.#t(
        command.envelope.userId,
        `已将当前对话绑定到 ${command.targetSessionId}。`,
        `Bound chat to ${command.targetSessionId}.`
      ),
      data: {
        sessionId: command.targetSessionId
      }
    };
  }

  async #executeCwd(
    command: NormalizedCommandRequest & { readonly command: "cwd"; readonly path: string }
  ): Promise<CommandExecutionResult> {
    const resolved = this.#requireBoundSession(command.command, command.envelope.chatId, command.envelope.userId, {
      rejectWhenActive: true
    });
    if (!resolved.ok) {
      return resolved.result;
    }
    const { session } = resolved.context;

    const result = await applyCwdChange(
      toWorkspaceSessionState(session),
      command.path,
      this.#workspaceMutationOptions
    );
    if (!result.ok) {
      return {
        command: "cwd",
        status: "rejected",
        message: this.#t(
          command.envelope.userId,
          `已拒绝 /cwd：${command.path}。`,
          `Rejected /cwd for ${command.path}.`
        ),
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
      message: this.#t(
        command.envelope.userId,
        `已将 cwd 更新为 ${result.session.cwd}。`,
        `Updated cwd to ${result.session.cwd}.`
      ),
      session: updated,
      issues: result.issues
    };
  }

  async #executeAddDir(
    command: NormalizedCommandRequest & { readonly command: "adddir"; readonly path: string }
  ): Promise<CommandExecutionResult<AddDirCommandData>> {
    const resolved = this.#requireBoundSession<AddDirCommandData>(command.command, command.envelope.chatId, command.envelope.userId, {
      rejectWhenActive: true
    });
    if (!resolved.ok) {
      return resolved.result;
    }
    const { session } = resolved.context;

    const requested = await prepareAddDirConfirmation(
      toWorkspaceSessionState(session),
      command.path,
      this.#workspaceMutationOptions
    );
    if (!requested.ok || !requested.confirmation) {
      return {
        command: "adddir",
        status: "rejected",
        message: this.#t(
          command.envelope.userId,
          `已拒绝 /adddir：${command.path}。`,
          `Rejected /adddir for ${command.path}.`
        ),
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
    const resolved = this.#requireBoundSession(command.command, command.envelope.chatId, command.envelope.userId, {
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
      message: this.#t(
        command.envelope.userId,
        `已将模式更新为 ${command.mode}。`,
        `Updated mode to ${command.mode}.`
      ),
      session: updated
    };
  }

  async #executeScope(
    command: Extract<NormalizedCommandRequest, { readonly command: "scope" }>
  ): Promise<CommandExecutionResult<ScopeCommandData>> {
    const resolved = this.#requireBoundSession<ScopeCommandData>(command.command, command.envelope.chatId, command.envelope.userId, {
      rejectWhenActive: true
    });
    if (!resolved.ok) {
      return resolved.result;
    }
    const { session } = resolved.context;
    const parsed = parseScopeArgs(command.args, session.accessScope);
    if (!parsed.ok) {
      return {
        command: "scope",
        status: "rejected",
        message: this.#t(
          command.envelope.userId,
          "用法：/scope [workspace|system]。",
          "Usage: /scope [workspace|system]."
        )
      };
    }

    if (parsed.scope === session.accessScope) {
      return {
        command: "scope",
        status: "ok",
        message: this.#t(
          command.envelope.userId,
          `当前访问范围是 ${session.accessScope}。`,
          `Current access scope is ${session.accessScope}.`
        ),
        session,
        data: {
          currentScope: session.accessScope
        }
      };
    }

    const result = await applyAccessScopeChange(
      toWorkspaceSessionState(session),
      parsed.scope,
      this.#workspaceMutationOptions
    );
    if (!result.ok) {
      return {
        command: "scope",
        status: "rejected",
        message: this.#t(
          command.envelope.userId,
          `已拒绝 /scope ${parsed.scope}。`,
          `Rejected /scope ${parsed.scope}.`
        ),
        session,
        issues: result.issues
      };
    }

    const updated = this.#store.sessions.update(session.sessionId, {
      accessScope: result.session.accessScope,
      cwd: result.session.cwd
    });

    return {
      command: "scope",
      status: "ok",
      message: result.fallbackCwdApplied
        ? this.#t(
            command.envelope.userId,
            `已将访问范围更新为 ${parsed.scope}，cwd 已回退到 ${result.session.cwd}。`,
            `Updated access scope to ${parsed.scope}. Cwd moved back to ${result.session.cwd}.`
          )
        : this.#t(
            command.envelope.userId,
            `已将访问范围更新为 ${parsed.scope}。`,
            `Updated access scope to ${parsed.scope}.`
          ),
      session: updated,
      issues: result.issues,
      data: {
        currentScope: updated.accessScope
      }
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
      message: this.#t(
        command.envelope.userId,
        "已为当前绑定会话发起取消请求。",
        "Cancellation requested for the currently bound session."
      ),
      ...(context.session ? { session: context.session } : {})
    };
  }

  async #executePerm(
    command: Extract<NormalizedCommandRequest, { readonly command: "perm" }>
  ): Promise<CommandExecutionResult<PermCommandData>> {
    const language = this.#languageFor(command.envelope.userId);
    const parsed = this.#approval.parsePermCommand(command.args, language);
    if (parsed.kind === "invalid") {
      return {
        command: "perm",
        status: "rejected",
        message: parsed.message
      };
    }

    if (parsed.kind === "list") {
      const resolved = this.#requireBoundSession<PermCommandData>(command.command, command.envelope.chatId, command.envelope.userId);
      if (!resolved.ok) {
        return resolved.result;
      }

      return {
        command: "perm",
        status: "ok",
        message: this.#approval.formatPermFallbackText(resolved.context.session.sessionId, language)
      };
    }

    const permission = this.#store.pendingPermissions.get(parsed.request.permissionId);
    if (!permission) {
      return {
        command: "perm",
        status: "rejected",
        message: this.#t(command.envelope.userId, "已过期或已处理。", "Expired or already handled.")
      };
    }

    const resolution = this.#approval.resolveDecision({
      permissionId: permission.permissionId,
      decision: parsed.request.decision,
      chatId: command.envelope.chatId,
      userId: command.envelope.userId,
      sessionSnapshot: this.#ensureRoutingSessionSnapshot(permission.sessionId)
    }, language);

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

  async #executePrune(
    command: Extract<NormalizedCommandRequest, { readonly command: "prune" }>
  ): Promise<CommandExecutionResult<PruneCommandData>> {
    const parsedArgs = parsePruneArgs(command.args);
    if (!parsedArgs.ok) {
      return {
        command: "prune",
        status: "rejected",
        message: this.#t(
          command.envelope.userId,
          "用法：/prune [keep_count]。",
          "Usage: /prune [keep_count]."
        )
      };
    }

    const boundSessionIds = new Set(this.#store.chatBindings.list().map((binding) => binding.sessionId));
    const deletableSessions: SessionRecord[] = [];
    let skippedBoundCount = 0;
    let skippedActiveCount = 0;

    for (const session of this.#store.sessions.list()) {
      const effectiveRunState = this.#routing.getSessionSnapshot(session.sessionId)?.runState ?? session.runState;
      if (isSessionStateActiveForCommandGate(effectiveRunState)) {
        skippedActiveCount += 1;
        continue;
      }

      if (boundSessionIds.has(session.sessionId)) {
        skippedBoundCount += 1;
        continue;
      }

      deletableSessions.push(session);
    }

    const keptSessions = deletableSessions.slice(0, parsedArgs.keepCount);
    const deletedSessionIds: string[] = [];
    for (const session of deletableSessions.slice(parsedArgs.keepCount)) {
      if (!this.#store.sessions.delete(session.sessionId)) {
        continue;
      }

      this.#routing.deleteSession(session.sessionId);
      deletedSessionIds.push(session.sessionId);
    }

    const messageParts = [
      this.#t(
        command.envelope.userId,
        `已清理 ${deletedSessionIds.length} 个未绑定且非活动态的会话。`,
        `Pruned ${deletedSessionIds.length} inactive unbound ${pluralize("session", deletedSessionIds.length)}.`
      )
    ];
    if (parsedArgs.keepCount > 0) {
      messageParts.push(
        this.#t(
          command.envelope.userId,
          `保留了 ${keptSessions.length} 个最新的未绑定且非活动态会话。`,
          `Kept ${keptSessions.length} newest inactive unbound ${pluralize("session", keptSessions.length)}.`
        )
      );
    }
    if (skippedBoundCount > 0 || skippedActiveCount > 0) {
      messageParts.push(
        this.#t(
          command.envelope.userId,
          `跳过了 ${skippedBoundCount} 个已绑定会话和 ${skippedActiveCount} 个活动态会话。`,
          `Skipped ${skippedBoundCount} bound and ${skippedActiveCount} active ${pluralize("session", skippedBoundCount + skippedActiveCount)}.`
        )
      );
    }
    if (deletedSessionIds.length > 0 && deletedSessionIds.length <= 5) {
      messageParts.push(
        this.#t(
          command.envelope.userId,
          `已删除：${deletedSessionIds.join(", ")}`,
          `Deleted: ${deletedSessionIds.join(", ")}`
        )
      );
    }

    return {
      command: "prune",
      status: "ok",
      message: messageParts.join(" "),
      data: {
        keepCount: parsedArgs.keepCount,
        keptSessionIds: keptSessions.map((session) => session.sessionId),
        deletedSessionIds,
        skippedBoundCount,
        skippedActiveCount
      }
    };
  }

  async #executeReasoning(
    command: Extract<NormalizedCommandRequest, { readonly command: "reasoning" }>
  ): Promise<CommandExecutionResult<ReasoningCommandData>> {
    if (!this.#reasoningConfigService) {
      return {
        command: "reasoning",
        status: "rejected",
        message: this.#t(
          command.envelope.userId,
          "当前部署未提供 reasoning 配置功能。",
          "Reasoning configuration is not available in this deployment."
        )
      };
    }

    const supportedValues = [...this.#reasoningConfigService.supportedValues];
    const args = command.args ?? [];

    if (args.length === 0) {
      const currentEffort = await Promise.resolve(this.#reasoningConfigService.getCurrentEffort());
      return {
        command: "reasoning",
        status: "ok",
        message: [
          this.#t(
            command.envelope.userId,
            `当前 reasoning effort：${currentEffort ?? "不可用"}。`,
            `Current reasoning effort: ${currentEffort ?? "unavailable"}.`
          ),
          this.#t(
            command.envelope.userId,
            `支持的取值：${supportedValues.join(", ")}。`,
            `Supported values: ${supportedValues.join(", ")}.`
          )
        ].join("\n"),
        data: {
          currentEffort,
          supportedValues
        }
      };
    }

    if (args.length !== 1) {
      return {
        command: "reasoning",
        status: "rejected",
        message: this.#t(
          command.envelope.userId,
          `用法：/reasoning [${supportedValues.join("|")}]。`,
          `Usage: /reasoning [${supportedValues.join("|")}].`
        )
      };
    }

    const requested = args[0]?.trim().toLowerCase() ?? "";
    if (!supportedValues.includes(requested)) {
      return {
        command: "reasoning",
        status: "rejected",
        message: this.#t(
          command.envelope.userId,
          `不支持的 reasoning effort：“${args[0]}”。可用值：${supportedValues.join(", ")}。`,
          `Unsupported reasoning effort "${args[0]}". Use: ${supportedValues.join(", ")}.`
        )
      };
    }

    await Promise.resolve(this.#reasoningConfigService.setCurrentEffort(requested));

    return {
      command: "reasoning",
      status: "ok",
      message: this.#t(
        command.envelope.userId,
        `已将 reasoning effort 更新为 ${requested}。该设置会用于新的 Codex 运行。`,
        `Updated reasoning effort to ${requested}. This applies to new Codex runs.`
      ),
      data: {
        currentEffort: requested,
        supportedValues
      }
    };
  }

  #rejectIfActive<TData>(
    command: NormalizedCommandRequest["command"],
    chatId: string,
    userId: string
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
      message: this.#t(
        userId,
        `/${command} 在当前绑定会话处于活动状态时不可用。`,
        `/${command} is blocked while the current bound session is active.`
      )
    };
  }

  #requireBoundSession<TData>(
    command: NormalizedCommandRequest["command"],
    chatId: string,
    userId: string,
    options: {
      readonly rejectWhenActive?: boolean;
    } = {}
  ): BoundSessionResolution<TData> {
    const context = this.#getChatSessionContext(chatId);
    if (!context.binding || !context.session) {
      return {
        ok: false,
        result: this.#missingBindingResult<TData>(command, userId)
      };
    }

    if (options.rejectWhenActive && context.actorSnapshot && isSessionStateActiveForCommandGate(context.actorSnapshot.runState)) {
      return {
        ok: false,
        result: {
          command,
          status: "rejected",
          message: this.#t(
            userId,
            `/${command} 在当前绑定会话处于活动状态时不可用。`,
            `/${command} is blocked while the current bound session is active.`
          )
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

  #missingBindingResult<TData>(command: NormalizedCommandRequest["command"], userId: string): CommandExecutionResult<TData> {
    return {
      command,
      status: "rejected",
      message: this.#t(
        userId,
        `/${command} 需要先绑定会话。`,
        `/${command} requires a bound session.`
      )
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

    return this.#routing.registerSession(sessionId, buildPersistedSessionActorSnapshot(this.#store, session));
  }

  #syncRoutingBinding(chatId: string, sessionId: string): void {
    if (this.#routing.getChatBinding(chatId).sessionId === sessionId) {
      return;
    }

    this.#routing.bindChat(chatId, sessionId);
  }

  #toSessionUpsertInput(sessionId: string, session: WorkspaceSessionState): SessionUpsertInput {
    return {
      sessionId,
      workspaceRoot: session.workspaceRoot,
      extraAllowedDirs: session.extraAllowedDirs,
      cwd: session.cwd,
      mode: session.mode,
      accessScope: session.accessScope
    };
  }

  #languageFor(userId: string): PromptLanguage {
    return this.#languageResolver(userId);
  }

  #t(userId: string, zh: string, en: string): string {
    return selectText(this.#languageFor(userId), zh, en);
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

function parsePruneArgs(args: readonly string[] | undefined): {
  readonly ok: true;
  readonly keepCount: number;
} | {
  readonly ok: false;
} {
  if (!args || args.length === 0) {
    return {
      ok: true,
      keepCount: 0
    };
  }

  if (args.length !== 1 || !/^\d+$/.test(args[0] ?? "")) {
    return {
      ok: false
    };
  }

  const keepCount = Number.parseInt(args[0] ?? "", 10);
  if (!Number.isSafeInteger(keepCount)) {
    return {
      ok: false
    };
  }

  return {
    ok: true,
    keepCount
  };
}

function pluralize(noun: string, count: number): string {
  return count === 1 ? noun : `${noun}s`;
}

function parseScopeArgs(
  args: readonly string[] | undefined,
  currentScope: SessionAccessScope
): {
  readonly ok: true;
  readonly scope: SessionAccessScope;
} | {
  readonly ok: false;
} {
  if (!args || args.length === 0) {
    return {
      ok: true,
      scope: currentScope
    };
  }

  if (args.length !== 1) {
    return {
      ok: false
    };
  }

  const requested = args[0]?.trim().toLowerCase();
  if (requested === "workspace" || requested === "system") {
    return {
      ok: true,
      scope: requested
    };
  }

  return {
    ok: false
  };
}
