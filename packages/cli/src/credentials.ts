/**
 * The credential file: `<config dir>/credentials.json` at mode 0600 in a directory at 0700, owned by the current user, never a link. It is written
 * through a temporary file (`O_EXCL|O_NOFOLLOW`) and a rename, the same pattern as fx-runner's credentials.ts. Every refusal is fixed text.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync, type Stats } from "node:fs";
import path from "node:path";
import { configDir, type Io } from "./context.js";
import { CliExit, EXIT } from "./errors.js";

export interface Credential {
  origin: string;
  token: string;
  saved_at: string;
}
/** Profile name to credential. Always a null-prototype object, so a name like `constructor` can never resolve to an inherited member; read it with `getCredential`. */
export type Credentials = Record<string, Credential>;

export const emptyCredentials = (): Credentials => Object.create(null) as Credentials;

/** The credential saved under `name`, or undefined. Only an own key counts. */
export function getCredential(creds: Credentials, name: string): Credential | undefined {
  return Object.hasOwn(creds, name) ? creds[name] : undefined;
}

const unsafe = (why: string): CliExit => new CliExit(EXIT.auth, "unsafe_credentials", `the credential file or its directory is not safe to use (${why}); fix it with chmod/chown, or run \`fx logout --all\` and log in again`);
const FILE = "credentials.json";
const MAX_BYTES = 1024 * 1024;

function look(target: string): Stats | undefined {
  try {
    return lstatSync(target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw unsafe("a path cannot be read");
  }
}

export function checkDir(dir: string, uid: number | undefined): Stats | undefined {
  const info = look(dir);
  if (info === undefined) return undefined;
  if (info.isSymbolicLink() || !info.isDirectory()) throw unsafe("the directory is a link or not a directory");
  if (uid !== undefined && info.uid !== uid) throw unsafe("the directory belongs to another user");
  if ((info.mode & 0o077) !== 0) throw unsafe("the directory can be used by other users");
  return info;
}

export function checkFile(info: Stats, uid: number | undefined): void {
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw unsafe("the file is a link or not a plain file");
  if (uid !== undefined && info.uid !== uid) throw unsafe("the file belongs to another user");
  if ((info.mode & 0o077) !== 0) throw unsafe("the file can be read by other users");
}

/** The stored credentials, `{}` when there is no file. Throws exit 3 when the file or its directory fails a safety check. */
export function readCredentials(io: Io): Credentials {
  const dir = configDir(io);
  if (checkDir(dir, io.uid) === undefined) return emptyCredentials();
  const file = path.join(dir, FILE);
  const before = look(file);
  if (before === undefined) return emptyCredentials();
  checkFile(before, io.uid);
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    // fx-swallow-ok: the system's text could hold a path
    throw unsafe("the file cannot be opened");
  }
  try {
    const info = fstatSync(fd);
    if (info.ino !== before.ino || info.dev !== before.dev) throw unsafe("the file changed while it was being read");
    checkFile(info, io.uid);
    if (info.size > MAX_BYTES) throw unsafe("the file is too large");
    const parsed = JSON.parse(readFileSync(fd, "utf8")) as { profiles?: Credentials };
    const out = emptyCredentials();
    for (const [name, value] of Object.entries(parsed.profiles ?? {})) {
      if (value !== null && typeof value === "object") out[name] = value;
    }
    return out;
  } catch (e) {
    if (e instanceof CliExit) throw e;
    // fx-swallow-ok: a parse error's text could quote the file
    throw unsafe("the file is not valid JSON");
  } finally {
    closeSync(fd);
  }
}

/** `fx logout --all`: removes the file even when it fails a safety check (a link is removed as a link). A linked directory is still refused. */
export function clearCredentials(io: Io): void {
  const dir = look(configDir(io));
  if (dir === undefined) return;
  if (dir.isSymbolicLink() || !dir.isDirectory()) throw unsafe("the directory is a link or not a directory");
  rmSync(path.join(configDir(io), FILE), { force: true });
}

/** Replaces the stored credentials. An empty set deletes the file. */
export function writeCredentials(io: Io, creds: Credentials): void {
  const dir = configDir(io);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  checkDir(dir, io.uid);
  const target = path.join(dir, FILE);
  const existing = look(target);
  if (existing !== undefined) checkFile(existing, io.uid);
  if (Object.keys(creds).length === 0) {
    if (existing !== undefined) rmSync(target);
    return;
  }
  const temp = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeSync(fd, JSON.stringify({ v: 1, profiles: creds }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}
