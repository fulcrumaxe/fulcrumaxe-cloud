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

  const loops = [heartbeats(), flushes()];

  return {
    signal: stopCtl.signal,
    ended: () => endedWith,
    push(event) {
      const parsed = LocalOnlyEvent.safeParse(event);
      if (!parsed.success) return;
      if (highest === undefined || parsed.data.seq > highest) highest = parsed.data.seq;
      seenTypes.add(parsed.data.type);
      queue.push(parsed.data);
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
 * Hands the engine's metadata events to whichever run holds the sandbox. The engine is built once with `emit` as its
 * `onLocalEvent`; the job handler attaches the current run's lease for the length of the run.
 */
export function createEventRelay(): { emit: (event: LocalOnlyEvent) => void; attach: (sink: (event: LocalOnlyEvent) => void) => () => void } {
  let current: ((event: LocalOnlyEvent) => void) | undefined;
  return {
    emit: (event) => current?.(event),
    attach(sink) {
      current = sink;
      return () => {
        if (current === sink) current = undefined;
      };
    },
  };
}
