/**
 * The runner's API key file (D#6 R5b-3, correction C38 section 1). A runner registered for `api_key` mode keeps its key in
 * `<state dir>/credentials/anthropic-api-key`: a plain file at mode 0600 in a directory at mode 0700, owned by the user the runner runs as,
 * never a link. Only `fx-runner credentials set-api-key` writes it, from standard input, through a temporary file and a rename.
 * The key is read when a job starts (not when the daemon does), so a replaced key applies from the next job, and it reaches the job only through
 * `cleanEnv`'s `api_key` branch. Every message here is fixed text: none carries the key, a path from the file, or an error's own words.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, unlinkSync, writeSync, type Stats } from "node:fs";
import path from "node:path";
import { CliError } from "./cliError.js";
import type { CredentialMode } from "./job/cleanEnv.js";

export const CREDENTIALS_DIR = "credentials";
export const API_KEY_FILE = "anthropic-api-key";
export const API_KEY_PREFIX = "sk-ant-";
export const API_KEY_MAX_BYTES = 256;

export type ApiKeyProblem = "api_key_not_configured" | "api_key_format" | "api_key_unsafe";

const TEXT: Readonly<Record<ApiKeyProblem, string>> = {
  api_key_not_configured: "no API key is stored for this runner; run: fx-runner credentials set-api-key (it reads the key from standard input)",
  api_key_format: `the key must be 1 to ${API_KEY_MAX_BYTES} printable characters with no spaces, and start with ${API_KEY_PREFIX}`,
  api_key_unsafe: "the key file or a directory above it is not safe to use",
};

/** A problem with the key file. The message is `<code>: <fixed text>`, with a fixed reason for `api_key_unsafe`; it never holds the key. */
export class ApiKeyError extends CliError {
  readonly code: ApiKeyProblem;
  constructor(code: ApiKeyProblem, reason?: string) {
    super(`${code}: ${reason ?? TEXT[code]}`);
    this.code = code;
  }
}

const unsafe = (reason: string): ApiKeyError => new ApiKeyError("api_key_unsafe", `${reason}; fix it with chmod/chown, or run: fx-runner credentials clear-api-key, then set-api-key again`);

/** The key a person typed or piped: one trailing newline is dropped, then it must be printable ASCII without spaces, start with the prefix and fit. */
export function parseApiKey(raw: string): string {
  const text = raw.replace(/\r?\n$/, "");
  if (Buffer.byteLength(text) > API_KEY_MAX_BYTES || text.length <= API_KEY_PREFIX.length || !/^[\x21-\x7e]+$/.test(text) || !text.startsWith(API_KEY_PREFIX)) throw new ApiKeyError("api_key_format");
  return text;
}

function needUid(uid: number | undefined): number {
  if (uid === undefined) throw unsafe("cannot tell which user this runs as");
  return uid;
}

/** `lstat` of a path, or undefined when it is not there. */
function look(target: string): Stats | undefined {
  try {
    return lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw unsafe("a path cannot be read");
  }
}

/** A plain directory (not a link) owned by `uid`. `closed` also refuses any group or world access; otherwise only group or world write. */
function checkDir(dir: string, label: string, uid: number, closed: boolean): void {
  const info = look(dir);
  if (info === undefined) throw new ApiKeyError("api_key_not_configured");
  if (info.isSymbolicLink() || !info.isDirectory()) throw unsafe(`the ${label} is a link or not a plain directory`);
  if (info.uid !== uid) throw unsafe(`the ${label} belongs to another user`);
  if ((info.mode & (closed ? 0o077 : 0o022)) !== 0) throw unsafe(`the ${label} can be ${closed ? "used" : "written"} by other users`);
}

function checkFile(info: Stats, uid: number): void {
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw unsafe("the key file is a link or not a plain file");
  if (info.uid !== uid) throw unsafe("the key file belongs to another user");
  if ((info.mode & 0o077) !== 0) throw unsafe("the key file can be read by other users");
}

const keyPath = (stateDir: string): string => path.join(stateDir, CREDENTIALS_DIR, API_KEY_FILE);

/** The stored key. Throws `ApiKeyError`: not configured (nothing there), unsafe (link, owner, mode) or format (the prefix, size or characters). */
export function readApiKey(stateDir: string, uid: number | undefined): string {
  const owner = needUid(uid);
  checkDir(stateDir, "state directory", owner, false);
  checkDir(path.join(stateDir, CREDENTIALS_DIR), "credentials directory", owner, true);
  const file = keyPath(stateDir);
  const before = look(file);
  if (before === undefined) throw new ApiKeyError("api_key_not_configured");
  checkFile(before, owner);
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    // fx-swallow-ok: a link (ELOOP) or a file that cannot be opened is the same refusal; the system's text could hold a path
    throw unsafe("the key file cannot be opened");
  }
  try {
    const info = fstatSync(fd);
    // The file that was checked is the file that is read: a swap between the two is refused.
    if (info.ino !== before.ino || info.dev !== before.dev) throw unsafe("the key file changed while it was being read");
    checkFile(info, owner);
    const buffer = Buffer.alloc(API_KEY_MAX_BYTES + 3);
    let filled = 0;
    for (;;) {
      const n = readSync(fd, buffer, filled, buffer.length - filled, null);
      if (n === 0) break;
      filled += n;
      if (filled === buffer.length) throw new ApiKeyError("api_key_format");
    }
    return parseApiKey(buffer.subarray(0, filled).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

/** Stores `raw` (already read from standard input) as the key: a temporary file at 0600 beside it, flushed, then renamed over the old one. */
export function writeApiKey(stateDir: string, uid: number | undefined, raw: string): void {
  const key = parseApiKey(raw);
  const owner = needUid(uid);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  checkDir(stateDir, "state directory", owner, false);
  const dir = path.join(stateDir, CREDENTIALS_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  checkDir(dir, "credentials directory", owner, true);
  const target = keyPath(stateDir);
  const existing = look(target);
  if (existing !== undefined) checkFile(existing, owner);
  const temp = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeSync(fd, key);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Deletes the key file. True when there was one. A link in place of the file is removed as a link, never followed. */
export function clearApiKey(stateDir: string, uid: number | undefined): boolean {
  const owner = needUid(uid);
  const dir = look(path.join(stateDir, CREDENTIALS_DIR));
  if (dir === undefined) return false;
  if (dir.isSymbolicLink() || !dir.isDirectory() || dir.uid !== owner) throw unsafe("the credentials directory is a link, not a plain directory, or belongs to another user");
  if (look(keyPath(stateDir)) === undefined) return false;
  unlinkSync(keyPath(stateDir));
  return true;
}

/**
 * The credentials of an `api_key` runner, read again at the start of each job. `credentials` is the object every part of the daemon holds; its key is
 * not an enumerable property, so a spread, a JSON dump or a log of the object shows only the mode. `refresh` leaves no key behind when it throws.
 */
export function perJobApiKey(stateDir: string, uid: number | undefined): { credentials: CredentialMode; refresh: () => void } {
  let current = "";
  const credentials = { mode: "api_key" as const } as CredentialMode;
  Object.defineProperty(credentials, "apiKey", { get: () => current, enumerable: false });
  return {
    credentials,
    refresh() {
      current = "";
      current = readApiKey(stateDir, uid);
    },
  };
}
