/**
 * The runner's side of the engine inbox: the directory the engine reads its commands from, and the small state file that keeps a command from being applied twice.
 *
 * - `engine-inbox/` and `engine-inbox/done/` are 0700 and never a link. A directory that is a link, belongs to someone else or is open to the group or others is
 *   refused (`InboxRefused`), and nothing is written. Directories are judged by `lstat`, files by the handle they were opened with.
 * - A command is written to `engine-inbox/<seq>-<command_id>.json` (0600) through a temp file and a rename, so the engine sees all of it or none of it.
 * - The engine moves a command it has dealt with into `done/` and writes `done/<seq>-<command_id>.outcome.json`, exactly the body of an ack
 *   (`{outcome:"applied"}` or `{outcome:"refused", refusal}`). The runner reads it, acks it, and renames it to `...acked.json`, so it is acked once.
 * - `engine-commands-state.json` (0600) holds, per repo, the highest command_seq handed to the engine, and the ids seen in the last 24 hours.
 * Every message is fixed text: no path, command or id reaches one.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { ENGINE_COMMAND_MAX_LIFE_S, EngineCommandAck, type EngineCommand } from "@fulcrumaxe/runner-protocol";

export const INBOX_DIR = "engine-inbox";
export const DONE_DIR = "done";
export const STATE_FILE = "engine-commands-state.json";
/** How long past `expires_at` the engine has to consume a command before it is acked `not_confirmed`. */
export const NOT_CONFIRMED_AFTER_MS = 10 * 60_000;
/** How long a command id is remembered. */
export const SEEN_TTL_MS = 24 * 60 * 60_000;
const FILE_MAX_BYTES = 64 * 1024;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const NAME = new RegExp(`^([1-9][0-9]{0,15})-(${UUID})\\.json$`, "i");
const OUTCOME = new RegExp(`^([1-9][0-9]{0,15}-${UUID})\\.outcome\\.json$`, "i");

export type InboxRefusal = "link" | "not_directory" | "foreign_owner" | "open_permissions" | "unreadable";
export class InboxRefused extends Error {
  constructor(readonly reason: InboxRefusal) {
    super(`engine-inbox: refused (${reason})`);
  }
}

export interface InboxState {
  /** Highest command_seq handed to the engine, by repo_gh_id. */
  repos: Record<string, number>;
  /** command_id -> ms the id was seen. */
  seen: Record<string, number>;
}
export interface Consumed {
  /** `<seq>-<command_id>`, the file's name without its suffix. */
  name: string;
  commandId: string;
  ack: EngineCommandAck;
}
export interface Waiting {
  name: string;
  commandId: string;
  /** From the file's own `expires_at`; null when the file cannot be read (it is then judged by `mtimeMs`). */
  expiresMs: number | null;
  /** When the file was last changed, in ms. */
  mtimeMs: number;
}

/**
 * The moment (ms) a command still waiting in the inbox is acked `not_confirmed`. The engine can write the file, so nothing in it or about it may hold the
 * command open: the clock is the time the runner recorded when it wrote the command (`seenAtMs`, from the state file) plus the longest command life plus
 * 10 minutes, and the file's own `expires_at` (plus the same 10 minutes) can only bring that earlier. The file's mtime is used only for an id the runner has no
 * record of (and even then it is capped by `expires_at`).
 */
export function notConfirmedDueMs(waiting: Pick<Waiting, "expiresMs" | "mtimeMs">, seenAtMs: number | undefined): number {
  const start = seenAtMs ?? waiting.mtimeMs;
  return Math.min(start + ENGINE_COMMAND_MAX_LIFE_S * 1000, waiting.expiresMs ?? Number.POSITIVE_INFINITY) + NOT_CONFIRMED_AFTER_MS;
}

export class Inbox {
  constructor(
    private readonly stateDir: string,
    private readonly uid: number | undefined,
  ) {}

  private get dir(): string {
    return path.join(this.stateDir, INBOX_DIR);
  }
  private get done(): string {
    return path.join(this.dir, DONE_DIR);
  }

  /** Makes the two directories when missing and refuses unsafe ones. Throws InboxRefused; writes nothing when it does. */
  ensure(): void {
    for (const dir of [this.stateDir, this.dir, this.done]) {
      if (lstatSync(dir, { throwIfNoEntry: false }) === undefined) {
        try {
          mkdirSync(dir, { mode: 0o700 });
        } catch {
          // fx-swallow-ok: a directory that cannot be made is one fixed refusal
          throw new InboxRefused("unreadable");
        }
      }
      const st = lstatSync(dir);
      if (st.isSymbolicLink()) throw new InboxRefused("link");
      if (!st.isDirectory()) throw new InboxRefused("not_directory");
      if (this.uid !== undefined && st.uid !== this.uid) throw new InboxRefused("foreign_owner");
      if ((st.mode & 0o077) !== 0) throw new InboxRefused("open_permissions");
    }
  }

  private readJson(file: string): unknown {
    let fd: number;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      // fx-swallow-ok: a missing file or a link is "no file"; the caller treats both the same way
      return undefined;
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || (this.uid !== undefined && st.uid !== this.uid) || (st.mode & 0o077) !== 0 || st.size > FILE_MAX_BYTES) return undefined;
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

  private writeJson(target: string, value: unknown): void {
    const temp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeSync(fd, `${JSON.stringify(value)}\n`);
      fsyncSync(fd);
      closeSync(fd);
      renameSync(temp, target);
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {
        // fx-swallow-ok: the temp file is already gone
      }
      throw error;
    }
  }

  loadState(nowMs: number): InboxState {
    const raw = this.readJson(path.join(this.stateDir, STATE_FILE)) as { repos?: unknown; seen?: unknown } | undefined;
    const state: InboxState = { repos: {}, seen: {} };
    const num = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
    if (typeof raw?.repos === "object" && raw.repos !== null) for (const [k, v] of Object.entries(raw.repos)) if (/^[1-9][0-9]{0,15}$/.test(k) && num(v)) state.repos[k] = v;
    if (typeof raw?.seen === "object" && raw.seen !== null) for (const [k, v] of Object.entries(raw.seen)) if (new RegExp(`^${UUID}$`, "i").test(k) && num(v) && nowMs - v < SEEN_TTL_MS) state.seen[k.toLowerCase()] = v;
    return state;
  }

  saveState(state: InboxState): void {
    this.writeJson(path.join(this.stateDir, STATE_FILE), { v: 1, ...state });
  }

  /** Writes a verified command for the engine (temp file, then rename) and returns its name. */
  write(command: EngineCommand): string {
    this.ensure();
    const name = `${command.command_seq}-${command.command_id.toLowerCase()}`;
    this.writeJson(path.join(this.dir, `${name}.json`), command);
    return name;
  }

  /** Commands the engine has not yet moved out of the inbox. */
  waiting(): Waiting[] {
    this.ensure();
    const out: Waiting[] = [];
    for (const entry of readdirSync(this.dir)) {
      const m = entry.match(NAME);
      if (m === null) continue;
      const file = path.join(this.dir, entry);
      const st = lstatSync(file, { throwIfNoEntry: false });
      if (st === undefined) continue;
      const body = this.readJson(file) as { expires_at?: unknown } | undefined;
      const expiresMs = typeof body?.expires_at === "string" ? Date.parse(body.expires_at) : Number.NaN;
      out.push({ name: entry.slice(0, -5), commandId: m[2]!, expiresMs: Number.isFinite(expiresMs) ? expiresMs : null, mtimeMs: st.mtimeMs });
    }
    return out;
  }

  /** Outcomes the engine wrote that have not been acked. A file that is not exactly an ack body is left alone (the command is then acked `not_confirmed`). */
  consumed(): Consumed[] {
    this.ensure();
    const out: Consumed[] = [];
    for (const entry of readdirSync(this.done)) {
      const m = entry.match(OUTCOME);
      if (m === null) continue;
      const ack = EngineCommandAck.safeParse(this.readJson(path.join(this.done, entry)));
      if (ack.success) out.push({ name: m[1]!, commandId: m[1]!.slice(m[1]!.indexOf("-") + 1), ack: ack.data });
    }
    return out;
  }

  /** After a settled ack: the outcome file becomes `.acked.json`, and a command still in the inbox moves to `done/`. */
  settle(name: string, ack: EngineCommandAck): void {
    this.ensure();
    const own = (file: string): string => path.join(this.done, file);
    try {
      renameSync(path.join(this.dir, `${name}.json`), own(`${name}.json`));
    } catch {
      // fx-swallow-ok: the engine moved it already
    }
    this.writeJson(own(`${name}.acked.json`), ack);
    try {
      unlinkSync(own(`${name}.outcome.json`));
    } catch {
      // fx-swallow-ok: there was no outcome file (a not_confirmed settle)
    }
  }
}
