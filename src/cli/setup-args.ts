import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ParsedSetupOptions } from "./setup-shared.js";

export const SETUP_HELP_TEXT = [
  "Usage: codex-telegram-bridge setup [options]",
  "",
  "Options:",
  "  --config-env-file <path>   Write the generated config to a specific env file.",
  "  --env-file <path>          Write the generated config to a specific env file.",
  "  --non-interactive          Skip prompts and rely on flags, existing env values, and defaults.",
  "  --bot-token <token>        Set CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN.",
  "  --allowed-user-id <id>     Set a single allowlisted Telegram user ID.",
  "  --allowed-user-ids <ids>   Set CODEX_TELEGRAM_BRIDGE_ALLOWED_TELEGRAM_USER_IDS.",
  "  --workspace-root <path>    Set CODEX_TELEGRAM_BRIDGE_DEFAULT_WORKSPACE_ROOT.",
  "  --app-home <path>          Set CODEX_TELEGRAM_BRIDGE_APP_HOME.",
  "  --codex-home <path>        Set CODEX_TELEGRAM_BRIDGE_CODEX_HOME.",
  "  --log-level <level>        Set CODEX_TELEGRAM_BRIDGE_LOG_LEVEL.",
  "  --owner-user-id <id>       Set CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_USER_ID.",
  "  --help                     Show this message."
].join("\n");

export function parseSetupCommandArgs(
  args: readonly string[],
  options: { readonly homeDir?: string } = {}
): ParsedSetupOptions {
  const resolvedHomeDir = resolve(options.homeDir ?? homedir());
  const values: Record<string, string> = {};
  let envFilePath = join(
    resolvedHomeDir,
    ".config",
    "codex-telegram-bridge",
    "config.env"
  );
  let interactive = true;
  let showHelp = false;

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];

    switch (current) {
      case "--env-file":
      case "--config-env-file":
        envFilePath = readNextValue(args, index, current);
        index += 1;
        break;
      case "--non-interactive":
        interactive = false;
        break;
      case "--bot-token":
        values.telegramBotToken = readNextValue(args, index, current);
        index += 1;
        break;
      case "--allowed-user-id":
      case "--allowed-user-ids":
        values.allowedTelegramUserIds = readNextValue(args, index, current);
        index += 1;
        break;
      case "--workspace-root":
        values.defaultWorkspaceRoot = readNextValue(args, index, current);
        index += 1;
        break;
      case "--app-home":
        values.appHome = readNextValue(args, index, current);
        index += 1;
        break;
      case "--codex-home":
        values.codexHome = readNextValue(args, index, current);
        index += 1;
        break;
      case "--log-level":
        values.logLevel = readNextValue(args, index, current);
        index += 1;
        break;
      case "--owner-user-id":
        values.ownerTelegramUserId = readNextValue(args, index, current);
        index += 1;
        break;
      case "--help":
      case "-h":
        showHelp = true;
        break;
      default:
        throw new Error(`Unsupported setup option: ${current}`);
    }
  }

  return {
    envFilePath: resolve(envFilePath),
    interactive,
    showHelp,
    values
  };
}

function readNextValue(
  args: readonly string[],
  index: number,
  flag: string
): string {
  const next = args[index + 1];
  if (!next) {
    throw new Error(`Missing value for ${flag}`);
  }

  return next;
}
