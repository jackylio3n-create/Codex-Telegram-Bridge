import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { inspect } from "node:util";

const LOG_LEVEL_ORDER = ["debug", "info", "warn", "error"] as const;
const LOG_LEVEL_RANK: Record<(typeof LOG_LEVEL_ORDER)[number], number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};
const LOG_LEVEL_SET = new Set<(typeof LOG_LEVEL_ORDER)[number]>(LOG_LEVEL_ORDER);
const DEFAULT_REDACT_KEYS = [
  "authorization",
  "cookie",
  "password",
  "passwd",
  "secret",
  "token",
  "api_key",
  "apikey",
  "access_token",
  "refresh_token"
] as const;

export type LogLevel = (typeof LOG_LEVEL_ORDER)[number];
export type LogFields = Record<string, unknown>;

export interface LoggerOptions {
  readonly name?: string;
  readonly level?: LogLevel;
  readonly console?: boolean;
  readonly filePath?: string;
  readonly bindings?: LogFields;
  readonly redactKeys?: readonly string[];
  readonly redactValues?: readonly string[];
  readonly clock?: () => Date;
}

export interface Logger {
  readonly level: LogLevel;
  child(bindings?: LogFields): Logger;
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

interface LogRecord {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly logger: string;
  readonly message: string;
  readonly fields?: LogFields;
}

interface SanitizerState {
  readonly redactKeys: readonly string[];
  readonly redactValues: readonly string[];
  readonly seen: WeakSet<object>;
}

const DEFAULT_LOGGER_NAME = "codex-telegram-bridge";
const REDACTED = "[REDACTED]";

export function createLogger(options: LoggerOptions = {}): Logger {
  const name = options.name ?? DEFAULT_LOGGER_NAME;
  const level = normalizeLogLevel(options.level ?? "info");
  const consoleEnabled = options.console ?? true;
  const bindings = options.bindings ?? {};
  const redactKeys = normalizeRedactKeys(options.redactKeys);
  const redactValues = normalizeRedactValues(options.redactValues);
  const clock = options.clock ?? (() => new Date());

  if (options.filePath) {
    mkdirSync(dirname(options.filePath), { recursive: true });
  }

  const write = (record: LogRecord): void => {
    if (consoleEnabled) {
      writeConsoleRecord(record);
    }

    if (options.filePath) {
      appendFileSync(options.filePath, `${JSON.stringify(record)}\n`, "utf8");
    }
  };

  const log = (recordLevel: LogLevel, message: string, fields?: LogFields): void => {
    if (!shouldLog(level, recordLevel)) {
      return;
    }

    const sanitizedFields = sanitizeLogValue(
      mergeFields(bindings, fields),
      redactKeys,
      redactValues
    );

    const record: LogRecord = {
      timestamp: clock().toISOString(),
      level: recordLevel,
      logger: name,
      message: sanitizeMessage(message, redactValues),
      ...(hasEntries(sanitizedFields) ? { fields: sanitizedFields as LogFields } : {})
    };

    write(record);
  };

  return {
    level,
    child(childBindings?: LogFields): Logger {
      const nextBindings = mergeFields(bindings, childBindings);
      return createLogger({
        ...options,
        name,
        level,
        console: consoleEnabled,
        redactKeys,
        redactValues,
        clock,
        ...(options.filePath ? { filePath: options.filePath } : {}),
        ...(nextBindings ? { bindings: nextBindings } : {})
      });
    },
    debug(message: string, fields?: LogFields): void {
      log("debug", message, fields);
    },
    info(message: string, fields?: LogFields): void {
      log("info", message, fields);
    },
    warn(message: string, fields?: LogFields): void {
      log("warn", message, fields);
    },
    error(message: string, fields?: LogFields): void {
      log("error", message, fields);
    }
  };
}

export function sanitizeLogValue(
  value: unknown,
  redactKeys: readonly string[] = DEFAULT_REDACT_KEYS,
  redactValues: readonly string[] = []
): unknown {
  return sanitizeUnknown(value, {
    redactKeys: normalizeRedactKeys(redactKeys),
    redactValues: normalizeRedactValues(redactValues),
    seen: new WeakSet<object>()
  });
}

function sanitizeUnknown(value: unknown, state: SanitizerState, key?: string): unknown {
  if (key && shouldRedactKey(key, state.redactKeys)) {
    return REDACTED;
  }

  if (typeof value === "string") {
    return sanitizeMessage(value, state.redactValues);
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "undefined") {
    return "[undefined]";
  }

  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return sanitizeError(value, state);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeUnknown(entry, state));
  }

  if (typeof value === "object") {
    if (state.seen.has(value)) {
      return "[Circular]";
    }

    state.seen.add(value);

    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      output[entryKey] = sanitizeUnknown(entryValue, state, entryKey);
    }
    return output;
  }

  return sanitizeMessage(inspect(value, { depth: 3, breakLength: Infinity }), state.redactValues);
}

function sanitizeError(error: Error, state: SanitizerState): Record<string, unknown> {
  const output: Record<string, unknown> = {
    name: error.name,
    message: sanitizeMessage(error.message, state.redactValues)
  };

  if (error.stack) {
    output.stack = sanitizeMessage(error.stack, state.redactValues);
  }

  const asRecord = error as Error & Record<string, unknown>;
  for (const [key, value] of Object.entries(asRecord)) {
    if (key === "name" || key === "message" || key === "stack") {
      continue;
    }

    output[key] = sanitizeUnknown(value, state, key);
  }

  return output;
}

function writeConsoleRecord(record: LogRecord): void {
  const stream = record.level === "error" || record.level === "warn" ? process.stderr : process.stdout;
  const fieldsText = record.fields ? ` ${JSON.stringify(record.fields)}` : "";
  stream.write(`${record.timestamp} ${record.level.toUpperCase()} ${record.logger} ${record.message}${fieldsText}\n`);
}

function mergeFields(base?: LogFields, extra?: LogFields): LogFields | undefined {
  if (!base && !extra) {
    return undefined;
  }

  return {
    ...(base ?? {}),
    ...(extra ?? {})
  };
}

function hasEntries(value: unknown): boolean {
  return typeof value === "object" && value !== null && Object.keys(value).length > 0;
}

function shouldLog(currentLevel: LogLevel, recordLevel: LogLevel): boolean {
  return LOG_LEVEL_RANK[recordLevel] >= LOG_LEVEL_RANK[currentLevel];
}

function normalizeLogLevel(level: string): LogLevel {
  if (LOG_LEVEL_SET.has(level as LogLevel)) {
    return level as LogLevel;
  }

  return "info";
}

function normalizeRedactKeys(keys?: readonly string[]): readonly string[] {
  const normalized = new Set<string>(DEFAULT_REDACT_KEYS);
  for (const key of keys ?? []) {
    if (key.trim()) {
      normalized.add(key.trim().toLowerCase());
    }
  }
  return Array.from(normalized);
}

function normalizeRedactValues(values?: readonly string[]): readonly string[] {
  const normalized = new Set<string>();
  for (const value of values ?? []) {
    if (value.trim()) {
      normalized.add(value.trim());
    }
  }
  return Array.from(normalized);
}

function sanitizeMessage(message: string, redactValues: readonly string[]): string {
  let sanitized = message;

  for (const secret of redactValues) {
    sanitized = sanitized.split(secret).join(REDACTED);
  }

  return sanitized;
}

function shouldRedactKey(key: string, redactKeys: readonly string[]): boolean {
  const normalizedKey = key.toLowerCase();
  return redactKeys.some((candidate) => normalizedKey === candidate || normalizedKey.includes(candidate));
}
