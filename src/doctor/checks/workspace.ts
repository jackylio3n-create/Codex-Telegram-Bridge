import {
  buildAllowedDirectorySet,
  validateWorkspaceSession,
  type FilesystemInspector,
  type VisibleDirectoryPolicy,
  type WorkspaceIssue
} from "../../core/workspace/index.js";
import type { BridgeStore } from "../../store/types.js";
import type { DoctorCheck, DoctorCheckStatus } from "../types.js";

const WARNING_ISSUE_CODES = new Set<WorkspaceIssue["code"]>([
  "path_duplicate",
  "path_not_normalized"
]);

export async function buildWorkspaceCheck(
  store: BridgeStore | undefined,
  inspector: FilesystemInspector,
  visiblePolicy: VisibleDirectoryPolicy | undefined
): Promise<DoctorCheck> {
  if (!store) {
    return {
      id: "workspace",
      label: "workspace boundaries",
      status: "skipped",
      summary: "Skipped because the store was not initialized.",
      details: []
    };
  }

  const sessions = store.sessions.listOverview();
  if (sessions.length === 0) {
    return {
      id: "workspace",
      label: "workspace boundaries",
      status: "ok",
      summary: "No sessions were found to validate.",
      details: []
    };
  }

  const details: string[] = [];
  let highestStatus: DoctorCheckStatus = "ok";

  for (const session of sessions) {
    const result = await validateWorkspaceSession(
      {
        workspaceRoot: session.workspaceRoot,
        extraAllowedDirs: session.extraAllowedDirs,
        cwd: session.cwd,
        mode: session.mode
      },
      {
        inspector,
        requireExistingPaths: true,
        ...(visiblePolicy ? { visiblePolicy } : {})
      }
    );

    if (result.issues.length === 0) {
      continue;
    }

    const sessionStatus = getWorkspaceStatus(result.issues);
    highestStatus = maxStatus(highestStatus, sessionStatus);

    details.push(
      `session=${session.sessionId} | allowed=${buildAllowedDirectorySet({
        workspaceRoot: session.workspaceRoot,
        extraAllowedDirs: session.extraAllowedDirs
      }).join(", ")}`
    );
    for (const issue of result.issues) {
      details.push(`session=${session.sessionId} | ${issue.field} | ${issue.message}${issue.detail ? ` | ${issue.detail}` : ""}`);
    }
  }

  if (details.length === 0) {
    return {
      id: "workspace",
      label: "workspace boundaries",
      status: "ok",
      summary: `Validated ${sessions.length} session workspace boundary set(s).`,
      details: []
    };
  }

  return {
    id: "workspace",
    label: "workspace boundaries",
    status: highestStatus,
    summary: `Workspace boundary issues were found in ${countAffectedSessions(details)} session(s).`,
    details: details.slice(0, 30)
  };
}

function getWorkspaceStatus(issues: readonly WorkspaceIssue[]): DoctorCheckStatus {
  return issues.some((issue) => !WARNING_ISSUE_CODES.has(issue.code)) ? "error" : "warning";
}

function maxStatus(left: DoctorCheckStatus, right: DoctorCheckStatus): DoctorCheckStatus {
  const weights: Record<DoctorCheckStatus, number> = {
    ok: 0,
    skipped: 0,
    warning: 1,
    error: 2
  };

  return weights[right] > weights[left] ? right : left;
}

function countAffectedSessions(details: readonly string[]): number {
  const sessionIds = new Set(
    details
      .map((detail) => detail.match(/^session=([^| ]+)/)?.[1] ?? null)
      .filter((value): value is string => value !== null)
  );

  return sessionIds.size;
}
