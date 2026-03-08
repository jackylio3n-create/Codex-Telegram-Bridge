import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";
import {
  formatConfigIssues,
  loadAppConfig,
  redactConfigForDisplay,
  validateStartupEnvironment
} from "../config/index.js";
import { SETUP_VERIFICATION_PASSWORD_ENV_VAR } from "../security/verification-password.js";
import { SETUP_HELP_TEXT, parseSetupCommandArgs } from "./setup-args.js";
import {
  readExistingEnvironmentFile,
  promptForSetupValues
} from "./setup-interactive.js";
import type {
  ParsedSetupOptions,
  SetupInputValues,
  SetupResolvedValues
} from "./setup-shared.js";
import {
  buildEnvironmentEntries,
  renderEnvironmentFile,
  resolveSetupValues
} from "./setup-values.js";

export {
  SETUP_HELP_TEXT,
  parseSetupCommandArgs,
  renderEnvironmentFile,
  resolveSetupValues,
  buildEnvironmentEntries
};
export type { ParsedSetupOptions, SetupInputValues, SetupResolvedValues };

export async function runSetupCommand(
  options: ParsedSetupOptions
): Promise<number> {
  if (options.showHelp) {
    process.stdout.write(`${SETUP_HELP_TEXT}\n`);
    return 0;
  }

  const existingEnv = await readExistingEnvironmentFile(options.envFilePath);
  const setupInputs: SetupInputValues = {
    ...options.values,
    ...(!options.interactive && process.env[SETUP_VERIFICATION_PASSWORD_ENV_VAR]
      ? {
          verificationPassword: process.env[SETUP_VERIFICATION_PASSWORD_ENV_VAR]
        }
      : {})
  };
  const resolvedValues = options.interactive
    ? await promptForSetupValues(existingEnv, setupInputs)
    : resolveSetupValues(existingEnv, setupInputs);
  const envEntries = buildEnvironmentEntries(existingEnv, resolvedValues);
  const env = Object.fromEntries(envEntries);
  const { config, issues } = loadAppConfig({
    env,
    cwd: process.cwd(),
    homeDir: homedir()
  });

  if (issues.some((issue) => issue.severity === "error")) {
    process.stderr.write(`${formatConfigIssues(issues)}\n`);
    return 1;
  }

  await mkdir(config.defaultWorkspaceRoot, { recursive: true });
  await mkdir(dirname(options.envFilePath), { recursive: true });
  await writeFile(
    options.envFilePath,
    renderEnvironmentFile(envEntries),
    "utf8"
  );

  const startupIssues = await validateStartupEnvironment(config, {
    createMissingDirectories: true
  });
  const actionableIssues = startupIssues.filter((issue) => {
    return (
      issue.field !== "defaultWorkspaceRoot" && issue.field !== "codexHome"
    );
  });
  const followUpIssues = startupIssues.filter((issue) => {
    return issue.field === "codexHome";
  });

  process.stdout.write(`Wrote environment file: ${options.envFilePath}\n`);
  process.stdout.write(
    `${JSON.stringify(redactConfigForDisplay(config), null, 2)}\n`
  );

  if (actionableIssues.length > 0 || followUpIssues.length > 0) {
    process.stdout.write("\nStartup checks reported follow-up items:\n");
    process.stdout.write(
      `${formatConfigIssues([...actionableIssues, ...followUpIssues])}\n`
    );
    process.stdout.write(
      "You can finish Codex login and rerun `npm run doctor` before starting the service.\n"
    );
  }

  return actionableIssues.some((issue) => issue.severity === "error") ? 1 : 0;
}
