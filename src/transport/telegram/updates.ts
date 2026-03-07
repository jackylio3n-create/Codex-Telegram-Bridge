import type { BridgeStore } from "../../store/types.js";
import type {
  ApprovalDecision,
  EventEnvelope,
  NormalizedApprovalDecision,
  NormalizedInboundMessage,
  SessionMode
} from "../../core/types/index.js";
import type { TelegramBotClient } from "./client.js";
import type {
  TelegramAcceptedUpdate,
  TelegramCallbackQuery,
  TelegramIgnoredUpdateResult,
  TelegramMessage,
  TelegramParsedCommand,
  TelegramTransportOptions,
  TelegramUpdate,
  TelegramUpdateMappingResult
} from "./types.js";
import { pickPreferredPhotoSize } from "./photo.js";

interface TelegramUpdateMapperDependencies {
  readonly allowedUserIds: ReadonlySet<string>;
  readonly store: Pick<BridgeStore, "pendingPermissions">;
  readonly client: Pick<TelegramBotClient, "answerCallbackQuery">;
  readonly callbackReceivedText: string;
  readonly callbackStaleText: string;
}

const DEFAULT_CALLBACK_RECEIVED_TEXT = "Received.";
const DEFAULT_CALLBACK_STALE_TEXT = "Expired or already handled.";
const PATH_COMMANDS = {
  cwd: true,
  adddir: true
} as const;
const OPTIONAL_ARGS_COMMANDS = {
  status: true,
  help: true,
  stop: true,
  sessions: true,
  start: true,
  perm: true
} as const;
const SESSION_MODES = {
  ask: true,
  plan: true,
  code: true
} as const;

export async function mapTelegramUpdateToInbound(
  update: TelegramUpdate,
  dependencies: TelegramUpdateMapperDependencies
): Promise<TelegramUpdateMappingResult> {
  if (update.edited_message) {
    return ignored(update.update_id, "edited_message_ignored", "Edited messages are ignored in V1.");
  }

  if (update.message) {
    return mapTelegramMessageUpdate(update.update_id, update.message, dependencies.allowedUserIds);
  }

  if (update.callback_query) {
    return mapTelegramCallbackQuery(update.update_id, update.callback_query, dependencies);
  }

  return ignored(update.update_id, "unsupported_update", "Only message and callback_query updates are supported.");
}

export function getTransportDefaults(options: Pick<
  TelegramTransportOptions,
  "callbackReceivedText" | "callbackStaleText"
>): {
  readonly callbackReceivedText: string;
  readonly callbackStaleText: string;
} {
  return {
    callbackReceivedText: options.callbackReceivedText ?? DEFAULT_CALLBACK_RECEIVED_TEXT,
    callbackStaleText: options.callbackStaleText ?? DEFAULT_CALLBACK_STALE_TEXT
  };
}

function mapTelegramMessageUpdate(
  updateId: number,
  message: TelegramMessage,
  allowedUserIds: ReadonlySet<string>
): TelegramUpdateMappingResult {
  const sender = message.from;
  if (!sender) {
    return ignored(updateId, "missing_sender", "Telegram message is missing the sender.");
  }

  if (message.chat.type !== "private") {
    return ignored(updateId, "non_private_chat", "Only private chats are supported in V1.");
  }

  if (!allowedUserIds.has(String(sender.id))) {
    return ignored(updateId, "user_not_allowed", `Telegram user ${sender.id} is not allowlisted.`);
  }

  const envelope = createEnvelope(message.chat.id, sender.id, message.message_id, message.date);
  const inboundMessage = parseMessageToInbound(message, envelope);
  if (!inboundMessage) {
    return ignored(updateId, "unsupported_message", "Message is neither supported text nor supported image media.");
  }

  return {
    kind: "accepted",
    envelope: {
      updateId,
      messageId: String(message.message_id),
      chatId: String(message.chat.id),
      userId: String(sender.id),
      inboundMessage
    }
  };
}

async function mapTelegramCallbackQuery(
  updateId: number,
  callbackQuery: TelegramCallbackQuery,
  dependencies: TelegramUpdateMapperDependencies
): Promise<TelegramUpdateMappingResult> {
  const callbackData = callbackQuery.data?.trim();
  const message = callbackQuery.message;
  if (!callbackData || !message) {
    return answerStaleCallback(
      updateId,
      callbackQuery.id,
      "unsupported_callback_data",
      "Callback data or callback message is missing.",
      dependencies
    );
  }

  const parsed = parseApprovalCallbackData(callbackData);
  if (!parsed) {
    return answerStaleCallback(
      updateId,
      callbackQuery.id,
      "unsupported_callback_data",
      `Unsupported callback payload: ${callbackData}.`,
      dependencies
    );
  }

  const pendingPermission = dependencies.store.pendingPermissions.get(parsed.permissionId);
  if (!pendingPermission) {
    return answerStaleCallback(
      updateId,
      callbackQuery.id,
      "unknown_permission",
      `Pending permission ${parsed.permissionId} was not found.`,
      dependencies
    );
  }

  await dependencies.client.answerCallbackQuery(callbackQuery.id, {
    text: dependencies.callbackReceivedText
  });

  const pendingDecision: NormalizedApprovalDecision = {
    type: "approval_decision",
    envelope: createEnvelope(message.chat.id, callbackQuery.from.id, message.message_id, message.date),
    sessionId: pendingPermission.sessionId,
    runId: pendingPermission.runId,
    permissionId: pendingPermission.permissionId,
    decision: parsed.decision,
    callbackQueryId: callbackQuery.id
  };

  return {
    kind: "accepted",
    envelope: {
      updateId,
      messageId: String(message.message_id),
      chatId: String(message.chat.id),
      userId: String(callbackQuery.from.id),
      inboundMessage: pendingDecision
    }
  };
}

async function answerStaleCallback(
  updateId: number,
  callbackQueryId: string,
  reason: TelegramIgnoredUpdateResult["ignored"]["reason"],
  detail: string,
  dependencies: TelegramUpdateMapperDependencies
): Promise<TelegramIgnoredUpdateResult> {
  await dependencies.client.answerCallbackQuery(callbackQueryId, {
    text: dependencies.callbackStaleText
  });

  return ignored(updateId, reason, detail);
}

function parseMessageToInbound(
  message: TelegramMessage,
  envelope: EventEnvelope
): NormalizedInboundMessage | null {
  if (typeof message.text === "string" && message.text.trim() !== "") {
    const parsedCommand = parseCommandText(message.text, envelope);
    if (parsedCommand) {
      return parsedCommand;
    }

    if (message.text.startsWith("/")) {
      return null;
    }

    return {
      type: "user_input",
      contentType: "text",
      envelope,
      text: message.text
    };
  }

  const imageInput = extractImageInput(message, envelope);
  return imageInput;
}

function extractImageInput(
  message: TelegramMessage,
  envelope: EventEnvelope
): NormalizedInboundMessage | null {
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const preferred = pickPreferredPhotoSize(message.photo);

    return {
      type: "user_input",
      contentType: "image",
      envelope,
      telegramFileId: preferred.file_id,
      mimeType: "image/jpeg",
      viaDocument: false,
      ...(message.caption ? { caption: message.caption } : {})
    };
  }

  if (message.document?.mime_type?.startsWith("image/")) {
    return {
      type: "user_input",
      contentType: "image",
      envelope,
      telegramFileId: message.document.file_id,
      mimeType: message.document.mime_type,
      viaDocument: true,
      ...(message.caption ? { caption: message.caption } : {})
    };
  }

  return null;
}

function parseCommandText(text: string, envelope: EventEnvelope): TelegramParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const [rawCommandToken, ...restTokens] = trimmed.slice(1).split(/\s+/);
  if (!rawCommandToken) {
    return null;
  }

  const commandToken = rawCommandToken.split("@")[0]?.toLowerCase() ?? "";
  const rawArgs = restTokens.join(" ").trim();

  if (commandToken === "bind") {
    return createBindCommand(envelope, rawArgs);
  }

  if (commandToken === "new") {
    return createNewCommand(envelope, rawArgs);
  }

  if (isPathCommand(commandToken)) {
    return createPathCommand(commandToken, envelope, rawArgs);
  }

  if (commandToken === "mode") {
    return createModeCommand(envelope, rawArgs);
  }

  if (isOptionalArgsCommand(commandToken)) {
    return createOptionalArgsCommand(commandToken, envelope, restTokens);
  }

  return null;
}

function createBindCommand(
  envelope: EventEnvelope,
  rawArgs: string
): Extract<TelegramParsedCommand, { readonly command: "bind" }> | null {
  return rawArgs === ""
    ? null
    : {
        type: "command",
        command: "bind",
        envelope,
        targetSessionId: rawArgs
      };
}

function createNewCommand(
  envelope: EventEnvelope,
  rawArgs: string
): Extract<TelegramParsedCommand, { readonly command: "new" }> {
  return {
    type: "command",
    command: "new",
    envelope,
    ...(rawArgs ? { requestedCwd: rawArgs } : {})
  };
}

function createPathCommand(
  command: Extract<TelegramParsedCommand["command"], "cwd" | "adddir">,
  envelope: EventEnvelope,
  rawArgs: string
): Extract<TelegramParsedCommand, { readonly command: "cwd" | "adddir" }> | null {
  return rawArgs === ""
    ? null
    : {
        type: "command",
        command,
        envelope,
        path: rawArgs
      };
}

function createModeCommand(
  envelope: EventEnvelope,
  rawArgs: string
): Extract<TelegramParsedCommand, { readonly command: "mode" }> | null {
  return isSessionMode(rawArgs)
    ? {
        type: "command",
        command: "mode",
        envelope,
        mode: rawArgs
      }
    : null;
}

function createOptionalArgsCommand(
  command: Extract<TelegramParsedCommand["command"], "status" | "help" | "stop" | "sessions" | "start" | "perm">,
  envelope: EventEnvelope,
  args: readonly string[]
): Extract<TelegramParsedCommand, { readonly command: "status" | "help" | "stop" | "sessions" | "start" | "perm" }> {
  return {
    type: "command",
    command,
    envelope,
    ...(args.length > 0 ? { args: [...args] } : {})
  };
}

function isPathCommand(command: string): command is Extract<TelegramParsedCommand["command"], "cwd" | "adddir"> {
  return Object.hasOwn(PATH_COMMANDS, command);
}

function isOptionalArgsCommand(
  command: string
): command is Extract<TelegramParsedCommand["command"], "status" | "help" | "stop" | "sessions" | "start" | "perm"> {
  return Object.hasOwn(OPTIONAL_ARGS_COMMANDS, command);
}

function isSessionMode(mode: string): mode is SessionMode {
  return Object.hasOwn(SESSION_MODES, mode);
}

function parseApprovalCallbackData(payload: string): {
  readonly decision: ApprovalDecision;
  readonly permissionId: string;
} | null {
  if (payload.length > 64) {
    return null;
  }

  const match = payload.match(/^(pa|pd):([A-Za-z0-9._-]+)$/);
  if (!match) {
    return null;
  }

  const [, prefix, permissionId] = match;
  if (!prefix || !permissionId) {
    return null;
  }

  return {
    decision: prefix === "pa" ? "approve" : "deny",
    permissionId
  };
}

function createEnvelope(
  chatId: number,
  userId: number,
  messageId: number,
  messageDateSeconds: number
): EventEnvelope {
  return {
    chatId: String(chatId),
    userId: String(userId),
    messageId: String(messageId),
    receivedAt: new Date(messageDateSeconds * 1000).toISOString()
  };
}

function ignored(
  updateId: number,
  reason: TelegramIgnoredUpdateResult["ignored"]["reason"],
  detail: string
): TelegramIgnoredUpdateResult {
  return {
    kind: "ignored",
    ignored: {
      updateId,
      reason,
      detail
    }
  };
}
