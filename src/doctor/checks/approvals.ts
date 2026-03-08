import type {
  BridgeStore,
  PendingPermissionRecord
} from "../../store/types.js";
import type { DoctorCheck } from "../types.js";

export function buildApprovalsCheck(
  store: BridgeStore | undefined,
  now: Date
): DoctorCheck {
  if (!store) {
    return {
      id: "approvals",
      label: "pending approvals",
      status: "skipped",
      summary: "Skipped because the store was not initialized.",
      details: []
    };
  }

  const staleApprovals = store.pendingPermissions
    .list({ resolved: false })
    .filter((record) => isExpired(record, now));

  if (staleApprovals.length === 0) {
    return {
      id: "approvals",
      label: "pending approvals",
      status: "ok",
      summary: "No stale unresolved approvals were found.",
      details: []
    };
  }

  return {
    id: "approvals",
    label: "pending approvals",
    status: "warning",
    summary: `${staleApprovals.length} stale unresolved approval(s) detected.`,
    details: staleApprovals
      .slice(0, 10)
      .map(
        (record) =>
          `${record.permissionId} | session=${record.sessionId} | run=${record.runId} | expired=${record.expiresAt}`
      )
  };
}

function isExpired(record: PendingPermissionRecord, now: Date): boolean {
  return Date.parse(record.expiresAt) <= now.getTime();
}
