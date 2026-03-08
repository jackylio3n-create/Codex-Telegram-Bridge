import assert from "node:assert/strict";
import test from "node:test";
import { parseCodexJsonEventLine } from "../../src/runtime/codex/events.js";

test("parseCodexJsonEventLine supports app-server style agent messages", () => {
  const parsed = parseCodexJsonEventLine(
    JSON.stringify({
      type: "agent_message",
      message: "Streaming answer"
    })
  );

  assert.deepEqual(parsed, {
    kind: "agent_message",
    itemId: null,
    text: "Streaming answer",
    rawType: "agent_message"
  });
});

test("parseCodexJsonEventLine supports exec approval requests", () => {
  const parsed = parseCodexJsonEventLine(
    JSON.stringify({
      type: "exec_approval_request",
      call_id: "call-1",
      approval_id: "approval-1",
      turn_id: "turn-1",
      command: ["git", "push"],
      cwd: "/workspace",
      reason: "Needs network access"
    })
  );

  assert.deepEqual(parsed, {
    kind: "approval_request",
    callId: "call-1",
    approvalId: "approval-1",
    turnId: "turn-1",
    command: ["git", "push"],
    cwd: "/workspace",
    reason: "Needs network access",
    summary: "git push (Needs network access)",
    rawType: "exec_approval_request"
  });
});
