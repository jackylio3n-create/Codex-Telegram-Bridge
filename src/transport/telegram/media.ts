import { mkdir, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { TelegramBotClient } from "./client.js";
import { pickPreferredPhotoSize } from "./photo.js";
import type {
  TelegramDocument,
  TelegramDownloadedMedia,
  TelegramMediaDescriptor,
  TelegramMessage
} from "./types.js";

export interface TelegramMediaDownloadOptions {
  readonly tempDirectoryPath: string;
  readonly maxFileSizeBytes: number;
}

export async function downloadTelegramImageToTemp(
  client: TelegramBotClient,
  message: TelegramMessage,
  options: TelegramMediaDownloadOptions
): Promise<TelegramDownloadedMedia | null> {
  const descriptor = pickImageDescriptor(message, options.maxFileSizeBytes);
  if (!descriptor) {
    return null;
  }

  await mkdir(options.tempDirectoryPath, { recursive: true });

  const telegramFile = await client.getFile(descriptor.telegramFileId);
  if (!telegramFile.file_path) {
    throw new Error(
      `Telegram file path is missing for ${descriptor.telegramFileId}.`
    );
  }

  const fileSize = telegramFile.file_size ?? 0;
  if (fileSize > options.maxFileSizeBytes) {
    throw new Error(
      `Telegram media exceeds the configured size cap (${fileSize} > ${options.maxFileSizeBytes}).`
    );
  }

  const extension = resolveTempExtension(
    descriptor.mimeType,
    telegramFile.file_path
  );
  const tempFilePath = join(
    options.tempDirectoryPath,
    `telegram-media-${randomUUID()}${extension}`
  );
  const fileContents = await client.downloadFile(telegramFile.file_path);
  await writeFile(tempFilePath, fileContents);

  return {
    ...descriptor,
    tempFilePath,
    async cleanup(): Promise<void> {
      await rm(tempFilePath, { force: true });
    }
  };
}

function pickImageDescriptor(
  message: TelegramMessage,
  maxFileSizeBytes: number
): TelegramMediaDescriptor | null {
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const photo = pickPreferredPhotoSize(message.photo);
    if ((photo.file_size ?? 0) > maxFileSizeBytes) {
      throw new Error(
        `Telegram photo exceeds the configured size cap (${photo.file_size} > ${maxFileSizeBytes}).`
      );
    }

    return {
      telegramFileId: photo.file_id,
      mimeType: "image/jpeg",
      viaDocument: false,
      ...(message.caption ? { caption: message.caption } : {})
    };
  }

  if (message.document && isImageDocument(message.document)) {
    if ((message.document.file_size ?? 0) > maxFileSizeBytes) {
      throw new Error(
        `Telegram document exceeds the configured size cap (${message.document.file_size} > ${maxFileSizeBytes}).`
      );
    }

    return {
      telegramFileId: message.document.file_id,
      mimeType: message.document.mime_type ?? "application/octet-stream",
      viaDocument: true,
      ...(message.caption ? { caption: message.caption } : {})
    };
  }

  return null;
}

function isImageDocument(document: TelegramDocument): boolean {
  return (
    typeof document.mime_type === "string" &&
    document.mime_type.startsWith("image/")
  );
}

function resolveTempExtension(mimeType: string, filePath: string): string {
  const byPath = extname(filePath).trim();
  if (byPath !== "") {
    return byPath;
  }

  switch (mimeType) {
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/jpeg":
    default:
      return ".jpg";
  }
}
