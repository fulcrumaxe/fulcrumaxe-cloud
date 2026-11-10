import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import type { BasePin } from "./pin.js";

/**
 * D#749 V2c-2b: what a verify storage-state file may hold. The state is the test account's saved sign-in for ONE app address, and nothing else. A browser that was used for anything
 * else before the sign-in (or whose profile held other sign-ins) would otherwise write those into the file, and every job would then carry them: so `verify-login` keeps only the base
 * origin's cookies and page storage, and the probe and the server refuse a file that holds anything of another origin. One module, so the three can never disagree.
 */

/**
 * The name of the app's signed session cookie (the same string as `SESSION_COOKIE_NAME` in the core package's session module; this package cannot import that one, and
 * test/verifyBrowser/playwrightLocal.test.ts reads the two files to prove they still agree). It is `__Host-` prefixed, so the browser stores it for the exact host with no Domain attribute.
 */
export const APP_SESSION_COOKIE = "__Host-fx_session";

export const MAX_STATE_BYTES = 2 * 1024 * 1024;

/** A cookie that belongs to the base host alone: its domain is the host, written with or without the leading dot. A parent domain (which every sibling host receives) is another origin's. */
export const cookieIsOfHost = (domain: unknown, host: string): boolean => typeof domain === "string" && domain.replace(/^\./, "").toLowerCase() === host.toLowerCase();

type Entry = Record<string, unknown>;
const entriesOf = (value: unknown): Entry[] | undefined => (Array.isArray(value) && value.every((e) => e !== null && typeof e === "object" && !Array.isArray(e)) ? (value as Entry[]) : undefined);

/** `ok`: every cookie and every page-storage origin is the base's. `foreign`: something else is in the file. `unreadable`: not a storage state at all. */
export function scopeOf(state: unknown, base: BasePin): "ok" | "foreign" | "unreadable" {
  if (state === null || typeof state !== "object" || Array.isArray(state)) return "unreadable";
  const cookies = entriesOf((state as Entry)["cookies"]);
  if (cookies === undefined) return "unreadable";
  const origins = (state as Entry)["origins"] === undefined ? [] : entriesOf((state as Entry)["origins"]);
  if (origins === undefined) return "unreadable";
  if (!cookies.every((c) => cookieIsOfHost(c["domain"], base.host))) return "foreign";
  return origins.every((o) => o["origin"] === base.origin) ? "ok" : "foreign";
}

/** The state cut down to the base origin: only the cookies of the base host and only the page storage of the base origin. Nothing of any other origin survives. */
export function keepBaseOrigin(state: unknown, base: BasePin): { cookies: Entry[]; origins: Entry[] } {
  const cookies = entriesOf((state as Entry | null)?.["cookies"]) ?? [];
  const origins = entriesOf((state as Entry | null)?.["origins"]) ?? [];
  return { cookies: cookies.filter((c) => cookieIsOfHost(c["domain"], base.host)), origins: origins.filter((o) => o["origin"] === base.origin) };
}

export type ScopedStateResult = { ok: true; state: { cookies: Entry[]; origins: Entry[] } } | { ok: false; code: "storage_state_unreadable" | "storage_state_foreign" };

/**
 * The server's read of the file: opened without following a link, a plain file at mode 0600 and a sane size, parsed once, and refused when it holds another origin.
 * The parsed object is what the browser is given (never the path again), so the file cannot change between the check and its use. The content is never put in a result.
 */
export function readScopedState(file: string, base: BasePin): ScopedStateResult {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_STATE_BYTES || (info.mode & 0o077) !== 0) return { ok: false, code: "storage_state_unreadable" };
    const parsed: unknown = JSON.parse(readFileSync(fd, "utf8"));
    const scope = scopeOf(parsed, base);
    if (scope === "unreadable") return { ok: false, code: "storage_state_unreadable" };
    if (scope === "foreign") return { ok: false, code: "storage_state_foreign" };
    return { ok: true, state: parsed as { cookies: Entry[]; origins: Entry[] } };
  } catch {
    // fx-swallow-ok: a file that cannot be opened or parsed is a closed code; the path and the content are never repeated
    return { ok: false, code: "storage_state_unreadable" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
