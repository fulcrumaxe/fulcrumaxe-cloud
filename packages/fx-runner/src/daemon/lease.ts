/**
 * Holding a run: a heartbeat every 30 seconds, and the run's metadata events sent in batches. The cloud ends the hold with
 * 409 `{continue:false, reason}` on either route; the lease then aborts its `signal`, which stops the job. If the cloud
 * cannot be reached for a whole lease (90 seconds) the hold is lost the same way. `seq_not_increasing` is not a stop: the
 * events at or below `last_accepted_seq` are dropped and the rest are sent again.
 */
import { MAX_EVENTS_PER_BATCH, RUNNER_LEASE_SECONDS, LocalOnlyEvent, type StopReason } from "@fulcrumaxe/runner-protocol";
import type { RunnerClient } from "./client.js";

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const EVENT_FLUSH_INTERVAL_MS = 5_000;
/** While an event that carries an `activity` or a `stage` waits, the queue is sent after this long instead of `EVENT_FLUSH_INTERVAL_MS` (D#6 C42-2). */
export const ACTIVITY_FLUSH_INTERVAL_MS = 2_000;
/** Activity-bearing events per run; later tool uses go out without their `activity`. */
export const MAX_ACTIVITY_EVENTS = 400;
/** Tool uses within this long of the first of a burst (by their own `ts`) keep one `activity`: the newest. */
export const ACTIVITY_WINDOW_MS = 250;
/** Events kept for sending; past this the oldest are dropped (they are display metadata, and memory is bounded). */
export const MAX_QUEUED_EVENTS = 5_000;
/** Resends after `seq_not_increasing` in one flush. */
const MAX_RESYNCS = 3;

export interface Clock {
  now(): Date;
  /** Resolves after `ms`, or as soon as `signal` aborts. Never rejects. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const realClock: Clock = {
  now: () => new Date(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const finish = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      signal.addEventListener("abort", finish, { once: true });
    }),
};

export type LeaseEnd = { kind: "stopped"; reason: StopReason } | { kind: "lost" };

export interface Lease {
  /** Aborts when the cloud says stop or the hold is lost. */
  readonly signal: AbortSignal;
  ended(): LeaseEnd | undefined;
  /** Queues one event for the cloud. An event the protocol does not accept is dropped. */
  push(event: LocalOnlyEvent): void;
  /** The highest `seq` queued so far, whether or not it was sent or later dropped from a full queue; undefined before the first event. */
  highestSeq(): number | undefined;
  /** Whether an event of this type has been queued. */
  saw(type: LocalOnlyEvent["type"]): boolean;
  /** How many events are queued and not yet accepted. */
  pending(): number;
  /** Sends what is queued. */
  flush(): Promise<void>;
  /** The cloud answered a call outside this loop (done) with a stop. */
  end(end: LeaseEnd): void;
  /**
   * Stops both loops. Sends nothing more. It waits for a send that is under way, unless `abandon` is set: then it returns at once
   * and the send is left to finish or time out on its own (the daemon is shutting down and has given its last report its time).
   */
  close(options?: { abandon?: boolean }): Promise<void>;
}

export interface LeaseConfig {
  client: Pick<RunnerClient, "heartbeat" | "events">;
  clock: Clock;
  runId: string;
  leaseGeneration: number;
  heartbeatMs?: number;
  flushMs?: number;
  activityFlushMs?: number;
}

export function startLease(config: LeaseConfig): Lease {
  const { client, clock, runId, leaseGeneration } = config;
  const stopCtl = new AbortController();
  const closeCtl = new AbortController();
  const loopSignal = AbortSignal.any([stopCtl.signal, closeCtl.signal]);
  let endedWith: LeaseEnd | undefined;
  let lastOk = clock.now().getTime();
  let queue: LocalOnlyEvent[] = [];
  let sending: Promise<void> = Promise.resolve();
  let highest: number | undefined;
  const seenTypes = new Set<LocalOnlyEvent["type"]>();
  const stagesSent = new Set<string>();
  let activityKept = 0;
  let burst: { anchor: number; event: LocalOnlyEvent } | undefined;
  let soonArmed = false;

  const end = (how: LeaseEnd): void => {
    if (endedWith !== undefined) return;
    endedWith = how;
    stopCtl.abort();
  };
  const ok = (): void => {
    lastOk = clock.now().getTime();
  };
  /** A call that did not get an answer: the hold is lost when the revoked key is refused, or when a whole lease has gone by without a good reply. */
  const failed = (status: number): void => {
    if (status === 401 || clock.now().getTime() - lastOk >= RUNNER_LEASE_SECONDS * 1000) end({ kind: "lost" });
  };

  async function drain(): Promise<void> {
    let resyncs = 0;
    while (queue.length > 0 && endedWith === undefined) {
      const batch = queue.slice(0, MAX_EVENTS_PER_BATCH);
      const reply = await client.events(runId, leaseGeneration, batch);
      if (reply.kind === "ok") {
        ok();
        queue = queue.slice(batch.length);
      } else if (reply.kind === "stop") {
        queue = [];
        end({ kind: "stopped", reason: reply.reason });
      } else if (reply.kind === "seq_not_increasing") {
        // The cloud has these already (a batch resent after a lost reply): keep only what is newer, then carry on.
        queue = queue.filter((event) => event.seq > reply.lastAcceptedSeq);
        if (++resyncs > MAX_RESYNCS) return;
      } else {
        failed(reply.status);
        return;
      }
    }
  }

  const flush = (): Promise<void> => {
    sending = sending.then(drain, drain);
    return sending;
  };

  async function heartbeats(): Promise<void> {
    for (;;) {
      await clock.sleep(config.heartbeatMs ?? HEARTBEAT_INTERVAL_MS, loopSignal);
      if (loopSignal.aborted) return;
      const reply = await client.heartbeat(runId, leaseGeneration);
      if (reply.kind === "ok") ok();
      else if (reply.kind === "stop") end({ kind: "stopped", reason: reply.reason });
      else failed(reply.status);
    }
  }

  async function flushes(): Promise<void> {
    for (;;) {
      await clock.sleep(config.flushMs ?? EVENT_FLUSH_INTERVAL_MS, loopSignal);
      if (loopSignal.aborted) return;
      await flush();
    }
  }

  const loops: Array<Promise<void>> = [heartbeats(), flushes()];

  /** Arms the short flush once while an activity or stage event waits; the regular 5 s loop covers everything else. */
  async function soon(): Promise<void> {
    await clock.sleep(config.activityFlushMs ?? ACTIVITY_FLUSH_INTERVAL_MS, loopSignal);
    soonArmed = false;
    if (!loopSignal.aborted) await flush();
  }

  /** The event as it will be queued: a repeat stage is dropped, a burst keeps its newest `activity`, and the run's cap strips the rest. */
  function shaped(event: LocalOnlyEvent): LocalOnlyEvent | undefined {
    if (event.type === "stage") {
      if (event.stage === undefined || stagesSent.has(event.stage)) return undefined;
      stagesSent.add(event.stage);
      return event;
    }
    if (event.activity === undefined) return event;
    const at = Date.parse(event.ts);
    if (burst !== undefined && Math.abs(at - burst.anchor) < ACTIVITY_WINDOW_MS) {
      // The older event of the burst is still waiting: it goes out as a bare tool use, and this one carries the burst's activity.
      const index = queue.indexOf(burst.event);
      if (index >= 0) {
        const { activity: _older, ...bare } = burst.event;
        void _older;
        queue[index] = bare;
        activityKept--;
      }
    } else burst = undefined;
    if (activityKept >= MAX_ACTIVITY_EVENTS) {
      const { activity: _over, ...bare } = event;
      void _over;
      return bare;
    }
    activityKept++;
    burst = { anchor: burst?.anchor ?? at, event };
    return event;
  }

  return {
    signal: stopCtl.signal,
    ended: () => endedWith,
    push(event) {
      const parsed = LocalOnlyEvent.safeParse(event);
      if (!parsed.success) return;
      if (highest === undefined || parsed.data.seq > highest) highest = parsed.data.seq;
      seenTypes.add(parsed.data.type);
      const shown = shaped(parsed.data);
      if (shown === undefined) return;
      queue.push(shown);
      if ((shown.type === "stage" || shown.activity !== undefined) && !soonArmed) {
        soonArmed = true;
        loops.push(soon());
      }
      if (queue.length > MAX_QUEUED_EVENTS) queue = queue.slice(queue.length - MAX_QUEUED_EVENTS);
    },
    highestSeq: () => highest,
    saw: (type) => seenTypes.has(type),
    pending: () => queue.length,
    flush,
    end,
    async close(options) {
      closeCtl.abort();
      if (options?.abandon === true) return;
      await Promise.all(loops);
      await sending.catch(() => undefined);
    },
  };
}

/**
 * Hands each job's engine metadata events to the run that produced them. Jobs can run at the same time and share this one relay, so an
 * event is always addressed to a run id: it goes to that run's sink and to no other. The engine for a job is built with an `onLocalEvent`
 * bound to that job's run id; the job handler attaches the run's lease for the length of the run. An event for a run with no sink (not
 * attached yet, or already detached) is dropped and counted; it is never handed to a different run, which could belong to another repo or tenant.
 */
export interface EventRelay {
  emit(runId: string, event: LocalOnlyEvent): void;
  attach(runId: string, sink: (event: LocalOnlyEvent) => void): () => void;
  /** How many events were addressed to a run with no sink. */
  dropped(): number;
}

export function createEventRelay(): EventRelay {
  const sinks = new Map<string, (event: LocalOnlyEvent) => void>();
  let dropped = 0;
  return {
    emit(runId, event) {
      const sink = sinks.get(runId);
      if (sink === undefined) dropped++;
      else sink(event);
    },
    attach(runId, sink) {
      sinks.set(runId, sink);
      return () => {
        if (sinks.get(runId) === sink) sinks.delete(runId);
      };
    },
    dropped: () => dropped,
  };
}
