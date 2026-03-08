import type { BridgeStore } from "../../store/types.js";
import type { NormalizedInboundMessage } from "../../core/types/index.js";
import type { TelegramBotClient } from "./client.js";
import type {
  TelegramIgnoredUpdate,
  TelegramInboundEnvelope,
  TelegramPollingResult,
  TelegramTransportOptions
} from "./types.js";
import { getTransportDefaults, mapTelegramUpdateToInbound } from "./updates.js";

const DEFAULT_POLLING_TIMEOUT_SECONDS = 30;
const DEFAULT_OFFSET_CHANNEL_KEY = "telegram:getUpdates";

export type TelegramPollingServiceOptions = TelegramTransportOptions;

type TelegramPollingRuntimeOptions = Omit<
  Required<
    Pick<
      TelegramPollingServiceOptions,
      "allowedUserIds" | "pollingTimeoutSeconds" | "offsetChannelKey"
    >
  >,
  "allowedUserIds"
> & {
  readonly allowedUserIds: ReadonlySet<string>;
  readonly verificationPasswordHash: string | null;
  readonly ownerUserId: string | null;
  readonly ownerChatId: string | null;
  readonly callbackReceivedText: string;
  readonly callbackStaleText: string;
};

export class TelegramPollingService {
  readonly #client: TelegramBotClient;
  readonly #store: Pick<
    BridgeStore,
    "channelOffsets" | "pendingPermissions" | "telegramUserAuth"
  >;
  readonly #options: TelegramPollingRuntimeOptions;
  #activePollController: AbortController | null = null;

  constructor(
    client: TelegramBotClient,
    store: Pick<
      BridgeStore,
      "channelOffsets" | "pendingPermissions" | "telegramUserAuth"
    >,
    options: TelegramPollingServiceOptions
  ) {
    this.#client = client;
    this.#store = store;
    const callbackDefaults = getTransportDefaults(options);

    this.#options = {
      allowedUserIds: new Set(options.allowedUserIds),
      verificationPasswordHash: options.verificationPasswordHash ?? null,
      ownerUserId: options.ownerUserId ?? null,
      ownerChatId: options.ownerChatId ?? null,
      pollingTimeoutSeconds:
        options.pollingTimeoutSeconds ?? DEFAULT_POLLING_TIMEOUT_SECONDS,
      offsetChannelKey: options.offsetChannelKey ?? DEFAULT_OFFSET_CHANNEL_KEY,
      callbackReceivedText: callbackDefaults.callbackReceivedText,
      callbackStaleText: callbackDefaults.callbackStaleText
    };
  }

  async pollOnce(
    onInboundMessage: (
      envelope: TelegramInboundEnvelope
    ) => Promise<void> | void
  ): Promise<TelegramPollingResult> {
    const offsetRecord = this.#store.channelOffsets.get(
      this.#options.offsetChannelKey
    );
    let currentOffset = offsetRecord?.currentOffset ?? 0;
    const acceptedUpdates: TelegramInboundEnvelope[] = [];
    const ignoredUpdates: TelegramIgnoredUpdate[] = [];
    const pollController = new AbortController();
    this.#activePollController = pollController;

    try {
      const updates = await this.#client.getUpdates({
        offset: currentOffset,
        timeoutSeconds: this.#options.pollingTimeoutSeconds,
        allowedUpdates: ["message", "callback_query"],
        signal: pollController.signal
      });

      for (const update of updates) {
        if (update.update_id < currentOffset) {
          ignoredUpdates.push({
            updateId: update.update_id,
            reason: "replayed_update",
            detail: `Update ${update.update_id} is below the committed offset ${currentOffset}.`
          });
          continue;
        }

        const mapped = await mapTelegramUpdateToInbound(update, {
          allowedUserIds: this.#options.allowedUserIds,
          verificationPasswordHash: this.#options.verificationPasswordHash,
          ownerUserId: this.#options.ownerUserId,
          ownerChatId: this.#options.ownerChatId,
          store: this.#store,
          client: this.#client,
          callbackReceivedText: this.#options.callbackReceivedText,
          callbackStaleText: this.#options.callbackStaleText
        });

        if (mapped.kind === "accepted") {
          await onInboundMessage(mapped.envelope);
          acceptedUpdates.push(mapped.envelope);
        } else {
          ignoredUpdates.push(mapped.ignored);
        }

        const nextOffset = update.update_id + 1;
        this.#store.channelOffsets.save({
          channelKey: this.#options.offsetChannelKey,
          currentOffset: nextOffset,
          previousOffset: currentOffset
        });
        currentOffset = nextOffset;
      }

      return {
        previousOffset: offsetRecord?.currentOffset ?? 0,
        nextOffset: currentOffset,
        processedUpdates: acceptedUpdates.length + ignoredUpdates.length,
        acceptedUpdates,
        ignoredUpdates
      };
    } finally {
      if (this.#activePollController === pollController) {
        this.#activePollController = null;
      }
    }
  }

  stop(): void {
    this.#activePollController?.abort();
  }

  createInboundCollector() {
    const events: NormalizedInboundMessage[] = [];

    return {
      handler(envelope: TelegramInboundEnvelope): void {
        events.push(envelope.inboundMessage);
      },
      snapshot(): readonly NormalizedInboundMessage[] {
        return [...events];
      }
    };
  }
}
