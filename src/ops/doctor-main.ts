import { runDoctorCommand } from "./doctor-command.js";

runDoctorCommand().then((exitCode) => {
  process.exitCode = exitCode;
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
