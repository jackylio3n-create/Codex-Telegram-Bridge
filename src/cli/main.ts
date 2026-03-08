import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  formatConfigIssues,
  loadAppConfig,
  redactConfigForDisplay,
  validateStartupEnvironment
} from "../config/index.js";
import { resolveRuntimeEnvironment } from "../config/env-file.js";
import { createLogger } from "../logger/index.js";
import { runDoctorCommand } from "../ops/doctor-command.js";
import {
  BridgeRuntime,
  isProcessRunning,
  readBridgeRuntimeState,
  readPidFile,
  removePidFile,
  writePidFile
} from "../runtime/bridge/index.js";
import { parseSetupCommandArgs, runSetupCommand } from "./setup.js";

type CommandName = "help" | "start" | "serve" | "stop" | "status" | "logs" | "doctor" | "setup";

const HELP_TEXT = [
  "Codex + Telegram Bridge V1 daemon CLI",
  "",
  "Commands:",
  "  start    Validate config, then launch the bridge daemon in the background.",
  "  serve    Run the bridge in the foreground (recommended for systemd).",
  "  stop     Stop the managed daemon if it is running.",
  "  status   Show daemon state, PID, poll health, and storage paths.",
  "  logs     Print the last 40 lines from the bridge log file.",
  "  doctor   Run configuration, storage, Telegram, Codex, and runtime diagnostics.",
  "  setup    Interactively write an env file for a local deployment.",
  "  help     Show this message.",
  "",
  "Global options:",
  "  --config-env-file <path>  Load configuration from a specific env file before running a command.",
  "  --env-file <path>         Alias for built binaries; avoid this form with npm/tsx because Node reserves it.",
  "",
  "Environment variables:",
  "  CODEX_TELEGRAM_BRIDGE_APP_HOME",
  "  CODEX_TELEGRAM_BRIDGE_CODEX_HOME (falls back to CODEX_HOME)",
  "  CODEX_TELEGRAM_BRIDGE_DEFAULT_WORKSPACE_ROOT",
  "  CODEX_TELEGRAM_BRIDGE_TELEGRAM_BOT_TOKEN",
  "  CODEX_TELEGRAM_BRIDGE_VERIFICATION_PASSWORD_HASH",
  "  CODEX_TELEGRAM_BRIDGE_ALLOWED_TELEGRAM_USER_IDS",
  "  CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_USER_ID (recommended for self-use)",
  "  CODEX_TELEGRAM_BRIDGE_OWNER_TELEGRAM_CHAT_ID (optional hard lock)",
  "  CODEX_TELEGRAM_BRIDGE_LOG_LEVEL",
  "  CODEX_TELEGRAM_BRIDGE_CODEX_EXECUTABLE (optional)"
].join("\n");

async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const parsed = parseMainArguments(argv);
  const command = normalizeCommand(parsed.command);

  if (command !== "help" && command !== "setup") {
    const runtimeEnvironment = await resolveRuntimeEnvironment({
      explicitEnvFilePath: parsed.envFilePath,
      cwd: process.cwd(),
      homeDir: homedir(),
      baseEnv: process.env
    });
    applyRuntimeEnvironment(runtimeEnvironment.env);

    if (runtimeEnvironment.envFilePath) {
      process.stderr.write(`Using env file: ${runtimeEnvironment.envFilePath}\n`);
    }
  }

  switch (command) {
    case "help":
      process.stdout.write(`${HELP_TEXT}\n`);
      return parsed.command && parsed.command !== "help" && parsed.command !== "--help" && parsed.command !== "-h" ? 1 : 0;
    case "start":
      return runStart();
    case "serve":
      return runServe();
    case "stop":
      return runStop();
    case "status":
      return runStatus();
    case "logs":
      return runLogs(parsed.args);
    case "doctor":
      return runDoctorCommand();
    case "setup":
      return runSetupCommand(parseSetupCommandArgs([
        ...(parsed.envFilePath ? ["--env-file", parsed.envFilePath] : []),
        ...parsed.args
      ]));
  }
}

function normalizeCommand(rawCommand: string | undefined): CommandName {
  if (rawCommand === undefined || rawCommand === "" || rawCommand === "help" || rawCommand === "--help" || rawCommand === "-h") {
    return "help";
  }

  switch (rawCommand) {
    case "start":
    case "serve":
    case "stop":
    case "status":
    case "logs":
    case "doctor":
    case "setup":
      return rawCommand;
    default:
      return "help";
  }
}

function parseMainArguments(argv: readonly string[]): {
  readonly command: string | undefined;
  readonly args: readonly string[];
  readonly envFilePath: string | null;
} {
  let envFilePath: string | null = null;
  const filteredArgs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (current === undefined) {
      continue;
    }

    if (current === "--env-file" || current === "--config-env-file") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error(`Missing value for ${current}`);
      }

      envFilePath = next;
      index += 1;
      continue;
    }

    filteredArgs.push(current);
  }

  const [command, ...args] = filteredArgs;
  return {
    command,
    args,
    envFilePath
  };
}

function applyRuntimeEnvironment(runtimeEnv: NodeJS.ProcessEnv): void {
  for (const [key, value] of Object.entries(runtimeEnv)) {
    if (value !== undefined) {
      process.env[key] = value;
    }
  }
}

async function runStart(): Promise<number> {
  const { config, issues } = loadAppConfig();
  const startupIssues = await validateStartupEnvironment(config, { createMissingDirectories: true });
  const combinedIssues = [...issues, ...startupIssues];
  if (hasErrors(combinedIssues)) {
    process.stderr.write(`${formatConfigIssues(combinedIssues)}\n`);
    return 1;
  }

  const existingPid = await readPidFile(config.paths.pidFilePath);
  if (existingPid && isProcessRunning(existingPid)) {
    process.stdout.write(`Bridge daemon is already running (pid ${existingPid}).\n`);
    return 0;
  }

  if (existingPid) {
    await removePidFile(config.paths.pidFilePath);
  }

  const child = spawn(
    process.execPath,
    [...process.execArgv, fileURLToPath(import.meta.url), "serve"],
    {
      cwd: process.cwd(),
      env: process.env,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }
  );
  child.unref();

  const started = await waitForDaemonStart(config.paths.pidFilePath, config.paths.stateFilePath, 5_000);
  if (!started) {
    process.stderr.write("Bridge daemon did not report a healthy start within 5 seconds.\n");
    return 1;
  }

  const pid = await readPidFile(config.paths.pidFilePath);
  process.stdout.write(`Bridge daemon started${pid ? ` (pid ${pid})` : ""}.\n`);
  process.stdout.write(`Log file: ${config.paths.logFilePath}\n`);
  return 0;
}

async function runServe(): Promise<number> {
  const { config, issues } = loadAppConfig();
  const startupIssues = await validateStartupEnvironment(config, { createMissingDirectories: true });
  const combinedIssues = [...issues, ...startupIssues];
  if (hasErrors(combinedIssues)) {
    process.stderr.write(`${formatConfigIssues(combinedIssues)}\n`);
    return 1;
  }

  const existingPid = await readPidFile(config.paths.pidFilePath);
  if (existingPid && existingPid !== process.pid && isProcessRunning(existingPid)) {
    process.stderr.write(`Bridge daemon is already running (pid ${existingPid}).\n`);
    return 1;
  }

  await writePidFile(config.paths.pidFilePath, process.pid);
  const logger = createLogger({
    name: config.appName,
    level: config.logLevel,
    console: false,
    filePath: config.paths.logFilePath,
    redactValues: [
      config.telegramBotToken,
      ...(config.verificationPasswordHash ? [config.verificationPasswordHash] : [])
    ]
  });
  const runtime = await BridgeRuntime.create({
    config,
    logger
  });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) {
      return;
    }

    stopping = true;
    logger.info("Shutdown signal received.", { signal, pid: process.pid });
    await runtime.stop();
  };

  const sigintHandler = () => { void shutdown("SIGINT"); };
  const sigtermHandler = () => { void shutdown("SIGTERM"); };
  process.on("SIGINT", sigintHandler);
  process.on("SIGTERM", sigtermHandler);

  try {
    logger.info("Bridge daemon starting.", {
      pid: process.pid,
      config: redactConfigForDisplay(config)
    });
    await runtime.runUntilStopped();
    logger.info("Bridge daemon stopped.", { pid: process.pid });
    return 0;
  } catch (error) {
    logger.error("Bridge daemon crashed.", { error, pid: process.pid });
    return 1;
  } finally {
    process.off("SIGINT", sigintHandler);
    process.off("SIGTERM", sigtermHandler);
    await removePidFile(config.paths.pidFilePath);
  }
}

async function runStop(): Promise<number> {
  const { config, issues } = loadAppConfig();
  if (issues.length > 0) {
    process.stderr.write(`${formatConfigIssues(issues)}\n`);
  }

  const pid = await readPidFile(config.paths.pidFilePath);
  if (!pid) {
    process.stdout.write("Bridge daemon is not running.\n");
    return 0;
  }

  if (!isProcessRunning(pid)) {
    await removePidFile(config.paths.pidFilePath);
    process.stdout.write(`Removed stale PID file for pid ${pid}.\n`);
    return 0;
  }

  process.kill(pid, "SIGTERM");
  const stopped = await waitForProcessExit(pid, 10_000);
  if (!stopped) {
    process.stderr.write(`Timed out waiting for pid ${pid} to exit.\n`);
    return 1;
  }

  await removePidFile(config.paths.pidFilePath);
  process.stdout.write(`Stopped bridge daemon (pid ${pid}).\n`);
  return 0;
}

async function runStatus(): Promise<number> {
  const { config, issues } = loadAppConfig();
  if (issues.length > 0) {
    process.stderr.write(`${formatConfigIssues(issues)}\n`);
  }

  const [pid, state, logFileExists] = await Promise.all([
    readPidFile(config.paths.pidFilePath),
    readBridgeRuntimeState(config.paths.stateFilePath),
    pathExists(config.paths.logFilePath)
  ]);
  const daemonRunning = pid ? isProcessRunning(pid) : false;

  process.stdout.write(`Daemon: ${daemonRunning ? "running" : "stopped"}\n`);
  process.stdout.write(`PID: ${pid ?? "none"}\n`);
  process.stdout.write(`State file: ${config.paths.stateFilePath}\n`);
  process.stdout.write(`Log file: ${config.paths.logFilePath} (${logFileExists ? "present" : "missing"})\n`);

  if (!state) {
    process.stdout.write("Runtime state: missing\n");
    return daemonRunning ? 0 : 1;
  }

  process.stdout.write(`Runtime status: ${state.status}\n`);
  process.stdout.write(`Started at: ${state.startedAt ?? "unknown"}\n`);
  process.stdout.write(`Database: ${state.databaseFilePath ?? "unknown"}\n`);
  process.stdout.write(`Active runs: ${state.activeRunCount}\n`);
  process.stdout.write(`Active sessions: ${state.activeSessionCount}\n`);
  process.stdout.write(`Bound chats: ${state.boundChatCount}\n`);
  process.stdout.write(`Last poll: ${state.lastPollAt ?? "never"}\n`);
  process.stdout.write(`Last successful poll: ${state.lastSuccessfulPollAt ?? "never"}\n`);
  process.stdout.write(`Last failed poll: ${state.lastFailedPollAt ?? "never"}\n`);
  process.stdout.write(`Poll failures: ${state.consecutivePollFailures}\n`);
  process.stdout.write(`Offset: ${state.previousOffset ?? "?"} -> ${state.currentOffset ?? "?"}\n`);
  process.stdout.write(`Last event: ${state.lastEvent ?? "none"}\n`);
  if (state.lastPollError) {
    process.stdout.write(`Last poll error: ${state.lastPollError}\n`);
  }

  return daemonRunning ? 0 : 1;
}

async function runLogs(args: readonly string[]): Promise<number> {
  const { config, issues } = loadAppConfig();
  if (issues.length > 0) {
    process.stderr.write(`${formatConfigIssues(issues)}\n`);
  }

  const lineCount = parseLineCount(args[0]);
  if (lineCount === null) {
    process.stderr.write('Invalid line count. Use "logs" or "logs <positive_number>".\n');
    return 1;
  }

  if (!(await pathExists(config.paths.logFilePath))) {
    process.stdout.write(`No log file found at ${config.paths.logFilePath}\n`);
    return 0;
  }

  const logContents = await readFile(config.paths.logFilePath, "utf8");
  const selectedLines = takeLastLines(logContents, lineCount);
  process.stdout.write(`Showing last ${selectedLines.length} log lines from ${config.paths.logFilePath}\n`);
  if (selectedLines.length > 0) {
    process.stdout.write(`${selectedLines.join("\n")}\n`);
  }
  return 0;
}

function hasErrors(issues: readonly { readonly severity: "error" | "warning" }[]): boolean {
  return issues.some((issue) => issue.severity === "error");
}

function parseLineCount(rawValue: string | undefined): number | null {
  if (rawValue === undefined) {
    return 40;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function takeLastLines(contents: string, lineCount: number): string[] {
  return contents
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .slice(-lineCount);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function waitForDaemonStart(pidFilePath: string, stateFilePath: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = await readPidFile(pidFilePath);
    const state = await readBridgeRuntimeState(stateFilePath);
    if (pid && isProcessRunning(pid) && state && (state.status === "starting" || state.status === "running" || state.status === "error")) {
      return true;
    }

    await delay(200);
  }

  return false;
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return true;
    }

    await delay(200);
  }

  return !isProcessRunning(pid);
}

main().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
