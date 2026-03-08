import type { AppConfig } from "./index.js";

export function redactConfigForDisplay(
  config: AppConfig
): Record<string, unknown> {
  return {
    appName: config.appName,
    env: config.env,
    codexHome: config.codexHome,
    defaultWorkspaceRoot: config.defaultWorkspaceRoot,
    telegramBotToken: maskSecret(config.telegramBotToken),
    verificationPasswordHash: maskNullableSecret(
      config.verificationPasswordHash
    ),
    allowedTelegramUserIds: config.allowedTelegramUserIds.map(maskIdentifier),
    allowedTelegramUserCount: config.allowedTelegramUserIds.length,
    ownerTelegramUserId: maskNullableIdentifier(config.ownerTelegramUserId),
    ownerTelegramChatId: maskNullableIdentifier(config.ownerTelegramChatId),
    logLevel: config.logLevel,
    secretEnvVarNames: [...config.secretEnvVarNames],
    paths: {
      ...config.paths
    },
    defaults: {
      ...config.defaults
    }
  };
}

function maskSecret(secret: string): string {
  if (secret.length <= 4) {
    return "*".repeat(Math.max(secret.length, 4));
  }

  return `${secret.slice(0, 2)}${"*".repeat(Math.max(secret.length - 4, 4))}${secret.slice(-2)}`;
}

function maskNullableSecret(secret: string | null): string | null {
  return secret === null ? null : maskSecret(secret);
}

function maskIdentifier(value: string): string {
  if (value.length <= 4) {
    return "*".repeat(Math.max(value.length, 4));
  }

  return `${value.slice(0, 2)}${"*".repeat(Math.max(value.length - 4, 4))}${value.slice(-2)}`;
}

function maskNullableIdentifier(value: string | null): string | null {
  return value === null ? null : maskIdentifier(value);
}
