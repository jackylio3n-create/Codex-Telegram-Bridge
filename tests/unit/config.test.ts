import assert from "node:assert/strict";
import test from "node:test";
import { hashVerificationPassword } from "../../src/security/verification-password.js";
import {
  loadAppConfig,
  redactConfigForDisplay
} from "../../src/config/index.js";

test("loadAppConfig derives the owner Telegram user ID from a single allowlisted user", () => {
  const { config, issues } = loadAppConfig({
    env: createEnv(),
    cwd: "/app",
    homeDir: "/home/bridge"
  });

  assert.equal(config.ownerTelegramUserId, "123456789");
  assert.equal(config.ownerTelegramChatId, null);
  assert.equal(config.verificationPasswordHash, null);
  assert.deepEqual(issues, []);
});

test("loadAppConfig rejects an explicit owner Telegram user ID outside the allowlist", () => {
  const { config, issues } = loadAppConfig({
    env: createEnv({
      CODEX_TELEGRAM_BRIDGE_ALLOWED_TELEGRAM_USER_IDS: "123456789,987654321",
      CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_USER_ID: "111111111"
    }),
    cwd: "/app",
    homeDir: "/home/bridge"
  });

  assert.equal(config.ownerTelegramUserId, "111111111");
  assert.ok(
    issues.some((issue) => {
      return (
        issue.field === "CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_USER_ID" &&
        issue.severity === "error"
      );
    })
  );
});

test("loadAppConfig warns when multiple allowlisted users are configured without an explicit owner", () => {
  const { config, issues } = loadAppConfig({
    env: createEnv({
      CODEX_TELEGRAM_BRIDGE_ALLOWED_TELEGRAM_USER_IDS: "123456789,987654321"
    }),
    cwd: "/app",
    homeDir: "/home/bridge"
  });

  assert.equal(config.ownerTelegramUserId, null);
  assert.ok(
    issues.some((issue) => {
      return (
        issue.field === "CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_USER_ID" &&
        issue.severity === "warning"
      );
    })
  );
});

test("loadAppConfig applies privacy-minded defaults and supports overrides", () => {
  const { config: defaults, issues: defaultIssues } = loadAppConfig({
    env: createEnv(),
    cwd: "/app",
    homeDir: "/home/bridge"
  });

  assert.deepEqual(defaultIssues, []);
  assert.equal(defaults.defaults.auditLevel, "minimal");
  assert.equal(defaults.defaults.includeRuntimeIdentifiers, false);
  assert.equal(defaults.defaults.maxAuditRows, 1000);
  assert.equal(defaults.defaults.maxSummariesPerSession, 10);
  assert.equal(defaults.defaults.resolvedApprovalRetentionDays, 7);
  assert.equal(defaults.defaults.expiredApprovalRetentionDays, 1);

  const { config: overridden, issues: overrideIssues } = loadAppConfig({
    env: createEnv({
      CODEX_TELEGRAM_BRIDGE_AUDIT_LEVEL: "debug",
      CODEX_TELEGRAM_BRIDGE_INCLUDE_RUNTIME_IDENTIFIERS: "true",
      CODEX_TELEGRAM_BRIDGE_MAX_AUDIT_ROWS: "25",
      CODEX_TELEGRAM_BRIDGE_MAX_SUMMARIES_PER_SESSION: "3",
      CODEX_TELEGRAM_BRIDGE_RESOLVED_APPROVAL_RETENTION_DAYS: "14",
      CODEX_TELEGRAM_BRIDGE_EXPIRED_APPROVAL_RETENTION_DAYS: "2"
    }),
    cwd: "/app",
    homeDir: "/home/bridge"
  });

  assert.deepEqual(overrideIssues, []);
  assert.equal(overridden.defaults.auditLevel, "debug");
  assert.equal(overridden.defaults.includeRuntimeIdentifiers, true);
  assert.equal(overridden.defaults.maxAuditRows, 25);
  assert.equal(overridden.defaults.maxSummariesPerSession, 3);
  assert.equal(overridden.defaults.resolvedApprovalRetentionDays, 14);
  assert.equal(overridden.defaults.expiredApprovalRetentionDays, 2);
});

test("redactConfigForDisplay masks Telegram identifiers", () => {
  const verificationPasswordHash = hashVerificationPassword("bridge-secret");
  const { config } = loadAppConfig({
    env: createEnv({
      CODEX_TELEGRAM_BRIDGE_ALLOWED_TELEGRAM_USER_IDS: "123456789,987654321",
      CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_USER_ID: "123456789",
      CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_CHAT_ID: "987654321",
      CODEX_TELEGRAM_BRIDGE_VERIFICATION_PASSWORD_HASH: verificationPasswordHash
    }),
    cwd: "/app",
    homeDir: "/home/bridge"
  });

  const redacted = redactConfigForDisplay(config);

  assert.deepEqual(redacted.allowedTelegramUserIds, ["12*****89", "98*****21"]);
  assert.equal(redacted.allowedTelegramUserCount, 2);
  assert.equal(redacted.ownerTelegramUserId, "12*****89");
  assert.equal(redacted.ownerTelegramChatId, "98*****21");
  assert.notEqual(redacted.verificationPasswordHash, verificationPasswordHash);
});

test("loadAppConfig rejects an invalid verification password hash", () => {
  const { config, issues } = loadAppConfig({
    env: createEnv({
      CODEX_TELEGRAM_BRIDGE_VERIFICATION_PASSWORD_HASH: "not-a-valid-hash"
    }),
    cwd: "/app",
    homeDir: "/home/bridge"
  });

  assert.equal(config.verificationPasswordHash, null);
  assert.ok(
    issues.some((issue) => {
      return (
        issue.field === "CODEX_TELEGRAM_BRIDGE_VERIFICATION_PASSWORD_HASH" &&
        issue.severity === "error"
      );
    })
  );
});

function createEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    CODEX_TELEGRAM_BRIDGE_DEFAULT_WORKSPACE_ROOT: "/workspaces/main",
    CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN: "123456:telegram-bot-token",
    CODEX_TELEGRAM_BRIDGE_ALLOWED_TELEGRAM_USER_IDS: "123456789",
    ...overrides
  };
}
