import { SessionActor } from "../session/index.js";
import type {
  ApprovalResolvedEvent,
  BoundCommandRequest,
  CancelRequestedEvent,
  ChatBindingSnapshot,
  CommandRejectedEffect,
  NewCommandRequest,
  NormalizedCommandRequest,
  NormalizedInboundMessage,
  NormalizedOutboundMessage,
  RoutingCoreOptions,
  RoutingDispatchResult,
  SessionActorDispatchResult,
  SessionActorSnapshot
} from "../types/index.js";
import { ChatGate } from "./chat-gate.js";

const ACTIVE_SESSION_ALLOWED_COMMANDS = new Set<NormalizedCommandRequest["command"]>(["help", "status", "stop"]);

export class InMemoryRoutingCore {
  private readonly actors = new Map<string, SessionActor>();
  private readonly chatGate = new ChatGate();
  private sessionCounter = 0;
  private readonly sessionIdFactory: () => string;

  public constructor(options: RoutingCoreOptions = {}) {
    this.sessionIdFactory = options.sessionIdFactory ?? (() => {
      this.sessionCounter += 1;
      return `session-${this.sessionCounter}`;
    });
  }

  public registerSession(sessionId: string, snapshot?: SessionActorSnapshot): SessionActorSnapshot {
    const actor = this.ensureActor(sessionId, snapshot);
    return actor.getSnapshot();
  }

  public bindChat(chatId: string, sessionId: string): ChatBindingSnapshot {
    return this.chatGate.hydrateBinding(chatId, sessionId);
  }

  public getSessionActor(sessionId: string): SessionActor | null {
    return this.actors.get(sessionId) ?? null;
  }

  public deleteSession(sessionId: string): boolean {
    const deleted = this.actors.delete(sessionId);
    this.chatGate.deleteBindingsForSession(sessionId);
    return deleted;
  }

  public getChatBinding(chatId: string): ChatBindingSnapshot {
    return this.chatGate.getBinding(chatId);
  }

  public getSessionSnapshot(sessionId: string): SessionActorSnapshot | null {
    return this.actors.get(sessionId)?.getSnapshot() ?? null;
  }

  public async dispatch(message: NormalizedInboundMessage): Promise<RoutingDispatchResult> {
    switch (message.type) {
      case "user_input":
        return this.routeUserInput(message);
      case "approval_decision":
        return this.routeApprovalDecision(message);
      case "command":
        return this.routeCommand(message);
    }
  }

  private async routeCommand(command: NormalizedCommandRequest): Promise<RoutingDispatchResult> {
    switch (command.command) {
      case "bind":
        return this.handleBindCommand(
          {
            chatId: command.envelope.chatId,
            targetSessionId: command.targetSessionId,
            command
          },
        );
      case "new":
        return this.handleNewCommand(command);
      case "stop":
        return this.routeStopCommand(command);
      case "prune":
      case "reasoning":
        return {
          binding: this.chatGate.getBinding(command.envelope.chatId),
          sessionSnapshot: null,
          effects: []
        };
      default:
        return this.routeBoundCommand(command);
    }
  }

  private async handleNewCommand(command: NewCommandRequest): Promise<RoutingDispatchResult> {
    const targetSessionId = command.targetSessionId ?? this.sessionIdFactory();
    const gateResult = await this.chatGate.createAndBindSession(
      {
        chatId: command.envelope.chatId,
        targetSessionId,
        command
      },
      this.actors
    );

    if (hasCommandRejection(gateResult.effects)) {
      return gateResult;
    }

    const actor = this.actors.get(targetSessionId);
    if (!actor) {
      return gateResult;
    }

    const createdResult = await actor.enqueue({
      kind: "session_created",
      chatId: command.envelope.chatId,
      sessionId: targetSessionId,
      createdAt: command.envelope.receivedAt
    });

    return mergeResults(gateResult.binding, createdResult, gateResult.effects);
  }

  private async handleBindCommand(
    request: {
      readonly chatId: string;
      readonly targetSessionId: string;
      readonly command: Extract<NormalizedCommandRequest, { readonly command: "bind" }>;
    }
  ): Promise<RoutingDispatchResult> {
    const gateResult = await this.chatGate.bindExistingSession(request, this.actors);
    if (hasCommandRejection(gateResult.effects)) {
      return gateResult;
    }

    const actor = this.actors.get(request.targetSessionId);
    if (!actor) {
      return gateResult;
    }

    const boundResult = await actor.enqueue({
      kind: "session_bound",
      chatId: request.chatId,
      sessionId: request.targetSessionId,
      boundAt: request.command.envelope.receivedAt
    });

    return mergeResults(gateResult.binding, boundResult, gateResult.effects);
  }

  private async routeUserInput(
    message: Extract<NormalizedInboundMessage, { readonly type: "user_input" }>
  ): Promise<RoutingDispatchResult> {
    const actor = this.resolveBoundActor(message.envelope.chatId);
    if (!actor) {
      return rejectMissingBinding(message.envelope.chatId, "No session is currently bound for user input.");
    }

    const dispatchResult = await actor.enqueue({
      kind: "user_input_received",
      input: message
    });

    return mergeResults(this.chatGate.getBinding(message.envelope.chatId), dispatchResult);
  }

  private async routeBoundCommand(command: BoundCommandRequest): Promise<RoutingDispatchResult> {
    const binding = this.chatGate.getBinding(command.envelope.chatId);
    if (!binding.sessionId) {
      return rejectMissingBinding(command.envelope.chatId, `/${command.command} requires a bound session.`, command.command);
    }

    const actor = this.actors.get(binding.sessionId);
    if (!actor) {
      return rejectMissingSession(command.envelope.chatId, binding.sessionId, command.command);
    }

    if (actor.isActiveForCommandGate() && !ACTIVE_SESSION_ALLOWED_COMMANDS.has(command.command)) {
      return rejectActiveBoundCommand(command.envelope.chatId, binding.sessionId, command.command);
    }

    const dispatchResult = await actor.enqueue({
      kind: "command_received",
      command
    });

    return mergeResults(binding, dispatchResult);
  }

  private async routeStopCommand(
    command: Extract<NormalizedCommandRequest, { readonly command: "stop" }>
  ): Promise<RoutingDispatchResult> {
    const binding = this.chatGate.getBinding(command.envelope.chatId);
    if (!binding.sessionId) {
      return rejectMissingBinding(command.envelope.chatId, "/stop requires a bound session.", command.command);
    }

    const actor = this.actors.get(binding.sessionId);
    if (!actor) {
      return rejectMissingSession(command.envelope.chatId, binding.sessionId, command.command);
    }

    const cancelEvent: CancelRequestedEvent = {
      kind: "cancel_requested",
      requestedAt: command.envelope.receivedAt
    };
    const dispatchResult = await actor.enqueue(cancelEvent);
    return mergeResults(binding, dispatchResult);
  }

  private async routeApprovalDecision(
    decision: Extract<NormalizedInboundMessage, { readonly type: "approval_decision" }>
  ): Promise<RoutingDispatchResult> {
    const actor = this.actors.get(decision.sessionId);
    if (!actor) {
      return {
        binding: this.chatGate.getBinding(decision.envelope.chatId),
        sessionSnapshot: null,
        effects: [
          {
            type: "command_rejected",
            chatId: decision.envelope.chatId,
            command: "perm",
            reason: "approval_session_missing",
            text: "Approval decision references an unknown session.",
            sessionId: decision.sessionId
          }
        ]
      };
    }

    const approvalEvent: ApprovalResolvedEvent = {
      kind: "approval_resolved",
      runId: decision.runId,
      permissionId: decision.permissionId,
      decision: decision.decision,
      resolvedAt: decision.envelope.receivedAt
    };
    const dispatchResult = await actor.enqueue(approvalEvent);

    return mergeResults(this.chatGate.getBinding(decision.envelope.chatId), dispatchResult);
  }

  private ensureActor(sessionId: string, snapshot?: SessionActorSnapshot): SessionActor {
    let actor = this.actors.get(sessionId);
    if (!actor) {
      actor = new SessionActor(sessionId, snapshot);
      this.actors.set(sessionId, actor);
    }
    return actor;
  }

  private resolveBoundActor(chatId: string): SessionActor | null {
    const binding = this.chatGate.getBinding(chatId);
    return binding.sessionId ? this.actors.get(binding.sessionId) ?? null : null;
  }
}

function mergeResults(
  binding: ChatBindingSnapshot,
  sessionResult: SessionActorDispatchResult,
  prefixEffects: readonly NormalizedOutboundMessage[] = []
): RoutingDispatchResult {
  return {
    binding,
    sessionSnapshot: sessionResult.snapshot,
    effects: [...prefixEffects, ...sessionResult.effects]
  };
}

function rejectMissingBinding(
  chatId: string,
  text: string,
  command?: NormalizedCommandRequest["command"]
): RoutingDispatchResult {
  const effects: NormalizedOutboundMessage[] = [];

  if (command) {
    const rejected: CommandRejectedEffect = {
      type: "command_rejected",
      chatId,
      command,
      reason: "missing_binding",
      text
    };
    effects.push(rejected);
  } else {
    effects.push({
      type: "chat_feedback",
      chatId,
      severity: "warning",
      text
    });
  }

  return {
    binding: {
      chatId,
      sessionId: null
    },
    sessionSnapshot: null,
    effects
  };
}

function rejectMissingSession(
  chatId: string,
  sessionId: string,
  command: NormalizedCommandRequest["command"]
): RoutingDispatchResult {
  return {
    binding: {
      chatId,
      sessionId
    },
    sessionSnapshot: null,
    effects: [
      {
        type: "command_rejected",
        chatId,
        command,
        reason: "missing_session",
        text: `Session "${sessionId}" does not exist.`,
        sessionId
      }
    ]
  };
}

function rejectActiveBoundCommand(
  chatId: string,
  sessionId: string,
  command: NormalizedCommandRequest["command"]
): RoutingDispatchResult {
  return {
    binding: {
      chatId,
      sessionId
    },
    sessionSnapshot: null,
    effects: [
      {
        type: "command_rejected",
        chatId,
        command,
        reason: "active_session_blocked",
        text: `/${command} is blocked while the current bound session is active.`,
        sessionId
      }
    ]
  };
}

function hasCommandRejection(effects: readonly NormalizedOutboundMessage[]): boolean {
  return effects.some(isCommandRejectedEffect);
}

function isCommandRejectedEffect(effect: NormalizedOutboundMessage): effect is CommandRejectedEffect {
  return effect.type === "command_rejected";
}
