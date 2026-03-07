import type {
  TelegramAnswerCallbackQueryOptions,
  TelegramApiResponse,
  TelegramEditMessageTextOptions,
  TelegramFile,
  TelegramGetUpdatesOptions,
  TelegramMessage,
  TelegramSendMessageOptions,
  TelegramSendMessageResult,
  TelegramUpdate
} from "./types.js";

export type TelegramFetch = typeof fetch;

export interface TelegramBotClientOptions {
  readonly botToken: string;
  readonly apiBaseUrl?: string;
  readonly fileBaseUrl?: string;
  readonly fetchImplementation?: TelegramFetch;
}

export class TelegramBotClient {
  readonly #botToken: string;
  readonly #apiBaseUrl: string;
  readonly #fileBaseUrl: string;
  readonly #fetch: TelegramFetch;

  constructor(options: TelegramBotClientOptions) {
    this.#botToken = options.botToken;
    this.#apiBaseUrl = `${options.apiBaseUrl ?? "https://api.telegram.org"}/bot${options.botToken}`;
    this.#fileBaseUrl = `${options.fileBaseUrl ?? "https://api.telegram.org"}/file/bot${options.botToken}`;
    this.#fetch = options.fetchImplementation ?? fetch;
  }

  async getUpdates(options: TelegramGetUpdatesOptions = {}): Promise<readonly TelegramUpdate[]> {
    return this.#callApi<readonly TelegramUpdate[]>("getUpdates", {
      ...(typeof options.offset === "number" ? { offset: options.offset } : {}),
      ...(typeof options.timeoutSeconds === "number" ? { timeout: options.timeoutSeconds } : {}),
      ...(typeof options.limit === "number" ? { limit: options.limit } : {}),
      ...(options.allowedUpdates ? { allowed_updates: [...options.allowedUpdates] } : {})
    });
  }

  async sendMessage(
    chatId: string,
    text: string,
    options: TelegramSendMessageOptions = {}
  ): Promise<TelegramSendMessageResult> {
    const rawMessage = await this.#callApi<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text,
      ...(options.disableNotification ? { disable_notification: true } : {}),
      ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {})
    });

    return {
      messageId: rawMessage.message_id,
      rawMessage
    };
  }

  async editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    options: TelegramEditMessageTextOptions = {}
  ): Promise<TelegramSendMessageResult> {
    const rawMessage = await this.#callApi<TelegramMessage>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {})
    });

    return {
      messageId: rawMessage.message_id,
      rawMessage
    };
  }

  async answerCallbackQuery(
    callbackQueryId: string,
    options: TelegramAnswerCallbackQueryOptions = {}
  ): Promise<boolean> {
    return this.#callApi<boolean>("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(options.text ? { text: options.text } : {}),
      ...(options.showAlert ? { show_alert: options.showAlert } : {})
    });
  }

  async getFile(fileId: string): Promise<TelegramFile> {
    return this.#callApi<TelegramFile>("getFile", {
      file_id: fileId
    });
  }

  async downloadFile(filePath: string): Promise<Uint8Array> {
    const response = await this.#fetch(`${this.#fileBaseUrl}/${filePath}`);
    if (!response.ok) {
      throw new Error(`Telegram file download failed with HTTP ${response.status}.`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }

  async #callApi<TResult>(method: string, payload: Record<string, unknown>): Promise<TResult> {
    const response = await this.#fetch(`${this.#apiBaseUrl}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Telegram API HTTP ${response.status} for ${method}.`);
    }

    const parsed = await response.json() as TelegramApiResponse<TResult>;
    if (!parsed.ok || parsed.result === undefined) {
      throw new Error(parsed.description ?? `Telegram API error for ${method}.`);
    }

    return parsed.result;
  }
}
