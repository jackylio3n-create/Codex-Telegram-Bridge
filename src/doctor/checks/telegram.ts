import { TelegramBotClient } from "../../transport/telegram/index.js";
import type { DoctorCheck } from "../types.js";

export async function buildTelegramCheck(botToken: string): Promise<DoctorCheck> {
  const client = new TelegramBotClient({ botToken });

  try {
    await client.getUpdates({
      offset: 0,
      timeoutSeconds: 0,
      limit: 1,
      allowedUpdates: ["message", "callback_query"]
    });

    return {
      id: "telegram",
      label: "telegram runtime",
      status: "ok",
      summary: "Telegram token probe succeeded.",
      details: ["Validated via getUpdates with a zero-timeout health probe."]
    };
  } catch (error) {
    return {
      id: "telegram",
      label: "telegram runtime",
      status: "error",
      summary: "Telegram token probe failed.",
      details: [getErrorMessage(error)]
    };
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }

  return "Unknown Telegram error.";
}
