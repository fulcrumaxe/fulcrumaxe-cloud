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

export interface BridgeLoopDeps {
  tail: Pick<EngineTail, "poll" | "ack" | "rewind">;
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
}

const REASONS: readonly DropReason[] = ["schema", "oversize", "redaction", "partial_line"];
type Session = EngineEventsMessage["session"];
interface Chunk {
  events: EngineEvent[];
}
interface EngineFlight {
  chunks: Chunk[];
  /** The last engine seq of the batch; null when it held only lines that were dropped or skipped. */
  ackSeq: number | null;
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

export class BridgeLoop {
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
        this.deps.tail.rewind();
        this.flight = null;
        wait = this.fail();
      }
      if (wait > 0) await this.deps.clock.sleep(wait, signal);
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
      const polled = this.deps.tail.poll();
      // Every poll that read is acked (an idle one writes nothing): the tail wants an ack or a rewind before it is polled again.
      if (polled.status === "ok") {
        const first = polled.events[0];
        const session: Session | null = first === undefined ? null : { engine_instance_id: first.engine_instance_id, repo_gh_id: this.deps.repoGhId, engine_version: this.deps.engineVersion };
        const chunks = session === null ? [] : splitBatch(session, polled.events);
        if (this.shouldHold(polled.events, polled.more, chunks.length, nowMs)) {
          // Held: the next tick reads these lines (and any that follow) again from the saved cursor. Nothing is lost, nothing is acked, nothing is counted twice.
          this.deps.tail.rewind();
        } else {
          this.heldSince = null;
          this.flight = {
            chunks,
            ackSeq: polled.events.length > 0 ? polled.events[polled.events.length - 1]!.seq : null,
            drops: polled.dropped,
            full: polled.more,
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
      // Every request of the batch is stored: only now does the cursor move, and only past this batch.
      try {
        this.deps.tail.ack(flight.ackSeq);
      } catch {
        // fx-swallow-ok: a cursor that cannot be saved is a failed pass; the batch is read again and the cloud drops the repeats by their seq
        this.deps.log("engine-bridge: the cursor could not be saved; trying again later");
        this.deps.tail.rewind();
        this.flight = null;
        return this.fail();
      }
      if (flight.ackSeq !== null) this.lastAcked = Math.max(this.lastAcked ?? -1, flight.ackSeq);
      for (const reason of REASONS) this.pendingDrops[reason] += flight.drops[reason];
      this.flight = null;
    }
    const bridgeWait = await this.sendOwn();
    if (bridgeWait !== null) return bridgeWait;
    return flight !== null && flight.full ? 0 : FLUSH_MS;
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
