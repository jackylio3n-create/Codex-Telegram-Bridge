import type { BridgeStore, PendingPermissionRecord, SessionRecord } from "../../store/types.js";
import type { DoctorCheck, DoctorCheckStatus } from "../types.js";

const ACTIVE_RUN_STATES = new Set<SessionRecord["runState"]>(["running", "waiting_approval", "cancelling"]);
const TERMINAL_STATES = new Set<SessionRecord["runState"]>(["idle", "cancelled", "failed", "stale_recovered"]);

export function buildRunsCheck(store: BridgeStore | undefined): DoctorCheck {
  if (!store) {
    return {
      id: "runs",
      label: "run state health",
      status: "skipped",
      summary: "Skipped because the store was not initialized.",
      details: []
    };
  }

  const sessions = store.sessions.listOverview();
  if (sessions.length === 0) {
    return {
      id: "runs",
      label: "run state health",
      status: "ok",
      summary: "No sessions were found to validate.",
      details: []
    };
  }

  const activeApprovalsByRun = groupActiveApprovalsByRun(
    store.pendingPermissions.list({ resolved: false })
  );
  const details: string[] = [];
  let status: DoctorCheckStatus = "ok";

  for (const session of sessions) {
    const activeApprovals = session.activeRunId
      ? activeApprovalsByRun.get(createSessionRunKey(session.sessionId, session.activeRunId)) ?? []
      : [];

    if (ACTIVE_RUN_STATES.has(session.runState) && !session.activeRunId) {
      status = "error";
      details.push(`session=${session.sessionId} | run_state=${session.runState} requires active_run_id.`);
    }

    if (TERMINAL_STATES.has(session.runState) && session.activeRunId) {
      status = maxStatus(status, "warning");
      details.push(`session=${session.sessionId} | terminal run_state=${session.runState} should not keep active_run_id=${session.activeRunId}.`);
    }

    if (session.runState === "waiting_approval") {
      if (!session.activeRunId) {
        status = "error";
        details.push(`session=${session.sessionId} | waiting_approval has no active_run_id.`);
      } else if (activeApprovals.length === 0) {
        status = "error";
        details.push(`session=${session.sessionId} | waiting_approval has no unresolved approval for run=${session.activeRunId}.`);
      } else if (activeApprovals.every((record) => isExpired(record))) {
        status = maxStatus(status, "warning");
        details.push(`session=${session.sessionId} | all unresolved approvals for run=${session.activeRunId} are already expired.`);
      } else if (activeApprovals.length > 1) {
        status = maxStatus(status, "warning");
        details.push(`session=${session.sessionId} | waiting_approval has ${activeApprovals.length} unresolved approvals for run=${session.activeRunId}.`);
      }
    }

    if (session.runState === "running" && activeApprovals.length > 0) {
      status = maxStatus(status, "warning");
      details.push(`session=${session.sessionId} | running still has ${activeApprovals.length} unresolved approval(s).`);
    }
  }

  if (details.length === 0) {
    return {
      id: "runs",
      label: "run state health",
      status: "ok",
      summary: `Validated ${sessions.length} session run state(s).`,
      details: []
    };
  }

  return {
    id: "runs",
    label: "run state health",
    status,
    summary: "Detected inconsistent or potentially stuck run states.",
    details: details.slice(0, 20)
  };
}

function groupActiveApprovalsByRun(
  approvals: readonly PendingPermissionRecord[]
): ReadonlyMap<string, readonly PendingPermissionRecord[]> {
  const grouped = new Map<string, PendingPermissionRecord[]>();

  for (const approval of approvals) {
    const key = createSessionRunKey(approval.sessionId, approval.runId);
    const existing = grouped.get(key);
    if (existing) {
      existing.push(approval);
      continue;
    }

    grouped.set(key, [approval]);
  }

  return grouped;
}

function createSessionRunKey(sessionId: string, runId: string): string {
  return `${sessionId}\u0000${runId}`;
}

function maxStatus(left: DoctorCheckStatus, right: DoctorCheckStatus): DoctorCheckStatus {
  if (left === "error" || right === "error") {
    return "error";
  }

  if (left === "warning" || right === "warning") {
    return "warning";
  }

  if (left === "ok") {
    return right;
  }

  return left;
}

function isExpired(record: PendingPermissionRecord): boolean {
  return Date.parse(record.expiresAt) <= Date.now();
}
