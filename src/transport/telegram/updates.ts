import type { BridgeStore, TelegramUserAuthRecord } from "../../store/types.js";
import type { PromptLanguage } from "../../i18n.js";
import { selectText, zhEn } from "../../i18n.js";
import type {
  ApprovalDecision,
  EventEnvelope,
  NormalizedApprovalDecision,
  NormalizedInboundMessage,
  SessionMode
} from "../../core/types/index.js";
import { verifyVerificationPassword } from "../../security/verification-password.js";
import type { TelegramBotClient } from "./client.js";
import type {
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
  readonly verificationPasswordHash: string | null;
  readonly ownerUserId: string | null;
  readonly ownerChatId: string | null;
  readonly store: Pick<BridgeStore, "pendingPermissions" | "telegramUserAuth">;
  readonly client: Pick<TelegramBotClient, "answerCallbackQuery" | "sendMessage">;
  readonly callbackReceivedText: string;
  readonly callbackStaleText: string;
}

interface TelegramAccessContext {
  readonly senderId: string;
  readonly chatId: string;
}

interface TelegramAccessFailure {
  readonly reason: TelegramIgnoredUpdateResult["ignored"]["reason"];
  readonly detail: string;
}

const DEFAULT_CALLBACK_RECEIVED_TEXT = "Received.";
const DEFAULT_CALLBACK_STALE_TEXT = "Expired or already handled.";
const VERIFICATION_BAN_THRESHOLD = 5;
const VERIFICATION_CALLBACK_REQUIRED_TEXT = "Verification required.";
const VERIFICATION_WELCOME_TEXT = [
  "欢迎使用。请发送验证密码完成身份确认。",
  "",
  "Welcome. Please send the verification password to continue."
].join("\n");
const VERIFICATION_PROMPT_TEXT = [
  "需要先完成验证。",
  "",
  "Verification is required before this bot can be used."
].join("\n");
const VERIFICATION_SUCCESS_TEXT = [
  "验证成功，已经确认身份，现在可以正常使用 Bot。",
  "",
  "Verification successful. You can now use the bot normally."
].join("\n");
const VERIFICATION_BANNED_TEXT = [
  "验证失败次数过多，这个 Telegram 用户 ID 已被本地封禁。",
  "",
  "Too many incorrect attempts. This Telegram user ID has been blocked locally."
].join("\n");
const LOCALIZED_VERIFICATION_WELCOME_TEXT = zhEn(
  "欢迎使用。请在下一条消息中输入验证密码完成身份确认。",
  "Welcome. Please send the verification password in your next message to confirm your identity."
);
const LOCALIZED_VERIFICATION_PROMPT_TEXT = zhEn(
  "请先输入验证密码。",
  "Please send the verification password first."
);
const LOCALIZED_VERIFICATION_BANNED_TEXT = zhEn(
  "验证失败次数过多，此 Telegram 用户 ID 已被本地封禁。",
  "Too many incorrect attempts. This Telegram user ID has been blocked locally."
);
const LANGUAGE_SELECTION_CALLBACK_PREFIX = "lang:";
const LANGUAGE_SELECTION_PROMPT_TEXT = zhEn(
  "验证成功。请选择提示语言。",
  "Verification successful. Please choose your prompt language."
);
const LANGUAGE_SELECTION_REMINDER_TEXT = zhEn(
  "请先选择提示语言。",
  "Please choose your prompt language first."
);

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
  perm: true,
  prune: true,
  reasoning: true,
  scope: true
} as const;
const SESSION_MODES = {
  ask: true,
  plan: true,
  code: true
} as const;
const COMMAND_ALIASES: Readonly<Record<string, string>> = {
  stat: "status",
  sess: "sessions",
  cd: "cwd",
  allow: "adddir",
  think: "reasoning",
  clean: "prune"
};

export async function mapTelegramUpdateToInbound(
  update: TelegramUpdate,
  dependencies: TelegramUpdateMapperDependencies
): Promise<TelegramUpdateMappingResult> {
  if (update.edited_message) {
    return ignored(update.update_id, "edited_message_ignored", "Edited messages are ignored in V1.");
  }

  if (update.message) {
    return mapTelegramMessageUpdate(update.update_id, update.message, dependencies);
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

async function mapTelegramMessageUpdate(
  updateId: number,
  message: TelegramMessage,
  dependencies: TelegramUpdateMapperDependencies
): Promise<TelegramUpdateMappingResult> {
  const sender = message.from;
  if (!sender) {
    return ignored(updateId, "missing_sender", "Telegram message is missing the sender.");
  }

  const accessContext = resolveTelegramAccessContext({
    chatType: message.chat.type,
    senderId: sender.id,
    chatId: message.chat.id,
    dependencies
  });
  if (!accessContext.ok) {
    return ignored(updateId, accessContext.reason, accessContext.detail);
  }

  const verificationGateResult = await handleVerificationMessageGate(
    updateId,
    message,
    accessContext.senderId,
    accessContext.chatId,
    dependencies
  );
  if (verificationGateResult) {
    return verificationGateResult;
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
      chatId: accessContext.chatId,
      userId: accessContext.senderId,
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

  const accessContext = resolveTelegramAccessContext({
    chatType: message.chat.type,
    senderId: callbackQuery.from.id,
    chatId: message.chat.id,
    dependencies
  });
  if (!accessContext.ok) {
    return answerStaleCallback(
      updateId,
      callbackQuery.id,
      accessContext.reason,
      accessContext.detail,
      dependencies
    );
  }
  const { senderId, chatId } = accessContext;

  const authState = dependencies.store.telegramUserAuth.get(senderId);
  if (authState?.bannedAt) {
    return ignored(updateId, "user_banned", `Telegram user ${callbackQuery.from.id} is blocked locally.`);
  }

  const selectedLanguage = parseLanguageSelectionCallbackData(callbackData);
  if (selectedLanguage) {
    if (!authState?.verifiedAt) {
      await dependencies.client.answerCallbackQuery(callbackQuery.id, {
        text: VERIFICATION_CALLBACK_REQUIRED_TEXT,
        showAlert: true
      });
      return ignored(updateId, "verification_required", `Telegram user ${callbackQuery.from.id} must verify before choosing a prompt language.`);
    }

    dependencies.store.telegramUserAuth.setPreferredLanguage({
      userId: senderId,
      chatId,
      preferredLanguage: selectedLanguage
    });
    await dependencies.client.answerCallbackQuery(callbackQuery.id, {
      text: selectText(selectedLanguage, "语言已保存。", "Language saved.")
    });
    await dependencies.client.sendMessage(chatId, buildLanguageSelectedText(selectedLanguage));
    return ignored(updateId, "language_selected", `Telegram user ${callbackQuery.from.id} selected ${selectedLanguage} as the prompt language.`);
  }

  if (dependencies.verificationPasswordHash && !authState?.verifiedAt) {
    await dependencies.client.answerCallbackQuery(callbackQuery.id, {
      text: VERIFICATION_CALLBACK_REQUIRED_TEXT,
      showAlert: true
    });
    return ignored(updateId, "verification_required", `Telegram user ${callbackQuery.from.id} must verify before using callback actions.`);
  }

  if (dependencies.verificationPasswordHash && authState?.verifiedAt && !authState.preferredLanguage) {
    await dependencies.client.answerCallbackQuery(callbackQuery.id, {
      text: LANGUAGE_SELECTION_REMINDER_TEXT,
      showAlert: true
    });
    await dependencies.client.sendMessage(chatId, LANGUAGE_SELECTION_PROMPT_TEXT, {
      replyMarkup: buildLanguageSelectionKeyboard()
    });
    return ignored(updateId, "language_required", `Telegram user ${callbackQuery.from.id} must choose a prompt language before using callback actions.`);
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
    text: authState?.preferredLanguage
      ? selectText(authState.preferredLanguage, "已收到。", "Received.")
      : dependencies.callbackReceivedText
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
      chatId,
      userId: senderId,
      inboundMessage: pendingDecision
    }
  };
}

async function handleVerificationMessageGate(
  updateId: number,
  message: TelegramMessage,
  senderId: string,
  chatId: string,
  dependencies: TelegramUpdateMapperDependencies
): Promise<TelegramUpdateMappingResult | null> {
  const authState = dependencies.store.telegramUserAuth.get(senderId);
  if (authState?.bannedAt) {
    return ignored(updateId, "user_banned", `Telegram user ${senderId} is blocked locally.`);
  }

  if (!dependencies.verificationPasswordHash) {
    return null;
  }

  if (authState?.verifiedAt && authState.preferredLanguage) {
    return null;
  }

  if (authState?.verifiedAt && !authState.preferredLanguage) {
    await dependencies.client.sendMessage(chatId, LANGUAGE_SELECTION_PROMPT_TEXT, {
      replyMarkup: buildLanguageSelectionKeyboard()
    });
    return ignored(updateId, "language_required", `Telegram user ${senderId} must choose a prompt language before using the bot.`);
  }

  dependencies.store.telegramUserAuth.getOrCreateFirstSeen({
    userId: senderId,
    chatId,
    firstSeenAt: new Date(message.date * 1000).toISOString()
  });
  const trimmedText = message.text?.trim() ?? "";

  if (isStartCommandText(trimmedText)) {
    await dependencies.client.sendMessage(chatId, authState ? LOCALIZED_VERIFICATION_PROMPT_TEXT : LOCALIZED_VERIFICATION_WELCOME_TEXT);
    return ignored(updateId, "verification_required", `Telegram user ${senderId} must verify before using the bot.`);
  }

  if (trimmedText !== "" && !trimmedText.startsWith("/")) {
    if (verifyVerificationPassword(trimmedText, dependencies.verificationPasswordHash)) {
      dependencies.store.telegramUserAuth.markVerified({
        userId: senderId,
        chatId,
        verifiedAt: new Date(message.date * 1000).toISOString()
      });
      await dependencies.client.sendMessage(chatId, LANGUAGE_SELECTION_PROMPT_TEXT, {
        replyMarkup: buildLanguageSelectionKeyboard()
      });
      return ignored(updateId, "language_required", `Telegram user ${senderId} completed first-contact verification and must choose a prompt language.`);
    }

    const failed = dependencies.store.telegramUserAuth.recordFailedAttempt({
      userId: senderId,
      chatId,
      failedAt: new Date(message.date * 1000).toISOString(),
      banThreshold: VERIFICATION_BAN_THRESHOLD
    });
    if (failed.bannedAt) {
      await dependencies.client.sendMessage(chatId, LOCALIZED_VERIFICATION_BANNED_TEXT);
      return ignored(updateId, "user_banned", `Telegram user ${senderId} was blocked after repeated verification failures.`);
    }

    await dependencies.client.sendMessage(
      chatId,
      buildLocalizedVerificationFailureText(Math.max(VERIFICATION_BAN_THRESHOLD - failed.failedAttempts, 0))
    );
    return ignored(updateId, "verification_required", `Telegram user ${senderId} failed verification.`);
  }

  const reminderText = authState ? LOCALIZED_VERIFICATION_PROMPT_TEXT : LOCALIZED_VERIFICATION_WELCOME_TEXT;
  await dependencies.client.sendMessage(chatId, reminderText);
  return ignored(updateId, "verification_required", `Telegram user ${senderId} must verify before using the bot.`);
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

function resolveTelegramAccessContext(input: {
  readonly chatType: TelegramMessage["chat"]["type"];
  readonly senderId: number;
  readonly chatId: number;
  readonly dependencies: Pick<TelegramUpdateMapperDependencies, "allowedUserIds" | "ownerUserId" | "ownerChatId">;
}): ({
  readonly ok: true;
} & TelegramAccessContext) | ({
  readonly ok: false;
} & TelegramAccessFailure) {
  if (input.chatType !== "private") {
    return {
      ok: false,
      reason: "non_private_chat",
      detail: "Only private chats are supported in V1."
    };
  }

  const senderId = String(input.senderId);
  if (!input.dependencies.allowedUserIds.has(senderId)) {
    return {
      ok: false,
      reason: "user_not_allowed",
      detail: `Telegram user ${input.senderId} is not allowlisted.`
    };
  }

  if (input.dependencies.ownerUserId && senderId !== input.dependencies.ownerUserId) {
    return {
      ok: false,
      reason: "owner_not_allowed",
      detail: `Telegram user ${input.senderId} is not the configured owner.`
    };
  }

  const chatId = String(input.chatId);
  if (input.dependencies.ownerChatId && chatId !== input.dependencies.ownerChatId) {
    return {
      ok: false,
      reason: "owner_chat_mismatch",
      detail: `Telegram chat ${input.chatId} is not the configured owner chat.`
    };
  }

  return {
    ok: true,
    senderId,
    chatId
  };
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

  const commandToken = normalizeCommandToken(rawCommandToken);
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
  command: Extract<TelegramParsedCommand["command"], "status" | "help" | "stop" | "sessions" | "start" | "perm" | "prune" | "reasoning" | "scope">,
  envelope: EventEnvelope,
  args: readonly string[]
): Extract<TelegramParsedCommand, { readonly command: "status" | "help" | "stop" | "sessions" | "start" | "perm" | "prune" | "reasoning" | "scope" }> {
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
): command is Extract<TelegramParsedCommand["command"], "status" | "help" | "stop" | "sessions" | "start" | "perm" | "prune" | "reasoning" | "scope"> {
  return Object.hasOwn(OPTIONAL_ARGS_COMMANDS, command);
}

function isSessionMode(mode: string): mode is SessionMode {
  return Object.hasOwn(SESSION_MODES, mode);
}

function normalizeCommandToken(rawCommandToken: string): string {
  const normalized = rawCommandToken.split("@")[0]?.toLowerCase() ?? "";
  return COMMAND_ALIASES[normalized] ?? normalized;
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

function buildVerificationFailureText(remainingAttempts: number): string {
  return [
    `验证密码错误，还剩 ${remainingAttempts} 次机会。`,
    "",
    `Incorrect verification password. ${remainingAttempts} attempt${remainingAttempts === 1 ? "" : "s"} remaining.`
  ].join("\n");
}

function buildLocalizedVerificationFailureText(remainingAttempts: number): string {
  return zhEn(
    `验证密码错误。剩余 ${remainingAttempts} 次机会。`,
    `Incorrect verification password. ${remainingAttempts} attempt${remainingAttempts === 1 ? "" : "s"} remaining.`
  );
}

function parseLanguageSelectionCallbackData(payload: string): PromptLanguage | null {
  if (payload === `${LANGUAGE_SELECTION_CALLBACK_PREFIX}zh`) {
    return "zh";
  }

  if (payload === `${LANGUAGE_SELECTION_CALLBACK_PREFIX}en`) {
    return "en";
  }

  return null;
}

function buildLanguageSelectionKeyboard() {
  return {
    inline_keyboard: [
      [
        {
          text: "中文",
          callback_data: `${LANGUAGE_SELECTION_CALLBACK_PREFIX}zh`
        },
        {
          text: "English",
          callback_data: `${LANGUAGE_SELECTION_CALLBACK_PREFIX}en`
        }
      ]
    ]
  } as const;
}

function buildLanguageSelectedText(language: PromptLanguage): string {
  return selectText(
    language,
    "后续提示将使用中文。",
    "Future prompts will be shown in English."
  );
}

function isStartCommandText(text: string): boolean {
  if (!text.startsWith("/")) {
    return false;
  }

  const [rawCommandToken] = text.slice(1).split(/\s+/);
  return rawCommandToken ? normalizeCommandToken(rawCommandToken) === "start" : false;
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
