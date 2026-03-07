import test from "node:test";
import assert from "node:assert/strict";
import {
  createInitialSessionSnapshot,
  reduceSessionEvent
} from "../../src/core/session/state-machine.js";

test("state machine completes a full run lifecycle including approval", () => {
  const startedAt = "2026-03-06T10:00:00.000Z";
  const requestedAt = "2026-03-06T10:01:00.000Z";
  const resolvedAt = "2026-03-06T10:02:00.000Z";
  const completedAt = "2026-03-06T10:03:00.000Z";

  const initial = createInitialSessionSnapshot("session-1");
  const started = reduceSessionEvent(initial, {
    kind: "run_started",
    runId: "run-1",
    startedAt
  });
  assert.equal(started.accepted, true);
  assert.equal(started.snapshot.runState, "running");
  assert.equal(started.snapshot.currentRunId, "run-1");
  assert.equal(started.snapshot.lastEventAt, startedAt);
  assert.deepEqual(started.effects.map((effect) => effect.type), [
    "session_event_queued",
    "session_state_changed"
  ]);

  const waiting = reduceSessionEvent(started.snapshot, {
    kind: "approval_requested",
    runId: "run-1",
    permissionId: "perm-1",
    requestedAt
  });
  assert.equal(waiting.accepted, true);
  assert.equal(waiting.snapshot.runState, "waiting_approval");
  assert.equal(waiting.snapshot.waitingPermissionId, "perm-1");
  assert.equal(waiting.snapshot.lastEventAt, requestedAt);

  const resumed = reduceSessionEvent(waiting.snapshot, {
    kind: "approval_resolved",
    runId: "run-1",
    permissionId: "perm-1",
    decision: "approve",
    resolvedAt
  });
  assert.equal(resumed.accepted, true);
  assert.equal(resumed.snapshot.runState, "running");
  assert.equal(resumed.snapshot.waitingPermissionId, null);
  assert.equal(resumed.snapshot.currentRunId, "run-1");

  const completed = reduceSessionEvent(resumed.snapshot, {
    kind: "run_completed",
    runId: "run-1",
    completedAt
  });
  assert.equal(completed.accepted, true);
  assert.equal(completed.snapshot.runState, "idle");
  assert.equal(completed.snapshot.currentRunId, null);
  assert.equal(completed.snapshot.waitingPermissionId, null);
  assert.equal(completed.snapshot.processedEventCount, 4);
  assert.equal(completed.snapshot.lastEventAt, completedAt);
});

test("state machine rejects stale approval decisions by permission id", () => {
  const waitingSnapshot = reduceSessionEvent(
    reduceSessionEvent(createInitialSessionSnapshot("session-2"), {
      kind: "run_started",
      runId: "run-2",
      startedAt: "2026-03-06T11:00:00.000Z"
    }).snapshot,
    {
      kind: "approval_requested",
      runId: "run-2",
      permissionId: "perm-current",
      requestedAt: "2026-03-06T11:01:00.000Z"
    }
  ).snapshot;

  const rejected = reduceSessionEvent(waitingSnapshot, {
    kind: "approval_resolved",
    runId: "run-2",
    permissionId: "perm-stale",
    decision: "deny",
    resolvedAt: "2026-03-06T11:02:00.000Z"
  });

  assert.equal(rejected.accepted, false);
  assert.equal(rejected.snapshot.runState, "waiting_approval");
  assert.equal(rejected.snapshot.waitingPermissionId, "perm-current");
  assert.deepEqual(rejected.effects.map((effect) => effect.type), [
    "session_event_queued",
    "session_event_rejected"
  ]);

  const rejection = rejected.effects[1];
  assert.equal(rejection?.type, "session_event_rejected");
  if (rejection?.type === "session_event_rejected") {
    assert.equal(rejection.reason, "permission_mismatch");
    assert.equal(rejection.runId, "run-2");
    assert.equal(rejection.permissionId, "perm-stale");
  }
});

test("state machine fails the run when approval is denied", () => {
  const denied = reduceSessionEvent(
    reduceSessionEvent(
      reduceSessionEvent(createInitialSessionSnapshot("session-3"), {
        kind: "run_started",
        runId: "run-3",
        startedAt: "2026-03-06T12:00:00.000Z"
      }).snapshot,
      {
        kind: "approval_requested",
        runId: "run-3",
        permissionId: "perm-3",
        requestedAt: "2026-03-06T12:01:00.000Z"
      }
    ).snapshot,
    {
      kind: "approval_resolved",
      runId: "run-3",
      permissionId: "perm-3",
      decision: "deny",
      resolvedAt: "2026-03-06T12:02:00.000Z"
    }
  );

  assert.equal(denied.accepted, true);
  assert.equal(denied.snapshot.runState, "failed");
  assert.equal(denied.snapshot.currentRunId, null);
  assert.equal(denied.snapshot.waitingPermissionId, null);
});

test("state machine rejects cancellation when no run is active", () => {
  const result = reduceSessionEvent(createInitialSessionSnapshot("session-4"), {
    kind: "cancel_requested",
    requestedAt: "2026-03-06T12:00:00.000Z"
  });

  assert.equal(result.accepted, false);
  assert.equal(result.snapshot.runState, "idle");
  const rejection = result.effects[1];
  assert.equal(rejection?.type, "session_event_rejected");
  if (rejection?.type === "session_event_rejected") {
    assert.equal(rejection.reason, "not_cancellable");
  }
});
