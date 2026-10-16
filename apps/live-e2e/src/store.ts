/**
 * The encrypted session store (T3; SE2). One file per target, in the live-run user's home and outside the wiped
 * work folder: `$HOME/.local/state/live-e2e/sessions-<target>.enc`, mode 0600, written by atomic rename.
 *
 * It holds ONLY each role's `__Host-fx_session` cookie value, keyed by role name. No github.com cookie, no Vercel
 * bypass cookie and nothing else from a browser's storage state ever reaches it. The session's own claims
 * (`sessionStart`, `lastSeenAt`) are read back out of the cookie's JWT payload, so they are not stored twice.
 *
 * AES-256-GCM. The key is `LIVE_E2E_SESSION_KEY` (a GitHub environment secret: 32 random bytes, base64). The
 * additional authenticated data names the format and the target, so a file cannot be swapped between targets.
 * The store is writable by design (the session slides, so every run writes the newest cookie back); writers
 * take a lock folder so two Playwright workers cannot lose each other's update.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export const SESSION_KEY_ENV = "LIVE_E2E_SESSION_KEY";
export const SESSION_COOKIE_NAME = "__Host-fx_session";
/** The closed set of roles (T0 takes the same set). `canary` is the production account; the rest are staging. */
export const ROLES = ["owner", "member", "outsider", "revoke", "canary"] as const;
export type Role = (typeof ROLES)[number];

const TARGET_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const JWT_PATTERN = /^[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{1,2048}$/;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

export function isRole(role: string): role is Role {
  return (ROLES as readonly string[]).includes(role);
}

/** Staging uses the four machine roles; the production canary is its own account and the only role allowed there. */
export function roleAllowedOn(role: Role, target: string): boolean {
  return target === "production" ? role === "canary" : role !== "canary";
}

/** The key must be exactly 32 bytes in canonical base64; anything else is refused without echoing it. */
export function parseKey(raw: string | undefined): Buffer {
  if (raw === undefined || raw === "") throw new StoreError(`${SESSION_KEY_ENV} is not set`);
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32 || key.toString("base64") !== raw) throw new StoreError(`${SESSION_KEY_ENV} must be 32 random bytes, base64 encoded`);
  return key;
}

export function storePath(home: string, target: string): string {
  if (!isAbsolute(home)) throw new StoreError("HOME must be an absolute path");
  if (!TARGET_PATTERN.test(target)) throw new StoreError("target is not a plain target name");
  return join(home, ".local", "state", "live-e2e", `sessions-${target}.enc`);
}

/** role -> cookie value. */
export type Roles = Record<string, string>;

const aad = (target: string): Buffer => Buffer.from(`live-e2e-sessions:v1:${target}`);

export function validCookie(value: unknown): value is string {
  return typeof value === "string" && JWT_PATTERN.test(value);
}

export interface SessionClaims {
  sessionStart: number;
  lastSeenAt: number;
}

/** The claims in the cookie's payload, or null when it is not a JWT with two positive millisecond timestamps. */
export function parseClaims(cookie: string): SessionClaims | null {
  if (!validCookie(cookie)) return null;
  try {
    const payload = JSON.parse(Buffer.from(cookie.split(".")[1] as string, "base64url").toString("utf8")) as Record<string, unknown>;
    const { sessionStart, lastSeenAt } = payload;
    if (typeof sessionStart !== "number" || typeof lastSeenAt !== "number" || !(sessionStart > 0) || !(lastSeenAt > 0)) return null;
    return { sessionStart, lastSeenAt };
  } catch {
    return null;
  }
}

/** Of the candidate cookies, the one with the newest `lastSeenAt` (the first wins a tie). Invalid ones are ignored. */
export function newestCookie(candidates: readonly (string | undefined)[]): string | undefined {
  let best: string | undefined;
  let bestSeen = -1;
  for (const c of candidates) {
    const claims = c === undefined ? null : parseClaims(c);
    if (c !== undefined && claims !== null && claims.lastSeenAt > bestSeen) {
      best = c;
      bestSeen = claims.lastSeenAt;
    }
  }
  return best;
}

/**
 * `incoming` laid over `current`: per role the cookie with the newest `lastSeenAt` wins (the stored one wins a tie),
 * and roles `incoming` does not mention stay. Every writer applies this under the store lock, so a late writer holding
 * an older cookie (a job's write-back, a keep-alive, a capture started earlier) can never shorten a session.
 */
export function mergeNewest(current: Roles, incoming: Roles): Roles {
  const out: Roles = { ...current };
  for (const [role, cookie] of Object.entries(incoming)) out[role] = newestCookie([current[role], cookie]) ?? cookie;
  return out;
}

/**
 * Every write and every decrypt goes through here, so "production holds the canary only, staging never does" holds for
 * the store itself and not just for the one command that captures. (The AAD names the target but not the role: the
 * roles live inside one authenticated blob, so they cannot be swapped without the key.)
 */
function checkRoles(roles: Roles, target: string): void {
  for (const [role, cookie] of Object.entries(roles)) {
    if (!isRole(role)) throw new StoreError(`"${role.slice(0, 32)}" is not a role`);
    if (!roleAllowedOn(role, target)) throw new StoreError(`the ${role} role is not used on ${target}`);
    if (!validCookie(cookie)) throw new StoreError(`the cookie for ${role} is not a session token`);
  }
}

/** The file's bytes for `roles`: JSON with a fresh 96-bit IV and the GCM tag. */
export function encryptRoles(roles: Roles, target: string, key: Buffer): string {
  checkRoles(roles, target);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(target));
  const ct = Buffer.concat([cipher.update(JSON.stringify({ version: 1, roles }), "utf8"), cipher.final()]);
  return `${JSON.stringify({ version: 1, alg: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") })}\n`;
}

/** Throws StoreError (no key, file or plaintext in the message) for a wrong key, a tampered file or another target's file. */
export function decryptRoles(text: string, target: string, key: Buffer): Roles {
  let roles: Roles;
  try {
    const f = JSON.parse(text) as { version?: unknown; alg?: unknown; iv?: unknown; tag?: unknown; ct?: unknown };
    if (f.version !== 1 || f.alg !== "aes-256-gcm" || typeof f.iv !== "string" || typeof f.tag !== "string" || typeof f.ct !== "string") throw new Error("shape");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(f.iv, "base64"));
    decipher.setAAD(aad(target));
    decipher.setAuthTag(Buffer.from(f.tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(f.ct, "base64")), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(plain) as { version?: unknown; roles?: unknown };
    if (parsed.version !== 1 || typeof parsed.roles !== "object" || parsed.roles === null || Array.isArray(parsed.roles)) throw new Error("shape");
    roles = parsed.roles as Roles;
  } catch {
    throw new StoreError("the session store cannot be decrypted (wrong key, edited file, or a file for another target)");
  }
  checkRoles(roles, target);
  return { ...roles };
}

/** Reads and decrypts the store; a missing file is an empty store. Refuses a symlink, another owner's file or loose permissions. */
export function readStore(file: string, target: string, key: Buffer): Roles {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    throw new StoreError(code === "ELOOP" ? "the session store is a symbolic link" : `the session store cannot be opened (${code ?? "error"})`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new StoreError("the session store is not a regular file");
    if (st.uid !== process.getuid?.()) throw new StoreError("the session store is owned by another user");
    if ((st.mode & 0o077) !== 0) throw new StoreError(`the session store is accessible to group or others (mode ${(st.mode & 0o777).toString(8)})`);
    return decryptRoles(readFileSync(fd, "utf8"), target, key);
  } finally {
    closeSync(fd);
  }
}

/** Writes `text` to `file` (0600, in a 0700 folder) by temp file and rename, so a reader never sees half a file. */
export function writeFileAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Each level of the store's folder (`.local`, `.local/state`, `live-e2e`) must be a real directory, never a link that
 * sends the store somewhere else. A missing one is made later (and nothing below it exists yet).
 */
function assertPlainFolder(dir: string): void {
  for (const level of [dirname(dirname(dir)), dirname(dir), dir]) {
    try {
      if (!lstatSync(level).isDirectory()) throw new StoreError("the session store folder is a link or not a directory");
    } catch (err) {
      if (err instanceof StoreError) throw err;
      if (isCode(err, "ENOENT")) return;
      throw err;
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const isCode = (err: unknown, code: string): boolean => (err as NodeJS.ErrnoException).code === code;

/** Test seam: runs right after a failed `mkdir` of the lock (the holder may release before the next line looks at it). */
export interface LockHooks {
  afterContended?: () => void;
  /** Runs right after this waiter took the reclaim guard, before it re-checks the lock's age: where another process could swap in a fresh lock. */
  afterGuard?: () => void;
}

/**
 * The lock is a folder. A lock older than LOCK_STALE_MS belongs to a crashed writer and is reclaimed, but only by one
 * waiter at a time (a second folder, `<lock>.reclaim`, serializes the reclaimers) and only after re-checking the age
 * under that guard, so a waiter that judged the lock stale a moment ago cannot delete the fresh lock another waiter
 * has taken since. A lock that vanishes between the failed `mkdir` and the look at it is simply retried.
 */
export async function withLock<T>(file: string, body: () => T, hooks: LockHooks = {}): Promise<T> {
  const lock = `${file}.lock`;
  const guard = `${lock}.reclaim`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const ageOf = (path: string): number | undefined => {
    try {
      return Date.now() - statSync(path).mtimeMs;
    } catch (err) {
      if (isCode(err, "ENOENT")) return undefined;
      throw err;
    }
  };
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (err) {
      if (!isCode(err, "EEXIST")) throw err;
    }
    hooks.afterContended?.();
    try {
      if (lstatSync(lock).isSymbolicLink()) throw new StoreError("the session store lock is a symbolic link");
    } catch (err) {
      if (err instanceof StoreError) throw err;
      if (!isCode(err, "ENOENT")) throw err;
    }
    const age = ageOf(lock);
    if (age === undefined) continue;
    if (age > LOCK_STALE_MS) {
      try {
        mkdirSync(guard, { mode: 0o700 });
      } catch (err) {
        if (!isCode(err, "EEXIST")) throw err;
        // Another waiter is reclaiming; a reclaim guard left by a crashed waiter goes stale the same way.
        if ((ageOf(guard) ?? 0) > LOCK_STALE_MS) rmSync(guard, { recursive: true, force: true });
        await sleep(25);
        continue;
      }
      try {
        hooks.afterGuard?.();
        const again = ageOf(lock);
        if (again !== undefined && again > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
      } finally {
        rmSync(guard, { recursive: true, force: true });
      }
      continue;
    }
    if (Date.now() > deadline) throw new StoreError("the session store is locked by another writer");
    await sleep(25);
  }
  try {
    return body();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Read-modify-write under the lock. `change` returns the new roles (a role set to undefined is removed). */
export async function updateStore(file: string, target: string, key: Buffer, change: (roles: Roles) => Roles, hooks: LockHooks = {}): Promise<Roles> {
  assertPlainFolder(dirname(file));
  return withLock(
    file,
    () => {
      const next = change(readStore(file, target, key));
      writeFileAtomic(file, encryptRoles(next, target, key));
      return next;
    },
    hooks,
  );
}

/** Sets one role's cookie unless the store already holds a newer one (decided under the lock). */
export const putRole = (file: string, target: string, key: Buffer, role: Role, cookie: string): Promise<Roles> =>
  updateStore(file, target, key, (roles) => mergeNewest(roles, { [role]: cookie }));

/** Removes one role (the undo of a capture; the disposable `revoke` session is discarded this way after a full run). */
export const removeRole = (file: string, target: string, key: Buffer, role: Role): Promise<Roles> =>
  updateStore(file, target, key, (roles) => Object.fromEntries(Object.entries(roles).filter(([r]) => r !== role)));
