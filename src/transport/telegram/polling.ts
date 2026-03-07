import type { BridgeStore } from "../../store/types.js";
import type { NormalizedInboundMessage } from "../../core/types/index.js";
import { TelegramBotClient } from "./client.js";
import type {
  TelegramIgnoredUpdate,
  TelegramInboundEnvelope,
  TelegramPollingResult,
  TelegramTransportOptions
} from "./types.js";
import { getTransportDefaults, mapTelegramUpdateToInbound } from "./updates.js";

const DEFAULT_POLLING_TIMEOUT_SECONDS = 30;
const DEFAULT_OFFSET_CHANNEL_KEY = "telegram:getUpdates";

export interface TelegramPollingServiceOptions extends TelegramTransportOptions {}

type TelegramPollingRuntimeOptions = Omit<Required<Pick<
  TelegramPollingServiceOptions,
  "allowedUserIds" | "pollingTimeoutSeconds" | "offsetChannelKey"
>>, "allowedUserIds"> & {
  readonly allowedUserIds: ReadonlySet<string>;
  readonly callbackReceivedText: string;
  readonly callbackStaleText: string;
};

export class TelegramPollingService {
  readonly #client: TelegramBotClient;
  readonly #store: Pick<BridgeStore, "channelOffsets" | "pendingPermissions">;
  readonly #options: TelegramPollingRuntimeOptions;

  constructor(
    client: TelegramBotClient,
    store: Pick<BridgeStore, "channelOffsets" | "pendingPermissions">,
    options: TelegramPollingServiceOptions
  ) {
    this.#client = client;
    this.#store = store;
    const callbackDefaults = getTransportDefaults(options);

    this.#options = {
      allowedUserIds: new Set(options.allowedUserIds),
      pollingTimeoutSeconds: options.pollingTimeoutSeconds ?? DEFAULT_POLLING_TIMEOUT_SECONDS,
      offsetChannelKey: options.offsetChannelKey ?? DEFAULT_OFFSET_CHANNEL_KEY,
      callbackReceivedText: callbackDefaults.callbackReceivedText,
      callbackStaleText: callbackDefaults.callbackStaleText
    };
  }

  async pollOnce(
    onInboundMessage: (envelope: TelegramInboundEnvelope) => Promise<void> | void
  ): Promise<TelegramPollingResult> {
    const offsetRecord = this.#store.channelOffsets.get(this.#options.offsetChannelKey);
    let currentOffset = offsetRecord?.currentOffset ?? 0;
    const acceptedUpdates: TelegramInboundEnvelope[] = [];
    const ignoredUpdates: TelegramIgnoredUpdate[] = [];

    const updates = await this.#client.getUpdates({
      offset: currentOffset,
      timeoutSeconds: this.#options.pollingTimeoutSeconds,
      allowedUpdates: ["message", "callback_query"]
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
