import {
  confirmAddDir,
  prepareAddDirConfirmation,
  type AddDirConfirmation,
  type WorkspaceIssue,
  type WorkspaceMutationOptions,
  type WorkspaceSessionState
} from "../workspace/index.js";

export interface AddDirCommandRequestResult {
  readonly status: "confirmation_required" | "rejected";
  readonly message: string;
  readonly confirmation?: AddDirConfirmation;
  readonly issues: readonly WorkspaceIssue[];
}

export interface AddDirCommandConfirmResult {
  readonly status: "updated" | "rejected";
  readonly message: string;
  readonly session: WorkspaceSessionState;
  readonly issues: readonly WorkspaceIssue[];
}

export async function requestAddDirCommand(
  session: WorkspaceSessionState,
  requestedPath: string,
  options: WorkspaceMutationOptions = {}
): Promise<AddDirCommandRequestResult> {
  const result = await prepareAddDirConfirmation(
    session,
    requestedPath,
    options
  );
  if (!result.ok || !result.confirmation) {
    return {
      status: "rejected",
      message: `Rejected /adddir for ${requestedPath}.`,
      issues: result.issues
    };
  }

  return {
    status: "confirmation_required",
    message: result.confirmation.summary,
    confirmation: result.confirmation,
    issues: result.issues
  };
}

export async function confirmAddDirCommand(
  session: WorkspaceSessionState,
  confirmation: AddDirConfirmation,
  options: WorkspaceMutationOptions = {}
): Promise<AddDirCommandConfirmResult> {
  const result = await confirmAddDir(session, confirmation, options);
  if (!result.ok) {
    return {
      status: "rejected",
      message: `Rejected confirmed /adddir for ${confirmation.normalizedPath}.`,
      session: result.session,
      issues: result.issues
    };
  }

  return {
    status: "updated",
    message: `Added ${confirmation.normalizedPath} to extra_allowed_dirs.`,
    session: result.session,
    issues: result.issues
  };
}
