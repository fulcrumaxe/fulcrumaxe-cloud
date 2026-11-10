/**
 * D#749 V2c-2b: `fx-runner verify-login --base-url <url>`, the one-time sign-in of the test account for the runner-owned verify browser. A HEADED browser opens on the app's address; the
 * owner signs in as the test user and presses Enter here; the browser's storage state is then saved to the verify storage-state file (default `~/.config/fx-runner/verify/storage-state.json`)
 * at mode 0600 through a temporary file and a rename. The state is a credential: it is never printed, logged or returned (the command prints the date the session lasts until and nothing
 * else about it). Only the app's own origin is kept: the cookies of the base host and the page storage of the base origin; whatever else the browser held (the identity provider's own sign-in
 * above all) is dropped before anything is written, and a state with no session cookie of the app left is not saved at all. The address must be https, or http on a loopback host.
 *
 * `fx-runner verify-login --forget` is the way back: it deletes the saved state file (a link is removed, never followed) and says so. `config unset` of the three browser settings leaves the file alone.
 */
import { lstatSync, rmSync } from "node:fs";
import path from "node:path";
import { CliError } from "../cliError.js";
import { writePrivateFile } from "../config.js";
import type { CommandContext, Flags } from "../context.js";
import { inCredentialFloor } from "../daemon/playwrightProbe.js";
import { VERIFY_BROWSER_BASE_URL_KEY, VERIFY_BROWSER_EXECUTABLE_KEY, loadSettings, setSetting, storageStateFor } from "../runnerSettings.js";
import { parseBase } from "../verifyBrowser/pin.js";
import { APP_SESSION_COOKIE, cookieIsOfHost, keepBaseOrigin } from "../verifyBrowser/stateScope.js";

export interface LoginSession {
  /** The browser context's storage state (cookies and local storage), as the library returns it. */
  storageState(): Promise<unknown>;
  /** The address of the page the browser is showing now (the app may have redirected the sign-in to its canonical address). Absent in a host that cannot tell. */
  currentUrl?(): string | undefined;
  close(): Promise<void>;
}

export interface VerifyLoginHost {
  home: string | undefined;
  /** Whether standard input is a terminal. The command waits for Enter, so it refuses to start without one. */
  interactive: boolean;
  /** A Chromium or Chrome with a window, found when the owner has not set `verify.browser.executable`. */
  findHeaded(): string | undefined;
  /** Opens a headed browser on `url` (nothing is loaded in it but that address). */
  openHeaded(executable: string, url: string): Promise<LoginSession>;
  /** Resolves when the owner has pressed Enter in the terminal, or with `"eof"` when standard input ended first (nobody can press Enter any more). */
  waitForEnter(): Promise<void | "eof">;
}

/** The app's session cookies kept in the state, as their expiry times (seconds since the epoch, -1 for a session cookie). */
const sessionExpiries = (cookies: Array<Record<string, unknown>>, host: string): number[] =>
  cookies.filter((c) => c["name"] === APP_SESSION_COOKIE && cookieIsOfHost(c["domain"], host)).map((c) => (typeof c["expires"] === "number" ? c["expires"] : -1));

/**
 * The app may redirect the sign-in to its own canonical address. When the app's session cookie is not on the base host but the open page is on another https origin that holds it,
 * that origin is returned so the owner can run again with it. Nothing of that origin is ever saved by this run.
 */
function redirectedOrigin(state: unknown, pageUrl: string | undefined, base: { origin: string }): string | undefined {
  if (pageUrl === undefined) return undefined;
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    // fx-swallow-ok: an unreadable page address means no advice, and the plain "no session" message follows
    return undefined;
  }
  if (page.protocol !== "https:" || page.origin === base.origin) return undefined;
  const cookies = (state as { cookies?: unknown } | null)?.cookies;
  if (!Array.isArray(cookies)) return undefined;
  const held = cookies.some((c: Record<string, unknown>) => c !== null && typeof c === "object" && c["name"] === APP_SESSION_COOKIE && cookieIsOfHost(c["domain"], page.hostname));
  return held ? page.origin : undefined;
}

/** `--forget`: removes the saved state file. `unlink` never follows a link, so a planted link is removed itself and its target is untouched. */
function forget(ctx: CommandContext, host: VerifyLoginHost): number {
  if (host.home === undefined || !path.isAbsolute(host.home)) throw new CliError("cannot find your home directory");
  const target = storageStateFor(host.home, loadSettings(ctx.stateDir).verify?.browser);
  if (!inCredentialFloor(host.home, target)) throw new CliError("the storage-state file is not inside ~/.config/fx-runner; it was not touched", 2);
  let present = true;
  try {
    lstatSync(target);
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw new CliError("cannot look at the saved session; nothing was deleted");
    present = false;
  }
  if (!present) {
    ctx.out("No saved session was found; there is nothing to delete.");
    return 0;
  }
  try {
    rmSync(target, { force: false });
  } catch {
    throw new CliError("the saved session could not be deleted; remove it by hand");
  }
  ctx.out("The saved session was deleted. Run verify-login again before the next deploy check.");
  return 0;
}

export async function verifyLoginCommand(flags: Flags, ctx: CommandContext, host: VerifyLoginHost): Promise<number> {
  if (flags.get("forget") === true) {
    if (flags.has("base-url")) throw new CliError("verify-login --forget takes no other option", 2);
    return forget(ctx, host);
  }
  const given = flags.get("base-url");
  const base = typeof given === "string" ? parseBase(given) : undefined;
  if (base === undefined) throw new CliError("verify-login needs --base-url <address>: https, or http on localhost", 2);
  if (host.home === undefined || !path.isAbsolute(host.home)) throw new CliError("cannot find your home directory");
  const settings = loadSettings(ctx.stateDir).verify?.browser;
  const executable = settings?.executable ?? host.findHeaded();
  if (executable === undefined) throw new CliError(`no Chrome or Chromium with a window was found; set it first: fx-runner config set ${VERIFY_BROWSER_EXECUTABLE_KEY} <absolute path>`, 1);
  const target = storageStateFor(host.home, settings);
  if (!inCredentialFloor(host.home, target)) throw new CliError("the storage-state file must be inside ~/.config/fx-runner, where a job's tools can never read it", 2);

  if (!host.interactive) throw new CliError("run this in a terminal: it waits for you to press Enter after signing in", 2);

  ctx.out(`A browser window opens on ${base.origin}. Sign in there as the TEST account, then come back here and press Enter.`);
  const session = await host.openHeaded(executable, base.href);
  let state: unknown;
  let pageUrl: string | undefined;
  try {
    if ((await host.waitForEnter()) === "eof") throw new CliError("standard input closed before you pressed Enter; nothing was saved. Run this again in a terminal", 1);
    state = await session.storageState();
    pageUrl = session.currentUrl?.();
  } finally {
    await session.close().catch(() => undefined);
  }
  // Only the app's own origin is kept; the browser may also hold the identity provider's sign-in, which must never reach a job.
  const kept = keepBaseOrigin(state, base);
  const live = sessionExpiries(kept.cookies, base.host);
  if (live.length === 0) {
    const elsewhere = redirectedOrigin(state, pageUrl, base);
    if (elsewhere !== undefined) throw new CliError(`the app signed you in at ${elsewhere}; run again with --base-url ${elsewhere}. Nothing was saved`, 1);
  }
  if (live.length === 0) throw new CliError("no session of the app was found in the browser (only its own session cookie is kept); nothing was saved. Sign in, then run this again", 1);
  writePrivateFile(path.dirname(target), path.basename(target), `${JSON.stringify(kept)}\n`);
  // Saved settings: the address (and the browser, when it was found rather than set). Never the state itself.
  setSetting(ctx.stateDir, VERIFY_BROWSER_BASE_URL_KEY, base.href);
  if (settings?.executable === undefined) setSetting(ctx.stateDir, VERIFY_BROWSER_EXECUTABLE_KEY, executable);
  const lasts = live.every((e) => e > 0) ? new Date(Math.min(...live) * 1000).toISOString().slice(0, 10) : undefined;
  ctx.out(`Session saved (mode 0600, this app's address only). ${lasts === undefined ? "It has no fixed end date; the app decides when it expires." : `The session cookie expires ${lasts}; sign in again after that.`}`);
  ctx.out("Next: fx-runner config set verify.test_account <the test account's label>, then check that the runner lists browser_playwright_v1. To remove the saved session: fx-runner verify-login --forget");
  return 0;
}
