import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  getDefaultEnvFileSearchPaths,
  parseEnvironmentFile,
  resolveRuntimeEnvironment
} from "../../src/config/env-file.js";

test("parseEnvironmentFile ignores comments and supports quoted values", () => {
  const env = parseEnvironmentFile(`
# comment
NODE_ENV=production
CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN="123456:replace me"
CODEX_TELEGRAM_BRIDGE_ALLOWED_TELEGRAM_USER_IDS=123456789
EMPTY=""
`);

  assert.equal(env.NODE_ENV, "production");
  assert.equal(env.CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN, "123456:replace me");
  assert.equal(env.CODEX_TELEGRAM_BRIDGE_ALLOWED_TELEGRAM_USER_IDS, "123456789");
  assert.equal(env.EMPTY, "");
});

test("resolveRuntimeEnvironment prefers process env over env file values", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "codex-telegram-bridge-env-"));
  const envFilePath = join(tempRoot, "config.env");
  await writeFile(envFilePath, [
    "NODE_ENV=production",
    "CODEX_TELEGRAM_BRIDGE_LOG_LEVEL=debug"
  ].join("\n"), "utf8");

  const resolved = await resolveRuntimeEnvironment({
    explicitEnvFilePath: envFilePath,
    baseEnv: {
      CODEX_TELEGRAM_BRIDGE_LOG_LEVEL: "warn"
    }
  });

  assert.equal(resolved.envFilePath, envFilePath);
  assert.equal(resolved.env.NODE_ENV, "production");
  assert.equal(resolved.env.CODEX_TELEGRAM_BRIDGE_LOG_LEVEL, "warn");
});

test("getDefaultEnvFileSearchPaths returns cwd and home based defaults", () => {
  const paths = getDefaultEnvFileSearchPaths({
    cwd: "/workspace/project",
    homeDir: "/home/bridge"
  });

  assert.deepEqual(paths, [
    resolve("/workspace/project", ".env"),
    join(resolve("/home/bridge"), ".config", "codex-telegram-bridge", "config.env"),
    "/etc/codex-telegram-bridge.env"
  ]);
});
