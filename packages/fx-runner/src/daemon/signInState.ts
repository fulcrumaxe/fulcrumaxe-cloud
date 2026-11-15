/**
 * D#749 VERIFY-SIGNIN-EXPIRY: how long the runner's saved verify sign-in can be trusted, worked out from two dates and nothing else.
 *
 * The app ends a session on its own server a day after the session was last signed (`SESSION_IDLE_SECONDS_DEFAULT` = 24 h in the app's session code, settable by
 * `FX_SESSION_IDLE_SECONDS`; a saved sign-in is never refreshed by the browser, so the day counts from the moment the login command saved it). The cookie in the saved file does not say so: it lives up to the
 * absolute limit, so it still looks valid here after the server dropped it. Two sign-ins were seen to end between 22 and 26 hours, so the runner counts `SERVER_SESSION_LIFETIME_MS` (22 h, a
 * margin under the shortest seen) from the moment `verify-login` saved it, and also honours the cookie's own end when that comes first.
 *
 * `verify-login` writes the two dates in a sidecar next to the saved sign-in (mode 0600, timestamps only). Nothing in the saved file itself is read, logged or sent from here; a sign-in saved before this
 * existed has no sidecar, and the saved file's modification time stands for the day it was saved.
 */
import { lstatSync } from "node:fs";
import path from "node:path";
import { readPrivateFile } from "../config.js";
import type { VerifySignInState } from "@fulcrumaxe/runner-protocol";
import { storageStateFor, type VerifySettings } from "../runnerSettings.js";

/** How long the app's server keeps a saved sign-in, as the runner counts it: under the 24 h idle limit, with the margin the 22 to 26 h observed ends call for. */
export const SERVER_SESSION_LIFETIME_MS = 22 * 60 * 60 * 1000;
/** Under this much left, the state is `expiring_soon`. */
export const EXPIRING_SOON_MS = 2 * 60 * 60 * 1000;
/** The sidecar's name: the saved sign-in's own name with this suffix, in the same private folder. */
export const SIGN_IN_SIDECAR_SUFFIX = ".meta.json";

export interface SignInDates {
  /** When `verify-login` saved the sign-in (ms since the epoch). */
  createdAtMs: number;
  /** When the app's session cookie ends (ms since the epoch); null for a cookie with no fixed end. */
  cookieExpiresMs: number | null;
}

/** Pure. The state at `nowMs`: the earlier of the cookie's end and the saved time plus the server's lifetime decides. */
export function signInState(nowMs: number, dates: SignInDates): VerifySignInState {
  const end = Math.min(dates.cookieExpiresMs ?? Number.POSITIVE_INFINITY, dates.createdAtMs + SERVER_SESSION_LIFETIME_MS);
  const left = end - nowMs;
  if (left <= 0) return "expired";
  return left < EXPIRING_SOON_MS ? "expiring_soon" : "ok";
}

/** The sidecar's text for a sign-in saved at `createdAtMs`. `cookieExpiresSec`: the earliest end of the app's session cookies in seconds since the epoch, or undefined when it has none. */
export function sidecarText(createdAtMs: number, cookieExpiresSec: number | undefined): string {
  return `${JSON.stringify({ created_at: new Date(createdAtMs).toISOString(), cookie_expires_at: cookieExpiresSec === undefined ? null : new Date(cookieExpiresSec * 1000).toISOString() })}\n`;
}

function parseSidecar(text: string): SignInDates | undefined {
  try {
    const v = JSON.parse(text) as { created_at?: unknown; cookie_expires_at?: unknown };
    const created = typeof v.created_at === "string" ? Date.parse(v.created_at) : Number.NaN;
    const cookie = typeof v.cookie_expires_at === "string" ? Date.parse(v.cookie_expires_at) : null;
    if (!Number.isFinite(created) || (cookie !== null && !Number.isFinite(cookie))) return undefined;
    return { createdAtMs: created, cookieExpiresMs: cookie };
  } catch {
    // fx-swallow-ok: a sidecar that does not parse is treated as absent; the saved file's own time then stands in
    return undefined;
  }
}

export interface SignInReadDeps {
  settings: () => VerifySettings | undefined;
  home: string;
  now: () => number;
}

/**
 * The state of this machine's saved sign-in now, or undefined when no verify address is set here (the runner then says nothing, and the cloud keeps nothing). `missing`: an address is set but
 * the saved file is not a plain file. A sign-in whose file is unreadable counts as `missing`: a person has to make a new one either way.
 */
export function readSignInState(deps: SignInReadDeps): VerifySignInState | undefined {
  const browser = deps.settings()?.browser;
  if (browser?.baseUrl === undefined) return undefined;
  const file = storageStateFor(deps.home, browser);
  let mtimeMs: number;
  try {
    const info = lstatSync(file);
    if (!info.isFile()) return "missing";
    mtimeMs = info.mtimeMs;
  } catch {
    // fx-swallow-ok: no file there is the answer "missing"
    return "missing";
  }
  let dates: SignInDates | undefined;
  try {
    const text = readPrivateFile(path.dirname(file), `${path.basename(file)}${SIGN_IN_SIDECAR_SUFFIX}`);
    dates = text === undefined ? undefined : parseSidecar(text);
  } catch {
    // fx-swallow-ok: an unreadable sidecar is as good as none; the saved file's own time stands in
    dates = undefined;
  }
  return signInState(deps.now(), dates ?? { createdAtMs: mtimeMs, cookieExpiresMs: null });
}
