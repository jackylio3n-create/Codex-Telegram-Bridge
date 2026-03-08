import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  APP_NAME,
  DEFAULTS,
  ENV_PREFIX,
  SECRET_ENV_VAR_NAMES
} from "./constants.js";
import {
  parseAllowedTelegramUserIds,
  parseAuditLevel,
  parseBooleanFlag,
  parseEnvironment,
  parseLogLevel,
  parseNonNegativeInteger,
  parseOptionalNumericTelegramId,
  parseOptionalVerificationPasswordHash,
  readRequiredString,
  resolveConfiguredPath,
  resolveOwnerTelegramUserId
} from "./parsing.js";
import { redactConfigForDisplay } from "./redaction.js";
import { validateStartupEnvironment } from "./validation.js";

export type AppEnvironment = "development" | "test" | "production";
export type AppLogLevel = "debug" | "info" | "warn" | "error";
export type AppAuditLevel = "minimal" | "debug";
export type ConfigIssueSeverity = "error" | "warning";

export interface ConfigIssue {
  readonly severity: ConfigIssueSeverity;
  readonly field: string;
  readonly message: string;
  readonly hint?: string;
}

export interface AppDefaults {
  readonly previewMaxLength: number;
  readonly finalChunkMaxLength: number;
  readonly offsetJumpWarningThreshold: number;
  readonly auditLevel: AppAuditLevel;
  readonly includeRuntimeIdentifiers: boolean;
  readonly maxAuditRows: number;
  readonly maxSummariesPerSession: number;
  readonly resolvedApprovalRetentionDays: number;
  readonly expiredApprovalRetentionDays: number;
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
  readonly verificationPasswordHash: string | null;
  readonly allowedTelegramUserIds: readonly string[];
  readonly ownerTelegramUserId: string | null;
  readonly ownerTelegramChatId: string | null;
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

export function loadAppConfig(
  options: LoadAppConfigOptions = {}
): LoadAppConfigResult {
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
  const verificationPasswordHash = parseOptionalVerificationPasswordHash(
    sourceEnv[`${ENV_PREFIX}VERIFICATION_PASSWORD_HASH`],
    `${ENV_PREFIX}VERIFICATION_PASSWORD_HASH`,
    issues
  );
  const allowedTelegramUserIds = parseAllowedTelegramUserIds(
    sourceEnv[`${ENV_PREFIX}ALLOWED_TELEGRAM_USER_IDS`],
    `${ENV_PREFIX}ALLOWED_TELEGRAM_USER_IDS`,
    issues
  );
  const ownerTelegramUserId = resolveOwnerTelegramUserId(
    sourceEnv[`${ENV_PREFIX}OWNER_TELEGRAM_USER_ID`],
    allowedTelegramUserIds,
    `${ENV_PREFIX}OWNER_TELEGRAM_USER_ID`,
    `${ENV_PREFIX}ALLOWED_TELEGRAM_USER_IDS`,
    issues
  );
  const ownerTelegramChatId = parseOptionalNumericTelegramId(
    sourceEnv[`${ENV_PREFIX}OWNER_TELEGRAM_CHAT_ID`],
    `${ENV_PREFIX}OWNER_TELEGRAM_CHAT_ID`,
    issues
  );
  const logLevel = parseLogLevel(
    sourceEnv[`${ENV_PREFIX}LOG_LEVEL`],
    `${ENV_PREFIX}LOG_LEVEL`,
    issues
  );
  const defaults: AppDefaults = {
    ...DEFAULTS,
    auditLevel: parseAuditLevel(
      sourceEnv[`${ENV_PREFIX}AUDIT_LEVEL`],
      `${ENV_PREFIX}AUDIT_LEVEL`,
      issues
    ),
    includeRuntimeIdentifiers: parseBooleanFlag(
      sourceEnv[`${ENV_PREFIX}INCLUDE_RUNTIME_IDENTIFIERS`],
      `${ENV_PREFIX}INCLUDE_RUNTIME_IDENTIFIERS`,
      DEFAULTS.includeRuntimeIdentifiers,
      issues
    ),
    maxAuditRows: parseNonNegativeInteger(
      sourceEnv[`${ENV_PREFIX}MAX_AUDIT_ROWS`],
      `${ENV_PREFIX}MAX_AUDIT_ROWS`,
      DEFAULTS.maxAuditRows,
      issues
    ),
    maxSummariesPerSession: parseNonNegativeInteger(
      sourceEnv[`${ENV_PREFIX}MAX_SUMMARIES_PER_SESSION`],
      `${ENV_PREFIX}MAX_SUMMARIES_PER_SESSION`,
      DEFAULTS.maxSummariesPerSession,
      issues
    ),
    resolvedApprovalRetentionDays: parseNonNegativeInteger(
      sourceEnv[`${ENV_PREFIX}RESOLVED_APPROVAL_RETENTION_DAYS`],
      `${ENV_PREFIX}RESOLVED_APPROVAL_RETENTION_DAYS`,
      DEFAULTS.resolvedApprovalRetentionDays,
      issues
    ),
    expiredApprovalRetentionDays: parseNonNegativeInteger(
      sourceEnv[`${ENV_PREFIX}EXPIRED_APPROVAL_RETENTION_DAYS`],
      `${ENV_PREFIX}EXPIRED_APPROVAL_RETENTION_DAYS`,
      DEFAULTS.expiredApprovalRetentionDays,
      issues
    )
  };

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

  return {
    config: {
      appName: APP_NAME,
      env,
      codexHome,
      defaultWorkspaceRoot,
      telegramBotToken,
      verificationPasswordHash,
      allowedTelegramUserIds,
      ownerTelegramUserId,
      ownerTelegramChatId,
      logLevel,
      secretEnvVarNames: SECRET_ENV_VAR_NAMES,
      paths,
      defaults
    },
    issues
  };
}

export { redactConfigForDisplay, validateStartupEnvironment };

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
