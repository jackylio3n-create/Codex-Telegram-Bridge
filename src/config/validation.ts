import { constants as fsConstants } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { ENV_PREFIX } from "./constants.js";
import type {
  AppConfig,
  ConfigIssue,
  ValidateStartupEnvironmentOptions
} from "./index.js";

export async function validateStartupEnvironment(
  config: AppConfig,
  options: ValidateStartupEnvironmentOptions = {}
): Promise<readonly ConfigIssue[]> {
  const issues: ConfigIssue[] = [];
  const createMissingDirectories = options.createMissingDirectories ?? false;

  await ensureManagedDirectory(
    config.paths.appHome,
    "paths.appHome",
    createMissingDirectories,
    issues
  );
  await ensureManagedDirectory(
    config.paths.dataDir,
    "paths.dataDir",
    createMissingDirectories,
    issues
  );
  await ensureManagedDirectory(
    config.paths.logsDir,
    "paths.logsDir",
    createMissingDirectories,
    issues
  );
  await ensureManagedDirectory(
    config.paths.tempDir,
    "paths.tempDir",
    createMissingDirectories,
    issues
  );
  await ensureManagedDirectory(
    config.paths.runtimeDir,
    "paths.runtimeDir",
    createMissingDirectories,
    issues
  );

  await ensureExistingDirectory(config.codexHome, "codexHome", issues);
  await ensureExistingDirectory(
    config.defaultWorkspaceRoot,
    "defaultWorkspaceRoot",
    issues
  );

  if (!config.verificationPasswordHash) {
    issues.push({
      severity: "warning",
      field: `${ENV_PREFIX}VERIFICATION_PASSWORD_HASH`,
      message:
        "Telegram first-contact verification password is not configured.",
      hint: "Run `npm run setup` again to enable the one-time Telegram password check."
    });
  }

  return issues;
}

async function ensureManagedDirectory(
  directoryPath: string,
  field: string,
  createIfMissing: boolean,
  issues: ConfigIssue[]
): Promise<void> {
  if (directoryPath.trim() === "") {
    issues.push({
      severity: "error",
      field,
      message: "Directory path is empty."
    });
    return;
  }

  try {
    if (createIfMissing) {
      await mkdir(directoryPath, { recursive: true });
      const exists = await ensureExistingDirectory(
        directoryPath,
        field,
        issues
      );
      if (!exists) {
        return;
      }
    } else {
      const state = await getDirectoryState(directoryPath);
      if (state === "missing") {
        await warnIfDirectoryCreatable(directoryPath, field, issues);
        return;
      }

      if (state === "not_directory") {
        issues.push({
          severity: "error",
          field,
          message: `Path is not a directory: ${directoryPath}.`
        });
        return;
      }
    }

    await access(directoryPath, fsConstants.W_OK);
  } catch (error) {
    issues.push({
      severity: "error",
      field,
      message: `Directory is not writable: ${directoryPath}.`,
      hint: getErrorMessage(error)
    });
  }
}

async function getDirectoryState(
  directoryPath: string
): Promise<"directory" | "missing" | "not_directory"> {
  try {
    const entry = await stat(directoryPath);
    return entry.isDirectory() ? "directory" : "not_directory";
  } catch (error) {
    if (isNotFoundError(error)) {
      return "missing";
    }

    throw error;
  }
}

async function warnIfDirectoryCreatable(
  directoryPath: string,
  field: string,
  issues: ConfigIssue[]
): Promise<void> {
  const writableAncestor = await findNearestExistingAncestor(directoryPath);
  if (writableAncestor === null) {
    issues.push({
      severity: "error",
      field,
      message: `Directory does not exist and no existing parent could be validated: ${directoryPath}.`
    });
    return;
  }

  try {
    await access(writableAncestor, fsConstants.W_OK);
    issues.push({
      severity: "warning",
      field,
      message: `Directory does not exist yet: ${directoryPath}.`,
      hint: `The bridge can create it on start. Verified writable parent: ${writableAncestor}.`
    });
  } catch (error) {
    issues.push({
      severity: "error",
      field,
      message: `Directory does not exist and parent is not writable: ${directoryPath}.`,
      hint: getErrorMessage(error)
    });
  }
}

async function findNearestExistingAncestor(
  directoryPath: string
): Promise<string | null> {
  let currentPath = dirname(directoryPath);
  let previousPath = "";

  while (currentPath !== previousPath) {
    try {
      const entry = await stat(currentPath);
      return entry.isDirectory() ? currentPath : null;
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    previousPath = currentPath;
    currentPath = dirname(currentPath);
  }

  return null;
}

async function ensureExistingDirectory(
  directoryPath: string,
  field: string,
  issues: ConfigIssue[]
): Promise<boolean> {
  if (directoryPath.trim() === "") {
    issues.push({
      severity: "error",
      field,
      message: "Directory path is empty."
    });
    return false;
  }

  try {
    const entry = await stat(directoryPath);
    if (!entry.isDirectory()) {
      issues.push({
        severity: "error",
        field,
        message: `Path is not a directory: ${directoryPath}.`
      });
      return false;
    }

    return true;
  } catch (error) {
    issues.push({
      severity: "error",
      field,
      message: `Directory does not exist: ${directoryPath}.`,
      hint: getErrorMessage(error)
    });
    return false;
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }

  return "Unknown filesystem error.";
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
