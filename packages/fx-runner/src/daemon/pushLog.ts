/**
 * The runner's own record of the pushes it made (D#519 MQ4-RUNNER-PUSH-LOG). One entry per successful push the daemon runs for a job:
 * the ref, the remote tip it checked just before (the zero id for a branch it created), the oid it pushed, when the push began, the
 * job, and the commit the run started from. It lets the runner tell its own commits on a pull request branch from a person's.
 *
 * It stays on this machine: nothing here is sent to the cloud, and no message carries it.
 *  - Only the daemon writes it. `publishBranch` appends after `runPush` returns; the `new` value is the oid the daemon fetched from its own
 *    snapshot, never text a job wrote. A person's own `git push` goes nowhere near this code, so it is never recorded as the runner's.
 *  - It lives in a 0700 directory below the runner's state directory, which the job sandbox lists as no-access (`protectedPaths`).
 *  - It is built as the job ledger is: a 0600 file replaced atomically, one holder at a time (the ledger's lock), and a damaged file is moved
 *    aside and the log CLOSED: it answers null ("unknown") until a valid file is back at the path.
 *  - It is bounded: an entry is forgotten after 96 hours (a job's life) and at most 5,000 are kept, oldest first out. Forgetting only ever makes
 *    a commit read as foreign, which is the safe way to be wrong.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { takeLock, type LedgerOptions } from "./ledger.js";

export const PUSH_LOG_FILE = "push-log/pushes.json";
export const PUSH_LOG_KEEP_MS = 96 * 60 * 60_000;
export const PUSH_LOG_MAX = 5_000;

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PushRecord {
  ref: string;
  old_sha: string;
  new_sha: string;
  started_at: string;
  job_id: string;
  /** The commit the run started from (its base). */
  start: string;
}

export interface PushLog {
  /** True while the file is damaged and not yet replaced by a valid one. */
  readonly closed: boolean;
  /** Appends one entry, or throws when it cannot be made durable (and then nothing is kept). */
  append(record: PushRecord): void;
  /** The entries still in their life, or null when the log is closed ("unknown"). */
  records(): readonly PushRecord[] | null;
  close(): void;
}

/** What `publishBranch` is given: the log bound to one job. */
export interface PushSink {
  record(entry: { ref: string; old: string; new: string; start: string; startedAt: Date }): void;
}

export const sinkFor = (log: PushLog, jobId: string): PushSink => ({
  record: (e) => log.append({ ref: e.ref, old_sha: e.old, new_sha: e.new, started_at: e.startedAt.toISOString(), job_id: jobId, start: e.start }),
});

/** The option `publishBranch` takes for a job: empty when there is no log or the job has no id. */
export const pushSinkOf = (log: PushLog | undefined, job: { job_id?: string }): { pushLog?: PushSink } => (log === undefined || job.job_id === undefined ? {} : { pushLog: sinkFor(log, job.job_id) });

const errnoOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;
const isRecord = (v: unknown): v is PushRecord => {
  const r = v as Record<string, unknown> | null;
  if (r === null || typeof r !== "object") return false;
  return typeof r.ref === "string" && /^refs\/heads\/[\x21-\x7e]{1,200}$/.test(r.ref) && typeof r.old_sha === "string" && OID.test(r.old_sha) && typeof r.new_sha === "string" && OID.test(r.new_sha) && typeof r.start === "string" && OID.test(r.start) &&
    typeof r.job_id === "string" && UUID.test(r.job_id) && typeof r.started_at === "string" && Number.isFinite(Date.parse(r.started_at));
};

export function createPushLog(file: string, options: LedgerOptions): PushLog {
  const now = options.now ?? ((): Date => new Date());
  const dir = path.dirname(file);
  const lock = `${file}.lock`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  takeLock(lock, options.pid, options.isAlive, now);
  let entries: PushRecord[] = [];
  let closed = false;
  let released = false;

  const quarantined = (): boolean => {
    try {
      return readdirSync(dir).some((name) => name.startsWith(`${path.basename(file)}.damaged-`));
    } catch {
      // fx-swallow-ok: a directory that cannot be listed cannot be told to hold no moved-aside log, so the log stays closed
      return true;
    }
  };
  const damaged = (): void => {
    closed = true;
    try {
      renameSync(file, `${file}.damaged-${now().getTime()}-${randomBytes(3).toString("hex")}`);
    } catch {
      // fx-swallow-ok: closed either way; a file that cannot be moved is reported by staying closed
    }
  };
  function load(): void {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      if (errnoOf(error) === "ENOENT") {
        closed = quarantined();
        entries = [];
        return;
      }
      // fx-swallow-ok: a file that cannot be read is a damaged log: moved aside, closed
      damaged();
      return;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed) || !parsed.every(isRecord)) return damaged();
      entries = parsed;
      closed = false;
    } catch {
      // fx-swallow-ok: text that is not JSON is a damaged log: moved aside, closed
      damaged();
    }
  }
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      if (readFileSync(lock, "utf8").trim() === String(options.pid)) unlinkSync(lock);
    } catch {
      // fx-swallow-ok: a lock that is gone or unreadable is not ours to remove
    }
  };
  try {
    load();
  } catch (error) {
    release();
    throw error;
  }
  const live = (list: readonly PushRecord[]): PushRecord[] => list.filter((r) => Date.parse(r.started_at) + PUSH_LOG_KEEP_MS > now().getTime()).slice(-PUSH_LOG_MAX);

  return {
    get closed() {
      return closed;
    },
    close: release,
    records() {
      if (released) return null;
      if (closed) load();
      return closed ? null : live(entries);
    },
    append(record) {
      if (released) throw new Error("push_log_closed");
      if (!isRecord(record)) throw new Error("push_log_record_invalid");
      if (closed) load();
      if (closed) throw new Error("push_log_closed");
      const kept = live([...entries, record]);
      const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
      let fd: number | undefined;
      try {
        fd = openSync(temp, "wx", 0o600);
        writeFileSync(fd, `${JSON.stringify(kept)}\n`);
        fsyncSync(fd);
        closeSync(fd);
        fd = undefined;
        renameSync(temp, file);
      } catch (error) {
        if (fd !== undefined) closeSync(fd);
        try {
          unlinkSync(temp);
        } catch {
          // fx-swallow-ok: the original failure is rethrown below
        }
        throw error;
      }
      entries = kept;
    },
  };
}
