import { spawnSync } from "node:child_process";

const targets = process.argv.slice(2);

if (targets.length === 0) {
  process.stderr.write(
    "Usage: node scripts/dev/run-shellcheck.mjs <file> [...files]\n"
  );
  process.exit(1);
}

const result = spawnSync("shellcheck", targets, {
  encoding: "utf8",
  stdio: "pipe",
  shell: process.platform === "win32"
});

const combinedOutput = `${result.stdout ?? ""}${result.stderr ?? ""}`;
const shellcheckMissing = combinedOutput.includes(
  "'shellcheck' is not recognized"
);

if (
  (result.error && result.error.message.includes("ENOENT")) ||
  shellcheckMissing
) {
  process.stdout.write(
    "shellcheck is not available in the local PATH; CI runs the real shellcheck gate on Ubuntu.\n"
  );
  process.exit(0);
}

if (result.stdout) {
  process.stdout.write(result.stdout);
}

if (result.stderr) {
  process.stderr.write(result.stderr);
}

if (typeof result.status === "number") {
  process.exit(result.status);
}

process.exit(1);
