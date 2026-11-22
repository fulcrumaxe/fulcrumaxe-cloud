/**
 * One secret in one file under `<state dir>/<dir>/`: a plain file at mode 0600 in a directory at mode 0700, owned by the user the runner runs as,
 * never a link (the rules of `src/credentials.ts` and `src/assistant/tokenFile.ts`: `lstat` of every directory and the file, then a no-follow open
 * judged on the open handle). The caller supplies the errors, so no message here holds the secret, a path or an error's own words.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, unlinkSync, writeSync, type Stats } from "node:fs";
import path from "node:path";

export interface SecretFileSpec {
  /** The directory under the state dir, and the file in it. */
  dir: string;
  file: string;
  /** The most bytes a file may hold; a longer one is refused. */
  maxBytes: number;
  /** Nothing is there (no directory, no file). */
  missing: () => Error;
  /** Anything unsafe; `reason` and `remedy` are fixed text. `remedy` is set for a directory problem (a clear-and-set of the file cannot fix it); left out, the caller's file remedy applies. */
  unsafe: (reason: string, remedy?: string) => Error;
  /** Test hook: runs between the `lstat` of the file and its open, where a swap race would land. */
  betweenLstatAndOpen?: (() => void) | undefined;
}

const DIR_REMEDY = {
  "state directory": "fix the runner state directory: run chmod go-w on it (chown it to the runner user if it belongs to another user, or replace a link with a plain directory)",
  "credentials directory": "fix the credentials directory inside the runner state directory: run chmod 700 on it (chown it to the runner user if it belongs to another user, or remove a link there)",
} as const;
type DirLabel = keyof typeof DIR_REMEDY;

function look(spec: SecretFileSpec, target: string): Stats | undefined {
  try {
    return lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw spec.unsafe("a path cannot be read");
  }
}

function needUid(spec: SecretFileSpec, uid: number | undefined): number {
  if (uid === undefined) throw spec.unsafe("cannot tell which user this runs as");
  return uid;
}

/** A plain directory (not a link) owned by `uid`; `closed` also refuses any group or world access, otherwise only group or world write. */
function checkDir(spec: SecretFileSpec, dir: string, label: DirLabel, uid: number, closed: boolean): void {
  const info = look(spec, dir);
  if (info === undefined) throw spec.missing();
  if (info.isSymbolicLink() || !info.isDirectory()) throw spec.unsafe(`the ${label} is a link or not a plain directory`, DIR_REMEDY[label]);
  if (info.uid !== uid) throw spec.unsafe(`the ${label} belongs to another user`, DIR_REMEDY[label]);
  if ((info.mode & (closed ? 0o077 : 0o022)) !== 0) throw spec.unsafe(`the ${label} can be ${closed ? "used" : "written"} by other users`, DIR_REMEDY[label]);
}

function checkFile(spec: SecretFileSpec, info: Stats, uid: number): void {
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw spec.unsafe("the file is a link or not a plain file");
  if (info.uid !== uid) throw spec.unsafe("the file belongs to another user");
  if ((info.mode & 0o077) !== 0) throw spec.unsafe("the file can be read by other users");
}

const filePath = (spec: SecretFileSpec, stateDir: string): string => path.join(stateDir, spec.dir, spec.file);

/** The file's bytes in a fresh buffer (the caller zeroes it). Throws the spec's `missing` or `unsafe`; an empty file comes back empty. */
export function readSecretFile(spec: SecretFileSpec, stateDir: string, uid: number | undefined): Buffer {
  const owner = needUid(spec, uid);
  checkDir(spec, stateDir, "state directory", owner, false);
  checkDir(spec, path.join(stateDir, spec.dir), "credentials directory", owner, true);
  const file = filePath(spec, stateDir);
  const before = look(spec, file);
  if (before === undefined) throw spec.missing();
  checkFile(spec, before, owner);
  spec.betweenLstatAndOpen?.();
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    // fx-swallow-ok: a link (ELOOP) or a file that cannot be opened is the same refusal; the system's text could hold a path
    throw spec.unsafe("the file cannot be opened");
  }
  const buffer = Buffer.alloc(spec.maxBytes + 1);
  let filled = 0;
  try {
    const info = fstatSync(fd);
    // The file that was checked is the file that is read: a swap between the two is refused.
    if (info.ino !== before.ino || info.dev !== before.dev) throw spec.unsafe("the file changed while it was being read");
    checkFile(spec, info, owner);
    for (;;) {
      const n = readSync(fd, buffer, filled, buffer.length - filled, null);
      if (n === 0) break;
      filled += n;
      if (filled === buffer.length) throw spec.unsafe("the file is too large");
    }
  } catch (error) {
    buffer.fill(0);
    throw error;
  } finally {
    closeSync(fd);
  }
  const out = Buffer.from(buffer.subarray(0, filled));
  buffer.fill(0);
  return out;
}

/** Stores `content` through an exclusive 0600 temporary file beside the target, flushed, then renamed over it. An unsafe existing file is refused, never replaced. */
export function writeSecretFile(spec: SecretFileSpec, stateDir: string, uid: number | undefined, content: string): void {
  const owner = needUid(spec, uid);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  checkDir(spec, stateDir, "state directory", owner, false);
  const dir = path.join(stateDir, spec.dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  checkDir(spec, dir, "credentials directory", owner, true);
  const target = filePath(spec, stateDir);
  const existing = look(spec, target);
  if (existing !== undefined) checkFile(spec, existing, owner);
  const temp = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Deletes the file; true when there was one. A link in its place is removed as a link, never followed. Safe to repeat. */
export function removeSecretFile(spec: SecretFileSpec, stateDir: string, uid: number | undefined): boolean {
  const owner = needUid(spec, uid);
  const dir = look(spec, path.join(stateDir, spec.dir));
  if (dir === undefined) return false;
  if (dir.isSymbolicLink() || !dir.isDirectory() || dir.uid !== owner) throw spec.unsafe("the credentials directory is a link, not a plain directory, or belongs to another user", DIR_REMEDY["credentials directory"]);
  if (look(spec, filePath(spec, stateDir)) === undefined) return false;
  unlinkSync(filePath(spec, stateDir));
  return true;
}
