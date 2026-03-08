import { mkdir, writeFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { Writable } from "node:stream";
import {
  formatConfigIssues,
  loadAppConfig,
  redactConfigForDisplay,
  validateStartupEnvironment,
  type AppLogLevel
} from "../config/index.js";
import {
  readEnvironmentFile,
  serializeEnvironmentFile
} from "../config/env-file.js";
import {
  hashVerificationPassword,
  normalizeVerificationPassword,
  SETUP_VERIFICATION_PASSWORD_ENV_VAR
} from "../security/verification-password.js";

export interface ParsedSetupOptions {
  readonly envFilePath: string;
  readonly interactive: boolean;
  readonly showHelp: boolean;
  readonly values: SetupInputValues;
}

export interface SetupInputValues {
  readonly nodeEnv?: string;
  readonly telegramBotToken?: string;
  readonly verificationPassword?: string;
  readonly verificationPasswordHash?: string;
  readonly allowedTelegramUserIds?: string;
  readonly defaultWorkspaceRoot?: string;
  readonly appHome?: string;
  readonly codexHome?: string;
  readonly logLevel?: string;
  readonly ownerTelegramUserId?: string;
}

interface SetupResolvedValues {
  readonly nodeEnv: string;
  readonly telegramBotToken: string;
  readonly verificationPasswordHash: string | null;
  readonly allowedTelegramUserIds: string;
  readonly defaultWorkspaceRoot: string;
  readonly appHome: string;
  readonly codexHome: string;
  readonly logLevel: AppLogLevel;
  readonly ownerTelegramUserId: string | null;
}

class MutedOutput extends Writable {
  readonly #target: NodeJS.WritableStream;
  #muted = false;

  constructor(target: NodeJS.WritableStream) {
    super();
    this.#target = target;
  }

  setMuted(muted: boolean): void {
    this.#muted = muted;
  }

  override _write(
    chunk: string | Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    if (!this.#muted) {
      this.#target.write(chunk);
    }
    callback(null);
  }
}

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
  let envFilePath = join(resolvedHomeDir, ".config", "codex-telegram-bridge", "config.env");
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
        values.allowedTelegramUserIds = readNextValue(args, index, current);
        index += 1;
        break;
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

export async function runSetupCommand(options: ParsedSetupOptions): Promise<number> {
  if (options.showHelp) {
    process.stdout.write(`${SETUP_HELP_TEXT}\n`);
    return 0;
  }

  const existingEnv = await readExistingEnvironmentFile(options.envFilePath);
  const setupInputs = {
    ...options.values,
    ...(!options.interactive && process.env[SETUP_VERIFICATION_PASSWORD_ENV_VAR]
      ? {
          verificationPassword: process.env[SETUP_VERIFICATION_PASSWORD_ENV_VAR]
        }
      : {})
  };
  const resolvedValues = options.interactive
    ? await promptForSetupValues(existingEnv, setupInputs)
    : resolveSetupValues(existingEnv, setupInputs);
  const envEntries = buildEnvironmentEntries(existingEnv, resolvedValues);
  const env = Object.fromEntries(envEntries);
  const { config, issues } = loadAppConfig({
    env,
    cwd: process.cwd(),
    homeDir: homedir()
  });

  if (issues.some((issue) => issue.severity === "error")) {
    process.stderr.write(`${formatConfigIssues(issues)}\n`);
    return 1;
  }

  await mkdir(config.defaultWorkspaceRoot, { recursive: true });
  await mkdir(dirname(options.envFilePath), { recursive: true });
  await writeFile(options.envFilePath, renderEnvironmentFile(envEntries), "utf8");

  const startupIssues = await validateStartupEnvironment(config, { createMissingDirectories: true });
  const actionableIssues = startupIssues.filter((issue) => {
    return issue.field !== "defaultWorkspaceRoot" && issue.field !== "codexHome";
  });
  const followUpIssues = startupIssues.filter((issue) => {
    return issue.field === "codexHome";
  });

  process.stdout.write(`Wrote environment file: ${options.envFilePath}\n`);
  process.stdout.write(`${JSON.stringify(redactConfigForDisplay(config), null, 2)}\n`);

  if (actionableIssues.length > 0 || followUpIssues.length > 0) {
    process.stdout.write("\nStartup checks reported follow-up items:\n");
    process.stdout.write(`${formatConfigIssues([...actionableIssues, ...followUpIssues])}\n`);
    process.stdout.write("You can finish Codex login and rerun `npm run doctor` before starting the service.\n");
  }

  return actionableIssues.some((issue) => issue.severity === "error") ? 1 : 0;
}

export function renderEnvironmentFile(entries: readonly [string, string][]): string {
  const header = [
    "# Generated by `codex-telegram-bridge setup`.",
    "# Review and keep this file private because it contains bot credentials.",
    ""
  ].join("\n");

  return `${header}${serializeEnvironmentFile(entries)}`;
}

export function resolveSetupValues(
  existingEnv: NodeJS.ProcessEnv,
  inputValues: SetupInputValues,
  options: { readonly homeDir?: string } = {}
): SetupResolvedValues {
  const resolvedHomeDir = resolve(options.homeDir ?? homedir());
  const defaults = {
    nodeEnv: "production",
    defaultWorkspaceRoot: join(resolvedHomeDir, "codex-workspaces", "main"),
    appHome: join(resolvedHomeDir, ".local", "share", "codex-telegram-bridge"),
    codexHome: join(resolvedHomeDir, ".codex"),
    logLevel: "info"
  } as const;

  const allowedTelegramUserIds = (
    inputValues.allowedTelegramUserIds
    ?? existingEnv.CODEX_TELEGRAM_BRIDGE_ALLOWED_TELEGRAM_USER_IDS
    ?? ""
  ).trim();
  const ownerTelegramUserId = (
    inputValues.ownerTelegramUserId
    ?? existingEnv.CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_USER_ID
    ?? deriveOwnerFromAllowlist(allowedTelegramUserIds)
    ?? ""
  ).trim();

  return {
    nodeEnv: (
      inputValues.nodeEnv
      ?? existingEnv.NODE_ENV
      ?? defaults.nodeEnv
    ).trim() || defaults.nodeEnv,
    telegramBotToken: (
      inputValues.telegramBotToken
      ?? existingEnv.CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN
      ?? ""
    ).trim(),
    verificationPasswordHash: resolveVerificationPasswordHash(existingEnv, inputValues),
    allowedTelegramUserIds,
    defaultWorkspaceRoot: resolve(
      (
        inputValues.defaultWorkspaceRoot
        ?? existingEnv.CODEX_TELEGRAM_BRIDGE_DEFAULT_WORKSPACE_ROOT
        ?? defaults.defaultWorkspaceRoot
      ).trim() || defaults.defaultWorkspaceRoot
    ),
    appHome: resolve(
      (
        inputValues.appHome
        ?? existingEnv.CODEX_TELEGRAM_BRIDGE_APP_HOME
        ?? defaults.appHome
      ).trim() || defaults.appHome
    ),
    codexHome: resolve(
      (
        inputValues.codexHome
        ?? existingEnv.CODEX_TELEGRAM_BRIDGE_CODEX_HOME
        ?? existingEnv.CODEX_HOME
        ?? defaults.codexHome
      ).trim() || defaults.codexHome
    ),
    logLevel: normalizeLogLevel(
      (
        inputValues.logLevel
        ?? existingEnv.CODEX_TELEGRAM_BRIDGE_LOG_LEVEL
        ?? defaults.logLevel
      ).trim() || defaults.logLevel
    ),
    ownerTelegramUserId: ownerTelegramUserId === "" ? null : ownerTelegramUserId
  };
}

export function buildEnvironmentEntries(
  existingEnv: NodeJS.ProcessEnv,
  values: SetupResolvedValues
): readonly [string, string][] {
  const knownEntries: [string, string][] = [
    ["NODE_ENV", values.nodeEnv],
    ["CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN", values.telegramBotToken],
    ...(values.verificationPasswordHash
      ? [["CODEX_TELEGRAM_BRIDGE_VERIFICATION_PASSWORD_HASH", values.verificationPasswordHash] as [string, string]]
      : []),
    ["CODEX_TELEGRAM_BRIDGE_ALLOWED_TELEGRAM_USER_IDS", values.allowedTelegramUserIds],
    ["CODEX_TELEGRAM_BRIDGE_DEFAULT_WORKSPACE_ROOT", values.defaultWorkspaceRoot],
    ["CODEX_TELEGRAM_BRIDGE_APP_HOME", values.appHome],
    ["CODEX_TELEGRAM_BRIDGE_CODEX_HOME", values.codexHome],
    ["CODEX_TELEGRAM_BRIDGE_LOG_LEVEL", values.logLevel]
  ];

  if (values.ownerTelegramUserId) {
    knownEntries.push(["CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_USER_ID", values.ownerTelegramUserId]);
  }

  const knownKeys = new Set(knownEntries.map(([key]) => key));
  const passthroughEntries = Object.entries(existingEnv)
    .filter(([key, value]) => value !== undefined && !knownKeys.has(key))
    .sort(([left], [right]) => left.localeCompare(right)) as [string, string][];

  return [...knownEntries, ...passthroughEntries];
}

async function promptForSetupValues(
  existingEnv: NodeJS.ProcessEnv,
  inputValues: SetupInputValues
): Promise<SetupResolvedValues> {
  const defaults = resolveSetupValues(existingEnv, inputValues);
  const output = new MutedOutput(process.stdout);
  const rl = createInterface({
    input: process.stdin,
    output
  });

  try {
    return {
      nodeEnv: await promptForValue(rl, "NODE_ENV", defaults.nodeEnv),
      telegramBotToken: await promptForSecretValue(
        rl,
        output,
        "Telegram bot token",
        defaults.telegramBotToken,
        { required: true }
      ),
      verificationPasswordHash: await promptForVerificationPasswordHash(
        rl,
        output,
        defaults.verificationPasswordHash
      ),
      allowedTelegramUserIds: await promptForValue(
        rl,
        "Allowed Telegram user IDs (comma-separated)",
        defaults.allowedTelegramUserIds,
        { required: true }
      ),
      defaultWorkspaceRoot: resolve(await promptForValue(
        rl,
        "Default workspace root",
        defaults.defaultWorkspaceRoot,
        { required: true }
      )),
      appHome: resolve(await promptForValue(
        rl,
        "App home",
        defaults.appHome,
        { required: true }
      )),
      codexHome: resolve(await promptForValue(
        rl,
        "Codex home",
        defaults.codexHome,
        { required: true }
      )),
      logLevel: normalizeLogLevel(await promptForValue(
        rl,
        "Log level",
        defaults.logLevel,
        { required: true }
      )),
      ownerTelegramUserId: normalizeOptionalValue(await promptForValue(
        rl,
        "Owner Telegram user ID",
        defaults.ownerTelegramUserId ?? deriveOwnerFromAllowlist(defaults.allowedTelegramUserIds) ?? ""
      ))
    };
  } finally {
    rl.close();
  }
}

async function promptForValue(
  rl: Interface,
  label: string,
  defaultValue: string,
  options: { readonly required?: boolean } = {}
): Promise<string> {
  while (true) {
    const suffix = defaultValue === "" ? "" : ` [${defaultValue}]`;
    const answer = (await rl.question(`${label}${suffix}: `)).trim();
    const value = answer === "" ? defaultValue : answer;

    if (!options.required || value.trim() !== "") {
      return value.trim();
    }

    process.stdout.write(`${label} is required.\n`);
  }
}

async function promptForSecretValue(
  rl: Interface,
  output: MutedOutput,
  label: string,
  defaultValue: string,
  options: { readonly required?: boolean } = {}
): Promise<string> {
  while (true) {
    const prompt = defaultValue === ""
      ? `${label}: `
      : `${label} [hidden, press Enter to keep existing]: `;

    output.setMuted(false);
    output.write(prompt);
    output.setMuted(true);
    const answer = (await rl.question("")).trim();
    output.setMuted(false);
    output.write("\n");

    const value = answer === "" ? defaultValue : answer;
    if (!options.required || value.trim() !== "") {
      return value.trim();
    }

    process.stdout.write(`${label} is required.\n`);
  }
}

async function promptForVerificationPasswordHash(
  rl: Interface,
  output: MutedOutput,
  existingHash: string | null
): Promise<string | null> {
  while (true) {
    const prompt = existingHash
      ? "Telegram verification password [hidden, press Enter to keep existing]: "
      : "Telegram verification password: ";
    const firstEntry = await promptForHiddenAnswer(rl, output, prompt);
    if (firstEntry === "") {
      if (existingHash) {
        return existingHash;
      }

      process.stdout.write("Telegram verification password is required.\n");
      continue;
    }

    const confirmation = await promptForHiddenAnswer(
      rl,
      output,
      "Confirm Telegram verification password: "
    );
    if (firstEntry !== confirmation) {
      process.stdout.write("Verification password confirmation did not match.\n");
      continue;
    }

    const normalizedPassword = normalizeVerificationPassword(firstEntry);
    if (normalizedPassword === "") {
      process.stdout.write("Telegram verification password is required.\n");
      continue;
    }

    return hashVerificationPassword(normalizedPassword);
  }
}

async function promptForHiddenAnswer(
  rl: Interface,
  output: MutedOutput,
  prompt: string
): Promise<string> {
  output.setMuted(false);
  output.write(prompt);
  output.setMuted(true);
  const answer = await rl.question("");
  output.setMuted(false);
  output.write("\n");
  return answer.trim();
}

async function readExistingEnvironmentFile(filePath: string): Promise<NodeJS.ProcessEnv> {
  if (!(await pathExists(filePath))) {
    return {};
  }

  return readEnvironmentFile(filePath);
}

function normalizeOptionalValue(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function normalizeLogLevel(value: string): AppLogLevel {
  const normalizedValue = value.trim().toLowerCase();
  if (normalizedValue === "debug" || normalizedValue === "info" || normalizedValue === "warn" || normalizedValue === "error") {
    return normalizedValue;
  }

  return "info";
}

function deriveOwnerFromAllowlist(value: string): string | null {
  const ids = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return ids.length === 1 ? ids[0] ?? null : null;
}

function resolveVerificationPasswordHash(
  existingEnv: NodeJS.ProcessEnv,
  inputValues: SetupInputValues
): string | null {
  if (inputValues.verificationPasswordHash !== undefined) {
    return normalizeOptionalValue(inputValues.verificationPasswordHash);
  }

  if (inputValues.verificationPassword !== undefined) {
    const normalizedPassword = normalizeVerificationPassword(inputValues.verificationPassword);
    return normalizedPassword === "" ? null : hashVerificationPassword(normalizedPassword);
  }

  return normalizeOptionalValue(existingEnv.CODEX_TELEGRAM_BRIDGE_VERIFICATION_PASSWORD_HASH ?? "");
}

function readNextValue(args: readonly string[], index: number, flag: string): string {
  const next = args[index + 1];
  if (!next) {
    throw new Error(`Missing value for ${flag}`);
  }

  return next;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
