import type {
  CodexAgentMessageEvent,
  CodexApprovalRequestEvent,
  CodexNormalizedEvent,
  CodexThreadStartedEvent,
  CodexTurnCompletedEvent,
  CodexUsage
} from "./types.js";

export function parseCodexJsonEventLine(
  line: string
): CodexNormalizedEvent | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const rawType = typeof parsed.type === "string" ? parsed.type : "unknown";

    switch (rawType) {
      case "thread.started":
        if (typeof parsed.thread_id === "string") {
          return {
            kind: "thread_started",
            threadId: parsed.thread_id,
            rawType
          };
        }
        break;
      case "turn.started":
        return {
          kind: "turn_started",
          rawType
        };
      case "item.completed":
        if (isAgentMessageItem(parsed.item)) {
          return {
            kind: "agent_message",
            itemId: typeof parsed.item.id === "string" ? parsed.item.id : null,
            text: parsed.item.text,
            rawType
          };
        }
        break;
      case "agent_message":
        if (typeof parsed.message === "string") {
          return {
            kind: "agent_message",
            itemId: null,
            text: parsed.message,
            rawType
          };
        }
        break;
      case "exec_approval_request":
        if (
          isStringArray(parsed.command) &&
          typeof parsed.call_id === "string" &&
          typeof parsed.cwd === "string"
        ) {
          return {
            kind: "approval_request",
            callId: parsed.call_id,
            approvalId:
              typeof parsed.approval_id === "string"
                ? parsed.approval_id
                : null,
            turnId: typeof parsed.turn_id === "string" ? parsed.turn_id : null,
            command: parsed.command,
            cwd: parsed.cwd,
            reason: typeof parsed.reason === "string" ? parsed.reason : null,
            summary: formatApprovalSummary(
              parsed.command,
              typeof parsed.reason === "string" ? parsed.reason : null
            ),
            rawType
          };
        }
        break;
      case "exec_command_begin":
        if (
          isStringArray(parsed.command) &&
          typeof parsed.call_id === "string" &&
          typeof parsed.cwd === "string"
        ) {
          return {
            kind: "exec_command_begin",
            callId: parsed.call_id,
            turnId: typeof parsed.turn_id === "string" ? parsed.turn_id : null,
            command: parsed.command,
            cwd: parsed.cwd,
            source: typeof parsed.source === "string" ? parsed.source : null,
            rawType
          };
        }
        break;
      case "exec_command_end":
        if (
          isStringArray(parsed.command) &&
          typeof parsed.call_id === "string" &&
          typeof parsed.cwd === "string"
        ) {
          return {
            kind: "exec_command_end",
            callId: parsed.call_id,
            turnId: typeof parsed.turn_id === "string" ? parsed.turn_id : null,
            command: parsed.command,
            cwd: parsed.cwd,
            source: typeof parsed.source === "string" ? parsed.source : null,
            exitCode:
              typeof parsed.exit_code === "number" ? parsed.exit_code : null,
            stdout: typeof parsed.stdout === "string" ? parsed.stdout : "",
            stderr: typeof parsed.stderr === "string" ? parsed.stderr : "",
            aggregatedOutput:
              typeof parsed.aggregated_output === "string"
                ? parsed.aggregated_output
                : "",
            status: typeof parsed.status === "string" ? parsed.status : null,
            rawType
          };
        }
        break;
      case "patch_apply_begin":
        if (
          typeof parsed.call_id === "string" &&
          parsed.changes &&
          typeof parsed.changes === "object"
        ) {
          return {
            kind: "patch_apply_begin",
            callId: parsed.call_id,
            turnId: typeof parsed.turn_id === "string" ? parsed.turn_id : null,
            changedPaths: Object.keys(
              parsed.changes as Record<string, unknown>
            ),
            rawType
          };
        }
        break;
      case "turn.completed":
      case "task_complete":
        return {
          kind: "turn_completed",
          usage: extractUsage(parsed.usage ?? parsed.token_usage),
          rawType
        };
      default:
        return {
          kind: "raw_json",
          rawType,
          payload: parsed
        };
    }
  } catch {
    return null;
  }

  return null;
}

export function buildPromptWithRollingSummary(
  prompt: string,
  rollingSummary?: string | null
): string {
  const trimmedSummary = rollingSummary?.trim() ?? "";
  const trimmedPrompt = prompt.trim();

  if (trimmedSummary === "") {
    return trimmedPrompt;
  }

  return [
    "Historical context recovered from the bridge rolling summary:",
    trimmedSummary,
    "",
    "Current user request:",
    trimmedPrompt
  ].join("\n");
}

export function isThreadStartedEvent(
  event: CodexNormalizedEvent
): event is CodexThreadStartedEvent {
  return event.kind === "thread_started";
}

export function isAgentMessageEvent(
  event: CodexNormalizedEvent
): event is CodexAgentMessageEvent {
  return event.kind === "agent_message";
}

export function isApprovalRequestEvent(
  event: CodexNormalizedEvent
): event is CodexApprovalRequestEvent {
  return event.kind === "approval_request";
}

export function isTurnCompletedEvent(
  event: CodexNormalizedEvent
): event is CodexTurnCompletedEvent {
  return event.kind === "turn_completed";
}

function isAgentMessageItem(value: unknown): value is {
  readonly id?: string;
  readonly type: "agent_message";
  readonly text: string;
} {
  return Boolean(
    value &&
    typeof value === "object" &&
    "type" in value &&
    "text" in value &&
    (value as { readonly type?: unknown }).type === "agent_message" &&
    typeof (value as { readonly text?: unknown }).text === "string"
  );
}

function extractUsage(value: unknown): CodexUsage | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const usage = value as Record<string, unknown>;
  return {
    ...(typeof usage.input_tokens === "number"
      ? { inputTokens: usage.input_tokens }
      : {}),
    ...(typeof usage.cached_input_tokens === "number"
      ? { cachedInputTokens: usage.cached_input_tokens }
      : {}),
    ...(typeof usage.output_tokens === "number"
      ? { outputTokens: usage.output_tokens }
      : {})
  };
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function formatApprovalSummary(
  command: readonly string[],
  reason: string | null
): string {
  const renderedCommand = command.join(" ").trim();
  if (renderedCommand === "") {
    return reason ?? "Approval requested.";
  }

  return reason ? `${renderedCommand} (${reason})` : renderedCommand;
}
