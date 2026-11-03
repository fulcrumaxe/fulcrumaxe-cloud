/**
 * D#597 CC-7a-1: the assistant's delegation token file, `<state dir>/assistant/token`: a plain 0600 file in a 0700 directory owned by the runner's
 * user, never a link (credentials.ts's rules: lstat, a no-follow open judged by the open handle). Only the runner reads it. Messages are fixed text.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, unlinkSync, writeSync, type Stats } from "node:fs";
import path from "node:path";
import { CliError } from "../cliError.js";

export const ASSISTANT_DIR = "assistant";
export const TOKEN_FILE = "token";
const TOKEN_FILE_MAX_BYTES = 4096;

export type AssistantProblem = "assistant_token_missing" | "assistant_token_unsafe" | "assistant_relink" | "assistant_tool_refused" | "assistant_link_failed" | "assistant_link_expired";

const TEXT: Readonly<Record<AssistantProblem, string>> = {
  assistant_token_missing: "no assistant token is stored on this machine; run: fx-runner assistant link",
  assistant_token_unsafe: "the assistant token file or a directory above it is not safe to use; run: fx-runner assistant link to replace it",
  assistant_relink: "the assistant token is expired or was revoked; run: fx-runner assistant link",
  assistant_tool_refused: "that tool is not available to the assistant",
  assistant_link_failed: "the cloud did not complete the link; run: fx-runner assistant link again",
  assistant_link_expired: "the link code expired before it was approved; run: fx-runner assistant link again",
};

/** The message is `<code>: <fixed text>`; it never holds the token. */
export class AssistantError extends CliError {
  readonly code: AssistantProblem;
  constructor(code: AssistantProblem, reason?: string) {
    super(`${code}: ${reason ?? TEXT[code]}`);
    this.code = code;
  }
}

const unsafe = (reason: string): AssistantError => new AssistantError("assistant_token_unsafe", `${reason}; run: fx-runner assistant link to replace the token`);

export interface StoredToken {
  token: string;
  /** The cloud's id for the token, which `assistant unlink` revokes it by. */
  token_id: string;
  expires_at: string;
  repo_id: string;
  client_id: string;
  origin: string;
}

const tokenPath = (stateDir: string): string => path.join(stateDir, ASSISTANT_DIR, TOKEN_FILE);

/** `lstat` of a path, or undefined when it is not there. */
function look(target: string): Stats | undefined {
  try {
    return lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw unsafe("a path cannot be read");
  }
}

/** A plain directory (not a link) owned by `uid`; `closed` also refuses group and world access. */
function checkDir(dir: string, label: string, uid: number, closed: boolean): void {
  const info = look(dir);
  if (info === undefined) throw new AssistantError("assistant_token_missing");
  if (info.isSymbolicLink() || !info.isDirectory()) throw unsafe(`the ${label} is a link or not a plain directory`);
  if (info.uid !== uid) throw unsafe(`the ${label} belongs to another user`);
  if ((info.mode & (closed ? 0o077 : 0o022)) !== 0) throw unsafe(`the ${label} can be ${closed ? "used" : "written"} by other users`);
}

function checkFile(info: Stats, uid: number): void {
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1) throw unsafe("the token file is a link or not a plain file");
  if (info.uid !== uid) throw unsafe("the token file belongs to another user");
  if ((info.mode & 0o077) !== 0) throw unsafe("the token file can be read by other users");
}

function parse(text: string): StoredToken {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // fx-swallow-ok: a file that is not JSON is the same refusal as any other damage; the parser's words could quote the token
    throw unsafe("the token file is damaged");
  }
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const keys = ["token", "token_id", "expires_at", "repo_id", "client_id", "origin"];
  if (Object.keys(v).length !== keys.length || keys.some((k) => typeof v[k] !== "string" || v[k] === "") || Number.isNaN(Date.parse(v.expires_at as string))) throw unsafe("the token file is damaged");
  return v as unknown as StoredToken;
}

/** The stored token. Throws `AssistantError`: missing (nothing there) or unsafe (link, owner, mode, damage). */
export function readAssistantToken(stateDir: string, uid: number | undefined): StoredToken {
  if (uid === undefined) throw unsafe("cannot tell which user this runs as");
  checkDir(stateDir, "state directory", uid, false);
  checkDir(path.join(stateDir, ASSISTANT_DIR), "assistant directory", uid, true);
  const file = tokenPath(stateDir);
  const before = look(file);
  if (before === undefined) throw new AssistantError("assistant_token_missing");
  checkFile(before, uid);
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    // fx-swallow-ok: a link (ELOOP) or a file that cannot be opened is the same refusal; the system's text could hold a path
    throw unsafe("the token file cannot be opened");
  }
  try {
    const info = fstatSync(fd);
    // The file that was checked is the file that is read: a swap between the two is refused.
    if (info.ino !== before.ino || info.dev !== before.dev) throw unsafe("the token file changed while it was being read");
    checkFile(info, uid);
    const buffer = Buffer.alloc(TOKEN_FILE_MAX_BYTES + 1);
    let filled = 0;
    for (;;) {
      const n = readSync(fd, buffer, filled, buffer.length - filled, null);
      if (n === 0) break;
      filled += n;
      if (filled === buffer.length) throw unsafe("the token file is too large");
    }
    return parse(buffer.subarray(0, filled).toString("utf8"));
  } finally {
    closeSync(fd);
  }
}

/** Stores the token through an exclusive 0600 temporary file and a rename (a link in its place is replaced, never followed). */
export function writeAssistantToken(stateDir: string, uid: number | undefined, stored: StoredToken): void {
  if (uid === undefined) throw unsafe("cannot tell which user this runs as");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  checkDir(stateDir, "state directory", uid, false);
  const dir = path.join(stateDir, ASSISTANT_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  checkDir(dir, "assistant directory", uid, true);
  const target = tokenPath(stateDir);
  const temp = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeSync(fd, JSON.stringify(stored));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** The state directory must be a plain 0700 directory of this user before anything is made under it. */
export function assertStateDirSafe(stateDir: string, uid: number | undefined): void {
  if (uid === undefined) throw unsafe("cannot tell which user this runs as");
  checkDir(stateDir, "state directory", uid, true);
}

/** Deletes the token file (a link in its place is removed as a link, never followed). True when there was one. Safe to repeat. */
export function removeAssistantToken(stateDir: string, uid: number | undefined): boolean {
  if (uid === undefined) throw unsafe("cannot tell which user this runs as");
  const dir = look(path.join(stateDir, ASSISTANT_DIR));
  if (dir === undefined) return false;
  if (dir.isSymbolicLink() || !dir.isDirectory() || dir.uid !== uid) throw unsafe("the assistant directory is a link, not a plain directory, or belongs to another user");
  if (look(tokenPath(stateDir)) === undefined) return false;
  unlinkSync(tokenPath(stateDir));
  return true;
}
