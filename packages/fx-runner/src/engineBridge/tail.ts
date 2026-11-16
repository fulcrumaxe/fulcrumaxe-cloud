/**
 * Reads engine-events.jsonl as an untrusted file and hands back validated, redacted events. The bridge only reads this file (and its `.1` after a
 * rotation) and its own cursor.
 *
 * One batch at a time: `poll()` reads from the working position and returns events; `ack(seq)` then moves the saved cursor to just past the acked event
 * (a crash before the ack re-reads the batch, a crash after it never does); `rewind()` goes back to the saved cursor to resend. Call `ack` or `rewind`
 * after every poll that read (`status: "ok"`), before the next `poll`: a second poll with a batch outstanding throws. `ack` writes the cursor and may throw
 * (a refused cursor file, an I/O error); it then changes nothing, the batch stays outstanding, and calling `ack` again (or `rewind`) is safe. An ack that
 * would not move the cursor writes nothing, so acking an idle poll is free. Drop and gap counts belong to one poll: after a `rewind` the re-read lines are counted again.
 *
 * A line is only parsed once its newline is there. A line that fails the schema, is over 64 KiB, or that redaction would change is counted and skipped.
 * Seq gaps are reported, never filled. A new `engine_instance_id` is a reset, not a gap. Nothing from a line is logged.
 */
import { closeSync, readSync } from "node:fs";
import type { EngineEvent } from "@fulcrumaxe/runner-protocol";
import { engineSeqOrderViolation } from "@fulcrumaxe/runner-protocol";
import { FileRefused, loadCursor, openPlain, saveCursor, type Cursor, type OpenObserver } from "./cursor.js";
import { emptyDrops, judgeLine, MAX_LINE_BYTES, type DropCounts } from "./shape.js";

export interface Gap {
  after_seq: number;
  next_seq: number;
  missing: number;
}
export interface PollResult {
  status: "ok" | "idle" | "refused";
  events: EngineEvent[];
  dropped: DropCounts;
  gaps: Gap[];
  /** The first event of this batch starts a new engine instance. */
  reset: boolean;
  /** The poll stopped at its event or line limit, so more may be waiting: poll again at once. */
  more: boolean;
}

export interface TailOptions {
  eventsPath: string;
  cursorPath: string;
  secrets: () => readonly string[];
  /** Gets fixed text only. */
  log: (line: string) => void;
  observe?: OpenObserver;
  maxEvents?: number;
  /** Most lines judged per poll (default 10,000), so a flood of tiny junk lines cannot hold the process for long. */
  maxLines?: number;
  /** The runner's user id (`process.getuid()`), given by the caller: a file of another user is refused. Undefined where the platform has none. */
  uid: number | undefined;
  /** Most bytes read from the file per poll; at least twice the line cap. */
  maxPollBytes?: number;
}

interface Pos {
  inode: number;
  offset: number;
}
interface Work extends Pos {
  instance: string | null;
  acked: number | null;
  lastSeen: number | null;
}
interface Poll {
  instance: string | null;
  start: Pos;
  end: Pos;
  marks: { seq: number; pos: Pos }[];
}
const NO_INODE = -1;

export class EngineTail {
  private committed: Cursor | null = null;
  private loaded = false;
  private work: Work = { instance: null, acked: null, lastSeen: null, inode: NO_INODE, offset: 0 };
  private discarding = false;
  private last: Poll | null = null;
  private lastRefusal: string | null = null;
  private readonly maxEvents: number;
  private readonly maxLines: number;
  private readonly maxPollBytes: number;

  constructor(private readonly opts: TailOptions) {
    this.maxEvents = Math.max(1, opts.maxEvents ?? 100);
    this.maxLines = Math.max(1, opts.maxLines ?? 10_000);
    this.maxPollBytes = Math.max(2 * MAX_LINE_BYTES, opts.maxPollBytes ?? 1024 * 1024);
  }

  /** Go back to the saved cursor, so the next poll re-reads whatever was not acked. */
  rewind(): void {
    this.work = this.committed === null ? { instance: null, acked: null, lastSeen: null, inode: NO_INODE, offset: 0 } : { instance: this.committed.engine_instance_id, acked: this.committed.last_acked_seq, lastSeen: this.committed.last_acked_seq, inode: this.committed.inode, offset: this.committed.offset };
    this.discarding = false;
    this.last = null;
  }

  /** The cloud accepted every event of the last poll up to `seq` (null: nothing was sent, only drops or skips to move past). */
  ack(seq: number | null): void {
    const poll = this.last;
    if (poll === null) return;
    const marks = poll.marks;
    // `null` says nothing was sent. With events in the poll that would move the cursor past them unsent, so it is refused (nothing changes).
    if (seq === null && marks.length > 0) throw new Error("engine-bridge: ack(null) while the poll holds events");
    let pos = poll.start;
    if (seq === null || marks.length === 0 || seq >= marks[marks.length - 1]!.seq) pos = poll.end;
    else for (const mark of marks) if (mark.seq <= seq) pos = mark.pos;
    const same = this.committed?.engine_instance_id === poll.instance;
    const acked = same ? (this.committed?.last_acked_seq ?? null) : null;
    const sent = Math.max(same ? (this.committed?.last_sent_seq ?? -1) : -1, marks.length > 0 ? marks[marks.length - 1]!.seq : -1);
    const next: Cursor = { engine_instance_id: poll.instance, inode: pos.inode, offset: pos.offset, last_sent_seq: sent < 0 ? null : sent, last_acked_seq: seq === null ? acked : Math.max(acked ?? -1, seq) };
    const c = this.committed;
    const unchanged = c !== null && c.engine_instance_id === next.engine_instance_id && c.inode === next.inode && c.offset === next.offset && c.last_sent_seq === next.last_sent_seq && c.last_acked_seq === next.last_acked_seq;
    if (!unchanged) saveCursor(this.opts.cursorPath, next, this.opts.observe, this.opts.uid);
    this.committed = next;
    if (this.work.instance === poll.instance) this.work.acked = next.last_acked_seq;
    this.last = null;
  }

  poll(): PollResult {
    if (this.last !== null) throw new Error("engine-bridge: poll() with a batch not yet acked or rewound");
    const result: PollResult = { status: "idle", events: [], dropped: emptyDrops(), gaps: [], reset: false, more: false };
    try {
      if (!this.loaded) {
        this.committed = loadCursor(this.opts.cursorPath, this.opts.observe, this.opts.uid);
        this.loaded = true;
        this.rewind();
      }
      const main = openPlain(this.opts.eventsPath, 0o022, this.opts.observe, this.opts.uid);
      if (main === null) return result;
      let rotated: ReturnType<typeof openPlain> = null;
      try {
        let source = main;
        let final = false;
        if (this.work.inode !== NO_INODE && this.work.inode !== main.stat.ino) {
          rotated = openPlain(`${this.opts.eventsPath}.1`, 0o022, this.opts.observe, this.opts.uid);
          if (rotated !== null && rotated.stat.ino === this.work.inode) {
            source = rotated;
            final = true;
          } else {
            // A rotation this bridge cannot follow: start the new file from 0 and skip what the cloud already has.
            this.work = { ...this.work, inode: main.stat.ino, offset: 0, lastSeen: this.work.acked };
            this.discarding = false;
          }
        } else if (this.work.inode === NO_INODE) {
          this.work = { ...this.work, inode: main.stat.ino, offset: 0 };
        } else if (main.stat.size < this.work.offset) {
          this.work = { ...this.work, offset: 0, lastSeen: this.work.acked };
          this.discarding = false;
        }
        this.scan(source.fd, source.stat.size, final, main.stat.ino, result);
      } finally {
        closeSync(main.fd);
        if (rotated !== null) closeSync(rotated.fd);
      }
      this.lastRefusal = null;
      result.status = "ok";
      return result;
    } catch (error) {
      if (!(error instanceof FileRefused)) throw error;
      // One fixed line per kind of refusal until the file is good again.
      if (this.lastRefusal !== error.reason) this.opts.log(`engine-bridge: a bridge file was refused (${error.reason}); nothing is read or sent`);
      this.lastRefusal = error.reason;
      return { ...result, status: "refused" };
    }
  }

  private scan(fd: number, size: number, final: boolean, mainInode: number, result: PollResult): void {
    const start = this.work.offset;
    const buf = Buffer.alloc(Math.min(Math.max(size - start, 0), this.maxPollBytes));
    let filled = 0;
    while (filled < buf.length) {
      const n = readSync(fd, buf, filled, buf.length - filled, start + filled);
      if (n === 0) break;
      filled += n;
    }
    const inode = this.work.inode;
    const events = result.events;
    let at = 0;
    if (this.discarding) {
      const nl = buf.subarray(0, filled).indexOf(10);
      at = nl < 0 ? filled : nl + 1;
      if (nl >= 0) this.discarding = false;
    }
    const poll: Poll = { instance: this.work.instance, start: { inode, offset: start }, end: { inode, offset: start }, marks: [] };
    let limited = false;
    let judged = 0;
    let sawNewline = true;
    while (at < filled) {
      const nl = buf.subarray(0, filled).indexOf(10, at);
      if (nl < 0) {
        sawNewline = false;
        break;
      }
      if (events.length >= this.maxEvents || judged >= this.maxLines) {
        limited = true;
        break;
      }
      const from = at;
      judged++;
      const len = nl - from;
      if (len > MAX_LINE_BYTES) result.dropped.oversize++;
      else if (len > 0) {
        const verdict = judgeLine(buf.subarray(from, nl), this.opts.secrets());
        if (!verdict.ok) result.dropped[verdict.reason]++;
        else {
          const event = verdict.event;
          if (this.work.instance === null) this.work.instance = event.engine_instance_id;
          else if (event.engine_instance_id !== this.work.instance) {
            if (events.length > 0) {
              limited = true;
              break;
            }
            this.work = { ...this.work, instance: event.engine_instance_id, acked: null, lastSeen: null };
            result.reset = true;
          }
          poll.instance = this.work.instance;
          if (this.work.acked !== null && event.seq <= this.work.acked) {
            // already delivered: skipped without a count
          } else if (this.work.lastSeen !== null && event.seq <= this.work.lastSeen) result.dropped.schema++;
          else {
            if (this.work.lastSeen !== null && event.seq > this.work.lastSeen + 1) result.gaps.push({ after_seq: this.work.lastSeen, next_seq: event.seq, missing: event.seq - this.work.lastSeen - 1 });
            events.push(event);
            this.work.lastSeen = event.seq;
            poll.marks.push({ seq: event.seq, pos: { inode, offset: start + nl + 1 } });
          }
        }
      }
      at = nl + 1;
    }
    if (!sawNewline && !limited) {
      const rest = filled - at;
      if (final && start + filled >= size && rest > 0) {
        result.dropped.partial_line++;
        at = filled;
      } else if (rest > MAX_LINE_BYTES) {
        result.dropped.oversize++;
        this.discarding = true;
        at = filled;
      }
    }
    result.more = limited;
    const done = final && !limited && start + at >= size;
    this.work.offset = start + at;
    if (done) {
      this.work = { ...this.work, inode: mainInode, offset: 0 };
      this.discarding = false;
    }
    poll.end = { inode: this.work.inode, offset: this.work.offset };
    if (engineSeqOrderViolation(events) !== null) throw new Error("engine-bridge: a batch was out of order");
    this.last = poll;
  }
}
