/**
 * The engine bridge's local files (Spec "Local files": every file 0600 and opened O_NOFOLLOW, every directory 0700). The state directory is
 * `$AUTONOMOUS_TEAM_STATE_DIR`, else `~/.autonomous-forever-state`, the engine's own rule. Nothing here follows a link: a directory is judged by `lstat`,
 * a file by the handle it was opened with, and a write goes to a fresh temp file that is renamed over the name, so a reader sees the old file or the
 * new one and never half of one.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";

export class EngineStateError extends Error {
  constructor(message: string) {
    super(`engine state: ${message}`);
    this.name = "EngineStateError";
  }
}

/** The engine's state directory. An empty or relative override is refused: a relative path would depend on where the runner was started. */
export function engineStateDir(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const override = env.AUTONOMOUS_TEAM_STATE_DIR;
  const dir = override !== undefined && override !== "" ? override : path.join(home, ".autonomous-forever-state");
  if (!path.isAbsolute(dir)) throw new EngineStateError("the state directory must be an absolute path");
  return dir;
}

const JSON_MAX_BYTES = 16 * 1024;

/** Makes the directory (0700) when it is missing, and refuses one that is a link, not ours or open to others. Never changes the mode of an existing one. */
export function ensurePrivateDir(dir: string, uid: number): void {
  let st = lstatSync(dir, { throwIfNoEntry: false });
  if (st === undefined) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    st = lstatSync(dir);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new EngineStateError("the state directory is not a plain directory");
  if (st.uid !== uid) throw new EngineStateError("the state directory is not owned by this user");
  if ((st.mode & 0o077) !== 0) throw new EngineStateError("the state directory is open to other users");
}

/**
 * Writes `value` as JSON to `<dir>/<name>` atomically at mode 0600 (temp file, fsync, rename). A link at the name is refused, unless `replaceLink` is set: the
 * rename then replaces the link itself and nothing is written through it (a directory or other non-file at the name is still refused).
 */
export function writeJsonAtomic(dir: string, name: string, value: unknown, uid: number, options: { replaceLink?: boolean; maxBytes?: number } = {}): void {
  ensurePrivateDir(dir, uid);
  const target = path.join(dir, name);
  const existing = lstatSync(target, { throwIfNoEntry: false });
  if (existing !== undefined && !(options.replaceLink === true && existing.isSymbolicLink()) && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new EngineStateError("a file of the bridge is a link or not a plain file");
  }
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  if (body.length > (options.maxBytes ?? JSON_MAX_BYTES)) throw new EngineStateError("file too large");
  const tmp = path.join(dir, `${name}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(tmp);
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(tmp, target);
  } catch (error) {
    unlinkSync(tmp);
    throw error;
  }
}

/** Removes `<dir>/<name>` when it is a plain file; absent is fine, a link or another kind of entry is refused (a link is never followed or removed here). */
export function removeStateFile(dir: string, name: string): void {
  const target = path.join(dir, name);
  const st = lstatSync(target, { throwIfNoEntry: false });
  if (st === undefined) return;
  if (st.isSymbolicLink() || !st.isFile()) throw new EngineStateError("a file of the bridge is a link or not a plain file");
  unlinkSync(target);
}

/** Reads `<dir>/<name>` as JSON, or undefined when it is absent. A link, a file of another owner, a file open to others or an oversized one is refused. */
export function readJsonNoFollow(dir: string, name: string, uid: number, maxBytes: number = JSON_MAX_BYTES): unknown {
  const target = path.join(dir, name);
  const dirStat = lstatSync(dir, { throwIfNoEntry: false });
  if (dirStat === undefined) return undefined;
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory() || dirStat.uid !== uid || (dirStat.mode & 0o077) !== 0) throw new EngineStateError("the state directory is not safe to read");
  const st = lstatSync(target, { throwIfNoEntry: false });
  if (st === undefined) return undefined;
  if (st.isSymbolicLink() || !st.isFile()) throw new EngineStateError("a file of the bridge is a link or not a plain file");
  let fd: number;
  try {
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    // fx-swallow-ok: ELOOP or a vanished file; reported as one fixed refusal, never the path
    throw new EngineStateError("a file of the bridge could not be opened without following a link");
  }
  try {
    const open = fstatSync(fd);
    if (!open.isFile() || open.uid !== uid || (open.mode & 0o077) !== 0 || open.size > maxBytes) throw new EngineStateError("a file of the bridge is not safe to read");
    const buf = Buffer.alloc(open.size);
    readSync(fd, buf, 0, open.size, 0);
    try {
      return JSON.parse(buf.toString("utf8"));
    } catch {
      // fx-swallow-ok: a file that is not JSON is refused with a fixed message
      throw new EngineStateError("a file of the bridge is not valid JSON");
    }
  } finally {
    closeSync(fd);
  }
}
