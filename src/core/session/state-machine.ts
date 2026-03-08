import type {
  NormalizedOutboundMessage,
  SessionActorDispatchResult,
  SessionActorSnapshot,
  SessionEvent,
  SessionEventRejectedEffect,
  SessionRunState
} from "../types/index.js";

export function createInitialSessionSnapshot(
  sessionId: string
): SessionActorSnapshot {
  return {
    sessionId,
    runState: "idle",
    currentRunId: null,
    waitingPermissionId: null,
    cancellationResult: null,
    queuedEventCount: 0,
    processedEventCount: 0,
    lastEventAt: null
  };
}

export function isSessionStateActiveForCommandGate(
  runState: SessionRunState
): boolean {
  return (
    runState === "running" ||
    runState === "waiting_approval" ||
    runState === "cancelling"
  );
}

export function reduceSessionEvent(
  snapshot: SessionActorSnapshot,
  event: SessionEvent
): SessionActorDispatchResult {
  const baseline: SessionActorSnapshot = {
    ...snapshot,
    processedEventCount: snapshot.processedEventCount + 1,
    lastEventAt: getEventTimestamp(event)
  };

  switch (event.kind) {
    case "session_created":
    case "session_bound":
    case "user_input_received":
    case "command_received":
      return {
        accepted: true,
        snapshot: baseline,
        effects: [createQueuedEffect(snapshot.sessionId, event.kind)]
      };
    case "run_started":
      if (isSessionStateActiveForCommandGate(snapshot.runState)) {
        return rejectEvent(
          baseline,
          event,
          "run_already_active",
          "A run is already active for this session."
        );
      }

      return acceptTransition(
        snapshot,
        {
          ...baseline,
          runState: "running",
          currentRunId: event.runId,
          waitingPermissionId: null,
          cancellationResult: null
        },
        event
      );
    case "approval_requested":
      if (
        snapshot.runState !== "running" ||
        snapshot.currentRunId !== event.runId
      ) {
        return rejectEvent(
          baseline,
          event,
          snapshot.currentRunId !== event.runId
            ? "run_id_mismatch"
            : "run_not_active",
          "Approval can only be requested by the currently running run."
        );
      }

      return acceptTransition(
        snapshot,
        {
          ...baseline,
          runState: "waiting_approval",
          waitingPermissionId: event.permissionId
        },
        event
      );
    case "approval_resolved":
      if (snapshot.runState !== "waiting_approval") {
        return rejectEvent(
          baseline,
          event,
          "not_waiting_for_approval",
          "The session is not waiting for approval."
        );
      }

      if (snapshot.currentRunId !== event.runId) {
        return rejectEvent(
          baseline,
          event,
          "run_id_mismatch",
          "Approval decision targets a stale run."
        );
      }

      if (snapshot.waitingPermissionId !== event.permissionId) {
        return rejectEvent(
          baseline,
          event,
          "permission_mismatch",
          "Approval decision targets a stale permission."
        );
      }

      return acceptTransition(
        snapshot,
        {
          ...baseline,
          runState: event.decision === "approve" ? "running" : "failed",
          currentRunId:
            event.decision === "approve" ? snapshot.currentRunId : null,
          waitingPermissionId: null,
          cancellationResult: null
        },
        event
      );
    case "cancel_requested":
      if (!isSessionStateActiveForCommandGate(snapshot.runState)) {
        return rejectEvent(
          baseline,
          event,
          "not_cancellable",
          "The session has no active run to cancel."
        );
      }

      return acceptTransition(
        snapshot,
        {
          ...baseline,
          runState: "cancelling"
        },
        event
      );
    case "run_completed":
      if (snapshot.currentRunId !== event.runId) {
        return rejectEvent(
          baseline,
          event,
          "run_id_mismatch",
          "Completion targets a stale run."
        );
      }

      return acceptTransition(
        snapshot,
        {
          ...baseline,
          runState: "idle",
          currentRunId: null,
          waitingPermissionId: null,
          cancellationResult: null
        },
        event
      );
    case "run_failed":
      if (snapshot.currentRunId !== event.runId) {
        return rejectEvent(
          baseline,
          event,
          "run_id_mismatch",
          "Failure targets a stale run."
        );
      }

      return acceptTransition(
        snapshot,
        {
          ...baseline,
          runState: "failed",
          currentRunId: null,
          waitingPermissionId: null
        },
        event
      );
    case "run_cancelled":
      if (snapshot.currentRunId !== event.runId) {
        return rejectEvent(
          baseline,
          event,
          "run_id_mismatch",
          "Cancellation targets a stale run."
        );
      }

      return acceptTransition(
        snapshot,
        {
          ...baseline,
          runState: "cancelled",
          currentRunId: null,
          waitingPermissionId: null,
          cancellationResult: event.cancellationResult
        },
        event
      );
    case "stale_recovered":
      return acceptTransition(
        snapshot,
        {
          ...baseline,
          runState: "stale_recovered",
          currentRunId: null,
          waitingPermissionId: null
        },
        event
      );
  }
}

function acceptTransition(
  previous: SessionActorSnapshot,
  next: SessionActorSnapshot,
  event: SessionEvent
): SessionActorDispatchResult {
  const effects: NormalizedOutboundMessage[] = [
    createQueuedEffect(previous.sessionId, event.kind)
  ];

  if (previous.runState !== next.runState) {
    effects.push({
      type: "session_state_changed",
      sessionId: previous.sessionId,
      eventKind: event.kind,
      previousState: previous.runState,
      nextState: next.runState,
      runId: next.currentRunId,
      cancellationResult: next.cancellationResult
    });
  }

  return {
    accepted: true,
    snapshot: next,
    effects
  };
}

function rejectEvent(
  snapshot: SessionActorSnapshot,
  event: SessionEvent,
  reason: SessionEventRejectedEffect["reason"],
  text: string
): SessionActorDispatchResult {
  return {
    accepted: false,
    snapshot,
    effects: [
      createQueuedEffect(snapshot.sessionId, event.kind),
      {
        type: "session_event_rejected",
        sessionId: snapshot.sessionId,
        eventKind: event.kind,
        reason,
        runId: getEventRunId(event),
        permissionId: getEventPermissionId(event),
        text
      }
    ]
  };
}

function createQueuedEffect(
  sessionId: string,
  eventKind: SessionEvent["kind"]
): NormalizedOutboundMessage {
  return {
    type: "session_event_queued",
    sessionId,
    eventKind
  };
}

function getEventTimestamp(event: SessionEvent): string {
  switch (event.kind) {
    case "session_created":
      return event.createdAt;
    case "session_bound":
      return event.boundAt;
    case "user_input_received":
      return event.input.envelope.receivedAt;
    case "command_received":
      return event.command.envelope.receivedAt;
    case "run_started":
      return event.startedAt;
    case "approval_requested":
      return event.requestedAt;
    case "approval_resolved":
      return event.resolvedAt;
    case "cancel_requested":
      return event.requestedAt;
    case "run_completed":
      return event.completedAt;
    case "run_failed":
      return event.failedAt;
    case "run_cancelled":
      return event.cancelledAt;
    case "stale_recovered":
      return event.recoveredAt;
  }
}

function getEventRunId(event: SessionEvent): string | null {
  switch (event.kind) {
    case "run_started":
    case "approval_requested":
    case "approval_resolved":
    case "run_completed":
    case "run_failed":
    case "run_cancelled":
      return event.runId;
    default:
      return null;
  }
}

function getEventPermissionId(event: SessionEvent): string | null {
  switch (event.kind) {
    case "approval_requested":
    case "approval_resolved":
      return event.permissionId;
    default:
      return null;
  }
}
