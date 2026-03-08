import {
  buildAllowedDirectorySet,
  normalizeContainerPath,
  validateWorkspaceSession,
  type SessionAccessScope,
  type WorkspaceValidationResult,
  type FilesystemInspector,
  type SessionMode,
  type VisibleDirectoryPolicy,
  type WorkspaceIssue,
  type WorkspaceSessionState
} from "./path-policy.js";

export interface NewSessionWorkspaceInput {
  readonly defaultWorkspaceRoot: string;
  readonly currentBoundSession?: Pick<WorkspaceSessionState, "workspaceRoot"> | null;
  readonly requestedCwd?: string | null;
}

export interface WorkspaceMutationOptions {
  readonly inspector?: FilesystemInspector;
  readonly visiblePolicy?: VisibleDirectoryPolicy;
  readonly requireExistingPaths?: boolean;
}

export interface WorkspaceMutationResult {
  readonly ok: boolean;
  readonly session: WorkspaceSessionState;
  readonly issues: readonly WorkspaceIssue[];
}

export interface AddDirConfirmation {
  readonly action: "adddir";
  readonly requestedPath: string;
  readonly normalizedPath: string;
  readonly summary: string;
}

export interface RuntimeWorkspaceContext {
  readonly cwd: string;
  readonly workspaceRoot: string;
  readonly writableRoots: readonly string[];
  readonly extraAllowedDirs: readonly string[];
  readonly mode: SessionMode;
  readonly accessScope: SessionAccessScope;
}

interface AddDirCandidate {
  readonly session: WorkspaceSessionState;
  readonly addedField: string | null;
}

export interface AccessScopeMutationResult extends WorkspaceMutationResult {
  readonly fallbackCwdApplied: boolean;
}

export async function initializeNewSessionWorkspace(
  input: NewSessionWorkspaceInput,
  options: WorkspaceMutationOptions = {}
): Promise<WorkspaceMutationResult> {
  const workspaceRoot = input.currentBoundSession?.workspaceRoot ?? input.defaultWorkspaceRoot;
  const requestedCwd = input.requestedCwd?.trim() ?? "";

  const initialSession: WorkspaceSessionState = {
    workspaceRoot,
    extraAllowedDirs: [],
    cwd: requestedCwd || workspaceRoot,
    mode: "code",
    accessScope: "workspace"
  };

  const validation = await validateWorkspaceCandidate(initialSession, options);
  const blockingCwdIssues = getBlockingIssues(filterIssuesByFields(validation.issues, ["cwd"]));

  if (requestedCwd === "" || blockingCwdIssues.length === 0) {
    return toWorkspaceMutationResult(validation);
  }

  const fallbackSession: WorkspaceSessionState = {
    ...validation.session,
    cwd: validation.session.workspaceRoot
  };
  const fallbackValidation = await validateWorkspaceCandidate(fallbackSession, options);

  return toWorkspaceMutationResult(
    fallbackValidation,
    [
      ...validation.issues,
      {
        code: "path_outside_allowed_set",
        field: "requestedCwd",
        message: `Requested cwd was rejected and fell back to workspace_root: ${requestedCwd || workspaceRoot}.`
      },
      ...fallbackValidation.issues
    ],
    fallbackValidation.issues
  );
}

export async function applyCwdChange(
  session: WorkspaceSessionState,
  requestedCwd: string,
  options: WorkspaceMutationOptions = {}
): Promise<WorkspaceMutationResult> {
  const nextSession: WorkspaceSessionState = {
    ...session,
    cwd: requestedCwd
  };

  return validateWorkspaceMutation(session, nextSession, options);
}

export async function applyAccessScopeChange(
  session: WorkspaceSessionState,
  requestedScope: SessionAccessScope,
  options: WorkspaceMutationOptions = {}
): Promise<AccessScopeMutationResult> {
  const nextSession: WorkspaceSessionState = {
    ...session,
    accessScope: requestedScope
  };

  const validation = await validateWorkspaceCandidate(nextSession, options);
  if (!hasBlockingIssues(validation.issues)) {
    return {
      ok: true,
      session: validation.session,
      issues: validation.issues,
      fallbackCwdApplied: false
    };
  }

  if (requestedScope !== "workspace" || !hasOnlyCwdScopeIssues(validation.issues)) {
    return {
      ok: false,
      session,
      issues: validation.issues,
      fallbackCwdApplied: false
    };
  }

  const fallbackSession: WorkspaceSessionState = {
    ...validation.session,
    cwd: validation.session.workspaceRoot
  };
  const fallbackValidation = await validateWorkspaceCandidate(fallbackSession, options);

  return {
    ok: !hasBlockingIssues(fallbackValidation.issues),
    session: fallbackValidation.session,
    issues: [
      ...validation.issues,
      {
        code: "path_outside_allowed_set",
        field: "scope",
        message: `Switching back to workspace scope reset cwd to workspace_root: ${validation.session.workspaceRoot}.`
      },
      ...fallbackValidation.issues
    ],
    fallbackCwdApplied: true
  };
}

export async function prepareAddDirConfirmation(
  session: WorkspaceSessionState,
  requestedPath: string,
  options: WorkspaceMutationOptions = {}
): Promise<{
  readonly ok: boolean;
  readonly confirmation?: AddDirConfirmation;
  readonly issues: readonly WorkspaceIssue[];
}> {
  const normalizedPath = normalizeContainerPath(requestedPath);
  const allowedDirs = new Set(buildAllowedDirectorySet(session));
  if (allowedDirs.has(normalizedPath)) {
    return {
      ok: false,
      issues: [createDuplicateRequestedPathIssue(normalizedPath)]
    };
  }

  const candidate = createAddDirCandidate(session, normalizedPath);
  const validation = await validateWorkspaceCandidate(candidate.session, options);
  const pathIssues = filterIssuesByFields(
    validation.issues,
    [
      "allowedDirs",
      ...(candidate.addedField ? [candidate.addedField] : [])
    ]
  );

  if (hasBlockingIssues(pathIssues)) {
    return {
      ok: false,
      issues: pathIssues
    };
  }

  return {
    ok: true,
    confirmation: {
      action: "adddir",
      requestedPath,
      normalizedPath,
      summary: `Allow access to ${normalizedPath} for the current session.`
    },
    issues: pathIssues
  };
}

export async function confirmAddDir(
  session: WorkspaceSessionState,
  confirmation: AddDirConfirmation,
  options: WorkspaceMutationOptions = {}
): Promise<WorkspaceMutationResult> {
  if (confirmation.action !== "adddir") {
    return {
      ok: false,
      session,
      issues: [
        {
          code: "path_empty",
          field: "confirmation.action",
          message: "Unsupported confirmation action."
        }
      ]
    };
  }

  const nextSession = createAddDirCandidate(session, confirmation.normalizedPath).session;

  return validateWorkspaceMutation(session, nextSession, options);
}

export function buildRuntimeWorkspaceContext(session: WorkspaceSessionState): RuntimeWorkspaceContext {
  return {
    cwd: session.cwd,
    workspaceRoot: session.workspaceRoot,
    writableRoots: buildAllowedDirectorySet(session),
    extraAllowedDirs: [...session.extraAllowedDirs],
    mode: session.mode,
    accessScope: session.accessScope
  };
}

function hasBlockingIssues(issues: readonly WorkspaceIssue[]): boolean {
  return getBlockingIssues(issues).length > 0;
}

async function validateWorkspaceMutation(
  previousSession: WorkspaceSessionState,
  nextSession: WorkspaceSessionState,
  options: WorkspaceMutationOptions
): Promise<WorkspaceMutationResult> {
  const validation = await validateWorkspaceCandidate(nextSession, options);
  if (hasBlockingIssues(validation.issues)) {
    return {
      ok: false,
      session: previousSession,
      issues: validation.issues
    };
  }

  return toWorkspaceMutationResult(validation);
}

function toWorkspaceMutationResult(
  validation: WorkspaceValidationResult,
  issues: readonly WorkspaceIssue[] = validation.issues,
  blockingIssues: readonly WorkspaceIssue[] = issues
): WorkspaceMutationResult {
  return {
    ok: !hasBlockingIssues(blockingIssues),
    session: validation.session,
    issues
  };
}

function createAddDirCandidate(
  session: WorkspaceSessionState,
  candidatePath: string
): AddDirCandidate {
  return {
    session: {
      ...session,
      extraAllowedDirs: [...session.extraAllowedDirs, candidatePath]
    },
    addedField: `extraAllowedDirs[${session.extraAllowedDirs.length}]`
  };
}

function createDuplicateRequestedPathIssue(normalizedPath: string): WorkspaceIssue {
  return {
    code: "path_duplicate",
    field: "requestedPath",
    message: `Directory is already in the allowed set: ${normalizedPath}.`
  };
}

function filterIssuesByFields(
  issues: readonly WorkspaceIssue[],
  fields: readonly string[]
): readonly WorkspaceIssue[] {
  const allowedFields = new Set(fields);
  return issues.filter((issue) => allowedFields.has(issue.field));
}

function getBlockingIssues(issues: readonly WorkspaceIssue[]): readonly WorkspaceIssue[] {
  return issues.filter((issue) => issue.code !== "path_not_normalized");
}

function hasOnlyCwdScopeIssues(issues: readonly WorkspaceIssue[]): boolean {
  const blockingIssues = getBlockingIssues(issues);
  return blockingIssues.length > 0 && blockingIssues.every((issue) => issue.field === "cwd");
}

async function validateWorkspaceCandidate(
  session: WorkspaceSessionState,
  options: WorkspaceMutationOptions
): Promise<WorkspaceValidationResult> {
  return validateWorkspaceSession(session, toValidationOptions(options));
}

function toValidationOptions(options: WorkspaceMutationOptions) {
  return {
    ...(options.inspector ? { inspector: options.inspector } : {}),
    ...(options.visiblePolicy ? { visiblePolicy: options.visiblePolicy } : {}),
    ...(options.requireExistingPaths !== undefined
      ? { requireExistingPaths: options.requireExistingPaths }
      : {})
  };
}
