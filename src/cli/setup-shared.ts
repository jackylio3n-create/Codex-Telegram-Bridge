import type { AppLogLevel } from "../config/index.js";

export interface ParsedSetupOptions {
  readonly envFilePath: string;
  readonly interactive: boolean;
  readonly showHelp: boolean;
  readonly values: SetupInputValues;
}

export interface SetupInputValues {
  readonly nodeEnv?: string;
  readonly telegramBotToken?: string;
  readonly verificationPassword?: string;
  readonly verificationPasswordHash?: string;
  readonly allowedTelegramUserIds?: string;
  readonly defaultWorkspaceRoot?: string;
  readonly appHome?: string;
  readonly codexHome?: string;
  readonly logLevel?: string;
  readonly ownerTelegramUserId?: string;
}

export interface SetupResolvedValues {
  readonly nodeEnv: string;
  readonly telegramBotToken: string;
  readonly verificationPasswordHash: string | null;
  readonly allowedTelegramUserIds: string;
  readonly defaultWorkspaceRoot: string;
  readonly appHome: string;
  readonly codexHome: string;
  readonly logLevel: AppLogLevel;
  readonly ownerTelegramUserId: string | null;
}
