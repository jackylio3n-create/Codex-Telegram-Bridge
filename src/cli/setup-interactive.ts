import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { Writable } from "node:stream";
import { readEnvironmentFile } from "../config/env-file.js";
import {
  hashVerificationPassword,
  normalizeVerificationPassword
} from "../security/verification-password.js";
import type { SetupInputValues, SetupResolvedValues } from "./setup-shared.js";
import {
  deriveOwnerFromAllowlist,
  normalizeLogLevel,
  normalizeOptionalValue,
  resolveSetupValues
} from "./setup-values.js";

class MutedOutput extends Writable {
  readonly #target: NodeJS.WritableStream;
  #muted = false;

  constructor(target: NodeJS.WritableStream) {
    super();
    this.#target = target;
  }

  setMuted(muted: boolean): void {
    this.#muted = muted;
  }

  override _write(
    chunk: string | Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    if (!this.#muted) {
      this.#target.write(chunk);
    }
    callback(null);
  }
}

export async function promptForSetupValues(
  existingEnv: NodeJS.ProcessEnv,
  inputValues: SetupInputValues
): Promise<SetupResolvedValues> {
  const defaults = resolveSetupValues(existingEnv, inputValues);
  const output = new MutedOutput(process.stdout);
  const rl = createInterface({
    input: process.stdin,
    output
  });

  try {
    return {
      nodeEnv: await promptForValue(rl, "NODE_ENV", defaults.nodeEnv),
      telegramBotToken: await promptForSecretValue(
        rl,
        output,
        "Telegram bot token",
        defaults.telegramBotToken,
        { required: true }
      ),
      verificationPasswordHash: await promptForVerificationPasswordHash(
        rl,
        output,
        defaults.verificationPasswordHash
      ),
      allowedTelegramUserIds: await promptForValue(
        rl,
        "Allowed Telegram user IDs (comma-separated)",
        defaults.allowedTelegramUserIds,
        { required: true }
      ),
      defaultWorkspaceRoot: resolve(
        await promptForValue(
          rl,
          "Default workspace root",
          defaults.defaultWorkspaceRoot,
          {
            required: true
          }
        )
      ),
      appHome: resolve(
        await promptForValue(rl, "App home", defaults.appHome, {
          required: true
        })
      ),
      codexHome: resolve(
        await promptForValue(rl, "Codex home", defaults.codexHome, {
          required: true
        })
      ),
      logLevel: normalizeLogLevel(
        await promptForValue(rl, "Log level", defaults.logLevel, {
          required: true
        })
      ),
      ownerTelegramUserId: normalizeOptionalValue(
        await promptForValue(
          rl,
          "Owner Telegram user ID",
          defaults.ownerTelegramUserId ??
            deriveOwnerFromAllowlist(defaults.allowedTelegramUserIds) ??
            ""
        )
      )
    };
  } finally {
    rl.close();
  }
}

export async function readExistingEnvironmentFile(
  filePath: string
): Promise<NodeJS.ProcessEnv> {
  if (!(await pathExists(filePath))) {
    return {};
  }

  return readEnvironmentFile(filePath);
}

async function promptForValue(
  rl: Interface,
  label: string,
  defaultValue: string,
  options: { readonly required?: boolean } = {}
): Promise<string> {
  for (;;) {
    const suffix = defaultValue === "" ? "" : ` [${defaultValue}]`;
    const answer = (await rl.question(`${label}${suffix}: `)).trim();
    const value = answer === "" ? defaultValue : answer;

    const normalizedValue = value.trim();
    if (options.required === true && normalizedValue === "") {
      process.stdout.write(`${label} is required.\n`);
      continue;
    }

    return normalizedValue;
  }
}

async function promptForSecretValue(
  rl: Interface,
  output: MutedOutput,
  label: string,
  defaultValue: string,
  options: { readonly required?: boolean } = {}
): Promise<string> {
  for (;;) {
    const prompt =
      defaultValue === ""
        ? `${label}: `
        : `${label} [hidden, press Enter to keep existing]: `;

    output.setMuted(false);
    output.write(prompt);
    output.setMuted(true);
    const answer = (await rl.question("")).trim();
    output.setMuted(false);
    output.write("\n");

    const value = answer === "" ? defaultValue : answer;
    const normalizedValue = value.trim();
    if (options.required === true && normalizedValue === "") {
      process.stdout.write(`${label} is required.\n`);
      continue;
    }

    return normalizedValue;
  }
}

async function promptForVerificationPasswordHash(
  rl: Interface,
  output: MutedOutput,
  existingHash: string | null
): Promise<string | null> {
  for (;;) {
    const prompt = existingHash
      ? "Telegram verification password [hidden, press Enter to keep existing]: "
      : "Telegram verification password: ";
    const firstEntry = await promptForHiddenAnswer(rl, output, prompt);
    if (firstEntry === "") {
      if (existingHash !== null) {
        return existingHash;
      }

      process.stdout.write("Telegram verification password is required.\n");
      continue;
    }

    const confirmation = await promptForHiddenAnswer(
      rl,
      output,
      "Confirm Telegram verification password: "
    );
    if (firstEntry !== confirmation) {
      process.stdout.write(
        "Verification password confirmation did not match.\n"
      );
      continue;
    }

    const normalizedPassword = normalizeVerificationPassword(firstEntry);
    if (normalizedPassword === "") {
      process.stdout.write("Telegram verification password is required.\n");
      continue;
    }

    return hashVerificationPassword(normalizedPassword);
  }
}

async function promptForHiddenAnswer(
  rl: Interface,
  output: MutedOutput,
  prompt: string
): Promise<string> {
  output.setMuted(false);
  output.write(prompt);
  output.setMuted(true);
  const answer = await rl.question("");
  output.setMuted(false);
  output.write("\n");
  return answer.trim();
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}
