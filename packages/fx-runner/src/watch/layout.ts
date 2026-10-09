/**
 * Where the tmux watch keeps its files (D#6 R4a-7), all under the runner's state directory, which the agent's sandbox can neither read nor
 * write (`sandboxSettings`' deny lists hold it whole). `tmux/` holds the socket; `watch/` holds one small record per running job and the
 * take-over request. Run ids name files, so every function that builds a path checks the id's shape first.
 */
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What one read of a log returns at most. */
const READ_CHUNK = 256 * 1024;

export const isRunId = (value: string): boolean => RUN_ID.test(value);
export const shortId = (runId: string): string => runId.slice(0, 8).toLowerCase();
export const sessionName = (runId: string): string => `fx-${shortId(runId)}`;
export const tmuxDir = (stateDir: string): string => path.join(stateDir, "tmux");
export const socketPath = (stateDir: string): string => path.join(tmuxDir(stateDir), "s");
const watchDir = (stateDir: string): string => path.join(stateDir, "watch");

function checkedId(runId: string): string {
  if (!RUN_ID.test(runId)) throw new TypeError("not a run id");
  return runId.toLowerCase();
}

/** A directory only this user can enter: made 0700 if missing, and refused if it is a link or not a directory. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory()) throw new Error("not a directory");
  if ((stat.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

/** The socket is a real socket in a private directory, reachable by its owner alone. A socket anyone else could open is never attached to. */
export function socketIsPrivate(stateDir: string, uid?: number): boolean {
  try {
    const dir = lstatSync(tmuxDir(stateDir));
    const sock = lstatSync(socketPath(stateDir));
    return dir.isDirectory() && (dir.mode & 0o077) === 0 && sock.isSocket() && (sock.mode & 0o077) === 0 && (uid === undefined || (dir.uid === uid && sock.uid === uid));
  } catch {
    // fx-swallow-ok: no directory or no socket means there is nothing to attach to
    return false;
  }
}

/** What the daemon records of a running job. Ids and names only. */
export interface WatchEntry {
  run_id: string;
  role: string;
  repo: string;
  started: string;
  /** Set when the job was handed over to the person: the entry is then not listed as a running job, and `__takeover` reads its role from it. */
  taken_over?: true;
}

const entryFile = (stateDir: string, runId: string): string => path.join(watchDir(stateDir), `${checkedId(runId)}.json`);
const requestFile = (stateDir: string, runId: string): string => path.join(watchDir(stateDir), `${checkedId(runId)}.takeover`);

export function writeEntry(stateDir: string, entry: WatchEntry): void {
  ensurePrivateDir(watchDir(stateDir));
  writeFileSync(entryFile(stateDir, entry.run_id), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

export function removeEntry(stateDir: string, runId: string): void {
  rmSync(entryFile(stateDir, runId), { force: true });
}

/** Removes the take-over request file (the daemon, for a job nobody took over; `attach`, once it has seen `ready`). */
export function clearTakeover(stateDir: string, runId: string): void {
  rmSync(requestFile(stateDir, runId), { force: true });
}

function parseEntry(text: string): WatchEntry | undefined {
  try {
    const value = JSON.parse(text) as Partial<Record<keyof WatchEntry, unknown>>;
    if (typeof value.run_id === "string" && RUN_ID.test(value.run_id) && typeof value.role === "string" && typeof value.repo === "string" && typeof value.started === "string") {
      return { run_id: value.run_id.toLowerCase(), role: value.role, repo: value.repo, started: value.started, ...(value.taken_over === true ? { taken_over: true as const } : {}) };
    }
  } catch {
    // fx-swallow-ok: a damaged record is a job that is not listed
  }
  return undefined;
}

export function readEntry(stateDir: string, runId: string): WatchEntry | undefined {
  try {
    return parseEntry(readFileSync(entryFile(stateDir, runId), "utf8"));
  } catch {
    // fx-swallow-ok: no record, no running job
    return undefined;
  }
}

/** Every recorded job, oldest first. */
export function readEntries(stateDir: string): WatchEntry[] {
  let names: string[];
  try {
    names = readdirSync(watchDir(stateDir));
  } catch {
    // fx-swallow-ok: no directory yet means nothing has run
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => {
      const entry = readEntry(stateDir, name.slice(0, -".json".length));
      return entry === undefined ? [] : [entry];
    })
    .sort((a, b) => a.started.localeCompare(b.started));
}

export type TakeoverState = "none" | "requested" | "ready";

/** The take-over request: `requested` by `attach`, `ready` once the daemon has stopped the agent, recorded it and swapped the pane. */
export function takeoverState(stateDir: string, runId: string): TakeoverState {
  try {
    return readFileSync(requestFile(stateDir, runId), "utf8").trim() === "ready" ? "ready" : "requested";
  } catch {
    // fx-swallow-ok: no file is no request
    return "none";
  }
}

/** Asks for a take-over. False when one is already asked for (the file is created exclusively). */
export function requestTakeover(stateDir: string, runId: string): boolean {
  ensurePrivateDir(watchDir(stateDir));
  try {
    writeFileSync(requestFile(stateDir, runId), "requested\n", { flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export function markTakeoverReady(stateDir: string, runId: string): void {
  writeFileSync(requestFile(stateDir, runId), "ready\n", { mode: 0o600 });
}

/** The longest log line the engine writes (`stream.ts`'s cap), plus its JSON wrapper. */
export const MAX_LOG_LINE_BYTES = 4 * 1024 * 1024 + 4096;
const SKIPPED_MARKER = `${JSON.stringify({ kind: "stderr", line: "[a log line over 4 MiB was skipped]" })}\n`;

/**
 * Up to `READ_CHUNK` bytes of the file, starting at byte `offset`, cut at the last whole line, and the offset to read from next. A line longer
 * than the chunk grows the read, up to `maxLine`; a line past that is skipped with a visible marker, so the offset always advances when
 * the file holds a whole line or more than `maxLine` bytes of one. A missing file reads as empty; a partial last line waits.
 */
export function readLogFrom(file: string, offset: number, maxLine: number = MAX_LOG_LINE_BYTES): { text: string; next: number } {
  if (!existsSync(file)) return { text: "", next: offset };
  const size = statSync(file).size;
  if (size <= offset) return { text: "", next: offset };
  const fd = openSync(file, "r");
  try {
    for (let want = READ_CHUNK; ; want = Math.min(want * 4, maxLine)) {
      const buffer = Buffer.alloc(Math.min(size - offset, want));
      readSync(fd, buffer, 0, buffer.length, offset);
      const cut = buffer.lastIndexOf(0x0a);
      if (cut !== -1) return { text: buffer.subarray(0, cut + 1).toString("utf8"), next: offset + cut + 1 };
      if (buffer.length >= size - offset && buffer.length < maxLine) return { text: "", next: offset };
      if (buffer.length >= maxLine) return { text: SKIPPED_MARKER, next: offset + buffer.length };
    }
  } finally {
    closeSync(fd);
  }
}
