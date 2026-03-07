import type { CodexModePolicy, CodexRuntimeMode } from "./types.js";

export function getCodexModePolicy(mode: CodexRuntimeMode): CodexModePolicy {
  switch (mode) {
    case "ask":
      return {
        mode,
        sandbox: "read-only",
        approval: "on-request"
      };
    case "plan":
    case "code":
      return {
        mode,
        sandbox: "workspace-write",
        approval: "on-request"
      };
  }
}
