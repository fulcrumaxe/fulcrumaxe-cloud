/**
 * EB-12a: the host's local files besides `engine-host.json`. All of them live in the engine's state directory (0700), are opened without following a link and are
 * 0600: the stream log (rotated at 20 MB, never uploaded), the bridge state the last pull left (`engine-bridge-state.json`, read here, never written) and the
 * supervisor's lifetime lock (`engine-host.lock`).
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, linkSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { conventionalUnit } from "../engineBridge/halt.js";
import { EngineStateError, ensurePrivateDir, readJsonNoFollow } from "../engineBridge/stateFiles.js";

export const HOST_LOG_FILE = "engine-host.log";
export const HOST_LOG_MAX_BYTES = 20 * 1024 * 1024;
export const BRIDGE_STATE_FILE = "engine-bridge-state.json";
export const HOST_LOCK_FILE = "engine-host.lock";

/**
 * The one rule for the repo id the supervisor names its scope after: a plain decimal of at most 19 digits with no leading zero. It is judged by the kill
 * path's own `conventionalUnit` (halt.ts), so the unit the supervisor writes always passes the reader that later signals it; the pattern above only
 * spells the same rule out.
 */
export const isRepoGhId = (id: string): boolean => /^[1-9][0-9]{0,18}$/.test(id) && conventionalUnit(id) !== undefined;

export interface HostLog {
  /** Appends to the log. Never throws: false means the write failed, the log is closed and nothing more will be written (the caller stops the host cleanly). */
  write(text: string): boolean;
  close(): void;
}

/** Opens the log for append at 0600; a link, a file of another owner or one open to others is refused. Past `maxBytes` the file becomes `<name>.1` (replacing the older one) and a new one starts. */
export function openHostLog(dir: string, uid: number, maxBytes: number = HOST_LOG_MAX_BYTES, name: string = HOST_LOG_FILE): HostLog {
  ensurePrivateDir(dir, uid);
  const target = path.join(dir, name);
  let fd = -1;
  let size = 0;
  const open = (): void => {
    const existing = lstatSync(target, { throwIfNoEntry: false });
    if (existing !== undefined && (existing.isSymbolicLink() || !existing.isFile())) throw new EngineStateError("the host log is a link or not a plain file");
    fd = openSync(target, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== uid || (st.mode & 0o077) !== 0) {
      closeSync(fd);
      fd = -1;
      throw new EngineStateError("the host log is not safe to write");
    }
    size = st.size;
  };
  open();
  return {
    write(text) {
      if (fd === -1) return false;
      try {
        const buf = Buffer.from(text);
        if (size > 0 && size + buf.length > maxBytes) {
          closeSync(fd);
          fd = -1;
          renameSync(target, `${target}.1`);
          open();
        }
        writeSync(fd, buf);
        size += buf.length;
        return true;
      } catch {
        // fx-swallow-ok: a log that cannot be written (full disk, a planted entry at the rotation name) is reported as false; the caller stops the host and nothing is retried
        if (fd !== -1) {
          try {
            closeSync(fd);
          } catch {
            // fx-swallow-ok: closing a descriptor that is already broken
          }
        }
        fd = -1;
        return false;
      }
    },
    close() {
      if (fd !== -1) closeSync(fd);
      fd = -1;
    },
  };
}

/** What `acquireHostLock` needs from the machine, so the lock can be tested with other processes' identities. */
export interface HostLockDeps {
  ownPid: number;
  /** Whether a pid is a live process. */
  isAlive: (pid: number) => boolean;
  /** When the process started (field 22 of its stat file on Linux), or undefined when it is gone: a reused pid has a different one. */
  startOf: (pid: number) => string | undefined;
}
export interface HostLock {
  release(): void;
}

/**
 * The lifetime lock of one supervisor: `engine-host.lock` in the state directory, holding `{pid, start}` of its owner. It is held for the supervisor's whole run,
 * so a second `start` is refused even while the first is in back-off with no host and no handle. A lock whose owner is gone (dead, or the pid now belongs to a
 * process that started later) is stale and is taken over. Node has no flock, so this is the same promise made with files:
 *  - the lock is always created by writing a private temp file and `link()`ing it to the lock name, so it appears whole and only one creator can win;
 *  - a stale lock is removed only by the holder of a short-lived takeover guard (`engine-host.lock.takeover`, created exclusively). The holder judges the lock
 *    again under the guard before removing it, so a claimant that judged it stale long ago can never remove a lock another claimant has since taken.
 * A guard left by a crashed claimant is replaced once it is older than `TAKEOVER_GUARD_MS`; until then a start that meets it is refused (a later start succeeds).
 */
export const TAKEOVER_GUARD_MS = 30_000;

export function acquireHostLock(dir: string, uid: number, deps: HostLockDeps): HostLock | undefined {
  ensurePrivateDir(dir, uid);
  const target = path.join(dir, HOST_LOCK_FILE);
  const guard = `${target}.takeover`;
  const mine = JSON.stringify({ pid: deps.ownPid, start: deps.startOf(deps.ownPid) ?? "" });
  /** The owner a lock file names, or undefined when there is no file or it is not of our shape (then it counts as stale). */
  const ownerOf = (): { pid: number; start: string } | undefined | "none" => {
    const text = readLockFile(target, uid);
    if (text === undefined) return "none";
    try {
      const parsed = JSON.parse(text) as { pid?: unknown; start?: unknown };
      if (Number.isSafeInteger(parsed.pid) && typeof parsed.start === "string") return { pid: parsed.pid as number, start: parsed.start };
    } catch {
      // fx-swallow-ok: a lock file that is not of our shape is treated as stale and replaced
    }
    return undefined;
  };
  const live = (o: { pid: number; start: string } | undefined | "none"): boolean => o !== undefined && o !== "none" && deps.isAlive(o.pid) && deps.startOf(o.pid) === o.start;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (createWhole(target, mine, dir, deps.ownPid)) {
      return {
        release() {
          try {
            if (readLockFile(target, uid) === mine) unlinkSync(target);
          } catch {
            // fx-swallow-ok: a lock that cannot be removed is judged stale by the next start (its owner is gone)
          }
        },
      };
    }
    if (live(ownerOf())) return undefined;
    if (!takeOverStale(guard, () => live(ownerOf()), target)) return undefined;
  }
  return undefined;
}

/** Writes `text` to a private temp file and links it to `target`: true when this call created `target`, false when it already existed. */
function createWhole(target: string, text: string, dir: string, ownPid: number): boolean {
  const tmp = path.join(dir, `.engine-host.lock.${ownPid}.${randomBytes(6).toString("hex")}`);
  try {
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
    linkSync(tmp, target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST" && lstatSync(tmp, { throwIfNoEntry: false }) !== undefined) return false;
    throw new EngineStateError("the host lock could not be created safely");
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // fx-swallow-ok: the temp file is ours alone; one that is already gone needs nothing
    }
  }
}

/** Removes a stale lock under the takeover guard. False when another claimant holds the guard or the lock turned out to be live once judged again. */
function takeOverStale(guard: string, liveNow: () => boolean, target: string): boolean {
  let fd: number;
  try {
    fd = openSync(guard, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new EngineStateError("the host lock could not be created safely");
    const st = lstatSync(guard, { throwIfNoEntry: false });
    if (st !== undefined && st.isFile() && Date.now() - st.mtimeMs > TAKEOVER_GUARD_MS) {
      try {
        unlinkSync(guard);
      } catch {
        // fx-swallow-ok: another claimant removed the old guard first; this start is refused either way and the next one decides
      }
    }
    return false;
  }
  try {
    closeSync(fd);
    if (liveNow()) return false;
    try {
      unlinkSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new EngineStateError("the host lock could not be created safely");
    }
    return true;
  } finally {
    try {
      unlinkSync(guard);
    } catch {
      // fx-swallow-ok: a guard that cannot be removed ages out
    }
  }
}

/** The text of the lock file, read without following a link; a link, another owner's file or a wide mode is refused. */
function readLockFile(target: string, uid: number): string | undefined {
  const st = lstatSync(target, { throwIfNoEntry: false });
  if (st === undefined) return undefined;
  if (st.isSymbolicLink() || !st.isFile() || st.uid !== uid || (st.mode & 0o077) !== 0 || st.size > 256) throw new EngineStateError("the host lock is not safe to read");
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * What the last cloud pull left for this repo. EB-8b's pull handler is the writer; this file only reads it, and anything that is not exactly this shape is
 * refused (the host then does not start). `repo_checkout` is the repo's main checkout, where the host runs.
 */
export interface BridgeState {
  repo_gh_id: string;
  bridge_enabled: boolean;
  operate_enabled: boolean;
  repo_checkout: string;
}

export function readBridgeState(dir: string, uid: number): BridgeState | undefined {
  const raw = readJsonNoFollow(dir, BRIDGE_STATE_FILE, uid);
  if (raw === undefined) return undefined;
  const o = raw as Record<string, unknown> | null;
  if (o === null || typeof o !== "object" || Array.isArray(o)) throw new EngineStateError("engine-bridge-state.json is not an object");
  const ok =
    Object.keys(o).sort().join(",") === "bridge_enabled,operate_enabled,repo_checkout,repo_gh_id" &&
    typeof o.repo_gh_id === "string" &&
    isRepoGhId(o.repo_gh_id) &&
    typeof o.bridge_enabled === "boolean" &&
    typeof o.operate_enabled === "boolean" &&
    typeof o.repo_checkout === "string" &&
    path.isAbsolute(o.repo_checkout) &&
    !o.repo_checkout.includes("\0");
  if (!ok) throw new EngineStateError("engine-bridge-state.json has an unexpected shape");
  return o as unknown as BridgeState;
}
