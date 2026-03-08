import { lstat, realpath } from "node:fs/promises";
import { posix as pathPosix } from "node:path";

export type SessionMode = "ask" | "plan" | "code";
export type SessionAccessScope = "workspace" | "system";
export type WorkspaceIssueCode =
  | "path_not_absolute"
  | "path_empty"
  | "path_not_directory"
  | "path_not_visible"
  | "path_missing"
  | "path_duplicate"
  | "path_outside_allowed_set"
  | "path_symlink_escape"
  | "path_not_normalized";

export interface WorkspaceSessionState {
  readonly workspaceRoot: string;
  readonly extraAllowedDirs: readonly string[];
  readonly cwd: string;
  readonly mode: SessionMode;
  readonly accessScope: SessionAccessScope;
}

export interface WorkspaceIssue {
  readonly code: WorkspaceIssueCode;
  readonly field: string;
  readonly message: string;
  readonly detail?: string;
}

export interface VisibleDirectoryPolicy {
  readonly mountedRoots: readonly string[];
}

export interface FilesystemInspector {
  lstat(targetPath: string): Promise<{
    readonly exists: boolean;
    readonly isDirectory: boolean;
    readonly isSymbolicLink: boolean;
  }>;
  realpath(targetPath: string): Promise<string>;
}

export interface WorkspaceValidationOptions {
  readonly inspector?: FilesystemInspector;
  readonly visiblePolicy?: VisibleDirectoryPolicy;
  readonly requireExistingPaths?: boolean;
}

export interface WorkspaceValidationResult {
  readonly session: WorkspaceSessionState;
  readonly normalizedAllowedDirs: readonly string[];
  readonly issues: readonly WorkspaceIssue[];
}

interface ResolvedRootsResult {
  readonly roots: readonly string[];
  readonly issues: readonly WorkspaceIssue[];
}

interface ResolvedPathInspectionResult {
  readonly resolvedPath: string | null;
  readonly issues: readonly WorkspaceIssue[];
}

interface InspectedPathState {
  readonly exists: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly resolvedPath: string | null;
}

export function createNodeFilesystemInspector(): FilesystemInspector {
  return {
    async lstat(targetPath: string) {
      try {
        const stats = await lstat(targetPath);
        return {
          exists: true,
          isDirectory: stats.isDirectory(),
          isSymbolicLink: stats.isSymbolicLink()
        };
      } catch (error) {
        if (isNotFoundError(error)) {
          return {
            exists: false,
            isDirectory: false,
            isSymbolicLink: false
          };
        }

        throw error;
      }
    },
    async realpath(targetPath: string) {
      return pathPosix.normalize(await realpath(targetPath));
    }
  };
}

export function normalizeContainerPath(targetPath: string): string {
  const trimmed = targetPath.trim();
  if (trimmed === "") {
    return "";
  }

  const normalized = pathPosix.normalize(trimmed);
  if (normalized === ".") {
    return "/";
  }

  return normalized;
}

export function isContainerAbsolutePath(targetPath: string): boolean {
  return pathPosix.isAbsolute(targetPath);
}

export function dedupeContainerPaths(paths: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const output: string[] = [];

  for (const entry of paths) {
    const normalized = normalizeContainerPath(entry);
    if (normalized === "" || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    output.push(normalized);
  }

  return output;
}

export function buildAllowedDirectorySet(
  session: Pick<WorkspaceSessionState, "workspaceRoot" | "extraAllowedDirs"> & Partial<Pick<WorkspaceSessionState, "accessScope">>
): readonly string[] {
  const scopeRoots = session.accessScope === "system" ? ["/"] : [];
  return dedupeContainerPaths([session.workspaceRoot, ...session.extraAllowedDirs, ...scopeRoots]);
}

export function isPathInsideBase(targetPath: string, basePath: string): boolean {
  const normalizedTarget = normalizeContainerPath(targetPath);
  const normalizedBase = normalizeContainerPath(basePath);

  if (normalizedBase === "/") {
    return normalizedTarget.startsWith("/");
  }

  return normalizedTarget === normalizedBase || normalizedTarget.startsWith(`${normalizedBase}/`);
}

export function isPathInsideAllowedSet(targetPath: string, allowedPaths: readonly string[]): boolean {
  return allowedPaths.some((allowedPath) => isPathInsideBase(targetPath, allowedPath));
}

export async function validateWorkspaceSession(
  session: WorkspaceSessionState,
  options: WorkspaceValidationOptions = {}
): Promise<WorkspaceValidationResult> {
  const issues: WorkspaceIssue[] = [];
  const workspaceRoot = validateDeclaredPath(session.workspaceRoot, "workspaceRoot", issues);
  const extraAllowedDirs = validateDeclaredDirectories(session.extraAllowedDirs, "extraAllowedDirs", issues);
  const normalizedAllowedDirs = dedupeContainerPaths([workspaceRoot, ...extraAllowedDirs]);
  const cwd = validateDeclaredPath(session.cwd, "cwd", issues);

  const normalizedSession: WorkspaceSessionState = {
    workspaceRoot,
    extraAllowedDirs,
    cwd,
    mode: session.mode,
    accessScope: session.accessScope
  };

  if (cwd !== "" && !isPathInsideAllowedSet(cwd, normalizedAllowedDirs)) {
    issues.push({
      code: "path_outside_allowed_set",
      field: "cwd",
      message: `cwd must remain inside workspace_root or an extra_allowed_dir: ${cwd}.`
    });
  }

  validateVisibleRoots(normalizedSession, normalizedAllowedDirs, options.visiblePolicy, issues);

  if (options.inspector) {
    const requireExisting = options.requireExistingPaths ?? true;
    issues.push(...await validateFilesystemState(
      normalizedSession,
      normalizedAllowedDirs,
      options.visiblePolicy,
      options.inspector,
      requireExisting
    ));
  }

  return {
    session: normalizedSession,
    normalizedAllowedDirs,
    issues
  };
}

function validateDeclaredDirectories(
  directories: readonly string[],
  field: string,
  issues: WorkspaceIssue[]
): readonly string[] {
  const seen = new Set<string>();
  const normalizedDirectories: string[] = [];

  directories.forEach((entry, index) => {
    const entryField = `${field}[${index}]`;
    const normalized = validateDeclaredPath(entry, entryField, issues);
    if (normalized === "") {
      return;
    }

    if (seen.has(normalized)) {
      issues.push({
        code: "path_duplicate",
        field: entryField,
        message: `Duplicate allowed directory: ${normalized}.`
      });
      return;
    }

    seen.add(normalized);
    normalizedDirectories.push(normalized);
  });

  return normalizedDirectories;
}

function validateDeclaredPath(rawPath: string, field: string, issues: WorkspaceIssue[]): string {
  const trimmed = rawPath.trim();
  if (trimmed === "") {
    issues.push({
      code: "path_empty",
      field,
      message: "Path must not be empty."
    });
    return "";
  }

  if (!isContainerAbsolutePath(trimmed)) {
    issues.push({
      code: "path_not_absolute",
      field,
      message: `Path must be an absolute Linux path: ${trimmed}.`
    });
    return normalizeContainerPath(trimmed);
  }

  const normalized = normalizeContainerPath(trimmed);
  if (normalized !== trimmed) {
    issues.push({
      code: "path_not_normalized",
      field,
      message: `Path is not normalized and will be rewritten as ${normalized}.`
    });
  }

  return normalized;
}

function validateVisibleRoots(
  session: WorkspaceSessionState,
  normalizedAllowedDirs: readonly string[],
  visiblePolicy: VisibleDirectoryPolicy | undefined,
  issues: WorkspaceIssue[]
): void {
  if (!visiblePolicy || visiblePolicy.mountedRoots.length === 0) {
    return;
  }

  const normalizedMountedRoots = dedupeContainerPaths(visiblePolicy.mountedRoots);
  const entries: Array<readonly [string, string]> = [
    ["workspaceRoot", session.workspaceRoot],
    ["cwd", session.cwd],
    ...session.extraAllowedDirs.map((path, index) => [`extraAllowedDirs[${index}]`, path] as const)
  ];

  for (const [field, targetPath] of entries) {
    if (targetPath !== "" && !isPathInsideAllowedSet(targetPath, normalizedMountedRoots)) {
      issues.push({
        code: "path_not_visible",
        field,
        message: `Path is outside configured visible roots: ${targetPath}.`
      });
    }
  }

  for (const allowedPath of normalizedAllowedDirs) {
    if (!isPathInsideAllowedSet(allowedPath, normalizedMountedRoots)) {
      issues.push({
        code: "path_not_visible",
        field: "allowedDirs",
        message: `Allowed directory is outside configured visible roots: ${allowedPath}.`
      });
    }
  }
}

async function validateFilesystemState(
  session: WorkspaceSessionState,
  normalizedAllowedDirs: readonly string[],
  visiblePolicy: VisibleDirectoryPolicy | undefined,
  inspector: FilesystemInspector,
  requireExistingPaths: boolean
): Promise<readonly WorkspaceIssue[]> {
  const mountedRoots = visiblePolicy?.mountedRoots ?? [];
  const normalizedMountedRoots = mountedRoots.length > 0
    ? dedupeContainerPaths(mountedRoots)
    : [];
  const inspections = await inspectPaths([
    ...normalizedAllowedDirs,
    ...normalizedMountedRoots,
    session.workspaceRoot,
    session.cwd,
    ...session.extraAllowedDirs
  ], inspector);
  const declaredAllowedRoots = buildResolvedRoots(
    normalizedAllowedDirs,
    "allowedDirs",
    inspections,
    requireExistingPaths
  );
  const declaredVisibleRoots = normalizedMountedRoots.length > 0
    ? buildResolvedRoots(
        normalizedMountedRoots,
        "mountedRoots",
        inspections,
        requireExistingPaths
      )
    : null;
  const visibleRoots = declaredVisibleRoots?.roots ?? declaredAllowedRoots.roots;
  const pathChecks = [
    assertPathState(
      session.workspaceRoot,
      "workspaceRoot",
      visibleRoots,
      inspections,
      requireExistingPaths
    ),
    assertPathState(
      session.cwd,
      "cwd",
      declaredAllowedRoots.roots,
      inspections,
      requireExistingPaths
    ),
    ...session.extraAllowedDirs.map((extraAllowedDir, index) => {
      return assertPathState(
        extraAllowedDir,
        `extraAllowedDirs[${index}]`,
        visibleRoots,
        inspections,
        requireExistingPaths
      );
    })
  ];

  return [
    ...declaredAllowedRoots.issues,
    ...(declaredVisibleRoots?.issues ?? []),
    ...pathChecks.flat()
  ];
}

function buildResolvedRoots(
  allowedDirs: readonly string[],
  field: string,
  inspections: ReadonlyMap<string, InspectedPathState>,
  requireExistingPaths: boolean
): ResolvedRootsResult {
  const seen = new Set<string>();
  const resolvedRoots: string[] = [];
  const issues: WorkspaceIssue[] = [];

  for (const allowedDir of allowedDirs) {
    const inspection = resolveWithInspection(
      allowedDir,
      field,
      inspections,
      requireExistingPaths
    );
    issues.push(...inspection.issues);

    if (inspection.resolvedPath && !seen.has(inspection.resolvedPath)) {
      seen.add(inspection.resolvedPath);
      resolvedRoots.push(inspection.resolvedPath);
    }
  }

  return {
    roots: resolvedRoots,
    issues
  };
}

function assertPathState(
  targetPath: string,
  field: string,
  resolvedAllowedDirs: readonly string[],
  inspections: ReadonlyMap<string, InspectedPathState>,
  requireExistingPaths: boolean
): readonly WorkspaceIssue[] {
  const inspection = resolveWithInspection(
    targetPath,
    field,
    inspections,
    requireExistingPaths
  );
  if (!inspection.resolvedPath) {
    return inspection.issues;
  }

  if (resolvedAllowedDirs.length === 0 || isPathInsideAllowedSet(inspection.resolvedPath, resolvedAllowedDirs)) {
    return inspection.issues;
  }

  return [
    ...inspection.issues,
    {
      code: "path_symlink_escape",
      field,
      message: `Resolved path escapes the allowed directory set: ${inspection.resolvedPath}.`,
      detail: targetPath
    }
  ];
}

function resolveWithInspection(
  targetPath: string,
  field: string,
  inspections: ReadonlyMap<string, InspectedPathState>,
  requireExistingPaths: boolean
): ResolvedPathInspectionResult {
  const issues: WorkspaceIssue[] = [];
  const state = getInspectedPath(inspections, targetPath);
  if (!state.exists) {
    if (requireExistingPaths) {
      issues.push({
        code: "path_missing",
        field,
        message: `Directory does not exist: ${targetPath}.`
      });
    }
    return {
      resolvedPath: null,
      issues
    };
  }

  if (!state.isDirectory) {
    issues.push({
      code: "path_not_directory",
      field,
      message: `Path is not a directory: ${targetPath}.`
    });
    return {
      resolvedPath: null,
      issues
    };
  }

  const resolved = state.resolvedPath;
  if (!resolved) {
    throw new Error(`Missing resolved path for inspected directory: ${targetPath}`);
  }

  if (state.isSymbolicLink && !isPathInsideBase(resolved, targetPath)) {
    issues.push({
      code: "path_symlink_escape",
      field,
      message: `Symbolic link resolves outside the declared directory: ${resolved}.`,
      detail: targetPath
    });
  }

  return {
    resolvedPath: resolved,
    issues
  };
}

async function inspectPaths(
  targetPaths: readonly string[],
  inspector: FilesystemInspector
): Promise<ReadonlyMap<string, InspectedPathState>> {
  const uniquePaths = [...new Set(targetPaths)];
  const inspections = await Promise.all(
    uniquePaths.map(async (targetPath) => {
      return [targetPath, await inspectPath(targetPath, inspector)] as const;
    })
  );

  return new Map(inspections);
}

async function inspectPath(
  targetPath: string,
  inspector: FilesystemInspector
): Promise<InspectedPathState> {
  const state = await inspector.lstat(targetPath);
  if (!state.exists) {
    return {
      exists: false,
      isDirectory: false,
      isSymbolicLink: false,
      resolvedPath: null
    };
  }

  if (!state.isDirectory) {
    return {
      exists: true,
      isDirectory: false,
      isSymbolicLink: state.isSymbolicLink,
      resolvedPath: null
    };
  }

  return {
    exists: true,
    isDirectory: true,
    isSymbolicLink: state.isSymbolicLink,
    resolvedPath: normalizeContainerPath(await inspector.realpath(targetPath))
  };
}

function getInspectedPath(
  inspections: ReadonlyMap<string, InspectedPathState>,
  targetPath: string
): InspectedPathState {
  const inspection = inspections.get(targetPath);
  if (!inspection) {
    throw new Error(`Missing inspection for path: ${targetPath}`);
  }

  return inspection;
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
