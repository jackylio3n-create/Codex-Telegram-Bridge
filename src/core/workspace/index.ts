export {
  buildAllowedDirectorySet,
  createNodeFilesystemInspector,
  dedupeContainerPaths,
  isContainerAbsolutePath,
  isPathInsideAllowedSet,
  isPathInsideBase,
  normalizeContainerPath,
  validateWorkspaceSession,
  type FilesystemInspector,
  type SessionAccessScope,
  type SessionMode,
  type VisibleDirectoryPolicy,
  type WorkspaceIssue,
  type WorkspaceSessionState,
  type WorkspaceValidationOptions,
  type WorkspaceValidationResult
} from "./path-policy.js";

export {
  applyAccessScopeChange,
  applyCwdChange,
  buildRuntimeWorkspaceContext,
  confirmAddDir,
  initializeNewSessionWorkspace,
  prepareAddDirConfirmation,
  type AccessScopeMutationResult,
  type AddDirConfirmation,
  type NewSessionWorkspaceInput,
  type RuntimeWorkspaceContext,
  type WorkspaceMutationOptions,
  type WorkspaceMutationResult
} from "./session-workspace.js";
