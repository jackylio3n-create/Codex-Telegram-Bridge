import { mkdirSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type BridgeRuntimeStatus = "starting" | "running" | "stopping" | "stopped" | "error";

export interface BridgeRuntimeState {
  readonly version: 1;
  readonly phase: "daemon";
  readonly status: BridgeRuntimeStatus;
  readonly updatedAt: string;
  readonly startedAt: string | null;
  readonly pid: number | null;
  readonly appName: string;
  readonly env: string;
  readonly logFilePath: string;
  readonly databaseFilePath: string | null;
  readonly activeRunCount: number;
  readonly activeSessionCount: number;
  readonly boundChatCount: number;
  readonly lastPollAt: string | null;
  readonly lastSuccessfulPollAt: string | null;
  readonly lastFailedPollAt: string | null;
  readonly consecutivePollFailures: number;
  readonly lastPollError: string | null;
  readonly previousOffset: number | null;
  readonly currentOffset: number | null;
  readonly lastEvent: string | null;
}

export async function readBridgeRuntimeState(filePath: string): Promise<BridgeRuntimeState | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<BridgeRuntimeState>;
    if (!isBridgeRuntimeState(parsed)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export async function writeBridgeRuntimeState(filePath: string, state: BridgeRuntimeState): Promise<void> {
  mkdirSync(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function removeBridgeRuntimeState(filePath: string): Promise<boolean> {
  try {
    await rm(filePath, { force: false });
    return true;
  } catch {
    return false;
  }
}

export async function readPidFile(filePath: string): Promise<number | null> {
  try {
    const raw = (await readFile(filePath, "utf8")).trim();
    if (!/^\d+$/.test(raw)) {
      return null;
    }

    return Number(raw);
  } catch {
    return null;
  }
}

export async function writePidFile(filePath: string, pid: number): Promise<void> {
  mkdirSync(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${pid}\n`, "utf8");
}

export async function removePidFile(filePath: string): Promise<boolean> {
  try {
    await rm(filePath, { force: false });
    return true;
  } catch {
    return false;
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isProcessNotFoundError(error);
  }
}

function isBridgeRuntimeState(value: Partial<BridgeRuntimeState>): value is BridgeRuntimeState {
  return (
    value.version === 1 &&
    value.phase === "daemon" &&
    isRuntimeStatus(value.status) &&
    typeof value.updatedAt === "string" &&
    (value.startedAt === null || typeof value.startedAt === "string") &&
    (value.pid === null || typeof value.pid === "number") &&
    typeof value.appName === "string" &&
    typeof value.env === "string" &&
    typeof value.logFilePath === "string" &&
    (value.databaseFilePath === null || typeof value.databaseFilePath === "string") &&
    typeof value.activeRunCount === "number" &&
    typeof value.activeSessionCount === "number" &&
    typeof value.boundChatCount === "number" &&
    (value.lastPollAt === null || typeof value.lastPollAt === "string") &&
    (value.lastSuccessfulPollAt === null || typeof value.lastSuccessfulPollAt === "string") &&
    (value.lastFailedPollAt === null || typeof value.lastFailedPollAt === "string") &&
    typeof value.consecutivePollFailures === "number" &&
    (value.lastPollError === null || typeof value.lastPollError === "string") &&
    (value.previousOffset === null || typeof value.previousOffset === "number") &&
    (value.currentOffset === null || typeof value.currentOffset === "number") &&
    (value.lastEvent === null || typeof value.lastEvent === "string")
  );
}

function isRuntimeStatus(value: unknown): value is BridgeRuntimeStatus {
  return value === "starting" || value === "running" || value === "stopping" || value === "stopped" || value === "error";
}

function isProcessNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
  );
}
