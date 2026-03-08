import { SessionActor } from "../session/index.js";
import type {
  ChatBindingChangedEffect,
  ChatBindingSnapshot,
  CommandRejectedEffect,
  NormalizedCommandRequest,
  RoutingDispatchResult
} from "../types/index.js";

export interface BindChatSessionRequest {
  readonly chatId: string;
  readonly targetSessionId: string;
  readonly command: Extract<
    NormalizedCommandRequest,
    { readonly command: "bind" }
  >;
}

export interface CreateAndBindSessionRequest {
  readonly chatId: string;
  readonly targetSessionId: string;
  readonly command: Extract<
    NormalizedCommandRequest,
    { readonly command: "new" }
  >;
}

export class ChatGate {
  private readonly bindings = new Map<string, string>();
  private readonly tails = new Map<string, Promise<void>>();

  public hydrateBinding(
    chatId: string,
    sessionId: string
  ): ChatBindingSnapshot {
    this.bindings.set(chatId, sessionId);
    return this.getBinding(chatId);
  }

  public getBinding(chatId: string): ChatBindingSnapshot {
    return {
      chatId,
      sessionId: this.bindings.get(chatId) ?? null
    };
  }

  public deleteBindingsForSession(sessionId: string): readonly string[] {
    const deletedChatIds: string[] = [];
    for (const [chatId, boundSessionId] of this.bindings.entries()) {
      if (boundSessionId !== sessionId) {
        continue;
      }

      this.bindings.delete(chatId);
      deletedChatIds.push(chatId);
    }

    return deletedChatIds;
  }

  public async bindExistingSession(
    request: BindChatSessionRequest,
    actors: ReadonlyMap<string, SessionActor>
  ): Promise<RoutingDispatchResult> {
    return this.enqueue(request.chatId, async () => {
      const currentBinding = this.getBinding(request.chatId);
      const currentActor = currentBinding.sessionId
        ? (actors.get(currentBinding.sessionId) ?? null)
        : null;

      if (currentActor?.isActiveForCommandGate()) {
        return rejectActiveCommand(request.command, currentBinding.sessionId);
      }

      const targetActor = actors.get(request.targetSessionId);
      if (!targetActor) {
        return rejectMissingSession(request.command);
      }

      this.bindings.set(request.chatId, request.targetSessionId);

      return {
        binding: this.getBinding(request.chatId),
        sessionSnapshot: targetActor.getSnapshot(),
        effects: [
          createBindingChangedEffect(
            request.chatId,
            currentBinding.sessionId,
            request.targetSessionId,
            "bind"
          )
        ]
      };
    });
  }

  public async createAndBindSession(
    request: CreateAndBindSessionRequest,
    actors: Map<string, SessionActor>
  ): Promise<RoutingDispatchResult> {
    return this.enqueue(request.chatId, async () => {
      const currentBinding = this.getBinding(request.chatId);
      const currentActor = currentBinding.sessionId
        ? (actors.get(currentBinding.sessionId) ?? null)
        : null;

      if (currentActor?.isActiveForCommandGate()) {
        return rejectActiveCommand(request.command, currentBinding.sessionId);
      }

      if (actors.has(request.targetSessionId)) {
        const duplicateEffect: CommandRejectedEffect = {
          type: "command_rejected",
          chatId: request.chatId,
          command: request.command.command,
          reason: "duplicate_session",
          text: `Session "${request.targetSessionId}" already exists.`,
          sessionId: request.targetSessionId
        };

        return {
          binding: currentBinding,
          sessionSnapshot: currentActor?.getSnapshot() ?? null,
          effects: [duplicateEffect]
        };
      }

      const actor = new SessionActor(request.targetSessionId);
      actors.set(request.targetSessionId, actor);
      this.bindings.set(request.chatId, request.targetSessionId);

      return {
        binding: this.getBinding(request.chatId),
        sessionSnapshot: actor.getSnapshot(),
        effects: [
          {
            type: "session_created",
            chatId: request.chatId,
            sessionId: request.targetSessionId
          },
          createBindingChangedEffect(
            request.chatId,
            currentBinding.sessionId,
            request.targetSessionId,
            "new"
          )
        ]
      };
    });
  }

  private enqueue<T>(chatId: string, work: () => Promise<T>): Promise<T> {
    const previousTail = this.tails.get(chatId) ?? Promise.resolve();
    const execution = previousTail.then(work);
    this.tails.set(
      chatId,
      execution.then(
        () => undefined,
        () => undefined
      )
    );
    return execution;
  }
}

function createBindingChangedEffect(
  chatId: string,
  previousSessionId: string | null,
  nextSessionId: string,
  reason: ChatBindingChangedEffect["reason"]
): ChatBindingChangedEffect {
  return {
    type: "chat_binding_changed",
    chatId,
    previousSessionId,
    nextSessionId,
    reason
  };
}

function rejectActiveCommand(
  command: Extract<
    NormalizedCommandRequest,
    { readonly command: "bind" | "new" }
  >,
  sessionId: string | null
): RoutingDispatchResult {
  return {
    binding: {
      chatId: command.envelope.chatId,
      sessionId
    },
    sessionSnapshot: null,
    effects: [
      {
        type: "command_rejected",
        chatId: command.envelope.chatId,
        command: command.command,
        reason: "active_session_blocked",
        text: `/${command.command} is blocked while the current bound session is active.`,
        ...(sessionId ? { sessionId } : {})
      }
    ]
  };
}

function rejectMissingSession(
  command: Extract<NormalizedCommandRequest, { readonly command: "bind" }>
): RoutingDispatchResult {
  return {
    binding: {
      chatId: command.envelope.chatId,
      sessionId: null
    },
    sessionSnapshot: null,
    effects: [
      {
        type: "command_rejected",
        chatId: command.envelope.chatId,
        command: command.command,
        reason: "missing_session",
        text: `Session "${command.targetSessionId}" does not exist.`
      }
    ]
  };
}
