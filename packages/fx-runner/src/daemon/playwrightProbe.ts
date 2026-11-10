/**
 * D#749 V2c-2b: the daemon's own check that this machine can serve a `playwright_runner` deploy verifier job, made by the daemon and never by the model. It looks at files and
 * settings only and starts no browser. Every one of these must hold:
 *  1. a test account (`verify.test_account`) and the app's address (`verify.browser.base_url`) are set;
 *  2. the Chromium program (`verify.browser.executable`) is there, a plain file the user can run, whose name says Chrome or Chromium;
 *  3. the Playwright library can be loaded (in the release build: the sidecar folder next to the binary);
 *  4. the storage-state file is there, is a plain file at mode 0600 owned by this user, lies inside the credential floor (so a job's tools can never read it), and holds a session cookie for
 *     the app's host that has not expired. "A session cookie" means the app's own signed session cookie (`__Host-fx_session`, stateScope.ts): another cookie of the host, such as an
 *     analytics one, never counts. The file may hold nothing of another origin (`storage_state_foreign`): no cookie of another host and no page storage of another origin.
 * The file's content is read for the cookie name, host and expiry only; nothing from it is returned, logged or put in a message. A failure is one closed reason code; the job then ends `runner_setup`.
 */
import { accessSync, constants, lstatSync, readFileSync, statSync, type Stats } from "node:fs";
import path from "node:path";
import { CREDENTIAL_FLOOR } from "../sandbox/sandboxSettings.js";
import { storageStateFor, type VerifySettings } from "../runnerSettings.js";
import { parseBase, type BasePin } from "../verifyBrowser/pin.js";
import { APP_SESSION_COOKIE, MAX_STATE_BYTES, cookieIsOfHost, scopeOf } from "../verifyBrowser/stateScope.js";

export type PlaywrightProbeReason =
  | "test_account_missing"
  | "base_url_missing"
  | "executable_missing"
  | "executable_not_runnable"
  | "executable_not_chromium"
  | "playwright_missing"
  | "storage_state_missing"
  | "storage_state_unsafe"
  | "storage_state_outside_floor"
  | "storage_state_unreadable"
  | "storage_state_no_session"
  | "storage_state_expired"
  | "storage_state_foreign";
export type PlaywrightProbeResult = { ok: true } | { ok: false; reason: PlaywrightProbeReason };

const CHROMIUM_NAME = /chrom/i;

export interface PlaywrightProbeDeps {
  /** The verify settings, read fresh on every probe (a change applies from the next claim). */
  settings: () => VerifySettings | undefined;
  home: string;
  uid: number;
  /** Milliseconds since the epoch. */
  now: () => number;
  /** Whether the Playwright library can be loaded. */
  playwrightAvailable: () => boolean;
  /** Replaceable by a test, to give one path another owner or mode. Default: `lstat`, null when the name is not there. */
  lstat?: (target: string) => Stats | null;
}

function lstatOrNull(target: string): Stats | null {
  try {
    return lstatSync(target);
  } catch {
    // fx-swallow-ok: a name that is not there is the answer "no"
    return null;
  }
}

/** Whether `file` lies inside one of the credential floor's locations under `home` (the runner's own `.config/fx-runner` among them). Both are absolute and normalized. */
export const inCredentialFloor = (home: string, file: string): boolean => CREDENTIAL_FLOOR.some((entry) => { const dir = path.join(home, entry); return file === dir || file.startsWith(`${dir}${path.sep}`); });

/**
 * What the file holds, as a closed word: `unreadable` (not a storage state), `foreign` (a cookie of another host or page storage of another origin), then for the app's own signed session
 * cookie (`__Host-fx_session`) of the base host: `ok` (one that has not expired), `expired` (it is there, past its time) or `none`. Other cookies of the host never count.
 */
function sessionState(text: string, base: BasePin, nowMs: number): "ok" | "none" | "expired" | "unreadable" | "foreign" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // fx-swallow-ok: a file that is not JSON is "unreadable"; its content is never shown
    return "unreadable";
  }
  const scope = scopeOf(parsed, base);
  if (scope !== "ok") return scope;
  let seen = false;
  for (const cookie of (parsed as { cookies: Array<Record<string, unknown>> }).cookies) {
    if (cookie["name"] !== APP_SESSION_COOKIE || !cookieIsOfHost(cookie["domain"], base.host)) continue;
    seen = true;
    const expires = cookie["expires"];
    // Playwright writes -1 for a session cookie; any other number is seconds since the epoch.
    if (expires === -1 || (typeof expires === "number" && expires * 1000 > nowMs)) return "ok";
  }
  return seen ? "expired" : "none";
}

export function probePlaywright(deps: PlaywrightProbeDeps): PlaywrightProbeResult {
  const verify = deps.settings();
  const browser = verify?.browser;
  if (verify?.testAccount === undefined || verify.testAccount === "") return { ok: false, reason: "test_account_missing" };
  const base = browser?.baseUrl === undefined ? undefined : parseBase(browser.baseUrl);
  if (base === undefined) return { ok: false, reason: "base_url_missing" };
  const exe = browser?.executable;
  if (exe === undefined) return { ok: false, reason: "executable_missing" };
  let exeStat: Stats;
  try {
    // A link is followed on purpose: a system Chrome is usually a link to its wrapper.
    exeStat = statSync(exe);
  } catch {
    // fx-swallow-ok: no file there is the answer "missing"
    return { ok: false, reason: "executable_missing" };
  }
  try {
    accessSync(exe, constants.X_OK);
  } catch {
    // fx-swallow-ok: a file that cannot be executed is "not runnable"
    return { ok: false, reason: "executable_not_runnable" };
  }
  if (!exeStat.isFile()) return { ok: false, reason: "executable_not_runnable" };
  if (!CHROMIUM_NAME.test(path.basename(exe))) return { ok: false, reason: "executable_not_chromium" };
  if (!deps.playwrightAvailable()) return { ok: false, reason: "playwright_missing" };

  const state = storageStateFor(deps.home, browser);
  const info = (deps.lstat ?? lstatOrNull)(state);
  if (info === null) return { ok: false, reason: "storage_state_missing" };
  // A link, another user's file or one anybody else can touch is not the file `verify-login` wrote.
  if (!info.isFile() || info.uid !== deps.uid || (info.mode & 0o777) !== 0o600 || info.size > MAX_STATE_BYTES) return { ok: false, reason: "storage_state_unsafe" };
  if (!inCredentialFloor(deps.home, state)) return { ok: false, reason: "storage_state_outside_floor" };
  let text: string;
  try {
    text = readFileSync(state, "utf8");
  } catch {
    // fx-swallow-ok: an unreadable file is a closed reason; the path is not repeated
    return { ok: false, reason: "storage_state_unreadable" };
  }
  const session = sessionState(text, base, deps.now());
  if (session === "unreadable") return { ok: false, reason: "storage_state_unreadable" };
  if (session === "foreign") return { ok: false, reason: "storage_state_foreign" };
  if (session === "none") return { ok: false, reason: "storage_state_no_session" };
  if (session === "expired") return { ok: false, reason: "storage_state_expired" };
  return { ok: true };
}
