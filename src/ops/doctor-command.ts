import { runDoctor, type DoctorCheck, type DoctorReport, type DoctorCheckStatus } from "../doctor/index.js";

export async function runDoctorCommand(): Promise<number> {
  const report = await runDoctor();
  process.stdout.write(renderDoctorReport(report));
  return report.summary.status === "error" ? 1 : 0;
}

export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];

  lines.push("Diagnostics doctor report");
  lines.push(`Generated at: ${report.generatedAt}`);
  lines.push("");

  for (const check of report.checks) {
    lines.push(`${renderStatus(check.status)} ${check.label}: ${check.summary}`);
    for (const detail of check.details) {
      lines.push(`  - ${detail}`);
    }
  }

  lines.push("");
  lines.push(
    `Summary: status=${report.summary.status}, ok=${report.summary.okCount}, warning=${report.summary.warningCount}, error=${report.summary.errorCount}, skipped=${report.summary.skippedCount}`
  );

  return `${lines.join("\n")}\n`;
}

function renderStatus(status: DoctorCheckStatus): string {
  switch (status) {
    case "ok":
      return "[OK]";
    case "warning":
      return "[WARN]";
    case "error":
      return "[FAIL]";
    case "skipped":
      return "[SKIP]";
  }
}
