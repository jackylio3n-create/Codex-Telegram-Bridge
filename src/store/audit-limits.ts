import type { AuditLogEventLimit } from "./types.js";

export function normalizeAuditLogEventLimits(
  limits: readonly AuditLogEventLimit[]
): readonly AuditLogEventLimit[] {
  const normalized = new Map<string, number>();

  for (const entry of limits) {
    if (entry.limit < 1) {
      continue;
    }

    normalized.set(entry.eventType, entry.limit);
  }

  return Array.from(normalized, ([eventType, limit]) => ({
    eventType,
    limit
  }));
}
