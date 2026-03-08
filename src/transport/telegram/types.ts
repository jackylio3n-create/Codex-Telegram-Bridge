import type {
  ApprovalDecision,
  NormalizedApprovalDecision,
  NormalizedCommandRequest,
  NormalizedInboundMessage
} from "../../core/types/index.js";

export type TelegramChatType = "private" | "group" | "supergroup" | "channel";
export type TelegramPreviewCapabilityMode = "draft" | "edit" | "none";

export interface TelegramUser {
  readonly id: number;
  readonly is_bot: boolean;
  readonly first_name: string;
  readonly username?: string;
}

export interface TelegramChat {
  readonly id: number;
  readonly type: TelegramChatType;
}

export interface TelegramPhotoSize {
  readonly file_id: string;
  readonly file_unique_id?: string;
  readonly width: number;
  readonly height: number;
  readonly file_size?: number;
}

export interface TelegramDocument {
  readonly file_id: string;
  readonly file_unique_id?: string;
  readonly file_name?: string;
  readonly mime_type?: string;
  readonly file_size?: number;
}

export interface TelegramMessage {
  readonly message_id: number;
  readonly date: number;
  readonly text?: string;
  readonly caption?: string;
  readonly photo?: readonly TelegramPhotoSize[];
  readonly document?: TelegramDocument;
  readonly chat: TelegramChat;
  readonly from?: TelegramUser;
}

export interface TelegramCallbackQuery {
  readonly id: string;
  readonly from: TelegramUser;
  readonly message?: TelegramMessage;
  readonly data?: string;
}

export interface TelegramUpdate {
  readonly update_id: number;
  readonly message?: TelegramMessage;
  readonly edited_message?: TelegramMessage;
  readonly callback_query?: TelegramCallbackQuery;
}

export interface TelegramFile {
  readonly file_id: string;
  readonly file_unique_id?: string;
  readonly file_size?: number;
  readonly file_path?: string;
}

export interface TelegramInlineKeyboardButton {
  readonly text: string;
  readonly callback_data?: string;
}

export interface TelegramInlineKeyboardMarkup {
  readonly inline_keyboard: readonly (readonly TelegramInlineKeyboardButton[])[];
}

export interface TelegramApiResponse<TResult> {
  readonly ok: boolean;
  readonly result?: TResult;
  readonly description?: string;
  readonly error_code?: number;
}

export interface TelegramSendMessageOptions {
  readonly disableNotification?: boolean;
  readonly replyMarkup?: TelegramInlineKeyboardMarkup;
}

export interface TelegramEditMessageTextOptions {
  readonly replyMarkup?: TelegramInlineKeyboardMarkup;
}

export interface TelegramAnswerCallbackQueryOptions {
  readonly text?: string;
  readonly showAlert?: boolean;
}

export interface TelegramGetUpdatesOptions {
  readonly offset?: number;
  readonly timeoutSeconds?: number;
  readonly limit?: number;
  readonly allowedUpdates?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface TelegramTransportOptions {
  readonly botToken: string;
  readonly allowedUserIds: readonly string[];
  readonly verificationPasswordHash?: string | null;
  readonly ownerUserId?: string | null;
  readonly ownerChatId?: string | null;
  readonly pollingTimeoutSeconds?: number;
  readonly offsetChannelKey?: string;
  readonly previewCapabilityMode?: TelegramPreviewCapabilityMode;
  readonly previewMaxLength?: number;
  readonly finalChunkMaxLength?: number;
  readonly mediaFileSizeCapBytes?: number;
  readonly tempDirectoryPath: string;
  readonly callbackReceivedText?: string;
  readonly callbackStaleText?: string;
}

export interface TelegramInboundEnvelope {
  readonly updateId: number;
  readonly messageId: string;
  readonly chatId: string;
  readonly userId: string;
  readonly inboundMessage: NormalizedInboundMessage;
}

export type TelegramIgnoredUpdateReason =
  | "replayed_update"
  | "edited_message_ignored"
  | "unsupported_update"
  | "non_private_chat"
  | "user_not_allowed"
  | "verification_required"
  | "language_required"
  | "language_selected"
  | "user_banned"
  | "owner_not_allowed"
  | "owner_chat_mismatch"
  | "missing_sender"
  | "unsupported_message"
  | "unsupported_command"
  | "unsupported_callback_data"
  | "unknown_permission";

export interface TelegramIgnoredUpdate {
  readonly updateId: number;
  readonly reason: TelegramIgnoredUpdateReason;
  readonly detail: string;
}

export interface TelegramAcceptedUpdate {
  readonly kind: "accepted";
  readonly envelope: TelegramInboundEnvelope;
}

export interface TelegramIgnoredUpdateResult {
  readonly kind: "ignored";
  readonly ignored: TelegramIgnoredUpdate;
}

export type TelegramUpdateMappingResult = TelegramAcceptedUpdate | TelegramIgnoredUpdateResult;

export interface TelegramPollingResult {
  readonly previousOffset: number;
  readonly nextOffset: number;
  readonly processedUpdates: number;
  readonly acceptedUpdates: readonly TelegramInboundEnvelope[];
  readonly ignoredUpdates: readonly TelegramIgnoredUpdate[];
}

export interface TelegramChunk {
  readonly text: string;
}

export interface TelegramPreviewHandle {
  readonly chatId: string;
  readonly mode: TelegramPreviewCapabilityMode;
  readonly previewText: string;
  readonly previewMessageId?: number;
}

export interface TelegramPreviewPublishResult {
  readonly previewHandle: TelegramPreviewHandle;
  readonly sentMessageIds: readonly number[];
}

export interface TelegramMediaDescriptor {
  readonly telegramFileId: string;
  readonly mimeType: string;
  readonly viaDocument: boolean;
  readonly caption?: string;
}

export interface TelegramDownloadedMedia extends TelegramMediaDescriptor {
  readonly tempFilePath: string;
  cleanup(): Promise<void>;
}

export interface TelegramApprovalCallback {
  readonly decision: ApprovalDecision;
  readonly permissionId: string;
}

export interface TelegramResolvedApprovalDecision extends TelegramApprovalCallback {
  readonly pendingDecision: NormalizedApprovalDecision;
}

export interface TelegramSendMessageResult {
  readonly messageId: number;
  readonly rawMessage: TelegramMessage;
}

export interface TelegramMessageSendFailure {
  readonly attempts: number;
  readonly error: Error;
}

export interface TelegramOffsetState {
  readonly currentOffset: number;
  readonly previousOffset: number;
}

export type TelegramParsedCommand = NormalizedCommandRequest;
