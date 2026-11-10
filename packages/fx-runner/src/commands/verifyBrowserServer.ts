/**
 * D#749 V2c-2b: `fx-runner verify-browser-server`, the entry the Claude CLI starts as the `fxverify` MCP server of one playwright deploy verifier job (settingsFile.ts writes the entry).
 * It is not in `--help`. Everything arrives as flags the runner itself wrote into the job's MCP file (job directory, app address, browser, storage-state file); the program's streams and
 * a short allowlist of its environment arrive through `host`. This is the PRODUCTION wiring of the server, and it never turns on the test-only certificate option of the server (the one the
 * tests' self-signed server needs): nothing here can reach it (test/verifyBrowser/wiring.test.ts pins both the built options and the files that mention it).
 */
import path from "node:path";
import { CliError } from "../cliError.js";
import type { Flags } from "../context.js";
import { parseBase } from "../verifyBrowser/pin.js";
import { startVerifyBrowserServer, type ServerOptions } from "../verifyBrowser/server.js";

export interface VerifyServerHost {
  input: ServerOptions["input"];
  output: ServerOptions["output"];
  /** The few variables the browser may inherit (PATH, locale, fontconfig); the driver passes on its own allowlist of them. */
  env: Readonly<Record<string, string | undefined>>;
}

const absolute = (flags: Flags, name: string): string => {
  const value = flags.get(name);
  if (typeof value !== "string" || !path.isAbsolute(value) || path.resolve(value) !== value) throw new CliError(`verify-browser-server needs --${name} as a plain absolute path`, 2);
  return value;
};

/** The server's options from the command line. Pure, so a test can read exactly what production passes. */
export function serverOptionsFrom(flags: Flags, host: VerifyServerHost): ServerOptions {
  const baseUrl = flags.get("base-url");
  if (typeof baseUrl !== "string" || parseBase(baseUrl) === undefined) throw new CliError("verify-browser-server needs --base-url as an https address (http only on a loopback host)", 2);
  return { baseUrl, jobDir: absolute(flags, "job-dir"), executablePath: absolute(flags, "executable"), storageStatePath: absolute(flags, "storage-state"), input: host.input, output: host.output, hostEnv: host.env };
}

export async function verifyBrowserServerCommand(flags: Flags, host: VerifyServerHost): Promise<number> {
  await startVerifyBrowserServer(serverOptionsFrom(flags, host)).done;
  return 0;
}
