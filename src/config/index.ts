import { access, mkdir, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type AppEnvironment = "development" | "test" | "production";
export type AppLogLevel = "debug" | "info" | "warn" | "error";
export type ConfigIssueSeverity = "error" | "warning";

export interface ConfigIssue {
  readonly severity: ConfigIssueSeverity;
  readonly field: string;
  readonly message: string;
  readonly hint?: string;
}

export interface AppDefaults {
  readonly previewMaxLength: 1500;
  readonly finalChunkMaxLength: 3600;
  readonly offsetJumpWarningThreshold: 10000;
}

export interface AppPaths {
  readonly appHome: string;
  readonly dataDir: string;
  readonly logsDir: string;
  readonly tempDir: string;
  readonly runtimeDir: string;
  readonly logFilePath: string;
  readonly stateFilePath: string;
  readonly pidFilePath: string;
}

export interface AppConfig {
  readonly appName: "codex-telegram-bridge";
  readonly env: AppEnvironment;
  readonly codexHome: string;
  readonly defaultWorkspaceRoot: string;
  readonly telegramBotToken: string;
  readonly allowedTelegramUserIds: readonly string[];
  readonly logLevel: AppLogLevel;
  readonly secretEnvVarNames: readonly string[];
  readonly paths: AppPaths;
  readonly defaults: AppDefaults;
}

export interface LoadAppConfigOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly homeDir?: string;
}

export interface LoadAppConfigResult {
  readonly config: AppConfig;
  readonly issues: readonly ConfigIssue[];
}

export interface ValidateStartupEnvironmentOptions {
  readonly createMissingDirectories?: boolean;
}

const APP_NAME = "codex-telegram-bridge" as const;
const ENV_PREFIX = "CODEX_TELEGRAM_BRIDGE_";
const DEFAULTS: AppDefaults = {
  previewMaxLength: 1500,
  finalChunkMaxLength: 3600,
  offsetJumpWarningThreshold: 10000
};
const SECRET_ENV_VAR_NAMES = Object.freeze([
  `${ENV_PREFIX}TELEGRAM_BOT_TOKEN`
]);
const LOG_LEVELS: readonly AppLogLevel[] = ["debug", "info", "warn", "error"];

export function loadAppConfig(options: LoadAppConfigOptions = {}): LoadAppConfigResult {
  const sourceEnv = options.env ?? process.env;
  const currentWorkingDirectory = resolve(options.cwd ?? process.cwd());
  const resolvedHomeDir = resolve(options.homeDir ?? homedir());
  const issues: ConfigIssue[] = [];

  const env = parseEnvironment(sourceEnv.NODE_ENV, issues);
  const appHome = resolveConfiguredPath(
    sourceEnv[`${ENV_PREFIX}APP_HOME`],
    join(resolvedHomeDir, ".codex-telegram-bridge"),
    currentWorkingDirectory,
    `${ENV_PREFIX}APP_HOME`,
    issues
  );
  const codexHome = resolveConfiguredPath(
    sourceEnv[`${ENV_PREFIX}CODEX_HOME`] ?? sourceEnv.CODEX_HOME,
    join(resolvedHomeDir, ".codex"),
    currentWorkingDirectory,
    `${ENV_PREFIX}CODEX_HOME`,
    issues
  );
  const defaultWorkspaceRoot = resolveConfiguredPath(
    sourceEnv[`${ENV_PREFIX}DEFAULT_WORKSPACE_ROOT`],
    "",
    currentWorkingDirectory,
    `${ENV_PREFIX}DEFAULT_WORKSPACE_ROOT`,
    issues,
    { required: true }
  );
  const telegramBotToken = readRequiredString(
    sourceEnv[`${ENV_PREFIX}TELEGRAM_BOT_TOKEN`],
    `${ENV_PREFIX}TELEGRAM_BOT_TOKEN`,
    issues
  );
  const allowedTelegramUserIds = parseAllowedTelegramUserIds(
    sourceEnv[`${ENV_PREFIX}ALLOWED_TELEGRAM_USER_IDS`],
    `${ENV_PREFIX}ALLOWED_TELEGRAM_USER_IDS`,
    issues
  );
  const logLevel = parseLogLevel(
    sourceEnv[`${ENV_PREFIX}LOG_LEVEL`],
    `${ENV_PREFIX}LOG_LEVEL`,
    issues
  );

  const paths: AppPaths = {
    appHome,
    dataDir: join(appHome, "data"),
    logsDir: join(appHome, "logs"),
    tempDir: join(appHome, "tmp"),
    runtimeDir: join(appHome, "run"),
    logFilePath: join(appHome, "logs", "bridge.log"),
    stateFilePath: join(appHome, "run", "runtime-state.json"),
    pidFilePath: join(appHome, "run", "bridge.pid")
  };

  const config: AppConfig = {
    appName: APP_NAME,
    env,
    codexHome,
    defaultWorkspaceRoot,
    telegramBotToken,
    allowedTelegramUserIds,
    logLevel,
    secretEnvVarNames: SECRET_ENV_VAR_NAMES,
    paths,
    defaults: DEFAULTS
  };

  return {
    config,
    issues
  };
}

export async function validateStartupEnvironment(
  config: AppConfig,
  options: ValidateStartupEnvironmentOptions = {}
): Promise<readonly ConfigIssue[]> {
  const issues: ConfigIssue[] = [];
  const createMissingDirectories = options.createMissingDirectories ?? false;

  await ensureManagedDirectory(config.paths.appHome, "paths.appHome", createMissingDirectories, issues);
  await ensureManagedDirectory(config.paths.dataDir, "paths.dataDir", createMissingDirectories, issues);
  await ensureManagedDirectory(config.paths.logsDir, "paths.logsDir", createMissingDirectories, issues);
  await ensureManagedDirectory(config.paths.tempDir, "paths.tempDir", createMissingDirectories, issues);
  await ensureManagedDirectory(config.paths.runtimeDir, "paths.runtimeDir", createMissingDirectories, issues);

  await ensureExistingDirectory(config.codexHome, "codexHome", issues);
  await ensureExistingDirectory(config.defaultWorkspaceRoot, "defaultWorkspaceRoot", issues);

  return issues;
}

export function formatConfigIssues(issues: readonly ConfigIssue[]): string {
  if (issues.length === 0) {
    return "No configuration issues.";
  }

  return issues
    .map((issue) => {
      const hint = issue.hint ? ` Hint: ${issue.hint}` : "";
      return `[${issue.severity.toUpperCase()}] ${issue.field}: ${issue.message}${hint}`;
    })
    .join("\n");
}

export function redactConfigForDisplay(config: AppConfig): Record<string, unknown> {
  return {
    appName: config.appName,
    env: config.env,
    codexHome: config.codexHome,
    defaultWorkspaceRoot: config.defaultWorkspaceRoot,
    telegramBotToken: maskSecret(config.telegramBotToken),
    allowedTelegramUserIds: [...config.allowedTelegramUserIds],
    logLevel: config.logLevel,
    secretEnvVarNames: [...config.secretEnvVarNames],
    paths: {
      ...config.paths
    },
    defaults: {
      ...config.defaults
    }
  };
}

function parseEnvironment(rawValue: string | undefined, issues: ConfigIssue[]): AppEnvironment {
  if (rawValue === undefined || rawValue.trim() === "") {
    return "development";
  }

  const normalizedValue = rawValue.trim().toLowerCase();
  if (
    normalizedValue === "development" ||
    normalizedValue === "test" ||
    normalizedValue === "production"
  ) {
    return normalizedValue;
  }

  issues.push({
    severity: "error",
    field: "NODE_ENV",
    message: `Unsupported environment "${rawValue}".`,
    hint: 'Use one of: "development", "test", or "production".'
  });
  return "development";
}

function readRequiredString(
  rawValue: string | undefined,
  field: string,
  issues: ConfigIssue[]
): string {
  if (rawValue === undefined || rawValue.trim() === "") {
    issues.push({
      severity: "error",
      field,
      message: "Missing required environment variable."
    });
    return "";
  }

  return rawValue.trim();
}

function parseAllowedTelegramUserIds(
  rawValue: string | undefined,
  field: string,
  issues: ConfigIssue[]
): readonly string[] {
  if (rawValue === undefined || rawValue.trim() === "") {
    issues.push({
      severity: "error",
      field,
      message: "At least one allowed Telegram user ID is required.",
      hint: "Provide a comma-separated list of numeric user IDs."
    });
    return [];
  }

  const seen = new Set<string>();
  const parsedIds: string[] = [];

  for (const token of rawValue.split(",")) {
    const normalizedToken = token.trim();
    if (normalizedToken === "") {
      continue;
    }

    if (!/^\d+$/.test(normalizedToken)) {
      issues.push({
        severity: "error",
        field,
        message: `Invalid Telegram user ID "${normalizedToken}".`,
        hint: "User IDs must contain digits only."
      });
      continue;
    }

    if (seen.has(normalizedToken)) {
      continue;
    }

    seen.add(normalizedToken);
    parsedIds.push(normalizedToken);
  }

  if (parsedIds.length === 0) {
    issues.push({
      severity: "error",
      field,
      message: "No valid Telegram user IDs were provided."
    });
  }

  return parsedIds;
}

function parseLogLevel(
  rawValue: string | undefined,
  field: string,
  issues: ConfigIssue[]
): AppLogLevel {
  if (rawValue === undefined || rawValue.trim() === "") {
    return "info";
  }

  const normalizedValue = rawValue.trim().toLowerCase() as AppLogLevel;
  if (LOG_LEVELS.includes(normalizedValue)) {
    return normalizedValue;
  }

  issues.push({
    severity: "error",
    field,
    message: `Unsupported log level "${rawValue}".`,
    hint: 'Use one of: "debug", "info", "warn", or "error".'
  });
  return "info";
}

function resolveConfiguredPath(
  rawValue: string | undefined,
  defaultValue: string,
  currentWorkingDirectory: string,
  field: string,
  issues: ConfigIssue[],
  options: { required?: boolean } = {}
): string {
  const trimmedValue = rawValue?.trim();
  if (trimmedValue === undefined || trimmedValue === "") {
    if (options.required) {
      issues.push({
        severity: "error",
        field,
        message: "Missing required absolute path."
      });
      return "";
    }

    return defaultValue;
  }

  if (!isAbsolute(trimmedValue)) {
    issues.push({
      severity: "error",
      field,
      message: `Path "${trimmedValue}" is not absolute.`,
      hint: "Use a fully qualified path visible to the runtime."
    });
  }

  return resolve(currentWorkingDirectory, trimmedValue);
}

async function ensureManagedDirectory(
  directoryPath: string,
  field: string,
  createIfMissing: boolean,
  issues: ConfigIssue[]
): Promise<void> {
  if (directoryPath.trim() === "") {
    issues.push({
      severity: "error",
      field,
      message: "Directory path is empty."
    });
    return;
  }

  try {
    if (createIfMissing) {
      await mkdir(directoryPath, { recursive: true });
      const exists = await ensureExistingDirectory(directoryPath, field, issues);
      if (!exists) {
        return;
      }
    } else {
      const state = await getDirectoryState(directoryPath);
      if (state === "missing") {
        await warnIfDirectoryCreatable(directoryPath, field, issues);
        return;
      }

      if (state === "not_directory") {
        issues.push({
          severity: "error",
          field,
          message: `Path is not a directory: ${directoryPath}.`
        });
        return;
      }
    }

    await access(directoryPath, fsConstants.W_OK);
  } catch (error) {
    issues.push({
      severity: "error",
      field,
      message: `Directory is not writable: ${directoryPath}.`,
      hint: getErrorMessage(error)
    });
  }
}

async function getDirectoryState(directoryPath: string): Promise<"directory" | "missing" | "not_directory"> {
  try {
    const entry = await stat(directoryPath);
    return entry.isDirectory() ? "directory" : "not_directory";
  } catch (error) {
    if (isNotFoundError(error)) {
      return "missing";
    }

    throw error;
  }
}

async function warnIfDirectoryCreatable(
  directoryPath: string,
  field: string,
  issues: ConfigIssue[]
): Promise<void> {
  const writableAncestor = await findNearestExistingAncestor(directoryPath);
  if (writableAncestor === null) {
    issues.push({
      severity: "error",
      field,
      message: `Directory does not exist and no existing parent could be validated: ${directoryPath}.`
    });
    return;
  }

  try {
    await access(writableAncestor, fsConstants.W_OK);
    issues.push({
      severity: "warning",
      field,
      message: `Directory does not exist yet: ${directoryPath}.`,
      hint: `The bridge can create it on start. Verified writable parent: ${writableAncestor}.`
    });
  } catch (error) {
    issues.push({
      severity: "error",
      field,
      message: `Directory does not exist and parent is not writable: ${directoryPath}.`,
      hint: getErrorMessage(error)
    });
  }
}

async function findNearestExistingAncestor(directoryPath: string): Promise<string | null> {
  let currentPath = dirname(directoryPath);
  let previousPath = "";

  while (currentPath !== previousPath) {
    try {
      const entry = await stat(currentPath);
      return entry.isDirectory() ? currentPath : null;
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    previousPath = currentPath;
    currentPath = dirname(currentPath);
  }

  return null;
}

async function ensureExistingDirectory(
  directoryPath: string,
  field: string,
  issues: ConfigIssue[]
): Promise<boolean> {
  if (directoryPath.trim() === "") {
    issues.push({
      severity: "error",
      field,
      message: "Directory path is empty."
    });
    return false;
  }

  try {
    const entry = await stat(directoryPath);
    if (!entry.isDirectory()) {
      issues.push({
        severity: "error",
        field,
        message: `Path is not a directory: ${directoryPath}.`
      });
      return false;
    }

    return true;
  } catch (error) {
    issues.push({
      severity: "error",
      field,
      message: `Directory does not exist: ${directoryPath}.`,
      hint: getErrorMessage(error)
    });
    return false;
  }
}

function maskSecret(secret: string): string {
  if (secret.length <= 4) {
    return "*".repeat(Math.max(secret.length, 4));
  }

  return `${secret.slice(0, 2)}${"*".repeat(Math.max(secret.length - 4, 4))}${secret.slice(-2)}`;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }

  return "Unknown filesystem error.";
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
