import type { TelegramChunk } from "./types.js";

export interface TelegramChunkingOptions {
  readonly maxLength: number;
}

export function chunkTelegramText(
  text: string,
  options: TelegramChunkingOptions
): readonly TelegramChunk[] {
  if (options.maxLength < 1) {
    throw new Error("Telegram chunk length must be positive.");
  }

  if (text.length <= options.maxLength) {
    return [{ text }];
  }

  const chunks: TelegramChunk[] = [];
  let remaining = text;

  while (remaining.length > options.maxLength) {
    const boundary = findChunkBoundary(remaining, options.maxLength);
    chunks.push({
      text: remaining.slice(0, boundary)
    });
    remaining = remaining.slice(boundary);
  }

  if (remaining.length > 0) {
    chunks.push({
      text: remaining
    });
  }

  return chunks;
}

export function createTelegramPreviewText(
  text: string,
  maxLength: number
): string {
  if (text.length <= maxLength) {
    return text;
  }

  const preview = text.slice(0, Math.max(maxLength - 3, 1)).trimEnd();
  return `${preview}...`;
}

function findChunkBoundary(text: string, maxLength: number): number {
  const candidate = text.slice(0, maxLength);
  const newlineIndex = candidate.lastIndexOf("\n");
  if (newlineIndex >= Math.floor(maxLength * 0.6)) {
    return newlineIndex + 1;
  }

  const spaceIndex = candidate.lastIndexOf(" ");
  if (spaceIndex >= Math.floor(maxLength * 0.6)) {
    return spaceIndex + 1;
  }

  return maxLength;
}
