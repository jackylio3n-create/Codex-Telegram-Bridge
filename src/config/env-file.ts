import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface ResolveRuntimeEnvironmentOptions {
  readonly explicitEnvFilePath?: string | null;
  readonly cwd?: string;
  readonly homeDir?: string;
  readonly baseEnv?: NodeJS.ProcessEnv;
}

export interface ResolvedRuntimeEnvironment {
  readonly env: NodeJS.ProcessEnv;
  readonly envFilePath: string | null;
}

export function parseEnvironmentFile(raw: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    const rawValue = line.slice(separatorIndex + 1).trim();
    env[key] = parseEnvironmentValue(rawValue);
  }

  return env;
}

export function serializeEnvironmentFile(entries: readonly [string, string][]): string {
  return entries
    .map(([key, value]) => `${key}=${quoteEnvironmentValue(value)}`)
    .join("\n")
    .concat("\n");
}

export function getDefaultEnvFileSearchPaths(options: {
  readonly cwd?: string;
  readonly homeDir?: string;
} = {}): readonly string[] {
  const currentWorkingDirectory = resolve(options.cwd ?? process.cwd());
  const resolvedHomeDir = resolve(options.homeDir ?? homedir());

  return [
    resolve(currentWorkingDirectory, ".env"),
    join(resolvedHomeDir, ".config", "codex-telegram-bridge", "config.env"),
    "/etc/codex-telegram-bridge.env"
  ];
}

export async function readEnvironmentFile(filePath: string): Promise<NodeJS.ProcessEnv> {
  const raw = await readFile(filePath, "utf8");
  return parseEnvironmentFile(raw);
}

export async function resolveRuntimeEnvironment(
  options: ResolveRuntimeEnvironmentOptions = {}
): Promise<ResolvedRuntimeEnvironment> {
  const baseEnv = options.baseEnv ?? process.env;
  const envFilePath = await resolveEnvironmentFilePath(options);

  if (!envFilePath) {
    return {
      env: { ...baseEnv },
      envFilePath: null
    };
  }

  const fileEnv = await readEnvironmentFile(envFilePath);
  return {
    env: {
      ...fileEnv,
      ...baseEnv
    },
    envFilePath
  };
}

async function resolveEnvironmentFilePath(
  options: ResolveRuntimeEnvironmentOptions
): Promise<string | null> {
  if (options.explicitEnvFilePath) {
    const explicitPath = resolve(options.explicitEnvFilePath);
    if (!(await pathExists(explicitPath))) {
      throw new Error(`Environment file not found: ${explicitPath}`);
    }

    return explicitPath;
  }

  for (const candidate of getDefaultEnvFileSearchPaths(options)) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function parseEnvironmentValue(rawValue: string): string {
  if (
    (rawValue.startsWith("\"") && rawValue.endsWith("\""))
    || (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    const inner = rawValue.slice(1, -1);
    return rawValue.startsWith("\"")
      ? inner
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, "\"")
        .replace(/\\\\/g, "\\")
      : inner.replace(/\\'/g, "'");
  }

  return rawValue;
}

function quoteEnvironmentValue(value: string): string {
  if (value === "") {
    return "\"\"";
  }

  if (/^[A-Za-z0-9_./:-]+$/.test(value)) {
    return value;
  }

  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/"/g, "\\\"")}"`;
}
