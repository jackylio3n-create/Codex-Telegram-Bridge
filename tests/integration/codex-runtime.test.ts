import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { startCodexRun } from "../../src/runtime/codex/index.js";

const fakeCodexPath = join(
  import.meta.dirname,
  "fixtures",
  process.platform === "win32" ? "fake-codex.ps1" : "fake-codex.sh"
);

test("codex runtime reports partial cancellation when the fake process exits on SIGINT", async () => {
  process.env.FAKE_CODEX_SCENARIO = "cancel";

  try {
    const controller = startCodexRun({
      executablePath: fakeCodexPath,
      prompt: "cancel this run",
      runtimeContext: {
        cwd: process.cwd(),
        extraWritableRoots: [],
        mode: "code"
      }
    });

    await delay(100);
    const cancelOutcome = await controller.cancel();
    const completion = await controller.completion;

    assert.equal(cancelOutcome.result, "partial");
    assert.equal(completion.startedFresh, true);
    assert.equal(completion.staleRecovered, false);
    assert.equal(completion.cancelOutcome, null);
  } finally {
    delete process.env.FAKE_CODEX_SCENARIO;
  }
});

test("codex runtime starts a fresh thread after stale resume mismatch and seeds with rolling summary", async () => {
  process.env.FAKE_CODEX_SCENARIO = "recover";

  try {
    const controller = startCodexRun({
      executablePath: fakeCodexPath,
      prompt: "continue the task",
      resumeThreadId: "stale-thread",
      rollingSummary: "Recovered summary",
      runtimeContext: {
        cwd: process.cwd(),
        extraWritableRoots: [],
        mode: "code"
      }
    });

    const result = await controller.completion;

    assert.equal(result.startedFresh, true);
    assert.equal(result.staleRecovered, true);
    assert.equal(result.usedSummarySeed, true);
    assert.equal(result.threadId, "recovered-thread");
    assert.equal(result.finalMessage, "Recovered answer");
    assert.equal(result.exitCode, 0);
  } finally {
    delete process.env.FAKE_CODEX_SCENARIO;
  }
});

test("codex runtime resumes inside the session cwd", async () => {
  process.env.FAKE_CODEX_SCENARIO = "cwd";

  try {
    const controller = startCodexRun({
      executablePath: fakeCodexPath,
      prompt: "continue in the same workspace",
      resumeThreadId: "resume-thread",
      runtimeContext: {
        cwd: process.cwd(),
        extraWritableRoots: [],
        mode: "code"
      }
    });

    const result = await controller.completion;

    assert.equal(result.startedFresh, false);
    assert.equal(result.staleRecovered, false);
    assert.equal(result.threadId, "resume-thread");
    assert.equal(result.finalMessage, process.cwd());
    assert.equal(result.exitCode, 0);
  } finally {
    delete process.env.FAKE_CODEX_SCENARIO;
  }
});

test("codex runtime includes --skip-git-repo-check on resumed runs", async () => {
  process.env.FAKE_CODEX_SCENARIO = "resume-skip-check";

  try {
    const controller = startCodexRun({
      executablePath: fakeCodexPath,
      prompt: "continue in a non-repo workspace",
      resumeThreadId: "resume-skip-thread",
      runtimeContext: {
        cwd: process.cwd(),
        extraWritableRoots: [],
        mode: "code"
      }
    });

    const result = await controller.completion;

    assert.equal(result.startedFresh, false);
    assert.equal(result.staleRecovered, false);
    assert.equal(result.threadId, "resume-skip-thread");
    assert.equal(result.finalMessage, "resume skip check present");
    assert.equal(result.exitCode, 0);
  } finally {
    delete process.env.FAKE_CODEX_SCENARIO;
  }
});
