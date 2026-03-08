import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { buildPromptWithRollingSummary, isAgentMessageEvent, isThreadStartedEvent, parseCodexJsonEventLine } from "./events.js";
import { getCodexModePolicy } from "./mode.js";
import type {
  CodexCancelOutcome,
  CodexCancellationResult,
  CodexLoginStatus,
  CodexNormalizedEvent,
  CodexRunController,
  CodexRunResult,
  CodexStartRunOptions
} from "./types.js";

const DEFAULT_EXECUTABLE_PATH = "codex";
const CANCEL_GRACE_MS = 1500;
const WINDOWS_PROMPT_ENV = "CODEX_TELEGRAM_BRIDGE_PROMPT_B64";

interface LaunchAttemptResult {
  readonly exitCode: number | null;
  readonly threadId: string | null;
  readonly finalMessage: string | null;
  readonly staleThreadMismatch: boolean;
}

export async function detectCodexLoginStatus(
  executablePath = DEFAULT_EXECUTABLE_PATH
): Promise<CodexLoginStatus> {
  try {
    const result = await runOneShotCommand(executablePath, ["login", "status"]);
    const combinedOutput = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
    const providerMatch = combinedOutput.match(/Logged in using (.+)$/m);

    return {
      available: true,
      loggedIn: /Logged in/i.test(combinedOutput),
      provider: providerMatch?.[1]?.trim() ?? null,
      rawOutput: combinedOutput
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      available: false,
      loggedIn: false,
      provider: null,
      rawOutput: message
    };
  }
}

export function startCodexRun(options: CodexStartRunOptions): CodexRunController {
  const executablePath = options.executablePath ?? DEFAULT_EXECUTABLE_PATH;
  const events: CodexNormalizedEvent[] = [];
  let activeChild: ChildProcess | null = null;
  let activeExitPromise: Promise<number | null> | null = null;
  let latestThreadId: string | null = null;
  let latestFinalMessage: string | null = null;
  let staleRecovered = false;
  let usedSummarySeed = false;
  let cancelOutcome: CodexCancelOutcome | null = null;

  const emit = (event: CodexNormalizedEvent): void => {
    events.push(event);
    options.onEvent?.(event);

    if (isThreadStartedEvent(event)) {
      latestThreadId = event.threadId;
    }

    if (isAgentMessageEvent(event)) {
      latestFinalMessage = event.text;
    }
  };

  const completion = (async (): Promise<CodexRunResult> => {
    const firstAttempt = await launchAttempt({
      executablePath,
      options,
      emit,
      prompt: options.prompt.trim(),
      resumeThreadId: options.resumeThreadId ?? null,
      ...(options.environment ? { environment: options.environment } : {}),
      cwd: options.runtimeContext.cwd
    }, (child, exitPromise) => {
      activeChild = child;
      activeExitPromise = exitPromise;
    });

    let exitCode = firstAttempt.exitCode;
    let startedFresh = !options.resumeThreadId;

    if (firstAttempt.staleThreadMismatch) {
      staleRecovered = true;
      startedFresh = true;
      usedSummarySeed = Boolean(options.rollingSummary?.trim());

      latestThreadId = null;
      latestFinalMessage = null;

      const recoveredPrompt = buildPromptWithRollingSummary(options.prompt, options.rollingSummary);
      const secondAttempt = await launchAttempt({
        executablePath,
        options,
        emit,
        prompt: recoveredPrompt,
        resumeThreadId: null,
        ...(options.environment ? { environment: options.environment } : {}),
        cwd: options.runtimeContext.cwd
      }, (child, exitPromise) => {
        activeChild = child;
        activeExitPromise = exitPromise;
      });

      exitCode = secondAttempt.exitCode;
    }

    return {
      threadId: latestThreadId,
      finalMessage: latestFinalMessage,
      exitCode,
      startedFresh,
      staleRecovered,
      usedSummarySeed,
      cancelOutcome,
      events
    };
  })();

  return {
    completion,
    async cancel(): Promise<CodexCancelOutcome> {
      if (cancelOutcome) {
        return cancelOutcome;
      }

      const requestedAt = new Date().toISOString();
      const child = activeChild;
      const exitPromise = activeExitPromise;

      if (!child || !exitPromise || child.killed) {
        cancelOutcome = {
          requestedAt,
          result: "full",
          exited: true
        };
        return cancelOutcome;
      }

      const result = await requestSoftCancellation(child, exitPromise);
      cancelOutcome = {
        requestedAt,
        result,
        exited: result !== "unknown"
      };
      return cancelOutcome;
    }
  };
}

async function launchAttempt(
  input: {
    readonly executablePath: string;
    readonly options: CodexStartRunOptions;
    readonly emit: (event: CodexNormalizedEvent) => void;
    readonly prompt: string;
    readonly resumeThreadId: string | null;
    readonly environment?: NodeJS.ProcessEnv;
    readonly cwd?: string;
  },
  onSpawn: (child: ChildProcess, exitPromise: Promise<number | null>) => void
): Promise<LaunchAttemptResult> {
  const spawnPlan = createSpawnPlan({
    executablePath: input.executablePath,
    args: buildCodexArgs(input.options, input.resumeThreadId),
    prompt: input.prompt,
    ...(input.environment ? { environment: input.environment } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {})
  });
  const child = spawn(spawnPlan.command, spawnPlan.args, spawnPlan.options);

  if (spawnPlan.useStdin && child.stdin) {
    child.stdin.write(`${input.prompt}\n`, "utf8");
    child.stdin.end();
  }

  let observedThreadId: string | null = null;
  let finalMessage: string | null = null;
  let staleThreadMismatch = false;
  let cancellationTriggered = false;

  const exitPromise = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });

  onSpawn(child, exitPromise);

  if (!child.stdout || !child.stderr) {
    throw new Error("Codex child process did not expose stdout/stderr pipes.");
  }

  const stdoutReader = createInterface({ input: child.stdout });
  stdoutReader.on("line", (line) => {
    const parsed = parseCodexJsonEventLine(line);
    if (parsed) {
      input.emit(parsed);

      if (parsed.kind === "thread_started") {
        observedThreadId = parsed.threadId;

        if (
          input.resumeThreadId &&
          parsed.threadId !== input.resumeThreadId &&
          !cancellationTriggered
        ) {
          staleThreadMismatch = true;
          cancellationTriggered = true;
          void requestSoftCancellation(child, exitPromise);
        }
      }

      if (parsed.kind === "agent_message") {
        finalMessage = parsed.text;
      }
      return;
    }

    input.emit({
      kind: "raw_stdout",
      text: line
    });
  });

  const stderrReader = createInterface({ input: child.stderr });
  stderrReader.on("line", (line) => {
    input.emit({
      kind: "stderr",
      text: line
    });
  });

  const exitCode = await exitPromise;
  stdoutReader.close();
  stderrReader.close();

  return {
    exitCode,
    threadId: observedThreadId,
    finalMessage,
    staleThreadMismatch
  };
}

function buildCodexArgs(
  options: CodexStartRunOptions,
  resumeThreadId: string | null
): string[] {
  const policy = getCodexModePolicy(options.runtimeContext.mode);
  const args: string[] = ["exec"];

  if (resumeThreadId) {
    args.push("resume", resumeThreadId);
    appendSharedExecArgs(args, options, policy);
    args.push("-");
    return args;
  }

  appendSharedExecPrelude(args, options);
  args.push("-C", options.runtimeContext.cwd);
  appendSharedExecConfig(args, options, policy);

  for (const extraDir of options.runtimeContext.extraWritableRoots) {
    args.push("--add-dir", extraDir);
  }

  args.push("-");
  return args;
}

function appendSharedExecArgs(
  args: string[],
  options: CodexStartRunOptions,
  policy: ReturnType<typeof getCodexModePolicy>
): void {
  appendSharedExecPrelude(args, options);
  appendSharedExecConfig(args, options, policy);
}

function appendSharedExecPrelude(
  args: string[],
  options: CodexStartRunOptions
): void {
  args.push("--json");

  if (options.skipGitRepoCheck ?? true) {
    args.push("--skip-git-repo-check");
  }
}

function appendSharedExecConfig(
  args: string[],
  options: CodexStartRunOptions,
  policy: ReturnType<typeof getCodexModePolicy>
): void {
  args.push("-c", `approval_policy="${policy.approval}"`);
  args.push("-c", `sandbox_mode="${policy.sandbox}"`);

  for (const imagePath of options.images ?? []) {
    args.push("-i", imagePath);
  }
}

async function requestSoftCancellation(
  child: ChildProcess,
  exitPromise: Promise<number | null>
): Promise<CodexCancellationResult> {
  if (child.killed) {
    return "full";
  }

  try {
    child.kill("SIGINT");
  } catch {
    return "unknown";
  }

  const interrupted = await Promise.race([
    exitPromise.then(() => true),
    delay(CANCEL_GRACE_MS, false)
  ]);

  if (interrupted) {
    return "partial";
  }

  try {
    child.kill();
  } catch {
    return "unknown";
  }

  const terminated = await Promise.race([
    exitPromise.then(() => true),
    delay(CANCEL_GRACE_MS, false)
  ]);

  return terminated ? "partial" : "unknown";
}

async function runOneShotCommand(
  executablePath: string,
  args: readonly string[]
): Promise<{
  readonly stdout: string;
  readonly stderr: string;
}> {
  const spawnPlan = createSpawnPlan({
    executablePath,
    args,
    prompt: null
  });
  const child = spawn(spawnPlan.command, spawnPlan.args, spawnPlan.options);

  let stdout = "";
  let stderr = "";

  if (!child.stdout || !child.stderr) {
    throw new Error("Codex command did not expose stdout/stderr pipes.");
  }

  child.stdout.on("data", (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  if (exitCode !== 0) {
    throw new Error([stdout.trim(), stderr.trim()].filter(Boolean).join("\n") || `Command exited with ${exitCode}.`);
  }

  return {
    stdout,
    stderr
  };
}

function createSpawnPlan(input: {
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly prompt: string | null;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}): {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: {
    readonly cwd?: string;
    readonly env: NodeJS.ProcessEnv;
    readonly stdio: ["pipe" | "ignore", "pipe", "pipe"];
  };
  readonly useStdin: boolean;
} {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...(input.environment ?? {})
  };

  if (process.platform !== "win32") {
    return {
      command: input.executablePath,
      args: [...input.args],
      options: {
        ...(input.cwd ? { cwd: input.cwd } : {}),
        env,
        stdio: ["pipe", "pipe", "pipe"]
      },
      useStdin: input.prompt !== null
    };
  }

  if (input.prompt !== null) {
    env[WINDOWS_PROMPT_ENV] = Buffer.from(input.prompt, "utf8").toString("base64");
  } else {
    delete env[WINDOWS_PROMPT_ENV];
  }

  return {
    command: "powershell.exe",
    args: ["-Command", buildPowerShellCommand(input.executablePath, input.args, input.prompt !== null)],
    options: {
      ...(input.cwd ? { cwd: input.cwd } : {}),
      env,
      stdio: ["ignore", "pipe", "pipe"]
    },
    useStdin: false
  };
}

function buildPowerShellCommand(
  executablePath: string,
  args: readonly string[],
  hasPrompt: boolean
): string {
  const renderedArgs = args.map((arg) => {
    if (arg === "-" && hasPrompt) {
      return "([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CODEX_TELEGRAM_BRIDGE_PROMPT_B64)))";
    }

    return toPowerShellLiteral(arg);
  });

  return `& ${toPowerShellLiteral(executablePath)} ${renderedArgs.join(" ")}`.trim();
}

function toPowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
