import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLogger } from "../../src/logger/index.js";

test("createLogger filters records below the configured level before writing", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "codex-telegram-bridge-logger-"));
  const filePath = join(tempDir, "bridge.log");
  const logger = createLogger({
    level: "warn",
    console: false,
    filePath,
    clock: () => new Date("2026-03-06T12:00:00.000Z")
  });

  try {
    logger.info("skip me");
    logger.warn("keep me", { scope: "logger-test" });

    const lines = (await readFile(filePath, "utf8"))
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.level, "warn");
    assert.equal(lines[0]?.message, "keep me");
    assert.deepEqual(lines[0]?.fields, { scope: "logger-test" });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
