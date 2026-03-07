import { chunkTelegramText, createTelegramPreviewText } from "./chunking.js";
import type { TelegramBotClient } from "./client.js";
import type {
  TelegramPreviewCapabilityMode,
  TelegramPreviewHandle,
  TelegramPreviewPublishResult,
  TelegramTransportOptions
} from "./types.js";

const DEFAULT_PREVIEW_MAX_LENGTH = 1500;
const DEFAULT_FINAL_CHUNK_MAX_LENGTH = 3600;

export interface TelegramPreviewPublisherOptions extends Pick<
  TelegramTransportOptions,
  "previewCapabilityMode" | "previewMaxLength" | "finalChunkMaxLength"
> {}

export class TelegramPreviewPublisher {
  readonly #client: TelegramBotClient;
  readonly #previewCapabilityMode: TelegramPreviewCapabilityMode;
  readonly #previewMaxLength: number;
  readonly #finalChunkMaxLength: number;

  constructor(client: TelegramBotClient, options: TelegramPreviewPublisherOptions = {}) {
    this.#client = client;
    this.#previewCapabilityMode = options.previewCapabilityMode ?? "edit";
    this.#previewMaxLength = options.previewMaxLength ?? DEFAULT_PREVIEW_MAX_LENGTH;
    this.#finalChunkMaxLength = options.finalChunkMaxLength ?? DEFAULT_FINAL_CHUNK_MAX_LENGTH;
  }

  async beginPreview(chatId: string, text: string): Promise<TelegramPreviewHandle> {
    const previewText = createTelegramPreviewText(text, this.#previewMaxLength);
    if (this.#previewCapabilityMode === "none") {
      return {
        chatId,
        mode: "none",
        previewText
      };
    }

    const sent = await this.#client.sendMessage(chatId, previewText);
    return {
      chatId,
      mode: this.#previewCapabilityMode,
      previewText,
      previewMessageId: sent.messageId
    };
  }

  async finalizePreview(handle: TelegramPreviewHandle, finalText: string): Promise<TelegramPreviewPublishResult> {
    const chunks = chunkTelegramText(finalText, {
      maxLength: this.#finalChunkMaxLength
    });

    if (handle.mode === "none" || handle.previewMessageId === undefined) {
      const sentMessageIds = await this.#sendChunks(handle.chatId, chunks);
      return {
        previewHandle: handle,
        sentMessageIds
      };
    }

    try {
      if (chunks.length === 1) {
        await this.#client.editMessageText(handle.chatId, handle.previewMessageId, chunks[0]!.text);
        return {
          previewHandle: handle,
          sentMessageIds: [handle.previewMessageId]
        };
      }

      const firstChunk = chunks[0]!.text;
      const canKeepFirstChunkInPreview = firstChunk.length <= this.#previewMaxLength;
      const replacementText = canKeepFirstChunkInPreview
        ? firstChunk
        : `Completed. Sending ${chunks.length} message parts.`;

      await this.#client.editMessageText(handle.chatId, handle.previewMessageId, replacementText);
      const remainingChunks = canKeepFirstChunkInPreview ? chunks.slice(1) : chunks;
      const sentMessageIds = await this.#sendChunks(handle.chatId, remainingChunks);

      return {
        previewHandle: handle,
        sentMessageIds: [handle.previewMessageId, ...sentMessageIds]
      };
    } catch {
      const sentMessageIds = await this.#sendChunks(handle.chatId, chunks);
      return {
        previewHandle: {
          ...handle,
          mode: "none"
        },
        sentMessageIds
      };
    }
  }

  async sendFinalText(chatId: string, text: string): Promise<readonly number[]> {
    const chunks = chunkTelegramText(text, {
      maxLength: this.#finalChunkMaxLength
    });

    return this.#sendChunks(chatId, chunks);
  }

  async #sendChunks(chatId: string, chunks: readonly { readonly text: string }[]): Promise<readonly number[]> {
    const sentMessageIds: number[] = [];

    for (const chunk of chunks) {
      const sent = await this.#client.sendMessage(chatId, chunk.text);
      sentMessageIds.push(sent.messageId);
    }

    return sentMessageIds;
  }

  async updatePreview(handle: TelegramPreviewHandle, text: string): Promise<TelegramPreviewHandle> {
    const previewText = createTelegramPreviewText(text, this.#previewMaxLength);
    if (handle.mode === "none" || handle.previewMessageId === undefined) {
      return {
        ...handle,
        previewText
      };
    }

    try {
      await this.#client.editMessageText(handle.chatId, handle.previewMessageId, previewText);
      return {
        ...handle,
        previewText
      };
    } catch {
      return {
        ...handle,
        mode: "none",
        previewText
      };
    }
  }
}
