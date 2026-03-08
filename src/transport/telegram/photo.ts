import type { TelegramPhotoSize } from "./types.js";

export function pickPreferredPhotoSize(
  photoSizes: readonly TelegramPhotoSize[]
): TelegramPhotoSize {
  let preferred = photoSizes[0];
  if (!preferred) {
    throw new Error("At least one Telegram photo size is required.");
  }

  let preferredWeight = scorePhotoSize(preferred);
  for (let index = 1; index < photoSizes.length; index += 1) {
    const candidate = photoSizes[index];
    if (!candidate) {
      continue;
    }

    const candidateWeight = scorePhotoSize(candidate);
    if (candidateWeight > preferredWeight) {
      preferred = candidate;
      preferredWeight = candidateWeight;
    }
  }

  return preferred;
}

function scorePhotoSize(photoSize: TelegramPhotoSize): number {
  return (photoSize.file_size ?? 0) + photoSize.width * photoSize.height;
}
