import { describe, expect, it } from "vitest";
import { MAX_EVENTS_PER_BATCH, type LocalOnlyEvent } from "@fulcrumaxe/runner-protocol";
import type { EventsResult, HeartbeatResult, RunnerClient } from "../../src/daemon/client.js";
import { MAX_QUEUED_EVENTS, createEventRelay, startLease } from "../../src/daemon/lease.js";
import { manualClock, until } from "../helpers/manualClock.js";

const RUN = "11111111-1111-4111-8111-111111111111";
const ok = { kind: "ok" as const, leaseExpiresAt: "2026-10-08T12:01:30.000Z" };
const accepted = (n: number): EventsResult => ({ kind: "ok", accepted: n, duplicates: 0, leaseExpiresAt: ok.leaseExpiresAt });
const event = (seq: number): LocalOnlyEvent => ({ seq, ts: "2026-10-08T12:00:00.000Z", type: "tool_use", tool_name: "Read" });

/** A client whose replies the test scripts; it records every call. */
function scripted(over: { heartbeat?: () => HeartbeatResult; events?: (events: readonly LocalOnlyEvent[]) => EventsResult } = {}) {
  const calls = { heartbeat: [] as Array<[string, number]>, events: [] as Array<readonly number[]> };
  const client: Pick<RunnerClient, "heartbeat" | "events"> = {
    async heartbeat(runId, gen) {
      calls.heartbeat.push([runId, gen]);
      return (over.heartbeat ?? (() => ok))();
    },
    async events(_runId, _gen, events) {
      calls.events.push(events.map((e) => e.seq));
      return (over.events ?? ((batch) => accepted(batch.length)))(events);
    },
  };
  return { client, calls };
}

describe("heartbeat", () => {
  it("beats every 30 seconds with the run and the claimed generation, and not before", async () => {
    const clock = manualClock();
    const { client, calls } = scripted();
    const lease = startLease({ client, clock, runId: RUN, leaseGeneration: 4 });
    await clock.advance(29_000);
    expect(calls.heartbeat).toEqual([]);
    await clock.advance(1_000);
    expect(calls.heartbeat).toEqual([[RUN, 4]]);
    await clock.advance(60_000);
    expect(calls.heartbeat).toHaveLength(3);
    expect(lease.ended()).toBeUndefined();
    await lease.close();
  });

  it("a stop reply ends the hold at once: the signal aborts with the reason and no more beats go out", async () => {
    const clock = manualClock();
    const { client, calls } = scripted({ heartbeat: () => ({ kind: "stop", reason: "lease_expired" }) });
    const lease = startLease({ client, clock, runId: RUN, leaseGeneration: 1 });
    await clock.advance(30_000);
    expect(lease.signal.aborted).toBe(true);
    expect(lease.ended()).toEqual({ kind: "stopped", reason: "lease_expired" });
    await clock.advance(120_000);
    expect(calls.heartbeat).toHaveLength(1);
    await lease.close();
  });

  it("failed beats are survived until a whole lease (90 seconds) has gone by without a good reply, then the hold is lost", async () => {
    const clock = manualClock();
    const { client } = scripted({ heartbeat: () => ({ kind: "error", status: 0 }) });
    const lease = startLease({ client, clock, runId: RUN, leaseGeneration: 1 });
    await clock.advance(60_000);
    expect(lease.ended()).toBeUndefined();
    await clock.advance(30_000);
    expect(lease.ended()).toEqual({ kind: "lost" });
    expect(lease.signal.aborted).toBe(true);
    await lease.close();
  });

  it("a good beat in between restarts that count", async () => {
    const clock = manualClock();
    let n = 0;
    const { client } = scripted({ heartbeat: () => (++n === 2 ? ok : { kind: "error", status: 503 }) });
    const lease = startLease({ client, clock, runId: RUN, leaseGeneration: 1 });
    await clock.advance(120_000); // the beat at 60 s was good; the ones at 90 and 120 s failed, 60 s after it
    expect(lease.ended()).toBeUndefined();
    await clock.advance(30_000); // 90 s after the good beat
    expect(lease.ended()).toEqual({ kind: "lost" });
    await lease.close();
  });

  it("a 401 (the runner is revoked) loses the hold at the first beat", async () => {
    const clock = manualClock();
    const { client } = scripted({ heartbeat: () => ({ kind: "error", status: 401, code: "unauthorized" }) });
    const lease = startLease({ client, clock, runId: RUN, leaseGeneration: 1 });
    await clock.advance(30_000);
    expect(lease.ended()).toEqual({ kind: "lost" });
    await lease.close();
  });

  it("close stops both loops: nothing is sent afterwards", async () => {
    const clock = manualClock();
    const { client, calls } = scripted();
    const lease = startLease({ client, clock, runId: RUN, leaseGeneration: 1 });
    await lease.close();
    lease.push(event(0));
    await clock.advance(120_000);
    expect(calls.heartbeat).toEqual([]);
    expect(calls.events).toEqual([]);
  });
});

describe("events", () => {
  it("queued events go out on the flush interval, in order, and only once", async () => {
    const clock = manualClock();
    const { client, calls } = scripted();
    const lease = startLease({ client, clock, runId: RUN, leaseGeneration: 1 });
    lease.push(event(0));
    lease.push(event(1));
    await clock.advance(5_000);
    expect(calls.events).toEqual([[0, 1]]);
    await clock.advance(10_000);
    expect(calls.events).toEqual([[0, 1]]);
    await lease.close();
  });

  it("more than a batch is sent as several batches of at most 100", async () => {
    const clock = manualClock();
    const { client, calls } = scripted();
    const lease = startLease({ client, clock, runId: RUN, leaseGeneration: 1 });
    for (let i = 0; i < 250; i++) lease.push(event(i));
    await lease.flush();
    expect(calls.events.map((batch) => batch.length)).toEqual([MAX_EVENTS_PER_BATCH, MAX_EVENTS_PER_BATCH, 50]);
    await lease.close();
  });

  it("seq_not_increasing: what the cloud has is dropped and the rest is sent again, in order", async () => {
    const clock = manualClock();
    let first = true;
    const { client, calls } = scripted({
      events: (batch) => {
        if (first) {
          first = false;
          return { kind: "seq_not_increasing", lastAcceptedSeq: 2 };
        }
        return accepted(batch.length);
      },
    });
    const lease = startLease({ client, clock, runId: RUN, leaseGeneration: 1 });
    for (let i = 0; i < 6; i++) lease.push(event(i));
    await lease.flush();
    expect(calls.events).toEqual([[0, 1, 2, 3, 4, 5], [3, 4, 5]]);
    expect(lease.ended()).toBeUndefined();
    await lease.flush();
    expect(calls.events).toHaveLength(2);
    await lease.close();
  });

  it("seq_not_increasing for everything in the batch sends nothing more and is not a stop", async () => {
    const clock = manualClock();
    const { client, calls } = scripted({ events: () => ({ kind: "seq_not_increasing", lastAcceptedSeq: 9 }) });
    const lease = startLease({ client, clock, runId: RUN, leaseGeneration: 1 });
    lease.push(event(3));
    lease.push(event(9));
    await lease.flush();
    expect(calls.events).toEqual([[3, 9]]);
    expect(lease.ended()).toBeUndefined();
    expect(lease.signal.aborted).toBe(false);
    await lease.close();
  });

  it("a cloud that keeps answering seq_not_increasing is given up on after a bounded number of resends", async () => {
    const clock = manualClock();
    let last = 0;
    const { client, calls } = scripted({ events: () => ({ kind: "seq_not_increasing", lastAcceptedSeq: last++ }) });
    const lease = startLease({ client, clock, runId: RUN, leaseGeneration: 1 });
    for (let i = 0; i < 20; i++) lease.push(event(i));
    await lease.flush();
    expect(calls.events.length).toBeLessThanOrEqual(5);
    await lease.close();
  });

  it("a stop on events ends the hold and drops what is queued", async () => {
    const clock = manualClock();
    const { client, calls } = scripted({ events: () => ({ kind: "stop", reason: "run_terminal" }) });
    const lease = startLease({ client, clock, runId: RUN, leaseGeneration: 1 });
    lease.push(event(0));
    await lease.flush();
    expect(lease.ended()).toEqual({ kind: "stopped", reason: "run_terminal" });
    expect(lease.signal.aborted).toBe(true);
    await lease.flush();
    expect(calls.events).toHaveLength(1);
    await lease.close();
  });

  it("a failed send keeps the events for the next flush", async () => {
    const clock = manualClock();
    let fail = true;
    const { client, calls } = scripted({ events: (batch) => (fail ? { kind: "error", status: 502 } : accepted(batch.length)) });
    const lease = startLease({ client, clock, runId: RUN, leaseGeneration: 1 });
    lease.push(event(0));
    await lease.flush();
    fail = false;
    await lease.flush();
    expect(calls.events).toEqual([[0], [0]]);
    await lease.close();
  });

  it("an event the protocol does not accept is dropped at the door; the queue is bounded", async () => {
    const clock = manualClock();
    const { client, calls } = scripted();
    const lease = startLease({ client, clock, runId: RUN, leaseGeneration: 1 });
    lease.push({ seq: 0, ts: "2026-10-08T12:00:00.000Z", type: "tool_use", text: "model output" } as unknown as LocalOnlyEvent);
    for (let i = 1; i <= MAX_QUEUED_EVENTS + 10; i++) lease.push(event(i));
    await lease.flush();
    const sent = calls.events.flat();
    expect(sent).toHaveLength(MAX_QUEUED_EVENTS);
    expect(sent[0]).toBe(11);
    await lease.close();
  });
});

describe("what the lease knows about the events it was given (for run_ended)", () => {
  it("reports the highest seq queued, which events were seen by type, and how many are still waiting", async () => {
    const clock = manualClock();
    const { client } = scripted();
    const lease = startLease({ client, clock, runId: RUN, leaseGeneration: 1 });
    expect(lease.highestSeq()).toBeUndefined();
    expect(lease.saw("credential_mismatch")).toBe(false);
    lease.push(event(3));
    lease.push({ seq: 4, ts: event(0).ts, type: "credential_mismatch" });
    lease.push(event(1));
    expect(lease.highestSeq()).toBe(4);
    expect(lease.saw("credential_mismatch")).toBe(true);
    expect(lease.saw("usage_limit_reached")).toBe(false);
    expect(lease.pending()).toBe(3);
    await lease.flush();
    expect(lease.pending()).toBe(0);
    // Sent events still count towards the highest number: the next event goes above them.
    expect(lease.highestSeq()).toBe(4);
    await lease.close();
  });

  it("the highest seq survives a full queue dropping the oldest events", async () => {
    const clock = manualClock();
    const { client } = scripted();
    const lease = startLease({ client, clock, runId: RUN, leaseGeneration: 1 });
    for (let i = 0; i < MAX_QUEUED_EVENTS + 10; i++) lease.push(event(i));
    expect(lease.pending()).toBe(MAX_QUEUED_EVENTS);
    expect(lease.highestSeq()).toBe(MAX_QUEUED_EVENTS + 9);
    await lease.close();
  });

  it("an event the protocol refuses is dropped and counts for nothing", async () => {
    const clock = manualClock();
    const { client } = scripted();
    const lease = startLease({ client, clock, runId: RUN, leaseGeneration: 1 });
    lease.push({ seq: 9, ts: event(0).ts, type: "run_ended" });
    expect(lease.pending()).toBe(0);
    expect(lease.highestSeq()).toBeUndefined();
    await lease.close();
  });

  it("a run_ended is queued and sent like any event, and a close that abandons a send in progress returns at once", async () => {
    const clock = manualClock();
    let release: (() => void) | undefined;
    const client: Pick<RunnerClient, "heartbeat" | "events"> = {
      async heartbeat() {
        return ok;
      },
      events: () =>
        new Promise<EventsResult>((resolve) => {
          release = () => resolve(accepted(1));
        }),
    };
    const lease = startLease({ client, clock, runId: RUN, leaseGeneration: 1 });
    lease.push({ seq: 0, ts: event(0).ts, type: "run_ended", reason: "runner_shutdown" });
    const sending = lease.flush();
    let closed = false;
    await until(() => release !== undefined);
    await lease.close({ abandon: true }).then(() => (closed = true));
    expect(closed).toBe(true);
    release?.();
    await sending;
  });
});

const RUN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("the event relay", () => {
  it("hands a run's events to that run's sink only, and detaching stops it", () => {
    const relay = createEventRelay();
    const got: number[] = [];
    relay.emit(RUN_A, event(0));
    const detach = relay.attach(RUN_A, (e) => got.push(e.seq));
    relay.emit(RUN_A, event(1));
    detach();
    relay.emit(RUN_A, event(2));
    expect(got).toEqual([1]);
  });

  it("a stale detach of the same run does not remove a newer sink for it", () => {
    const relay = createEventRelay();
    const got: string[] = [];
    const first = relay.attach(RUN_A, () => got.push("a"));
    relay.attach(RUN_A, () => got.push("b"));
    first();
    relay.emit(RUN_A, event(0));
    expect(got).toEqual(["b"]);
  });

  it("an event for a run with no sink, or a detached one, is dropped and counted, never routed to another run", () => {
    const relay = createEventRelay();
    const other: string[] = [];
    relay.attach(RUN_B, (e) => other.push(String(e.seq)));
    relay.emit(RUN_A, event(0));
    const detach = relay.attach(RUN_A, () => undefined);
    detach();
    relay.emit(RUN_A, event(1));
    expect(other).toEqual([]);
    expect(relay.dropped()).toBe(2);
  });

  it("two attached runs each get their own events, in order, whatever the interleaving", () => {
    const relay = createEventRelay();
    const a: number[] = [];
    const b: number[] = [];
    relay.attach(RUN_A, (e) => a.push(e.seq));
    relay.attach(RUN_B, (e) => b.push(e.seq));
    relay.emit(RUN_A, event(10));
    relay.emit(RUN_B, event(20));
    relay.emit(RUN_B, event(21));
    relay.emit(RUN_A, event(11));
    expect(a).toEqual([10, 11]);
    expect(b).toEqual([20, 21]);
    expect(relay.dropped()).toBe(0);
  });
});

/** Two concurrent jobs wired the way the job handler wires one: a lease per run, a sink that renumbers into that lease. */
function twoJobs() {
  const clock = manualClock();
  const relay = createEventRelay();
  const make = (runId: string) => {
    const { client, calls } = scripted();
    const lease = startLease({ client, clock, runId, leaseGeneration: 1 });
    const next = (): number => (lease.highestSeq() ?? -1) + 1;
    const detach = relay.attach(runId, (e) => lease.push({ ...e, seq: next() }));
    return { lease, calls, detach, emit: (e: LocalOnlyEvent) => relay.emit(runId, e) };
  };
  return { clock, relay, a: make(RUN_A), b: make(RUN_B) };
}
const tagged = (tool: string): LocalOnlyEvent => ({ seq: 0, ts: "2026-10-08T12:00:00.000Z", type: "tool_use", tool_name: tool });

describe("concurrent jobs share one relay without sharing events", () => {
  it("interleaved events land on their own lease, each with its own seq line", async () => {
    const t = twoJobs();
    t.a.emit(tagged("A1"));
    t.b.emit(tagged("B1"));
    t.a.emit(tagged("A2"));
    t.b.emit(tagged("B2"));
    t.b.emit(tagged("B3"));
    expect(t.a.lease.pending()).toBe(2);
    expect(t.b.lease.pending()).toBe(3);
    expect(t.a.lease.highestSeq()).toBe(1);
    expect(t.b.lease.highestSeq()).toBe(2);
    await t.a.lease.flush();
    await t.b.lease.flush();
    expect(t.a.calls.events).toEqual([[0, 1]]);
    expect(t.b.calls.events).toEqual([[0, 1, 2]]);
    await t.a.lease.close();
    await t.b.lease.close();
  });

  it("detaching one job leaves the other streaming", () => {
    const t = twoJobs();
    t.b.emit(tagged("B1"));
    t.b.detach();
    t.a.emit(tagged("A1"));
    t.b.emit(tagged("B-late"));
    t.a.emit(tagged("A2"));
    expect(t.a.lease.pending()).toBe(2);
    expect(t.b.lease.pending()).toBe(1);
    expect(t.relay.dropped()).toBe(1);
    void t.a.lease.close({ abandon: true });
    void t.b.lease.close({ abandon: true });
  });

  it("aborting one job (its lease stops) leaves the other's events and seq untouched", async () => {
    const clock = manualClock();
    const relay = createEventRelay();
    const stopA = scripted({ heartbeat: () => ({ kind: "stop", reason: "lease_expired" }) });
    const okB = scripted();
    const leaseA = startLease({ client: stopA.client, clock, runId: RUN_A, leaseGeneration: 1 });
    const leaseB = startLease({ client: okB.client, clock, runId: RUN_B, leaseGeneration: 1 });
    const detachA = relay.attach(RUN_A, (e) => leaseA.push({ ...e, seq: (leaseA.highestSeq() ?? -1) + 1 }));
    relay.attach(RUN_B, (e) => leaseB.push({ ...e, seq: (leaseB.highestSeq() ?? -1) + 1 }));
    relay.emit(RUN_B, tagged("B1"));
    await clock.advance(30_000);
    expect(leaseA.signal.aborted).toBe(true);
    expect(leaseB.signal.aborted).toBe(false);
    detachA();
    relay.emit(RUN_A, tagged("A-after-abort"));
    relay.emit(RUN_B, tagged("B2"));
    expect(leaseB.highestSeq()).toBe(1);
    expect(leaseA.pending()).toBe(0);
    await leaseA.close({ abandon: true });
    await leaseB.close({ abandon: true });
  });

  it("one job finishing mid-stream of another does not drop the other's later events", () => {
    const t = twoJobs();
    t.a.emit(tagged("A1"));
    t.b.emit(tagged("B1"));
    t.b.detach(); // B is the later attach: under a single shared sink this is the call that used to silence A
    t.a.emit(tagged("A2"));
    t.a.emit(tagged("A3"));
    expect(t.a.lease.highestSeq()).toBe(2);
    expect(t.a.lease.pending()).toBe(3);
    void t.a.lease.close({ abandon: true });
    void t.b.lease.close({ abandon: true });
  });

  it("each job keeps its own buffering bound: a flooded job drops its oldest, the other keeps everything", () => {
    const t = twoJobs();
    for (let i = 0; i < MAX_QUEUED_EVENTS + 10; i++) t.a.emit(tagged(`A${i}`));
    for (let i = 0; i < 5; i++) t.b.emit(tagged(`B${i}`));
    expect(t.a.lease.pending()).toBe(MAX_QUEUED_EVENTS);
    expect(t.a.lease.highestSeq()).toBe(MAX_QUEUED_EVENTS + 9);
    expect(t.b.lease.pending()).toBe(5);
    expect(t.b.lease.highestSeq()).toBe(4);
    void t.a.lease.close({ abandon: true });
    void t.b.lease.close({ abandon: true });
  });
});
