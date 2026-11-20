/**
 * The bridge's cursor, and the one way it opens any file. The cursor is a 0600 file written by temp file then rename; every read refuses a link, a FIFO,
 * a device, a file of another user and one with open permissions. Messages are fixed text.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync, type Stats } from "node:fs";
import path from "node:path";

export type FileRefusal = "link" | "not_plain" | "foreign_owner" | "open_permissions" | "unreadable";
export class FileRefused extends Error {
  constructor(readonly reason: FileRefusal) {
    super(`engine-bridge: a file was refused (${reason})`);
  }
}

/** Called with every path the bridge opens; the L1 test records them. */
export type OpenObserver = (file: string) => void;


/** Opens `file` for reading with no link followed (`uid` is the runner's user id, given by the caller; undefined where the platform has none), and judges the open handle (not a path). Null when the file is absent. */
export function openPlain(file: string, forbiddenMode: number, observe: OpenObserver | undefined, uid: number | undefined): { fd: number; stat: Stats } | null {
  observe?.(file);
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw new FileRefused(code === "ELOOP" ? "link" : "unreadable");
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new FileRefused("not_plain");
    if (uid !== undefined && stat.uid !== uid) throw new FileRefused("foreign_owner");
    if ((stat.mode & forbiddenMode) !== 0) throw new FileRefused("open_permissions");
    return { fd, stat };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

/** True when `file` is there as a plain file the bridge would read (no link followed, same owner rules as the tail); false when absent or refused. Reads nothing. */
export function plainFileExists(file: string, uid: number | undefined): boolean {
  try {
    const opened = openPlain(file, 0o022, undefined, uid);
    if (opened === null) return false;
    closeSync(opened.fd);
    return true;
  } catch {
    // fx-swallow-ok: a refused file is one the bridge will not read either, so it counts as not there
    return false;
  }
}

export interface Cursor {
  engine_instance_id: string | null;
  inode: number;
  offset: number;
  last_sent_seq: number | null;
  last_acked_seq: number | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isCountOrNull = (value: unknown): value is number | null => value === null || isCount(value);
const CURSOR_KEYS = ["engine_instance_id", "inode", "offset", "last_sent_seq", "last_acked_seq"];

/** The cursor in `value`, or null when it is not exactly the five fields with their types. */
export function parseCursor(value: unknown): Cursor | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  if (keys.length !== CURSOR_KEYS.length || !CURSOR_KEYS.every((key) => keys.includes(key))) return null;
  if (!(v.engine_instance_id === null || (typeof v.engine_instance_id === "string" && UUID.test(v.engine_instance_id)))) return null;
  if (!isCount(v.inode) || !isCount(v.offset) || !isCountOrNull(v.last_sent_seq) || !isCountOrNull(v.last_acked_seq)) return null;
  return { engine_instance_id: v.engine_instance_id, inode: v.inode, offset: v.offset, last_sent_seq: v.last_sent_seq, last_acked_seq: v.last_acked_seq };
}

const CURSOR_MAX_BYTES = 4096;

/** The saved cursor; null when none is saved or the file is damaged (the bridge then re-reads from 0). Throws FileRefused on an unsafe file. */
export function loadCursor(file: string, observe: OpenObserver | undefined, uid: number | undefined): Cursor | null {
  const opened = openPlain(file, 0o077, observe, uid);
  if (opened === null) return null;
  try {
    const buffer = Buffer.alloc(CURSOR_MAX_BYTES + 1);
    let filled = 0;
    for (;;) {
      const n = readSync(opened.fd, buffer, filled, buffer.length - filled, null);
      if (n === 0) break;
      filled += n;
      if (filled === buffer.length) return null;
    }
    return parseCursor(JSON.parse(buffer.subarray(0, filled).toString("utf8")));
  } catch {
    // fx-swallow-ok: a cursor that is not JSON is as good as no cursor
    return null;
  } finally {
    closeSync(opened.fd);
  }
}

/**
 * Writes `text` to `file` atomically: a new 0600 file, flushed, renamed over the old one. A link, FIFO, device or file of another user at the path is refused before anything is written.
 * The cursor and the detail spool's own state go through here, so both keep one set of refusal rules.
 */
export function saveTextAtomic(file: string, text: string, observe: OpenObserver | undefined, uid: number | undefined): void {
  const existing = openPlain(file, 0o077, observe, uid);
  if (existing !== null) closeSync(existing.fd);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  observe?.(temp);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let open = true;
  try {
    writeSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    open = false;
    renameSync(temp, file);
  } catch (error) {
    if (open) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      // fx-swallow-ok: the temp file is already gone
    }
    throw error;
  }
}

/** Writes the cursor atomically: a new 0600 file, flushed, renamed over the old one. A link at the cursor path is refused before anything is written. */
export function saveCursor(file: string, cursor: Cursor, observe: OpenObserver | undefined, uid: number | undefined): void {
  saveTextAtomic(file, `${JSON.stringify(cursor)}\n`, observe, uid);
}
