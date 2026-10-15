import { homedir } from "node:os";
import { main } from "./main.js";
import { scrub } from "./scrub.js";

/** A crash outside `main` (a stray rejection or timer): fixed text, plus the scrubbed stack under --debug. Node's own crash printout never runs. */
function crash(error: unknown): never {
  process.stderr.write("error: unexpected error: run again with --debug for details\n");
  if (process.argv.includes("--debug")) process.stderr.write(scrub(`debug: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`));
  process.exit(1);
}

process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);

process.exitCode = await main(process.argv.slice(2), {
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  platform: process.platform,
  uid: process.getuid?.(),
  home: homedir(),
});
