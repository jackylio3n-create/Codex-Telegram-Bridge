import {
  applyCwdChange,
  type WorkspaceIssue,
  type WorkspaceMutationOptions,
  type WorkspaceSessionState
} from "../workspace/index.js";

export interface CwdCommandResult {
  readonly status: "updated" | "rejected";
  readonly message: string;
  readonly session: WorkspaceSessionState;
  readonly issues: readonly WorkspaceIssue[];
}

export async function executeCwdCommand(
  session: WorkspaceSessionState,
  requestedCwd: string,
  options: WorkspaceMutationOptions = {}
): Promise<CwdCommandResult> {
  const result = await applyCwdChange(session, requestedCwd, options);
  if (!result.ok) {
    return {
      status: "rejected",
      message: `Rejected /cwd for ${requestedCwd}.`,
      session: result.session,
      issues: result.issues
    };
  }

  return {
    status: "updated",
    message: `Updated cwd to ${result.session.cwd}.`,
    session: result.session,
    issues: result.issues
  };
}
