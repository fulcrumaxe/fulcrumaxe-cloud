/**
 * What a pack's `session` fixture does, kept out of the Playwright file so vitest can run it: take a role's cookie
 * from the encrypted store, give it to the browser context and to a client acting as that role, and when the test
 * is over write the newest cookie the app set (the sliding refresh) back to the store.
 */
import { MaskRegistry, MASK_FILE_ENV } from "./mask.js";
import { browserSessionCookie, newestCookie, sessionClient, sessionStatus } from "./sessions.js";
import { parseKey, putRole, readStore, SESSION_COOKIE_NAME, SESSION_KEY_ENV, storePath, type Role } from "./store.js";
import type { EnvSource, Target } from "./targets.js";
import type { ApiClient } from "./client.js";

/** The slice of a Playwright BrowserContext the fixture touches. */
export interface CookieContext {
  addCookies(cookies: ReturnType<typeof browserSessionCookie>[]): Promise<void>;
  cookies(url: string): Promise<{ name: string; value: string }[]>;
}

export class SessionUnavailable extends Error {
  constructor(role: string, why: string) {
    super(`the ${role} session cannot be used (${why}); the pack must declare session:${role}, so this should have been skipped`);
    this.name = "SessionUnavailable";
  }
}

export interface OpenSession {
  role: Role;
  /** The shared client acting as the role (cookie on the target origin only; the fence applies). */
  api: ApiClient;
  /** Writes the newest cookie back. Call it once, after the test. */
  finish(): Promise<void>;
}

export async function openSession(o: { target: Target; targetsDir: string; env: EnvSource; role: Role; context: CookieContext; fetchImpl?: typeof fetch; now?: number }): Promise<OpenSession> {
  const key = parseKey(o.env[SESSION_KEY_ENV]);
  const home = o.env["HOME"];
  if (home === undefined) throw new SessionUnavailable(o.role, "HOME is not set");
  const file = storePath(home, o.target.name);
  const cookie = readStore(file, o.target.name, key)[o.role];
  if (cookie === undefined) throw new SessionUnavailable(o.role, "not stored");
  const state = sessionStatus(cookie, o.now ?? Date.now()).state;
  if (state !== "ok") throw new SessionUnavailable(o.role, state);
  // Workers register into the mask file (the main process announces them); the value never goes to stdout from here.
  const maskFile = o.env[MASK_FILE_ENV];
  const mask = new MaskRegistry({ emit: () => undefined, ...(maskFile ? { file: maskFile } : {}) });
  mask.register(cookie);
  const s = sessionClient(o.target, o.targetsDir, o.env, cookie, o.fetchImpl);
  await o.context.addCookies([browserSessionCookie(o.target.origin, cookie)]);
  return {
    role: o.role,
    api: s.client,
    async finish() {
      const inBrowser = (await o.context.cookies(o.target.origin)).find((c) => c.name === SESSION_COOKIE_NAME)?.value;
      const newest = newestCookie([cookie, s.refreshed(), inBrowser]);
      if (newest !== undefined && newest !== cookie) {
        mask.register(newest);
        await putRole(file, o.target.name, key, o.role, newest);
      }
    },
  };
}
