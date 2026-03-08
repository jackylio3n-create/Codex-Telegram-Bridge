import type { SessionActorSnapshot } from "../types/index.js";
import type { WorkspaceSessionState } from "../workspace/index.js";
import type { BridgeStore, SessionRecord } from "../../store/types.js";
import { isSessionStateActiveForCommandGate } from "./state-machine.js";

type PersistedSessionActorStore = Pick<BridgeStore, "pendingPermissions">;

export function buildPersistedSessionActorSnapshot(
  store: PersistedSessionActorStore,
  session: SessionRecord
): SessionActorSnapshot {
  const currentRunId = isSessionStateActiveForCommandGate(session.runState)
    ? session.activeRunId
    : null;
  const waitingPermissionId =
    session.runState === "waiting_approval" && currentRunId
      ? (store.pendingPermissions.list({
          sessionId: session.sessionId,
          runId: currentRunId,
          resolved: false,
          limit: 1
        })[0]?.permissionId ?? null)
      : null;

  return {
    sessionId: session.sessionId,
    runState: session.runState,
    currentRunId,
    waitingPermissionId,
    cancellationResult: session.cancellationResult,
    queuedEventCount: 0,
    processedEventCount: 0,
    lastEventAt: session.updatedAt
  };
}

export function toWorkspaceSessionState(
  session: SessionRecord
): WorkspaceSessionState {
  return {
    workspaceRoot: session.workspaceRoot,
    extraAllowedDirs: session.extraAllowedDirs,
    cwd: session.cwd,
    mode: session.mode,
    accessScope: session.accessScope
  };
}
