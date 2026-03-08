import type { ConfigIssue } from "../../config/index.js";
import type { DoctorCheck, DoctorCheckStatus } from "../types.js";

export function buildConfigChecks(
  configIssues: readonly ConfigIssue[],
  startupIssues: readonly ConfigIssue[]
): readonly DoctorCheck[] {
  const configFieldIssues = configIssues.filter(
    (issue) => !isPathIssue(issue.field)
  );
  const managedDirectoryIssues = startupIssues.filter((issue) =>
    issue.field.startsWith("paths.")
  );
  const codexHomeIssues = startupIssues.filter(
    (issue) => issue.field === "codexHome"
  );
  const workspaceIssues = startupIssues.filter(
    (issue) => issue.field === "defaultWorkspaceRoot"
  );
  const startupBlocked = startupIssues.length === 0 && hasErrors(configIssues);

  return [
    summarizeIssueCheck(
      "config",
      "config parsing",
      configFieldIssues,
      "Bootstrap environment variables parsed successfully."
    ),
    summarizeIssueCheck(
      "directories",
      "managed directories",
      startupBlocked ? undefined : managedDirectoryIssues,
      "App home, data, logs, temp, and runtime directories are writable."
    ),
    summarizeIssueCheck(
      "codex_home",
      "codex home",
      startupBlocked ? undefined : codexHomeIssues,
      "Codex home exists and is accessible."
    ),
    summarizeIssueCheck(
      "workspace_root",
      "default workspace root",
      startupBlocked ? undefined : workspaceIssues,
      "Default workspace root exists and is accessible."
    )
  ];
}

function summarizeIssueCheck(
  id: string,
  label: string,
  issues: readonly ConfigIssue[] | undefined,
  successSummary: string
): DoctorCheck {
  if (issues === undefined) {
    return {
      id,
      label,
      status: "skipped",
      summary: "Skipped because configuration parsing already failed.",
      details: []
    };
  }

  if (issues.length === 0) {
    return {
      id,
      label,
      status: "ok",
      summary: successSummary,
      details: []
    };
  }

  return {
    id,
    label,
    status: summarizeIssuesStatus(issues),
    summary: `${issues.length} issue(s) detected.`,
    details: issues.map((issue) => renderIssue(issue))
  };
}

function summarizeIssuesStatus(
  issues: readonly ConfigIssue[]
): DoctorCheckStatus {
  return issues.some((issue) => issue.severity === "error")
    ? "error"
    : "warning";
}

function hasErrors(issues: readonly ConfigIssue[]): boolean {
  return issues.some((issue) => issue.severity === "error");
}

function isPathIssue(field: string): boolean {
  return (
    field.startsWith("paths.") ||
    field === "codexHome" ||
    field === "defaultWorkspaceRoot"
  );
}

function renderIssue(issue: ConfigIssue): string {
  return issue.hint
    ? `${issue.field}: ${issue.message} Hint: ${issue.hint}`
    : `${issue.field}: ${issue.message}`;
}
