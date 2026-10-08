/**
 * The runner's own memory of the job ids it has started, kept in a 0600 file so a restart or a replayed signed job cannot
 * run the same job twice (the signed job names no runner and no audience; this check is the replay defence, D#6 C9 section 5).
 * `claim` is synchronous and answers true once per id. It records the id before it answers, and answers false when the
 * record cannot be written: a job whose start could not be remembered is not started.
 *
 * What the file holds, and how it fails (D#6 R4a-2, both reviews of the daemon):
 *  - each id is kept until its own job's `expires_at`. A job past it is refused by `verifyJob` anyway, so forgetting it then
 *    cannot let it run again; an id claimed without an expiry is kept four days;
 *  - only a missing file (ENOENT) is an empty ledger. A file that cannot be read, is not JSON, is not an object of
 *    id-to-time entries, or has any other entry, is damaged: it is moved aside (`<file>.damaged-<time>-<random>`) and the ledger
 *    FAILS CLOSED, answering false to every claim, because the ids it held may still be inside their life. It stays closed until
 *    the ledger is recreated, that is until a valid file is back at the path, which a restart does not do by itself: a missing file
 *    next to a moved-aside one is still closed;
 *  - the ledger's directory is made 0700, also when it already exists;
 *  - a write goes to a new 0600 file opened exclusively, is flushed to disk, and is renamed over the ledger; if any step fails
 *    the temporary file is removed and the id is not remembered (and so not started);
 *  - one process holds a ledger at a time: a second `createFileLedger` on the same file throws `LedgerLockedError`. The lock is a
 *    `<file>.lock` holding the owner's pid, published whole (a pid-filled temp file linked to the lock path, so the lock never
 *    exists without its pid). A lock whose process is gone is taken over by renaming it aside and checking it is still the one
 *    judged stale; one with no readable pid counts as held for a few seconds from its mtime. `close()` removes the lock only if
 *    it still holds this process's pid. The caller
 *    passes its own pid and a liveness check, because this file is not one of the two the environment guard lets read the
 *    runtime's own state.
 *
 * Known residual (D#6 C26 section 2 item 7): the takeover of a stale lock is not atomic against a third starter. If three
 * processes start together on a lock left by a crash, two can each judge it stale and both end up holding the ledger. An advisory
 * `flock` would close that, but Node has no `flock` call and a native addon would break the single reproducible binary, so the
 * window is accepted. `fx-runner service install` runs exactly one instance per user, which is what keeps it from being reached.
 * Temporary files a crash leaves next to the ledger are removed at start by `removeStaleLedgerTemp` (staleTemp.ts).
 */
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { JobLedger } from "../job/runJob.js";

/** How long an id is kept when its job's expiry is not known: a job lives 72 hours at most, and this is four days. */
const DEFAULT_KEEP_MS = 96 * 60 * 60_000;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Another process holds this ledger. */
export class LedgerLockedError extends Error {
  readonly code = "ledger_locked";
  constructor() {
    super("another runner process is using this job ledger");
    this.name = "LedgerLockedError";
  }
}

export interface FileLedger extends JobLedger {
  /** True while the ledger refuses every claim because its file was damaged and has not been recreated. */
  readonly closed: boolean;
  /** Releases the single-instance lock. Claims after this answer false. */
  close(): void;
}

const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;

export interface LedgerOptions {
  /** This process's pid, written into the lock. */
  pid: number;
  /** Whether a process with this pid exists. A process of another user counts as existing. */
  isAlive: (pid: number) => boolean;
  now?: () => Date;
}

/** How long a lock whose owner cannot be read (empty, unreadable or not a pid) still counts as held, measured from its mtime. */
const LOCK_GRACE_MS = 5_000;

/** What a lock holds: its text and the owner's pid when the text is one; `text` is undefined when the file cannot be read. */
function readOwner(lock: string): { text: string | undefined; pid: number | undefined } | "gone" {
  let text: string | undefined;
  try {
    text = readFileSync(lock, "utf8").trim();
  } catch (error) {
    if (errnoOf(error) === "ENOENT") return "gone";
    // fx-swallow-ok: a lock that cannot be read has an unknown owner, which is handled as held for the grace below
    text = undefined;
  }
  const pid = text === undefined ? Number.NaN : Number.parseInt(text, 10);
  return { text, pid: Number.isSafeInteger(pid) && pid > 0 ? pid : undefined };
}

/** Publishes the lock with this process's pid already in it: a private temp file is linked to the lock path, EEXIST meaning held. */
function publishLock(lock: string, pid: number): boolean {
  const temp = `${lock}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, `${pid}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temp, lock);
      return true;
    } catch (error) {
      if (errnoOf(error) === "EEXIST") return false;
      throw error;
    }
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // fx-swallow-ok: the temp file is only a second name for the lock's content; the outcome above stands either way
    }
  }
}

function takeLock(lock: string, pid: number, alive: (pid: number) => boolean, now: () => Date): void {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (publishLock(lock, pid)) return;
    const owner = readOwner(lock);
    if (owner === "gone") continue;
    if (owner.pid !== undefined) {
      if (alive(owner.pid)) throw new LedgerLockedError();
    } else {
      // No readable owner: a lock another starter is still filling in, or a damaged one. It is held until it is a few seconds old.
      let mtime: number;
      try {
        mtime = statSync(lock).mtimeMs;
      } catch (error) {
        if (errnoOf(error) === "ENOENT") continue;
        throw error;
      }
      if (now().getTime() - mtime < LOCK_GRACE_MS) throw new LedgerLockedError();
    }
    // A stale lock (a crash): take it over by renaming it to a name of our own and checking it is still the lock we judged.
    // Unlinking it by name after reading it could remove whatever another process published in between.
    const aside = `${lock}.stale-${randomBytes(6).toString("hex")}`;
    try {
      renameSync(lock, aside);
    } catch (error) {
      if (errnoOf(error) === "ENOENT") continue;
      throw error;
    }
    const again = readOwner(aside);
    if (again !== "gone" && again.text === owner.text) {
      try {
        unlinkSync(aside);
      } catch {
        // fx-swallow-ok: a stale copy that cannot be removed does not hold the lock; ours is published next
      }
      continue;
    }
    // It was replaced by another process's lock before we moved it: put it back (the link fails if the path is taken again) and give up.
    try {
      linkSync(aside, lock);
    } catch {
      // fx-swallow-ok: the path was taken again by yet another process, which is then the holder; giving up below is the answer either way
    }
    try {
      unlinkSync(aside);
    } catch {
      // fx-swallow-ok: as above, the answer below does not depend on removing the copy
    }
    throw new LedgerLockedError();
  }
  throw new LedgerLockedError();
}

export function createFileLedger(file: string, options: LedgerOptions): FileLedger {
  const now = options.now ?? ((): Date => new Date());
  const dir = path.dirname(file);
  const lock = `${file}.lock`;
  // The directory is private whether or not it was there before: a job ledger is not for other users to read or replace.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  takeLock(lock, options.pid, options.isAlive, now);

  /** id -> when the id may be forgotten (ms since the epoch). */
  let seen = new Map<string, number>();
  let closedByDamage = false;
  let released = false;

  const quarantined = (): boolean => {
    const prefix = `${path.basename(file)}.damaged-`;
    try {
      return readdirSync(dir).some((name) => name.startsWith(prefix));
    } catch {
      // fx-swallow-ok: a directory that cannot be listed cannot be told to hold no moved-aside ledger, so the ledger stays closed
      return true;
    }
  };
  const moveAside = (): void => {
    try {
      renameSync(file, `${file}.damaged-${now().getTime()}-${randomBytes(3).toString("hex")}`);
    } catch {
      // fx-swallow-ok: the ledger is closed either way; a file that cannot be moved is reported by staying closed
    }
  };

  /** Reads the file: opens the ledger on a valid one or a missing one, closes it on anything else. */
  function load(): void {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if (errnoOf(error) === "ENOENT") {
        closedByDamage = quarantined();
        seen = new Map();
        return;
      }
      // fx-swallow-ok: a file that cannot be read is a damaged ledger: it is moved aside and the ledger is closed, which is the report
      closedByDamage = true;
      moveAside();
      return;
    }
    const entries = new Map<string, number>();
    let valid = true;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) valid = false;
      else {
        for (const [id, until] of Object.entries(parsed)) {
          if (JOB_ID.test(id) && typeof until === "number" && Number.isFinite(until)) entries.set(id.toLowerCase(), until);
          else valid = false;
        }
      }
    } catch {
      // fx-swallow-ok: text that is not JSON is a damaged ledger, handled below
      valid = false;
    }
    if (!valid) {
      closedByDamage = true;
      moveAside();
      return;
    }
    closedByDamage = false;
    seen = entries;
  }
  try {
    load();
  } catch (error) {
    release();
    throw error;
  }

  function release(): void {
    if (released) return;
    released = true;
    // Only a lock that still holds this process's pid is ours to remove: after a takeover it belongs to the new holder.
    try {
      if (readFileSync(lock, "utf8").trim() === String(options.pid)) unlinkSync(lock);
    } catch {
      // fx-swallow-ok: a lock that is already gone or cannot be read is not ours to remove
    }
  }

  /** Writes `entries` to a new file next to the ledger and renames it over the ledger. Throws on any failure, leaving no temporary file. */
  function write(entries: Map<string, number>): void {
    const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    let fd: number | undefined;
    let created = false;
    try {
      fd = openSync(temp, "wx", 0o600);
      created = true;
      writeFileSync(fd, `${JSON.stringify(Object.fromEntries(entries))}\n`);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, file);
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // fx-swallow-ok: the original failure is rethrown below
        }
      }
      // Only a file this call created is removed: one that was already at the name (the exclusive open failed) is not ours.
      if (created) {
        try {
          unlinkSync(temp);
        } catch {
          // fx-swallow-ok: the original failure is rethrown below
        }
      }
      throw error;
    }
  }

  return {
    get closed() {
      return closedByDamage;
    },
    close: release,
    has: (jobId) => seen.has(jobId.toLowerCase()),
    claim(jobId, expiresAt) {
      if (released) return false;
      if (closedByDamage) {
        // Closed until the ledger is recreated: look again, so a valid file put back by the owner reopens it without a restart.
        load();
        if (closedByDamage) return false;
      }
      const id = jobId.toLowerCase();
      if (seen.has(id)) return false;
      const at = now().getTime();
      const expiry = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt);
      const until = Number.isFinite(expiry) ? expiry : at + DEFAULT_KEEP_MS;
      const kept = new Map([...seen].filter(([, keepUntil]) => keepUntil > at));
      kept.set(id, until);
      try {
        write(kept);
      } catch {
        // fx-swallow-ok: answered as "do not start": a job that cannot be remembered must not run
        return false;
      }
      seen = kept;
      return true;
    },
  };
}
