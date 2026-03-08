export function serializeStringArray(values: readonly string[]): string {
  return JSON.stringify(Array.from(values));
}

export function parseStringArray(value: unknown): readonly string[] {
  const raw = toStringValue(value);
  const parsed = JSON.parse(raw) as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.some((entry) => typeof entry !== "string")
  ) {
    throw new Error("Expected JSON string array.");
  }

  return parsed as readonly string[];
}

export function serializeJson(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  return JSON.stringify(value);
}

export function parseJson(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  return JSON.parse(toStringValue(value)) as unknown;
}

export function toStringValue(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error(`Expected string SQLite value, received ${typeof value}.`);
  }

  return value;
}

export function toNullableStringValue(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return toStringValue(value);
}

export function toNumberValue(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  throw new Error(`Expected numeric SQLite value, received ${typeof value}.`);
}

export function integerToBoolean(value: unknown): boolean {
  const numericValue = toNumberValue(value);
  return numericValue !== 0;
}

export function booleanToInteger(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}
