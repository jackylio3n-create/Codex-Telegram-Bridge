import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatCodexAccountStatus, readCodexAccountStatus } from "../../src/runtime/codex/status.js";

test("readCodexAccountStatus reads model, reasoning effort, and latest known rate limits from codex home", async () => {
  const codexHome = await mkdtemp(join(tmpdir(), "codex-telegram-bridge-codex-home-"));

  try {
    await writeFile(join(codexHome, "config.toml"), [
      "model = \"gpt-5.4\"",
      "model_reasoning_effort = \"xhigh\""
    ].join("\n"));

    const sessionsDir = join(codexHome, "sessions", "2026", "03", "07");
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(
      join(sessionsDir, "rollout-1.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-03-07T17:40:00.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            rate_limits: {
              primary: {
                used_percent: 15,
                window_minutes: 300,
                resets_at: 1_772_541_600
              },
              secondary: {
                used_percent: 4,
                window_minutes: 10_080,
                resets_at: 1_772_768_800
              }
            }
          }
        }),
        ""
      ].join("\n")
    );

    const status = await readCodexAccountStatus(codexHome);
    assert.equal(status.model, "gpt-5.4");
    assert.equal(status.reasoningEffort, "xhigh");
    assert.equal(status.fiveHourRemainingPercent, 85);
    assert.equal(status.weeklyRemainingPercent, 96);
    assert.equal(status.quotasUpdatedAt, "2026-03-07T17:40:00.000Z");
    assert.equal(
      formatCodexAccountStatus(status),
      [
        "Model: gpt-5.4",
        "Reasoning effort: xhigh",
        "5-hour limit remaining (latest known): 85%",
        "Weekly limit remaining (latest known): 96%"
      ].join("\n")
    );
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});
