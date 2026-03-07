import { detectCodexLoginStatus } from "../../runtime/codex/index.js";
import type { DoctorCheck } from "../types.js";

export async function buildCodexCheck(): Promise<DoctorCheck> {
  const status = await detectCodexLoginStatus();

  if (!status.available) {
    return {
      id: "codex",
      label: "codex runtime",
      status: "error",
      summary: "Codex CLI is not available.",
      details: [status.rawOutput]
    };
  }

  if (!status.loggedIn) {
    return {
      id: "codex",
      label: "codex runtime",
      status: "error",
      summary: "Codex CLI is available but not logged in.",
      details: [status.rawOutput]
    };
  }

  return {
    id: "codex",
    label: "codex runtime",
    status: "ok",
    summary: "Codex CLI is available and logged in.",
    details: [status.provider ? `Provider: ${status.provider}.` : "Provider was not reported by the CLI."]
  };
}
