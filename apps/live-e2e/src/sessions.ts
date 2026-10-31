/**
 * Sessions (T3; 4a). The app's session cookie is a signed, readable JWT whose claims carry `sessionStart` (fixed at
 * sign-in) and `lastSeenAt` (advanced by every request the app answers). A session therefore dies 24 h after its
 * last use and at the latest 30 days after sign-in. Everything here works from those two numbers and the app's own
 * answers; nothing verifies the signature (the runner has no secret for that, and the server is the judge).
 *
 *  - `sessionStatus`: ok, lapsed (idle > 24 h), expired (> 30 days) or malformed, plus the 3-day warning.
 *  - `keepAlive`: one `GET /api/cloud/auth/me` per stored role, writing the refreshed cookie back.
 *  - `captureSession`: the owner signs in by hand in a fresh temporary profile; only the app cookie is kept.
 *  - `sessionClient`: the shared API client acting as a role, noting every cookie the app sets.
 */
import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createClient, type ApiClient } from "./client.js";
import type { MaskRegistry } from "./mask.js";
import { BYPASS_ENV } from "./needs.js";
import { fenceConfigFor, type EnvSource, type Target } from "./targets.js";
import { newestCookie, parseClaims, putRole, SESSION_COOKIE_NAME, validCookie, type Role } from "./store.js";

// The claims reader and the newest-wins rule belong to the store (it applies them under its lock); re-exported for callers.
export { newestCookie, parseClaims, type SessionClaims } from "./store.js";

export const IDLE_LIMIT_MS = 24 * 3_600_000;
export const ABSOLUTE_LIMIT_MS = 30 * 86_400_000;
export const WARN_BEFORE_MS = 3 * 86_400_000;
export const ME_PATH = "/api/cloud/auth/me";
/** The sign-in entry point the capture opens (A1: it redirects to github.com). */
export const SIGN_IN_PATH = "/api/auth/github";

export type SessionState = "ok" | "lapsed" | "expired" | "malformed";

export interface SessionStatus {
  state: SessionState;
  /** Whole days left before the 30-day limit, set only while ok and inside the 3-day warning window. */
  warnDaysLeft?: number;
}

export function sessionStatus(cookie: string, now: number): SessionStatus {
  const claims = parseClaims(cookie);
  if (claims === null) return { state: "malformed" };
  if (now - claims.sessionStart >= ABSOLUTE_LIMIT_MS) return { state: "expired" };
  if (now - claims.lastSeenAt >= IDLE_LIMIT_MS) return { state: "lapsed" };
  const left = claims.sessionStart + ABSOLUTE_LIMIT_MS - now;
  return left <= WARN_BEFORE_MS ? { state: "ok", warnDaysLeft: Math.max(0, Math.ceil(left / 86_400_000)) } : { state: "ok" };
}

/** The value of the session cookie a response sets (a deletion, an empty value or any other cookie is not one). */
export function setCookieValue(headers: Headers): string | undefined {
  for (const line of headers.getSetCookie()) {
    const m = new RegExp(`^${SESSION_COOKIE_NAME}=([^;]*)`).exec(line);
    if (m !== null && validCookie(m[1]) && !/;\s*max-age=0\b/i.test(line)) return m[1];
  }
  return undefined;
}

/** The cookie as a Playwright context takes it (a `__Host-` cookie: secure, path `/`, no domain). */
export function browserSessionCookie(origin: string, value: string): { name: string; value: string; url: string; httpOnly: true; secure: true; sameSite: "Lax" } {
  return { name: SESSION_COOKIE_NAME, value, url: origin, httpOnly: true, secure: true, sameSite: "Lax" };
}

export interface SessionClient {
  client: ApiClient;
  /** The newest session cookie the app set on any answer so far (the sliding refresh), if any. */
  refreshed(): string | undefined;
}

/**
 * The shared client acting as `cookie`'s role. The cookie travels as an ambient header on the target origin only
 * (the client drops credential headers on any other origin) and is never given to a refusal probe.
 */
export function sessionClient(target: Target, targetsDir: string, env: EnvSource, cookie: string, fetchImpl: typeof fetch = globalThis.fetch): SessionClient {
  const secret = env[BYPASS_ENV];
  if (target.protected && (secret === undefined || secret === "")) throw new Error(`${target.name} is protected and ${BYPASS_ENV} is not set`);
  const seen: string[] = [];
  const noting: typeof fetch = async (input, init) => {
    const res = await fetchImpl(input, init);
    const set = setCookieValue(res.headers);
    if (set !== undefined) seen.push(set);
    return res;
  };
  const client = createClient({
    origin: target.origin,
    bypassSecret: target.protected ? secret : undefined,
    fence: fenceConfigFor(target, targetsDir, env),
    fetchImpl: noting,
    ambientHeaders: { cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
  });
  return { client, refreshed: () => newestCookie(seen) };
}

export type KeepAliveState = SessionState | "rejected" | "error";

export interface RoleReport {
  role: string;
  state: KeepAliveState;
  warnDaysLeft?: number;
}

export interface KeepAliveOptions {
  target: Target;
  targetsDir: string;
  env: EnvSource;
  file: string;
  key: Buffer;
  roles: Readonly<Record<string, string>>;
  now: number;
  fetchImpl?: typeof fetch;
  mask?: MaskRegistry;
}

/** A role the server turned away, or that can no longer be used, counts as lapsed for the one issue per role. */
export const isLapsed = (state: KeepAliveState): boolean => state !== "ok" && state !== "error";

/**
 * One `GET /api/cloud/auth/me` per stored role, with the write-back. A dead cookie (idle, past the limit, or
 * turned away by the server with a 401) is reported and not retried. A network error is `error`: it says nothing
 * about the session, so it must not open a lapse issue.
 */
export async function keepAlive(opts: KeepAliveOptions): Promise<RoleReport[]> {
  const out: RoleReport[] = [];
  for (const [role, cookie] of Object.entries(opts.roles)) {
    const status = sessionStatus(cookie, opts.now);
    if (status.state !== "ok") {
      out.push({ role, state: status.state });
      continue;
    }
    opts.mask?.register(cookie);
    try {
      const { client, refreshed } = sessionClient(opts.target, opts.targetsDir, opts.env, cookie, opts.fetchImpl);
      const res = await client.get(ME_PATH, { redirect: "manual" });
      // The app answers a dead session with an empty 401; a 401 with a body is Vercel's wall (a wrong or rotated
      // bypass secret), which says nothing about the session and must not open a lapse issue.
      if (res.status === 401 && res.body === "") {
        out.push({ role, state: "rejected" });
        continue;
      }
      if (res.status !== 200) {
        out.push({ role, state: "error" });
        continue;
      }
      const next = refreshed();
      if (next !== undefined) {
        opts.mask?.register(next);
        await putRole(opts.file, opts.target.name, opts.key, role as Role, next);
      }
      const after = sessionStatus(next ?? cookie, opts.now);
      out.push({ role, state: "ok", ...(after.warnDaysLeft !== undefined ? { warnDaysLeft: after.warnDaysLeft } : {}) });
    } catch {
      out.push({ role, state: "error" });
    }
  }
  return out;
}

/** A browser the capture drives. `cookie()` is the app's session cookie value in that browser, if it has one yet. */
export interface CaptureBrowser {
  cookie(): Promise<string | undefined>;
  close(): Promise<void>;
}
export interface LaunchOptions {
  profileDir: string;
  origin: string;
  startPath: string;
  bypassSecret?: string | undefined;
  headless: boolean;
}
export type Launcher = (options: LaunchOptions) => Promise<CaptureBrowser>;

export interface CaptureOptions {
  target: Target;
  launcher: Launcher;
  bypassSecret?: string | undefined;
  headless?: boolean;
  timeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  /** Called the moment the poll sees a valid cookie, before the browser is closed: from then on the cookie is in hand. */
  onCookie?: () => void;
  /** Where the throw-away profile is made. */
  profileRoot?: string;
  /** Test seam: what a handled signal ends the process with. */
  exit?: (code: number) => void;
  /** Test seam: how long a handled signal waits for a browser that is still launching (default LAUNCH_GRACE_MS). */
  launchGraceMs?: number;
}

export const CAPTURE_PREFIX = "live-e2e-capture-";
/** A capture can run for its whole timeout (10 minutes by default), so only a folder older than this is a leftover. */
export const STALE_PROFILE_MS = 30 * 60_000;
/** How long a handled signal waits for a browser that is still launching before it removes the profile anyway. */
const LAUNCH_GRACE_MS = 15_000;
const SIGNAL_EXIT: Record<string, number> = { SIGINT: 130, SIGHUP: 129, SIGTERM: 143 };

/**
 * Removes capture profiles a killed capture (SIGKILL, power loss) left behind. Only `live-e2e-capture-*` directly under
 * `root`, only real directories owned by this user (lstat: a symlink is never followed or removed), only when older
 * than STALE_PROFILE_MS, and only when the resolved path is still directly inside `root`. Returns what it removed.
 */
export function sweepStaleProfiles(root: string, nowMs: number = Date.now()): string[] {
  const removed: string[] = [];
  const base = resolve(root);
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return removed;
  }
  for (const name of names) {
    if (!name.startsWith(CAPTURE_PREFIX) || name.includes("/")) continue;
    const path = join(base, name);
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== process.getuid?.()) continue;
      if (dirname(resolve(path)) !== base || nowMs - st.mtimeMs < STALE_PROFILE_MS) continue;
      rmSync(path, { recursive: true, force: true });
      removed.push(name);
    } catch {
      /* gone already, or not ours to remove */
    }
  }
  return removed;
}

/**
 * Opens a fresh temporary profile, waits for the owner to sign in by hand, and returns ONLY the app's session
 * cookie value. The profile (with the github.com session, the bypass cookie and everything else the browser
 * learned) is deleted on every exit path: normal and error returns by the `finally`, and SIGINT, SIGHUP and SIGTERM
 * by a handler that closes the browser, removes the profile and exits non-zero. A SIGKILL cannot be handled, so every
 * capture first sweeps the leftovers of earlier ones. Throws when no usable cookie appears before the deadline.
 */
export async function captureSession(opts: CaptureOptions): Promise<string> {
  const now = opts.now ?? Date.now;
  const root = opts.profileRoot ?? tmpdir();
  sweepStaleProfiles(root);
  const profileDir = mkdtempSync(join(root, CAPTURE_PREFIX));
  let launching: Promise<CaptureBrowser> | undefined;
  let signalled = false;
  const closeAll = async (): Promise<void> => {
    // A launcher that never settles must not keep the profile on disk: wait a bounded time for the browser, then remove it.
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<void>((r) => {
      timer = setTimeout(r, opts.launchGraceMs ?? LAUNCH_GRACE_MS);
      timer.unref();
    });
    try {
      await Promise.race([launching?.then((b) => b.close()).catch(() => undefined), bound]);
    } finally {
      clearTimeout(timer);
    }
    rmSync(profileDir, { recursive: true, force: true });
  };
  // Installed in the same tick as the folder is made, so there is no moment a profile exists without a handler.
  const handlers = Object.keys(SIGNAL_EXIT).map((sig) => {
    const handler = (): void => {
      if (signalled) return;
      signalled = true;
      void closeAll().finally(() => (opts.exit ?? process.exit)(SIGNAL_EXIT[sig] as number));
    };
    process.on(sig as NodeJS.Signals, handler);
    return [sig as NodeJS.Signals, handler] as const;
  });
  try {
    launching = opts.launcher({
      profileDir,
      origin: opts.target.origin,
      startPath: SIGN_IN_PATH,
      bypassSecret: opts.target.protected ? opts.bypassSecret : undefined,
      headless: opts.headless ?? false,
    });
    const browser = await launching;
    const deadline = now() + (opts.timeoutMs ?? 10 * 60_000);
    for (;;) {
      const cookie = await browser.cookie();
      if (cookie !== undefined && sessionStatus(cookie, now()).state === "ok") {
        opts.onCookie?.();
        return cookie;
      }
      if (now() >= deadline) throw new Error("no session cookie appeared before the deadline; nothing was stored");
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 1000));
    }
  } catch (error) {
    // Closing the browser makes the poll (or the launch) reject. Once a signal is being handled that is not a failure
    // to report: letting it escape would exit 1 before the handler gets to exit with the signal's code.
    if (signalled) await new Promise<never>(() => undefined);
    throw error;
  } finally {
    // The handlers stay until cleanup is done: a signal that lands while the browser is closing still ends cleanly.
    try {
      await closeAll();
    } finally {
      for (const [sig, handler] of handlers) process.off(sig, handler);
    }
    // A signal arrived during cleanup: its handler owns the exit code, so do not return or rethrow ahead of it.
    if (signalled) await new Promise<never>(() => undefined);
  }
}
