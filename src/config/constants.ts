import type { AppAuditLevel, AppDefaults, AppLogLevel } from "./index.js";

export const APP_NAME = "codex-telegram-bridge" as const;
export const ENV_PREFIX = "CODEX_TELEGRAM_BRIDGE_";
export const DEFAULTS: AppDefaults = {
  previewMaxLength: 1500,
  finalChunkMaxLength: 3600,
  offsetJumpWarningThreshold: 10000,
  auditLevel: "minimal",
  includeRuntimeIdentifiers: false,
  maxAuditRows: 1000,
  maxSummariesPerSession: 10,
  resolvedApprovalRetentionDays: 7,
  expiredApprovalRetentionDays: 1
};
export const SECRET_ENV_VAR_NAMES = Object.freeze([
  `${ENV_PREFIX}TELEGRAM_BOT_TOKEN`,
  `${ENV_PREFIX}VERIFICATION_PASSWORD_HASH`
]);
export const LOG_LEVELS: readonly AppLogLevel[] = [
  "debug",
  "info",
  "warn",
  "error"
];
export const AUDIT_LEVELS: readonly AppAuditLevel[] = ["minimal", "debug"];
