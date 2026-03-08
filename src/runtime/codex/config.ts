import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const SUPPORTED_CODEX_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
] as const;

export type CodexReasoningEffort =
  (typeof SUPPORTED_CODEX_REASONING_EFFORTS)[number];

export interface CodexReasoningConfigService {
  readonly supportedValues: readonly CodexReasoningEffort[];
  getCurrentEffort(): Promise<string | null>;
  setCurrentEffort(value: CodexReasoningEffort): Promise<void>;
}

export function isCodexReasoningEffort(
  value: string
): value is CodexReasoningEffort {
  return (SUPPORTED_CODEX_REASONING_EFFORTS as readonly string[]).includes(
    value
  );
}

export function createCodexReasoningConfigService(
  codexHome: string
): CodexReasoningConfigService {
  return {
    supportedValues: SUPPORTED_CODEX_REASONING_EFFORTS,
    getCurrentEffort() {
      return readCodexReasoningEffort(codexHome);
    },
    setCurrentEffort(value) {
      return writeCodexReasoningEffort(codexHome, value);
    }
  };
}

export async function readCodexReasoningEffort(
  codexHome: string
): Promise<string | null> {
  try {
    const raw = await readFile(join(codexHome, "config.toml"), "utf8");
    return readTomlString(raw, "model_reasoning_effort");
  } catch {
    return null;
  }
}

export async function writeCodexReasoningEffort(
  codexHome: string,
  effort: CodexReasoningEffort
): Promise<void> {
  const configPath = join(codexHome, "config.toml");
  const nextLine = `model_reasoning_effort = "${effort}"`;

  let current: string;
  try {
    current = await readFile(configPath, "utf8");
  } catch {
    current = "";
  }

  const next = /^\s*model_reasoning_effort\s*=.*$/m.test(current)
    ? current.replace(/^\s*model_reasoning_effort\s*=.*$/m, nextLine)
    : appendConfigLine(current, nextLine);

  await mkdir(codexHome, { recursive: true });
  await writeFile(configPath, next, "utf8");
}

function appendConfigLine(raw: string, line: string): string {
  const trimmed = raw.trimEnd();
  return trimmed === "" ? `${line}\n` : `${trimmed}\n${line}\n`;
}

function readTomlString(raw: string, key: string): string | null {
  const match = raw.match(
    new RegExp(`^\\s*${escapeRegularExpression(key)}\\s*=\\s*"([^"]*)"`, "m")
  );
  return match?.[1] ?? null;
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
