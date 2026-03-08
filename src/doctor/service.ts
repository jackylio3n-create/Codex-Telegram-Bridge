import { loadAppConfig, validateStartupEnvironment } from "../config/index.js";
import { createNodeFilesystemInspector } from "../core/workspace/index.js";
import { createBridgeStore } from "../store/index.js";
import { buildApprovalsCheck } from "./checks/approvals.js";
import { buildCodexCheck } from "./checks/codex.js";
import { buildConfigChecks } from "./checks/config.js";
import { buildDaemonCheck } from "./checks/daemon.js";
import { buildOffsetsCheck } from "./checks/offsets.js";
import { buildRunsCheck } from "./checks/runs.js";
import { buildStorageCheck } from "./checks/storage.js";
import { buildTelegramCheck } from "./checks/telegram.js";
import { buildWorkspaceCheck } from "./checks/workspace.js";
import type {
  DoctorCheck,
  DoctorReport,
  DoctorRunOptions,
  DoctorSummary
} from "./types.js";

const DEFAULT_OFFSET_CHANNEL_KEY = "telegram:getUpdates";

export async function runDoctor(
  options: DoctorRunOptions = {}
): Promise<DoctorReport> {
  const now = options.clock?.() ?? new Date();
  const { config, issues: configIssues } = loadAppConfig();
  const startupIssues = await validateStartupEnvironment(config, {
    createMissingDirectories: false
  });

  let storeError: string | undefined;
  let store;

  if (!hasErrors(configIssues) && !hasErrors(startupIssues)) {
    try {
      store = await createBridgeStore({ config });
    } catch (error) {
      storeError = getErrorMessage(error);
    }
  }

  try {
    const checks: DoctorCheck[] = [
      ...buildConfigChecks(configIssues, startupIssues),
      await buildDaemonCheck(
        config.paths.pidFilePath,
        config.paths.stateFilePath
      ),
      buildStorageCheck(store, storeError),
      await buildTelegramCheck(config.telegramBotToken),
      await buildCodexCheck(),
      buildOffsetsCheck(
        store,
        options.offsetChannelKey ?? DEFAULT_OFFSET_CHANNEL_KEY,
        config.defaults.offsetJumpWarningThreshold
      ),
      buildApprovalsCheck(store, now),
      buildRunsCheck(store),
      await buildWorkspaceCheck(
        store,
        options.filesystemInspector ?? createNodeFilesystemInspector(),
        options.visiblePolicy
      )
    ];

    return {
      generatedAt: now.toISOString(),
      checks,
      summary: summarizeChecks(checks)
    };
  } finally {
    store?.close();
  }
}

function summarizeChecks(checks: readonly DoctorCheck[]): DoctorSummary {
  let okCount = 0;
  let warningCount = 0;
  let errorCount = 0;
  let skippedCount = 0;

  for (const check of checks) {
    switch (check.status) {
      case "ok":
        okCount += 1;
        break;
      case "warning":
        warningCount += 1;
        break;
      case "error":
        errorCount += 1;
        break;
      case "skipped":
        skippedCount += 1;
        break;
    }
  }

  return {
    status: errorCount > 0 ? "error" : warningCount > 0 ? "warning" : "ok",
    okCount,
    warningCount,
    errorCount,
    skippedCount
  };
}

function hasErrors(
  issues: readonly { readonly severity: "error" | "warning" }[]
): boolean {
  return issues.some((issue) => issue.severity === "error");
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }

  return "Unknown error.";
}
