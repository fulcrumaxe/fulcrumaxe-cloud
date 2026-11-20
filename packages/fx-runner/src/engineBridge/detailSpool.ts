/**
 * The detail spool (D#845 watch mode): the engine's on-demand events, kept on this machine until someone watches the repo.
 *
 * An on-demand event (`ENGINE_EVENT_CLASSES.on_demand`) never goes into the engine's own upload session. It is written here, under a session of its own (an instance id made once
 * and kept in the state file, and a `seq` that counts from 0 in it), and only a watch sends it: a catch-up when the watch starts, then every flush while it lasts. The cursor of the
 * engine's file moves past an event only after it is in this spool, so nothing is lost and nothing waits in the engine's file.
 *
 *  - Files: `<repo>.detail.jsonl` (one JSON line per event, 0600, appended) and `<repo>.detail.json` (the instance, the next seq and the highest seq already sent, 0600, written
 *    by temp file then rename). Both are opened with the cursor's own rules (`openPlain`): no link followed, a plain file, the runner's own, no open permissions.
 *    A pruned spool is written to a temp file and renamed over the old one.
 *  - Kept for 7 days or 64 MiB, whichever comes first (the oldest lines go first). The engine's own events file keeps its rotation.
 *  - Each line carries its origin (the file it came from, the engine's instance and `seq`), so a batch that was spooled but whose cursor move failed is not spooled twice.
 *  - A catch-up takes the newest events not yet sent, at most 24 h old, 2,000 of them, 1 MiB; whatever is older stays here ("Load older" asks for it with a `before` seq).
 * Nothing here logs a line's content, and a failure is a fixed `FileRefused` reason or an error the caller words itself.
 */
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, openSync, readdirSync, readSync, unlinkSync, writeSync } from "node:fs";
import path from "node:path";
import { EngineEvent } from "@fulcrumaxe/runner-protocol";
import { FileRefused, openPlain, saveTextAtomic, type OpenObserver } from "./cursor.js";

export const SPOOL_MAX_AGE_MS = 7 * 24 * 3_600_000;
export const SPOOL_MAX_BYTES = 64 * 1024 * 1024;
export const CATCHUP_MAX_AGE_MS = 24 * 3_600_000;
export const CATCHUP_MAX_EVENTS = 2_000;
export const CATCHUP_MAX_BYTES = 1_048_576;
/** A catch-up is at most this many requests (each at most 256 KiB and 100 events); what does not fit stays on the machine. */
export const CATCHUP_MAX_BATCHES = 4;
const AGE_PRUNE_EVERY_MS = 3_600_000;
const STATE_MAX_BYTES = 4096;
const READ_CHUNK = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Where a repo's spool and its state file live, under the runner's state directory. */
export const detailSpoolPaths = (runnerStateDir: string, repoGhId: number): { file: string; statePath: string } => ({
  file: path.join(runnerStateDir, "engine-bridge", `${repoGhId}.detail.jsonl`),
  statePath: path.join(runnerStateDir, "engine-bridge", `${repoGhId}.detail.json`),
});

/**
 * Removes a repo's spool and state file (a disconnect leaves nothing of the repo's detail on the machine). A name that is a link loses the link and nothing it points at; an absent file is fine.
 * Returns false when a file could not be removed.
 */
export function removeDetailSpool(runnerStateDir: string, repoGhId: number): boolean {
  let ok = true;
  for (const file of Object.values(detailSpoolPaths(runnerStateDir, repoGhId))) {
    try {
      unlinkSync(file);
    } catch (error) {
      // fx-swallow-ok: an absent file is already removed; any other failure is reported as false and its text could name a path
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") ok = false;
    }
  }
  return ok;
}

/** Removes the spool files of every repo that is not in `keep` (named `<repo id>.detail.jsonl` or `.detail.json` under the runner's `engine-bridge` directory; any other name is left alone). A name that is a link loses the link only. */
export function sweepDetailSpools(runnerStateDir: string, keep: ReadonlySet<number>, log: (line: string) => void): void {
  let names: string[];
  try {
    names = readdirSync(path.join(runnerStateDir, "engine-bridge"));
  } catch {
    // fx-swallow-ok: no directory (or an unreadable one) is nothing to sweep
    return;
  }
  const gone = new Set<number>();
  for (const name of names) {
    const m = name.match(/^([1-9][0-9]{0,15})\.detail\.(?:jsonl|json)$/);
    if (m !== null && Number.isSafeInteger(Number(m[1])) && !keep.has(Number(m[1]))) gone.add(Number(m[1]));
  }
  for (const id of gone) if (!removeDetailSpool(runnerStateDir, id)) log("engine-bridge: the detail spool of a repo that is no longer bridged could not be removed");
}

interface Entry {
  seq: number;
  tsMs: number;
  off: number;
  /** The line's length with its newline. */
  len: number;
  tail: number;
  /** For a plan snapshot chunk: which snapshot, and which chunk of how many (a whole snapshot is re-sent when a watch starts). */
  snap?: { id: string; i: number; n: number };
}
interface State {
  v: 1;
  instance: string;
  next_seq: number;
  /** The highest detail seq already sent (or deliberately left on the machine by a catch-up); null before any. */
  uploaded_through: number | null;
}
export interface SpoolOptions {
  /** The spool's lines. */
  file: string;
  /** The small state file next to it. */
  statePath: string;
  uid: number | undefined;
  now: () => number;
  newInstanceId?: () => string;
  observe?: OpenObserver;
  maxAgeMs?: number;
  maxBytes?: number;
}
export interface Selection {
  /** Oldest first, with the detail session's instance id and seq. */
  events: EngineEvent[];
  /** The highest detail seq the selection speaks for (what `markUploaded` takes once it is all sent). */
  through: number;
}

/**
 * The detail session's instance id: a random UUID whose version is 8. The cloud tells a detail session from the engine's by that digit (the engine's own ids are version 4), so it never
 * has to guess from the kinds an upload holds.
 */
export const newDetailInstanceId = (): string => {
  const id = randomUUID();
  return `${id.slice(0, 14)}8${id.slice(15)}`;
};

const snapOf = (e: EngineEvent): { snap?: { id: string; i: number; n: number } } => (e.kind === "plan_snapshot" ? { snap: { id: e.snapshot_id, i: e.chunk_index, n: e.chunk_count } } : {});
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function parseState(text: string): State | null {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    const keys = Object.keys(v).sort().join(",");
    if (keys !== "instance,next_seq,uploaded_through,v" || v.v !== 1 || typeof v.instance !== "string" || !UUID.test(v.instance) || !isCount(v.next_seq)) return null;
    if (!(v.uploaded_through === null || isCount(v.uploaded_through))) return null;
    return { v: 1, instance: v.instance.toLowerCase(), next_seq: v.next_seq, uploaded_through: v.uploaded_through as number | null };
  } catch {
    // fx-swallow-ok: a state file that is not JSON is as good as none (a new instance is made)
    return null;
  }
}

export class DetailSpool {
  private state: State | null = null;
  private index: Entry[] = [];
  private bytes = 0;
  /** The last origin spooled per source file: [engine instance, seq]. */
  private origin = new Map<number, { instance: string; seq: number }>();
  private lastAgePrune = Number.NEGATIVE_INFINITY;
  private loaded = false;
  private readonly maxAgeMs: number;
  private readonly maxBytes: number;

  constructor(private readonly opts: SpoolOptions) {
    this.maxAgeMs = opts.maxAgeMs ?? SPOOL_MAX_AGE_MS;
    this.maxBytes = opts.maxBytes ?? SPOOL_MAX_BYTES;
  }

  /** Reads the state and the spool once (and trims it). Throws `FileRefused` for an unsafe file. */
  private ensure(): State {
    if (this.loaded && this.state !== null) return this.state;
    const stateFile = openPlain(this.opts.statePath, 0o077, this.opts.observe, this.opts.uid);
    let state: State | null = null;
    if (stateFile !== null) {
      try {
        const buffer = Buffer.alloc(STATE_MAX_BYTES + 1);
        const n = readSync(stateFile.fd, buffer, 0, buffer.length, 0);
        state = n <= STATE_MAX_BYTES ? parseState(buffer.subarray(0, n).toString("utf8")) : null;
      } finally {
        closeSync(stateFile.fd);
      }
    }
    const fresh = state === null;
    this.state = state ?? { v: 1, instance: (this.opts.newInstanceId ?? newDetailInstanceId)().toLowerCase(), next_seq: 0, uploaded_through: null };
    this.scan();
    const top = this.index.length === 0 ? -1 : this.index[this.index.length - 1]!.seq;
    this.state.next_seq = Math.max(this.state.next_seq, top + 1);
    this.loaded = true;
    if (fresh) this.saveState();
    this.prune(true);
    return this.state;
  }

  /** Rebuilds the index from the file; a line that is not an event of this instance, a partial last line and an out-of-order seq are left out (and the file rewritten without them). */
  private scan(): void {
    this.index = [];
    this.bytes = 0;
    this.origin = new Map();
    const opened = openPlain(this.opts.file, 0o077, this.opts.observe, this.opts.uid);
    if (opened === null) return;
    let dirty = false;
    const keep: Buffer[] = [];
    try {
      let carry = Buffer.alloc(0);
      let pos = 0;
      for (;;) {
        const chunk = Buffer.alloc(READ_CHUNK);
        const n = readSync(opened.fd, chunk, 0, chunk.length, pos);
        if (n === 0) break;
        pos += n;
        carry = Buffer.concat([carry, chunk.subarray(0, n)]);
        let at = 0;
        for (;;) {
          const nl = carry.indexOf(10, at);
          if (nl < 0) break;
          const line = carry.subarray(at, nl);
          at = nl + 1;
          if (!this.take(line, keep)) dirty = true;
        }
        carry = carry.subarray(at);
      }
      if (carry.length > 0) dirty = true;
    } finally {
      closeSync(opened.fd);
    }
    if (dirty) this.rewrite(keep);
  }

  /** Judges one stored line; true when it is kept. `keep` collects the kept lines. */
  private take(line: Buffer, keep: Buffer[]): boolean {
    const entry = this.judge(line, this.bytes);
    if (entry === null) return false;
    this.index.push(entry);
    this.bytes += line.length + 1;
    keep.push(line);
    return true;
  }

  private judge(line: Buffer, off: number): Entry | null {
    try {
      const raw = JSON.parse(line.toString("utf8")) as { o?: unknown; e?: unknown };
      const o = raw.o;
      if (!Array.isArray(o) || o.length !== 3 || !isCount(o[0]) || typeof o[1] !== "string" || !isCount(o[2])) return null;
      const parsed = EngineEvent.safeParse(raw.e);
      if (!parsed.success || parsed.data.engine_instance_id.toLowerCase() !== this.state!.instance) return null;
      const last = this.index[this.index.length - 1];
      if (last !== undefined && parsed.data.seq <= last.seq) return null;
      const tsMs = Date.parse(parsed.data.ts);
      this.origin.set(o[0], { instance: o[1], seq: o[2] });
      return { seq: parsed.data.seq, tsMs: Number.isFinite(tsMs) ? tsMs : 0, off, len: line.length + 1, tail: o[0], ...snapOf(parsed.data) };
    } catch {
      // fx-swallow-ok: a line that does not parse is left out of the spool, and nothing of it is logged
      return null;
    }
  }

  /** Replaces the spool file with `lines` (temp file, then rename) and rebuilds the index over them. */
  private rewrite(lines: Buffer[]): void {
    const text = lines.length === 0 ? "" : `${lines.map((l) => l.toString("utf8")).join("\n")}\n`;
    saveTextAtomic(this.opts.file, text, this.opts.observe, this.opts.uid);
    this.index = [];
    this.bytes = 0;
    let off = 0;
    for (const line of lines) {
      const entry = this.judge(line, off);
      if (entry !== null) {
        this.index.push(entry);
        off += line.length + 1;
      }
    }
    this.bytes = off;
  }

  private saveState(): void {
    saveTextAtomic(this.opts.statePath, `${JSON.stringify(this.state)}\n`, this.opts.observe, this.opts.uid);
  }

  /** Reads the lines the index names, in index order. */
  private readLines(entries: readonly Entry[]): Buffer[] {
    const opened = openPlain(this.opts.file, 0o077, this.opts.observe, this.opts.uid);
    if (opened === null) return [];
    try {
      return entries.map((e) => {
        const buf = Buffer.alloc(e.len - 1);
        let filled = 0;
        while (filled < buf.length) {
          const n = readSync(opened.fd, buf, filled, buf.length - filled, e.off + filled);
          if (n === 0) break;
          filled += n;
        }
        return buf.subarray(0, filled);
      });
    } finally {
      closeSync(opened.fd);
    }
  }

  /** Drops the oldest lines: past `maxAgeMs`, and until the file is under 90% of `maxBytes` when it is over the cap. `force` also runs the age check now. */
  private prune(force = false): void {
    const now = this.opts.now();
    const ageDue = force || now - this.lastAgePrune >= AGE_PRUNE_EVERY_MS || now < this.lastAgePrune;
    let drop = 0;
    if (ageDue) {
      this.lastAgePrune = now;
      while (drop < this.index.length && now - this.index[drop]!.tsMs > this.maxAgeMs) drop++;
    }
    if (this.bytes > this.maxBytes) {
      let size = this.bytes;
      for (let i = 0; i < drop; i++) size -= this.index[i]!.len;
      while (drop < this.index.length && size > this.maxBytes * 0.9) size -= this.index[drop++]!.len;
    }
    if (drop === 0) return;
    const kept = this.readLines(this.index.slice(drop));
    const state = this.state!;
    // The seq counter never goes back, even when everything is pruned: a session's seq only grows.
    state.next_seq = Math.max(state.next_seq, (this.index[this.index.length - 1]?.seq ?? -1) + 1);
    this.rewrite(kept);
    this.saveState();
  }

  /** The detail session's instance id. Throws `FileRefused` when a spool file is unsafe. */
  instance(): string {
    return this.ensure().instance;
  }

  /** The highest seq in the session so far (spooled), or -1 when none. */
  highSeq(): number {
    this.ensure();
    return this.state!.next_seq - 1;
  }

  /** The highest seq already sent, or -1. */
  uploadedThrough(): number {
    return this.ensure().uploaded_through ?? -1;
  }

  /** True when events were spooled that no upload has covered. */
  hasPending(): boolean {
    return this.highSeq() > this.uploadedThrough();
  }

  /** Lines held now (a test and status reads this). */
  size(): { events: number; bytes: number } {
    this.ensure();
    return { events: this.index.length, bytes: this.bytes };
  }

  /**
   * Spools `items` (oldest first), each as `[source file index, the event as the engine wrote it]`. An item whose origin is not past the last spooled from that source is skipped
   * (it was spooled before and its cursor move failed). Returns how many were written. Written and flushed before it returns: the caller moves the engine's cursor only after.
   */
  append(items: ReadonlyArray<{ tail: number; event: EngineEvent }>): number {
    const state = this.ensure();
    const lines: string[] = [];
    const added: Entry[] = [];
    let off = this.bytes;
    let seq = state.next_seq;
    const origin = new Map(this.origin);
    for (const { tail, event } of items) {
      const seen = origin.get(tail);
      if (seen !== undefined && seen.instance === event.engine_instance_id && event.seq <= seen.seq) continue;
      const stored = { ...event, engine_instance_id: state.instance, seq } as EngineEvent;
      const line = `${JSON.stringify({ o: [tail, event.engine_instance_id, event.seq], e: stored })}\n`;
      const tsMs = Date.parse(event.ts);
      lines.push(line);
      added.push({ seq, tsMs: Number.isFinite(tsMs) ? tsMs : 0, off, len: Buffer.byteLength(line, "utf8"), tail, ...snapOf(event) });
      origin.set(tail, { instance: event.engine_instance_id, seq: event.seq });
      off += Buffer.byteLength(line, "utf8");
      seq++;
    }
    if (lines.length === 0) return 0;
    const fd = this.openAppend();
    try {
      writeSync(fd, lines.join(""));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.index.push(...added);
    this.bytes = off;
    this.origin = origin;
    state.next_seq = seq;
    this.prune();
    return lines.length;
  }

  /** Opens the spool for appending with no link followed, judging the open handle (a plain file of the runner's own, no open permissions). */
  private openAppend(): number {
    this.opts.observe?.(this.opts.file);
    let fd: number;
    try {
      fd = openSync(this.opts.file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new FileRefused(code === "ELOOP" ? "link" : "unreadable");
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new FileRefused("not_plain");
      if (this.opts.uid !== undefined && stat.uid !== this.opts.uid) throw new FileRefused("foreign_owner");
      if ((stat.mode & 0o077) !== 0) throw new FileRefused("open_permissions");
      return fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  private eventsOf(entries: readonly Entry[]): EngineEvent[] {
    const out: EngineEvent[] = [];
    for (const line of this.readLines(entries)) {
      try {
        const parsed = EngineEvent.safeParse((JSON.parse(line.toString("utf8")) as { e?: unknown }).e);
        if (parsed.success) out.push(parsed.data);
      } catch {
        // fx-swallow-ok: a line that cannot be read now is left out of this upload; nothing of it is logged
      }
    }
    return out;
  }

  /** The newest of `candidates` (walked newest first) within the age, count and size limits, oldest first. */
  private window(candidates: readonly Entry[], anchorMs: number): Entry[] {
    const picked: Entry[] = [];
    let bytes = 0;
    for (let i = candidates.length - 1; i >= 0; i--) {
      const e = candidates[i]!;
      if (picked.length >= CATCHUP_MAX_EVENTS || bytes + e.len > CATCHUP_MAX_BYTES) break;
      // Too old is skipped, not the end: a re-sent plan chunk is the newest by seq and can be the oldest by time.
      if (anchorMs - e.tsMs > CATCHUP_MAX_AGE_MS) continue;
      picked.push(e);
      bytes += e.len;
    }
    return picked.reverse();
  }

  /**
   * The catch-up: the newest events not yet sent, within 24 h of now, 2,000 events and 1 MiB. Null when nothing is pending. Older pending events are not in it, and `through` covers
   * them, so they stay on the machine until a reader asks for them with a `before` seq.
   */
  selectPending(): Selection | null {
    const state = this.ensure();
    const from = state.uploaded_through ?? -1;
    const candidates = this.index.filter((e) => e.seq > from);
    if (candidates.length === 0) return null;
    const picked = this.window(candidates, this.opts.now());
    return { events: this.eventsOf(picked), through: candidates[candidates.length - 1]!.seq };
  }

  /** Events older than `before` (a detail seq), the newest of them first within the limits (24 h counted back from the newest of them), oldest first. Null when there are none. */
  selectOlder(before: number): Selection | null {
    this.ensure();
    const candidates = this.index.filter((e) => e.seq < before);
    if (candidates.length === 0) return null;
    const newest = candidates[candidates.length - 1]!;
    const picked = this.window(candidates, newest.tsMs);
    return { events: this.eventsOf(picked), through: newest.seq };
  }

  /**
   * The latest COMPLETE plan snapshot (every chunk of the newest snapshot id that has all of them), as copies under NEW seqs, oldest chunk first. Whatever its age or whether it was sent before: a watcher
   * must always be able to see the plan, and a cloud keeps each seq once, so only a new seq is a new send. The copies are NOT written to the spool (a plan can be 6 MiB, and every watch start would add
   * it again): the seqs are taken from the session's counter and the counter is saved, so a seq is never used twice. A crash before they are sent only costs the next watch start the same work.
   * Null when no snapshot is complete.
   */
  planCopies(): EngineEvent[] | null {
    const state = this.ensure();
    const bySnap = new Map<string, Map<number, Entry>>();
    for (const e of this.index) {
      if (e.snap === undefined) continue;
      const chunks = bySnap.get(e.snap.id) ?? new Map<number, Entry>();
      chunks.set(e.snap.i, e);
      bySnap.set(e.snap.id, chunks);
    }
    let best: Entry[] | null = null;
    for (const chunks of bySnap.values()) {
      const any = [...chunks.values()][0]!;
      const all = Array.from({ length: any.snap!.n }, (_, i) => chunks.get(i));
      if (all.some((c) => c === undefined || c.snap!.n !== any.snap!.n)) continue;
      const entries = all as Entry[];
      if (best === null || Math.max(...entries.map((c) => c.seq)) > Math.max(...best.map((c) => c.seq))) best = entries;
    }
    if (best === null) return null;
    const originals = this.eventsOf(best);
    if (originals.length !== best.length) return null;
    const first = state.next_seq;
    state.next_seq = first + originals.length;
    this.saveState();
    return originals.map((event, i) => ({ ...event, seq: first + i }) as EngineEvent);
  }

  /** The cloud holds everything up to `seq`: it is not sent again. */
  markUploaded(seq: number): void {
    const state = this.ensure();
    if (state.uploaded_through !== null && seq <= state.uploaded_through) return;
    state.uploaded_through = seq;
    this.saveState();
  }
}
