import { isAbsolute, resolve } from "node:path";
import { isVerificationPasswordHash } from "../security/verification-password.js";
import { AUDIT_LEVELS, DEFAULTS, LOG_LEVELS } from "./constants.js";
import type {
  AppAuditLevel,
  AppEnvironment,
  AppLogLevel,
  ConfigIssue
} from "./index.js";

export function parseEnvironment(
  rawValue: string | undefined,
  issues: ConfigIssue[]
): AppEnvironment {
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

export function readRequiredString(
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

export function parseAllowedTelegramUserIds(
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

export function parseOptionalVerificationPasswordHash(
  rawValue: string | undefined,
  field: string,
  issues: ConfigIssue[]
): string | null {
  const normalizedValue = rawValue?.trim();
  if (normalizedValue === undefined || normalizedValue === "") {
    return null;
  }

  if (!isVerificationPasswordHash(normalizedValue)) {
    issues.push({
      severity: "error",
      field,
      message: "Verification password hash is invalid.",
      hint: "Regenerate it with `npm run setup` instead of editing it manually."
    });
    return null;
  }

  return normalizedValue;
}

export function resolveOwnerTelegramUserId(
  rawValue: string | undefined,
  allowedUserIds: readonly string[],
  field: string,
  allowedField: string,
  issues: ConfigIssue[]
): string | null {
  const explicitOwnerId = parseOptionalNumericTelegramId(
    rawValue,
    field,
    issues
  );
  if (explicitOwnerId) {
    if (!allowedUserIds.includes(explicitOwnerId)) {
      issues.push({
        severity: "error",
        field,
        message: `Owner Telegram user ID "${explicitOwnerId}" must also be present in ${allowedField}.`
      });
    }

    return explicitOwnerId;
  }

  if (allowedUserIds.length === 1) {
    return allowedUserIds[0] ?? null;
  }

  if (allowedUserIds.length > 1) {
    issues.push({
      severity: "warning",
      field,
      message: "Owner Telegram user ID is not locked.",
      hint: `Set ${field} to one of the allowlisted IDs if this bot should remain self-use only.`
    });
  }

  return null;
}

export function parseOptionalNumericTelegramId(
  rawValue: string | undefined,
  field: string,
  issues: ConfigIssue[]
): string | null {
  const normalizedValue = rawValue?.trim();
  if (normalizedValue === undefined || normalizedValue === "") {
    return null;
  }

  if (!/^\d+$/.test(normalizedValue)) {
    issues.push({
      severity: "error",
      field,
      message: `Invalid Telegram ID "${normalizedValue}".`,
      hint: "Telegram IDs must contain digits only."
    });
    return null;
  }

  return normalizedValue;
}

export function parseLogLevel(
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

export function parseAuditLevel(
  rawValue: string | undefined,
  field: string,
  issues: ConfigIssue[]
): AppAuditLevel {
  if (rawValue === undefined || rawValue.trim() === "") {
    return DEFAULTS.auditLevel;
  }

  const normalizedValue = rawValue.trim().toLowerCase() as AppAuditLevel;
  if (AUDIT_LEVELS.includes(normalizedValue)) {
    return normalizedValue;
  }

  issues.push({
    severity: "error",
    field,
    message: `Unsupported audit level "${rawValue}".`,
    hint: 'Use one of: "minimal" or "debug".'
  });
  return DEFAULTS.auditLevel;
}

export function parseBooleanFlag(
  rawValue: string | undefined,
  field: string,
  fallback: boolean,
  issues: ConfigIssue[]
): boolean {
  if (rawValue === undefined || rawValue.trim() === "") {
    return fallback;
  }

  const normalizedValue = rawValue.trim().toLowerCase();
  if (
    normalizedValue === "true" ||
    normalizedValue === "1" ||
    normalizedValue === "yes"
  ) {
    return true;
  }

  if (
    normalizedValue === "false" ||
    normalizedValue === "0" ||
    normalizedValue === "no"
  ) {
    return false;
  }

  issues.push({
    severity: "error",
    field,
    message: `Unsupported boolean value "${rawValue}".`,
    hint: 'Use one of: "true", "false", "1", "0", "yes", or "no".'
  });
  return fallback;
}

export function parseNonNegativeInteger(
  rawValue: string | undefined,
  field: string,
  fallback: number,
  issues: ConfigIssue[]
): number {
  if (rawValue === undefined || rawValue.trim() === "") {
    return fallback;
  }

  if (!/^\d+$/.test(rawValue.trim())) {
    issues.push({
      severity: "error",
      field,
      message: `Invalid non-negative integer "${rawValue}".`
    });
    return fallback;
  }

  return Number(rawValue.trim());
}

export function resolveConfiguredPath(
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
