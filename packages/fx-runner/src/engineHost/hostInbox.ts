/**
 * EB-12b: the host's side of the command hand-off. While the host is alive (its `engine-host.json` heartbeat is fresh), the engine's reader moves a command out
 * of `engine-inbox/` into `engine-host-inbox/` and writes no outcome. The host then:
 *  - CLAIMS a command by renaming it into `engine-host-inbox/claimed/`, before it applies anything. The reader takes back what is in `claimed/` only when the host's pid
 *    is dead, never on a stale heartbeat alone, so a host that is still applying a command is never applied twice;
 *  - writes `engine-inbox/done/<seq>-<command_id>.outcome.json` (exactly the ack body, 0600) with link semantics: the file is made whole under a temp name and
 *    linked to its final name, so an outcome already there (the reader's, or an earlier write) is never replaced.
 * Directories are judged by `lstat` (never a link, owned by this user, closed to the group and others) and files by the handle they were opened with. Nothing
 * here reads a name or a body into a message: a file that is not a command is answered with one fixed refusal.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import type { EngineCommandAck } from "@fulcrumaxe/runner-protocol";
import { EngineStateError } from "../engineBridge/stateFiles.js";

export const HOST_INBOX_DIR = "engine-host-inbox";
export const CLAIMED_DIR = "claimed";
const INBOX_DIR = "engine-inbox";
const DONE_DIR = "done";
const FILE_MAX_BYTES = 64 * 1024;
const NAME = /^([1-9][0-9]{0,15})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/i;

export interface Claimed {
  /** `<seq>-<command_id>`, the file's name without its suffix; the outcome is written under it. */
  name: string;
  seq: number;
  commandId: string;
  /** The file's JSON, or undefined when it could not be read safely (a link, another owner's file, a wide mode, too large, not JSON). */
  body: unknown;
}

export interface HostInbox {
  /** Claims every command waiting in `engine-host-inbox/`, lowest seq first. Returns [] when there is no such directory. Throws `EngineStateError` for an unsafe directory. */
  claimAll(): Claimed[];
  /** Writes the outcome file for a claimed command without replacing one that exists. True when this call made it, false when one was already there. */
  writeOutcome(name: string, ack: EngineCommandAck): boolean;
  /** True when `engine-inbox/done/<name>.outcome.json` exists (a link counts: the name is taken). False when the done directory is missing. Throws `EngineStateError` for an unsafe directory. */
  hasOutcome(name: string): boolean;
  /** Removes `claimed/<name>.json` (a link is removed, never followed). Only for a command that already has an outcome. Nothing happens when there is no such file; throws `EngineStateError` for an unsafe directory. */
  dropClaimed(name: string): void;
}

function checkDir(dir: string, uid: number, create: boolean): boolean {
  let st = lstatSync(dir, { throwIfNoEntry: false });
  if (st === undefined) {
    if (!create) return false;
    mkdirSync(dir, { mode: 0o700 });
    st = lstatSync(dir);
  }
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid || (st.mode & 0o077) !== 0) throw new EngineStateError("a directory of the host inbox is not safe to use");
  return true;
}

function readBody(file: string, uid: number): unknown {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    // fx-swallow-ok: a link or a vanished file is "no readable body"; the caller answers it with the one fixed refusal
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== uid || (st.mode & 0o077) !== 0 || st.size > FILE_MAX_BYTES) return undefined;
    const buf = Buffer.alloc(st.size);
    readSync(fd, buf, 0, st.size, 0);
    return JSON.parse(buf.toString("utf8"));
  } catch {
    // fx-swallow-ok: a file that is not JSON is as good as none
    return undefined;
  } finally {
    closeSync(fd);
  }
}

export function openHostInbox(stateDir: string, uid: number): HostInbox {
  const inbox = path.join(stateDir, HOST_INBOX_DIR);
  const claimed = path.join(inbox, CLAIMED_DIR);
  const engineInbox = path.join(stateDir, INBOX_DIR);
  const done = path.join(engineInbox, DONE_DIR);
  return {
    claimAll() {
      if (!checkDir(stateDir, uid, false) || !checkDir(inbox, uid, false)) return [];
      checkDir(claimed, uid, true);
      const names = readdirSync(inbox)
        .map((entry) => ({ entry, m: entry.match(NAME) }))
        .filter((x): x is { entry: string; m: RegExpMatchArray } => x.m !== null)
        .sort((a, b) => Number(a.m[1]) - Number(b.m[1]));
      const out: Claimed[] = [];
      for (const { entry, m } of names) {
        const from = path.join(inbox, entry);
        const to = path.join(claimed, entry);
        const st = lstatSync(from, { throwIfNoEntry: false });
        if (st === undefined) continue;
        if (lstatSync(to, { throwIfNoEntry: false }) !== undefined) {
          // Claimed once already: a second copy is never applied (the first one's outcome stands).
          unlinkSync(from);
          continue;
        }
        try {
          renameSync(from, to);
        } catch {
          // fx-swallow-ok: the reader took it back (or it is gone) between the listing and the rename: it is not ours, and it is not applied
          continue;
        }
        out.push({ name: entry.slice(0, -5), seq: Number(m[1]), commandId: m[2]!.toLowerCase(), body: readBody(to, uid) });
      }
      return out;
    },
    hasOutcome(name) {
      if (!checkDir(stateDir, uid, false) || !checkDir(engineInbox, uid, false) || !checkDir(done, uid, false)) return false;
      return lstatSync(path.join(done, `${name}.outcome.json`), { throwIfNoEntry: false }) !== undefined;
    },
    dropClaimed(name) {
      if (!checkDir(stateDir, uid, false) || !checkDir(inbox, uid, false) || !checkDir(claimed, uid, false)) return;
      try {
        unlinkSync(path.join(claimed, `${name}.json`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    },
    writeOutcome(name, ack) {
      // The parent is judged as the done directory is: a link or a wide `engine-inbox` would send the outcome somewhere the reader does not look.
      if (!checkDir(stateDir, uid, false) || !checkDir(engineInbox, uid, false) || !checkDir(done, uid, false)) fail();
      const target = path.join(done, `${name}.outcome.json`);
      const temp = path.join(done, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        try {
          writeSync(fd, `${JSON.stringify(ack)}\n`);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        try {
          linkSync(temp, target);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
          throw error;
        }
      } finally {
        try {
          unlinkSync(temp);
        } catch {
          // fx-swallow-ok: the temp name is ours alone; one already gone needs nothing
        }
      }
    },
  };
}

function fail(): never {
  throw new EngineStateError("the engine inbox's done directory is missing or not safe to use");
}
