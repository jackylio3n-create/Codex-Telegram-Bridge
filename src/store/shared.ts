export type StoreClock = () => Date;

export function toIsoTimestamp(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
}
