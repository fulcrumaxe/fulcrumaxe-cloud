/**
 * D#749 V2c-2b: `fx-runner verify-browser-server`, the entry the Claude CLI starts as the `fxverify` MCP server of one playwright deploy verifier job (settingsFile.ts writes the entry).
 * It is not in `--help`. Everything arrives as flags the runner itself wrote into the job's MCP file (job directory, app address, browser, storage-state file); the program's streams and
 * a short allowlist of its environment arrive through `host`. This is the PRODUCTION wiring of the server, and it never turns on the test-only certificate option of the server (the one the
 * tests' self-signed server needs): nothing here can reach it (test/verifyBrowser/wiring.test.ts pins both the built options and the files that mention it).
 */
import path from "node:path";
import { CliError } from "../cliError.js";
import type { Flags } from "../context.js";
import { bypassRefusalText, loadBypass } from "../protectionBypass.js";
import { parseBase } from "../verifyBrowser/pin.js";
import { startVerifyBrowserServer, type ServerOptions } from "../verifyBrowser/server.js";

export interface VerifyServerHost {
  input: ServerOptions["input"];
  output: ServerOptions["output"];
  /** The few variables the browser may inherit (PATH, locale, fontconfig); the driver passes on its own allowlist of them. */
  env: Readonly<Record<string, string | undefined>>;
  /** For the protection bypass file's checks (owner, mode, place); without them no bypass file is accepted. */
  uid?: number | undefined;
  home?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  xdgCacheHome?: string | undefined;
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
  const options: ServerOptions = { baseUrl, jobDir: absolute(flags, "job-dir"), executablePath: absolute(flags, "executable"), storageStatePath: absolute(flags, "storage-state"), input: host.input, output: host.output, hostEnv: host.env };
  // The protection bypass: the runner passes the file's PATH (never the secret) and the registered cloud origin, and only for a base that is that origin. The secret is read here, by the
  // same checks the runner applied (owner, mode, place), and goes no further than the driver's request route.
  const bypassFile = flags.get("bypass-file");
  const cloudOrigin = flags.get("cloud-origin");
  if (bypassFile === undefined && cloudOrigin === undefined) return options;
  if (typeof bypassFile !== "string" || typeof cloudOrigin !== "string" || !path.isAbsolute(bypassFile)) throw new CliError("verify-browser-server needs --bypass-file (an absolute path) and --cloud-origin together", 2);
  const loaded = loadBypass(bypassFile, host.uid, { home: host.home, platform: host.platform ?? "linux", xdgCacheHome: host.xdgCacheHome });
  if (loaded.kind === "refused") throw new CliError(bypassRefusalText(loaded.code), 2);
  return loaded.kind === "ok" ? { ...options, bypassSecret: loaded.secret, cloudOrigin } : options;
}

export async function verifyBrowserServerCommand(flags: Flags, host: VerifyServerHost): Promise<number> {
  await startVerifyBrowserServer(serverOptionsFrom(flags, host)).done;
  return 0;
}
