/**
 * The bridge's upload loop: it takes batches from the tail, sends them in order, and moves the tail's cursor only past what the cloud has.
 *
 * - A batch is the tail's poll (at most 100 events), cut into requests of at most 256 KiB. Nothing is asked of the tail again until the whole batch is
 *   delivered, so a cloud that is down never makes the bridge read ahead, lose a line or send one twice: the same requests are tried again, and the cursor
 *   moves (`tail.ack`) only after the last one is accepted. An event the cloud already holds is dropped from a resend by its `last_accepted_seq`.
 * - The runner's own events (`bridge_dropped`, `bridge_heartbeat`) go in their own session, with an id made when the bridge starts and a `seq` that
 *   counts from 0 in it. They cannot share the engine's `seq` numbers: the cloud takes a session's `seq` in strict order, so a runner event placed between two
 *   engine events would make the cloud refuse the engine's next one. Drop notices are counted only once the tail's cursor has moved past the dropped lines.
 * - Waits are bounded: 2, 4, 8 ... 300 seconds after a failure to reach the cloud, 5 minutes while the cloud's switch is off, and the cloud's own wait (at
 *   most a day) when the day's quota is used. A request the cloud refuses for good (400, 413) is not worth a quick retry: it waits 300 seconds from the first
 *   failure, drops nothing, and `status` shows `backoff` with the closed word `refused`.
 * - `run` is a loop of its own and never awaited by the claim loop, so a job is claimed while the bridge waits.
 * Every log line is fixed text: no repo, event, address or key ever reaches one.
 */
import { randomUUID } from "node:crypto";
import { ENGINE_COUNT_MAX, ENGINE_EVENTS_BODY_MAX_BYTES, ENGINE_VERSION_PATTERN, EngineEvent, type EngineEventsMessage } from "@fulcrumaxe/runner-protocol";
import type { Clock } from "../daemon/lease.js";
import { MAX_WAIT_S, type RetryWhy, type SendOutcome } from "./upload.js";
import { emptyDrops, type DropReason, type DropCounts } from "./shape.js";
import type { EngineTail } from "./tail.js";

/** How often the tail's file is looked at. A local read, never a request: what is held back below is held here. */
export const FLUSH_MS = 2_000;
/**
 * The slim status: how long the runner may go without any accepted request before it sends `bridge_heartbeat`, and how long a batch of nothing but the engine's and
 * the host's own heartbeats may wait to go out (they are the same word, "alive", said by different parts): such a batch is sent when the status is due and then replaces it. Events of any other kind are never held this long.
 */
export const HEARTBEAT_MS = 300_000;
/** The most events a request carries (the tail's own cap). */
const ENGINE_BATCH_EVENTS = 100;
/** The kinds that only say "alive"; a batch of nothing else waits for `HEARTBEAT_MS` rather than the coalescing window. */
const SLIM_KINDS: ReadonlySet<string> = new Set(["engine_heartbeat", "host_heartbeat"]);
/**
 * How long events other than asks and halts may wait to be sent together, counted from the first one held. Nobody is watching the repo's detail by default
 * (the watch signal is a later row), so it is the long window; a watching reader gets `WATCHED_COALESCE_MS` through `coalesceMs`.
 */
export const UNWATCHED_COALESCE_MS = 60_000;
export const WATCHED_COALESCE_MS = 10_000;
/** Kinds that never wait: a decision the person is needed for, its clearing, and the halt's answer (the last is the runner's own and goes out through `reportHalt`). */
export const URGENT_KINDS: ReadonlySet<string> = new Set(["ask_raised", "ask_cleared", "halt_applied"]);
export const OFF_RETRY_S = 300;
/** How often the wake epoch is looked at while paused because the switch is off (the command puller's tick). A local read, never a request. */
export const OFF_WAKE_CHECK_MS = 1_000;
export const BACKOFF_START_S = 2;
export const BACKOFF_MAX_S = 300;
export const HALT_REPORTS_MAX = 20;

/** What `status` shows for a repo. */
export type BridgeState = "uploading" | "off" | "backoff" | "quota";
export interface BridgeStatus {
  state: BridgeState;
  lastAckedSeq: number | null;
  /** ISO time of the last request the cloud accepted; null before the first. */
  lastSuccessAt: string | null;
  /** Why the loop is in `backoff`, as a closed word; null in every other state. */
  reason: RetryWhy | null;
}

export type TailLike = Pick<EngineTail, "poll" | "ack" | "rewind">;

export interface BridgeLoopDeps {
  /** The engine's own events file. The first tail is the engine's: `status` shows its acked seq. */
  tail?: TailLike;
  /** More tails (the engine host's events file), each with its own cursor. Their events are merged into the one ordered stream of the repo. */
  tails?: readonly TailLike[];
  send: (message: EngineEventsMessage) => Promise<SendOutcome>;
  clock: Clock;
  repoGhId: number;
  /** The engine's own version, for its session. */
  engineVersion: string;
  /** This runner's version, for the bridge's own session (a dotted number). */
  bridgeVersion: string;
  /** Gets fixed text only. */
  log: (line: string) => void;
  newInstanceId?: () => string;
  /** The last seq the saved cursor holds as acked, for `status` before anything is sent. */
  lastAckedSeq?: number | null;
  /** The longest events other than asks may be held to go out together, in ms (default `UNWATCHED_COALESCE_MS`). A later row passes `WATCHED_COALESCE_MS` while someone watches. 0 sends everything at the next tick. */
  coalesceMs?: () => number;
  /**
   * The wake epoch the claim loop last saw (the same one the command puller watches); null before the first. While the cloud's switch is off, a change ends the pause
   * early and the next pass tries the upload, so ticking the repo in settings does not wait for the 5-minute retry. Not a request: it reads a number the runner already holds.
   */
  wakeEpoch?: () => number | null;
}

const REASONS: readonly DropReason[] = ["schema", "oversize", "redaction", "partial_line"];
type Session = EngineEventsMessage["session"];
interface Chunk {
  events: EngineEvent[];
}
interface TailAck {
  index: number;
  /** The last seq of this tail's events in the batch; null when it held only lines that were dropped or skipped. */
  seq: number | null;
}
interface EngineFlight {
  chunks: Chunk[];
  /** One ack per tail the batch took from, each moved only past its own events. */
  acks: TailAck[];
  drops: DropCounts;
  full: boolean;
}
const sizeOf = (event: unknown): number => Buffer.byteLength(JSON.stringify(event), "utf8");

/** Cuts `events` into requests that each fit the body cap, in order. The size is exact: the JSON of an events array is its items and the commas between them. */
export function splitBatch(session: Session, events: readonly EngineEvent[]): Chunk[] {
  const base = sizeOf({ session, events: [] });
  const chunks: Chunk[] = [];
  let current: EngineEvent[] = [];
  let bytes = base;
  for (const event of events) {
    const own = sizeOf(event);
    if (current.length > 0 && bytes + own + 1 > ENGINE_EVENTS_BODY_MAX_BYTES) {
      chunks.push({ events: current });
      current = [];
      bytes = base;
    }
    bytes += own + (current.length > 0 ? 1 : 0);
    current.push(event);
  }
  if (current.length > 0) chunks.push({ events: current });
  return chunks;
}

/**
 * Cuts `events` into requests: a request has one session, so the events are grouped by engine instance (in order of first appearance, each session in its own order),
 * then cut for size. That is one request per session plus size splits, however the sources' times interleave; the cloud keeps each session's seq apart, so the order
 * between sessions inside one upload means nothing to it.
 */
export function splitRuns(repoGhId: number, engineVersion: string, events: readonly EngineEvent[]): Chunk[] {
  const bySession = new Map<string, EngineEvent[]>();
  for (const event of events) {
    const list = bySession.get(event.engine_instance_id);
    if (list === undefined) bySession.set(event.engine_instance_id, [event]);
    else list.push(event);
  }
  const chunks: Chunk[] = [];
  for (const [instance, list] of bySession) chunks.push(...splitBatch({ engine_instance_id: instance, repo_gh_id: repoGhId, engine_version: engineVersion }, list));
  return chunks;
}

const countSessions = (events: readonly EngineEvent[]): number => new Set(events.map((e) => e.engine_instance_id)).size;

/**
 * Merges each source's events into one stream by the event's own time. Each source keeps its own order (only the heads are compared, so a source whose clock went back is
 * not reordered); when two heads have the same time the lower source index goes first, so the same input always gives the same output.
 */
export function mergeByTs(sources: readonly (readonly EngineEvent[])[]): Array<{ event: EngineEvent; src: number }> {
  const at = sources.map(() => 0);
  const out: Array<{ event: EngineEvent; src: number }> = [];
  const time = (event: EngineEvent): number => {
    const t = Date.parse(event.ts);
    return Number.isFinite(t) ? t : 0;
  };
  for (;;) {
    let best = -1;
    for (let i = 0; i < sources.length; i++) {
      const head = sources[i]![at[i]!];
      if (head === undefined) continue;
      if (best < 0 || time(head) < time(sources[best]![at[best]!]!)) best = i;
    }
    if (best < 0) return out;
    out.push({ event: sources[best]![at[best]!]!, src: best });
    at[best]!++;
  }
}

export class BridgeLoop {
  private readonly tails: readonly TailLike[];
  private state: BridgeState = "uploading";
  private failures = 0;
  private reason: RetryWhy | null = null;
  private holdUntil = 0;
  private lastSuccess: string | null = null;
  private lastAcked: number | null;
  private flight: EngineFlight | null = null;
  private pendingDrops: DropCounts = emptyDrops();
  private bridgeFlight: Chunk | null = null;
  /** When the cloud last accepted any request of this loop (the cloud's "heard"); null before the first. */
  private lastHeardAt: number | null = null;
  /** When the first event now held back was first seen, or when the first drop notice became owed; null when nothing waits. */
  private heldSince: number | null = null;
  private dropsSince: number | null = null;
  private bridgeSeq = 0;
  /** `halt_applied` reports waiting to go out in the bridge session (the kill path's answer); at most `HALT_REPORTS_MAX` are kept, the oldest dropped first. */
  private pendingHalts: Array<{ halt_epoch: number; method: "scope" | "group_only"; survivors: number }> = [];
  private readonly bridgeInstance: string;

  constructor(private readonly deps: BridgeLoopDeps) {
    // A version that is not a dotted number would make every request of the session a 400; refuse it before anything is read.
    if (!ENGINE_VERSION_PATTERN.test(deps.engineVersion)) throw new Error("engine-bridge: engineVersion is not a dotted number");
    if (!ENGINE_VERSION_PATTERN.test(deps.bridgeVersion)) throw new Error("engine-bridge: bridgeVersion is not a dotted number");
    this.tails = [...(deps.tail === undefined ? [] : [deps.tail]), ...(deps.tails ?? [])];
    if (this.tails.length === 0) throw new Error("engine-bridge: no tail");
    this.bridgeInstance = (deps.newInstanceId ?? randomUUID)();
    this.lastAcked = deps.lastAckedSeq ?? null;
  }

  status(): BridgeStatus {
    return { state: this.state, lastAckedSeq: this.lastAcked, lastSuccessAt: this.lastSuccess, reason: this.state === "backoff" ? this.reason : null };
  }

  /** Queues a `halt_applied` event for the bridge session. A survivors count that is not a whole number counts as 1, never 0. */
  reportHalt(report: { halt_epoch: number; method: "scope" | "group_only"; survivors: number }): void {
    const survivors = Number.isSafeInteger(report.survivors) && report.survivors >= 0 ? Math.min(report.survivors, ENGINE_COUNT_MAX) : 1;
    this.pendingHalts.push({ ...report, survivors });
    if (this.pendingHalts.length > HALT_REPORTS_MAX) this.pendingHalts.shift();
  }

  /** Runs until `signal` aborts. A pass that throws is one failure and a wait, never the end of the loop. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let wait: number;
      try {
        wait = await this.cycle();
      } catch {
        // fx-swallow-ok: the error text could hold a line of the engine's file; a fixed line is logged and the pass is tried again after a wait
        this.deps.log("engine-bridge: an upload pass failed; trying again later");
        this.rewindAll();
        this.flight = null;
        wait = this.fail();
      }
      if (wait > 0) await (this.state === "off" && this.deps.wakeEpoch !== undefined ? this.sleepOff(wait, signal) : this.deps.clock.sleep(wait, signal));
    }
  }

  /**
   * The 5-minute pause while the cloud's switch is off, in one-tick slices. A change in the wake epoch ends it at once (`holdUntil` is cleared so the next pass tries the
   * upload); with no wake the whole wait is slept, as before. A wake that finds the switch still off costs one upload attempt, answered "off", and a new 5 minutes.
   */
  private async sleepOff(waitMs: number, signal: AbortSignal): Promise<void> {
    const epochNow = (): number | null => {
      try {
        return this.deps.wakeEpoch!();
      } catch {
        // fx-swallow-ok: a wake source that throws is no wake; the full wait is slept
        return null;
      }
    };
    let baseline = epochNow();
    let left = waitMs;
    while (left > 0 && !signal.aborted) {
      const slice = Math.min(OFF_WAKE_CHECK_MS, left);
      await this.deps.clock.sleep(slice, signal);
      left -= slice;
      const current = epochNow();
      if (current === null) continue;
      if (baseline === null) {
        baseline = current;
        continue;
      }
      if (current !== baseline) {
        this.holdUntil = 0;
        return;
      }
    }
  }

  /**
   * One pass: finish or take a batch, send it, then the runner's own events. Resolves with how long to wait before the next pass (ms).
   * A batch of events that are not asks waits (up to `coalesceMs`) to go out with the ones that follow; every tick the tail is read again from its saved cursor,
   * so an ask or a halt that lands behind them is seen within one tick and sends the whole batch at once. A batch of 100 events or more than one request goes at once.
   */
  async cycle(): Promise<number> {
    const nowMs = this.deps.clock.now().getTime();
    if (nowMs < this.holdUntil) return this.holdUntil - nowMs;
    if (this.flight === null) {
      // Each tail is read from its own saved cursor; one that refuses its file (or has no file yet) adds nothing and never stops the others.
      const polls = this.tails.map((tail, index) => ({ tail, index, polled: tail.poll() }));
      // Every poll that read is acked (an idle one writes nothing): a tail wants an ack or a rewind before it is polled again.
      const reads = polls.filter((p) => p.polled.status === "ok");
      if (reads.length > 0) {
        const merged = mergeByTs(reads.map((p) => p.polled.events));
        let take = merged.map((m) => ({ event: m.event, tail: reads[m.src]!.index }));
        let events = take.map((t) => t.event);
        let used = reads;
        // A batch of nothing but "alive" from more than one session would be a request each, and two sessions each heard every 5 minutes do not fit the idle budget. The engine's
        // session (the first tail with events) is the one agents' liveness is read from, so it goes alone, every time it is due; the host's "alive" events wait for the next batch
        // that is not only "alive", and go on their own only when the engine has none or the host's poll is full (`more`). Chosen by source, never by time, so a clock that is
        // wrong in one file cannot starve the other.
        if (events.length > 0 && events.every((e) => SLIM_KINDS.has(e.kind)) && countSessions(events) > 1) {
          const first = reads.find((p) => p.polled.events.length > 0)!;
          if (!reads.some((p) => p.index !== first.index && p.polled.more)) {
            take = take.filter((t) => t.tail === first.index);
            used = reads.filter((p) => p.index === first.index || p.polled.events.length === 0);
            for (const p of reads) if (!used.includes(p)) p.tail.rewind();
            events = take.map((t) => t.event);
          }
        }
        const more = used.some((p) => p.polled.more);
        const chunks = splitRuns(this.deps.repoGhId, this.deps.engineVersion, events);
        // Two sessions are two requests however few the events: only a request cut for size makes a batch one that goes at once.
        if (this.shouldHold(events, more, chunks.length > countSessions(events) ? 2 : 1, nowMs)) {
          // Held: the next tick reads these lines (and any that follow) again from the saved cursors. Nothing is lost, nothing is acked, nothing is counted twice.
          this.rewindAll();
        } else {
          this.heldSince = null;
          const drops = emptyDrops();
          for (const p of used) for (const reason of REASONS) drops[reason] += p.polled.dropped[reason];
          this.flight = {
            chunks,
            acks: used.map((p) => ({ index: p.index, seq: p.polled.events.length > 0 ? p.polled.events[p.polled.events.length - 1]!.seq : null })),
            drops,
            full: used.some((p) => p.polled.more),
          };
        }
      }
    }
    const flight = this.flight;
    if (flight !== null) {
      while (flight.chunks.length > 0) {
        const chunk = flight.chunks[0]!;
        const wait = await this.deliver(chunk, { engine_instance_id: chunk.events[0]!.engine_instance_id, repo_gh_id: this.deps.repoGhId, engine_version: this.deps.engineVersion });
        if (wait !== null) return wait;
        flight.chunks.shift();
      }
      // Every request of the batch is stored: only now do the cursors move, each past its own events.
      try {
        for (const a of flight.acks) this.tails[a.index]!.ack(a.seq);
      } catch {
        // fx-swallow-ok: a cursor that cannot be saved is a failed pass; the batch is read again and the cloud drops the repeats by their seq
        this.deps.log("engine-bridge: the cursor could not be saved; trying again later");
        this.rewindAll();
        this.flight = null;
        return this.fail();
      }
      const own = flight.acks.find((a) => a.index === 0);
      if (own !== undefined && own.seq !== null) this.lastAcked = Math.max(this.lastAcked ?? -1, own.seq);
      for (const reason of REASONS) this.pendingDrops[reason] += flight.drops[reason];
      this.flight = null;
    }
    const bridgeWait = await this.sendOwn();
    if (bridgeWait !== null) return bridgeWait;
    return flight !== null && flight.full ? 0 : FLUSH_MS;
  }

  private rewindAll(): void {
    for (const tail of this.tails) tail.rewind();
  }

  /** Whether a poll's events wait for company. Only a batch that holds events, none of them an ask, that is not full and still fits one request, and whose window is open. */
  private shouldHold(events: readonly EngineEvent[], more: boolean, requests: number, nowMs: number): boolean {
    if (events.length === 0 || more || requests > 1 || events.length >= ENGINE_BATCH_EVENTS) return false;
    if (events.some((event) => URGENT_KINDS.has(event.kind))) return false;
    if (events.every((event) => SLIM_KINDS.has(event.kind))) {
      // Nothing but "alive": it goes out when the status is due, and then it is the status (the heartbeat after it is not due). Never later than that.
      return !this.statusDue(nowMs);
    }
    this.heldSince ??= nowMs;
    // A clock that went back is a window that has not elapsed, but never one that never ends: it is judged from now.
    if (nowMs < this.heldSince) this.heldSince = nowMs;
    return nowMs - this.heldSince < Math.max(0, this.deps.coalesceMs?.() ?? UNWATCHED_COALESCE_MS);
  }

  /** True when the cloud has heard nothing from this loop for `HEARTBEAT_MS` (or ever, or the clock went back). */
  private statusDue(nowMs: number): boolean {
    return this.lastHeardAt === null || nowMs < this.lastHeardAt || nowMs - this.lastHeardAt >= HEARTBEAT_MS;
  }

  /**
   * The runner's own events: a halt report at once; the notices of lines that were lost and the heartbeat when the heartbeat is due or the coalescing window has run
   * (the notices are not urgent, so they ride with the heartbeat). The heartbeat is due only when the cloud has heard nothing from this loop for `HEARTBEAT_MS`: an upload
   * of events is already a sign of life, and sending a heartbeat after one would only be a second request.
   */
  private async sendOwn(): Promise<number | null> {
    const nowMs = this.deps.clock.now().getTime();
    if (this.bridgeFlight === null) {
      const events: EngineEvent[] = [];
      const ts = this.deps.clock.now().toISOString();
      const own = (rest: Record<string, unknown>): EngineEvent => EngineEvent.parse({ v: 1, engine_instance_id: this.bridgeInstance, seq: this.bridgeSeq++, ts, ...rest });
      const owed = REASONS.some((reason) => this.pendingDrops[reason] > 0);
      if (owed) this.dropsSince ??= nowMs;
      const heartbeat = this.statusDue(nowMs);
      const noticesDue = owed && (heartbeat || this.pendingHalts.length > 0 || nowMs - this.dropsSince! >= Math.max(0, this.deps.coalesceMs?.() ?? UNWATCHED_COALESCE_MS));
      if (noticesDue) {
        for (const reason of REASONS) {
          if (this.pendingDrops[reason] > 0) events.push(own({ kind: "bridge_dropped", count: Math.min(this.pendingDrops[reason], ENGINE_COUNT_MAX), reason }));
        }
        this.pendingDrops = emptyDrops();
        this.dropsSince = null;
      }
      for (const halt of this.pendingHalts.splice(0)) events.push(own({ kind: "halt_applied", ...halt }));
      if (heartbeat) events.push(own({ kind: "bridge_heartbeat" }));
      if (events.length === 0) return null;
      this.bridgeFlight = { events };
    }
    const wait = await this.deliver(this.bridgeFlight, { engine_instance_id: this.bridgeInstance, repo_gh_id: this.deps.repoGhId, engine_version: this.deps.bridgeVersion });
    if (wait !== null) return wait;
    this.bridgeFlight = null;
    return null;
  }

  /** Sends `chunk` until the cloud holds all of it. Null when it does; else how long to wait (the chunk keeps what is still unsent). */
  private async deliver(chunk: Chunk, session: Session): Promise<number | null> {
    while (chunk.events.length > 0) {
      const outcome = await this.deps.send({ session, events: chunk.events });
      switch (outcome.kind) {
        case "accepted":
        case "conflict": {
          // Both say what the cloud holds. What it holds is not sent again; a batch it does not fully cover is sent on from where it stops.
          const rest = outcome.last === null ? chunk.events : chunk.events.filter((event) => event.seq > outcome.last!);
          if (rest.length === chunk.events.length) return this.fail("unexpected");
          chunk.events = rest;
          this.succeed();
          break;
        }
        case "off":
          return this.hold("off", OFF_RETRY_S);
        case "quota":
          return this.hold("quota", Math.min(outcome.waitS, MAX_WAIT_S));
        case "retry":
          return this.fail(outcome.why);
      }
    }
    return null;
  }

  private succeed(): void {
    if (this.state !== "uploading") this.deps.log("engine-bridge: uploads are going through again");
    this.state = "uploading";
    this.reason = null;
    this.failures = 0;
    this.holdUntil = 0;
    this.lastHeardAt = this.deps.clock.now().getTime();
    this.lastSuccess = this.deps.clock.now().toISOString();
  }

  private hold(state: "off" | "quota", seconds: number): number {
    if (this.state !== state) this.deps.log(state === "off" ? "engine-bridge: uploads are paused, the cloud's switch for this repo is off; trying again in 5 minutes" : "engine-bridge: uploads are paused, the cloud's daily event limit is used");
    this.state = state;
    this.reason = null;
    this.holdUntil = this.deps.clock.now().getTime() + seconds * 1000;
    return seconds * 1000;
  }

  /** A failure to get a batch through: wait 2, 4, 8 ... at most 300 seconds; a refusal for good (400, 413) waits 300 from the first. `why` is a closed word, the only thing kept of the cloud's answer. */
  private fail(why: RetryWhy = "unexpected"): number {
    if (this.state !== "backoff") this.deps.log("engine-bridge: the cloud did not take the events; trying again later");
    this.state = "backoff";
    this.reason = why;
    const seconds = why === "refused" ? BACKOFF_MAX_S : Math.min(BACKOFF_MAX_S, BACKOFF_START_S * 2 ** Math.min(this.failures, 10));
    this.failures += 1;
    this.holdUntil = this.deps.clock.now().getTime() + seconds * 1000;
    return seconds * 1000;
  }
}
