import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CodexAccountStatus, CodexRateLimitWindow } from "./types.js";

const DEFAULT_STATUS_TEXT = [
  "Model: unavailable",
  "Reasoning effort: unavailable",
  "5-hour limit remaining (latest known): unavailable",
  "Weekly limit remaining (latest known): unavailable"
].join("\n");

const SESSION_SCAN_LIMIT = 20;

export async function readCodexAccountStatus(codexHome: string): Promise<CodexAccountStatus> {
  const [config, rateLimits] = await Promise.all([
    readCodexConfig(codexHome),
    readLatestKnownRateLimits(codexHome)
  ]);

  return {
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    fiveHourRemainingPercent: toRemainingPercent(rateLimits?.primary ?? null),
    weeklyRemainingPercent: toRemainingPercent(rateLimits?.secondary ?? null),
    quotasUpdatedAt: rateLimits?.timestamp ?? null
  };
}

export function formatCodexAccountStatus(status: CodexAccountStatus): string {
  return [
    `Model: ${status.model ?? "unavailable"}`,
    `Reasoning effort: ${status.reasoningEffort ?? "unavailable"}`,
    `5-hour limit remaining (latest known): ${formatRemainingPercent(status.fiveHourRemainingPercent)}`,
    `Weekly limit remaining (latest known): ${formatRemainingPercent(status.weeklyRemainingPercent)}`
  ].join("\n");
}

export function createCodexStatusTextProvider(
  codexHome: string,
  options: {
    readonly cacheTtlMs?: number;
  } = {}
): () => Promise<string> {
  const cacheTtlMs = options.cacheTtlMs ?? 30_000;
  let cachedText: string | null = null;
  let cachedAt = 0;
  let inFlight: Promise<string> | null = null;

  return async (): Promise<string> => {
    const now = Date.now();
    if (cachedText && now - cachedAt < cacheTtlMs) {
      return cachedText;
    }

    if (inFlight) {
      return inFlight;
    }

    inFlight = (async () => {
      try {
        const snapshot = await readCodexAccountStatus(codexHome);
        const text = formatCodexAccountStatus(snapshot);
        cachedText = text;
        cachedAt = Date.now();
        return text;
      } catch {
        cachedText = DEFAULT_STATUS_TEXT;
        cachedAt = Date.now();
        return DEFAULT_STATUS_TEXT;
      }
    })();

    try {
      return await inFlight;
    } finally {
      inFlight = null;
    }
  };
}

async function readCodexConfig(codexHome: string): Promise<{
  readonly model: string | null;
  readonly reasoningEffort: string | null;
}> {
  try {
    const raw = await readFile(join(codexHome, "config.toml"), "utf8");
    return {
      model: readTomlString(raw, "model"),
      reasoningEffort: readTomlString(raw, "model_reasoning_effort")
    };
  } catch {
    return {
      model: null,
      reasoningEffort: null
    };
  }
}

async function readLatestKnownRateLimits(codexHome: string): Promise<{
  readonly primary: CodexRateLimitWindow | null;
  readonly secondary: CodexRateLimitWindow | null;
  readonly timestamp: string | null;
} | null> {
  const sessionFiles = await listRecentSessionFiles(join(codexHome, "sessions"));
  for (const filePath of sessionFiles) {
    const rateLimits = await readRateLimitsFromSessionFile(filePath);
    if (rateLimits) {
      return rateLimits;
    }
  }

  return null;
}

async function listRecentSessionFiles(sessionsRoot: string): Promise<readonly string[]> {
  try {
    const filePaths = await walkSessionFiles(sessionsRoot);
    return filePaths
      .filter((filePath) => filePath.endsWith(".jsonl"))
      .sort((left, right) => right.localeCompare(left))
      .slice(0, SESSION_SCAN_LIMIT);
  } catch {
    return [];
  }
}

async function walkSessionFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const filePaths: string[] = [];

  for (const entry of entries) {
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      filePaths.push(...await walkSessionFiles(absolutePath));
      continue;
    }

    if (entry.isFile()) {
      filePaths.push(absolutePath);
    }
  }

  return filePaths;
}

async function readRateLimitsFromSessionFile(filePath: string): Promise<{
  readonly primary: CodexRateLimitWindow | null;
  readonly secondary: CodexRateLimitWindow | null;
  readonly timestamp: string | null;
} | null> {
  const raw = await readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line || !line.includes("\"rate_limits\"")) {
      continue;
    }

    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const payload = asRecord(parsed.payload);
      const rateLimits = payload ? asRecord(payload.rate_limits) : null;
      if (!rateLimits) {
        continue;
      }

      return {
        primary: readRateLimitWindow(rateLimits.primary),
        secondary: readRateLimitWindow(rateLimits.secondary),
        timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : null
      };
    } catch {
      continue;
    }
  }

  return null;
}

function readTomlString(raw: string, key: string): string | null {
  const match = raw.match(new RegExp(`^\\s*${escapeRegularExpression(key)}\\s*=\\s*\"([^\"]*)\"`, "m"));
  return match?.[1] ?? null;
}

function readRateLimitWindow(value: unknown): CodexRateLimitWindow | null {
  const record = asRecord(value);
  if (!record || typeof record.used_percent !== "number") {
    return null;
  }

  return {
    usedPercent: record.used_percent,
    windowMinutes: typeof record.window_minutes === "number" ? record.window_minutes : null,
    resetsAt: typeof record.resets_at === "number" ? record.resets_at : null
  };
}

function toRemainingPercent(window: CodexRateLimitWindow | null): number | null {
  if (!window) {
    return null;
  }

  return clampPercent(100 - window.usedPercent);
}

function formatRemainingPercent(value: number | null): string {
  if (value === null) {
    return "unavailable";
  }

  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded.toFixed(0)}%` : `${rounded.toFixed(1)}%`;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
