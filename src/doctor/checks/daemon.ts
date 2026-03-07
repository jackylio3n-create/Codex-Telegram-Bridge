import { isProcessRunning, readBridgeRuntimeState, readPidFile } from "../../runtime/bridge/index.js";
import type { DoctorCheck } from "../types.js";

export async function buildDaemonCheck(
  pidFilePath: string,
  stateFilePath: string
): Promise<DoctorCheck> {
  const [pid, state] = await Promise.all([
    readPidFile(pidFilePath),
    readBridgeRuntimeState(stateFilePath)
  ]);

  if (!pid && !state) {
    return {
      id: "daemon",
      label: "daemon runtime",
      status: "warning",
      summary: "Bridge daemon is not running.",
      details: ["No PID file or runtime state file was found."]
    };
  }

  if (!pid) {
    return {
      id: "daemon",
      label: "daemon runtime",
      status: "warning",
      summary: "Runtime state exists but the PID file is missing.",
      details: [state ? `Last known status: ${state.status}.` : "Runtime state file is unreadable."]
    };
  }

  if (!isProcessRunning(pid)) {
    return {
      id: "daemon",
      label: "daemon runtime",
      status: "warning",
      summary: `PID ${pid} is not running.`,
      details: [state ? `Last known status: ${state.status}.` : "Runtime state file is unreadable."]
    };
  }

  return {
    id: "daemon",
    label: "daemon runtime",
    status: "ok",
    summary: `Bridge daemon is running (pid ${pid}).`,
    details: state
      ? [
          `Runtime status: ${state.status}.`,
          `Last successful poll: ${state.lastSuccessfulPollAt ?? "never"}.`,
          `Active runs: ${state.activeRunCount}.`
        ]
      : ["Runtime state file is missing, but the PID is alive."]
  };
}
