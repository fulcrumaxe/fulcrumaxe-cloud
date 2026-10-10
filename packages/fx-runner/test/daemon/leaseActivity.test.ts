import { describe, expect, it } from "vitest";
import type { LocalOnlyEvent } from "@fulcrumaxe/runner-protocol";
import type { EventsResult, RunnerClient } from "../../src/daemon/client.js";
import { ACTIVITY_FLUSH_INTERVAL_MS, EVENT_FLUSH_INTERVAL_MS, MAX_ACTIVITY_EVENTS, startLease } from "../../src/daemon/lease.js";
import { manualClock } from "../helpers/manualClock.js";

const RUN = "11111111-1111-4111-8111-111111111111";
const T0 = Date.parse("2026-10-09T12:00:00.000Z");
const at = (ms: number): string => new Date(T0 + ms).toISOString();
const ok = { kind: "ok" as const, leaseExpiresAt: "2026-10-09T12:01:30.000Z" };
const accepted = (n: number): EventsResult => ({ kind: "ok", accepted: n, duplicates: 0, leaseExpiresAt: ok.leaseExpiresAt });
const use = (seq: number, ms: number, withActivity = true): LocalOnlyEvent => ({ seq, ts: at(ms), type: "tool_use", tool_name: "Read", ...(withActivity ? { activity: { tool: "read", path: `src/f${seq}.ts` } } : {}) });

/** A client that records every batch it is sent. */
function recording() {
  const batches: Array<{ at: number; events: LocalOnlyEvent[] }> = [];
  let clockNow = (): number => 0;
  const client: Pick<RunnerClient, "heartbeat" | "events"> = {
    async heartbeat() {
      return ok;
    },
    async events(_run, _gen, events) {
      batches.push({ at: clockNow(), events: [...events] });
      return accepted(events.length);
    },
  };
  return { client, batches, all: () => batches.flatMap((b) => b.events), bindClock: (fn: () => number) => void (clockNow = fn) };
}

describe("the cap: 400 activity-bearing events per run", () => {
  it("the 401st and later tool uses are sent without their activity, and all of them are still sent", async () => {
    const clock = manualClock(T0);
    const { client, all } = recording();
    const lease = startLease({ client, clock, runId: RUN, leaseGeneration: 1 });
    expect(MAX_ACTIVITY_EVENTS).toBe(400);
    for (let i = 0; i < 450; i++) lease.push(use(i, i * 300));
    await lease.flush();
    const sent = all();
    expect(sent).toHaveLength(450);
    expect(sent.filter((e) => e.activity !== undefined)).toHaveLength(400);
    expect(sent.slice(0, 400).every((e) => e.activity !== undefined)).toBe(true);
    expect(sent.slice(400).every((e) => e.activity === undefined && e.type === "tool_use" && e.tool_name === "Read")).toBe(true);
    await lease.close();
  });

  it("the cap counts events kept, not events folded into a newer one of their burst", async () => {
    const clock = manualClock(T0);
    const { client, all } = recording();
    const lease = startLease({ client, clock, runId: RUN, leaseGeneration: 1 });
    // 500 bursts of 2 events each 10 ms apart: each burst keeps one, so 500 would-be activities make 500 kept, capped at 400.
    for (let i = 0; i < 500; i++) {
      lease.push(use(i * 2, i * 1000));
      lease.push(use(i * 2 + 1, i * 1000 + 10));
    }
    await lease.flush();
    expect(all()).toHaveLength(1000);
    expect(all().filter((e) => e.activity !== undefined)).toHaveLength(400);
    await lease.close();
  });
});

describe("coalescing: a burst inside 250 ms keeps the newest", () => {
  it("ten tool uses within 100 ms: only the last carries its activity; the others go as bare tool uses", async () => {
    const clock = manualClock(T0);
    const { client, all } = recording();
    const lease = startLease({ client, clock, runId: RUN, leaseGeneration: 1 });
    for (let i = 0; i < 10; i++) lease.push(use(i, i * 10));
    await lease.flush();
    expect(all().map((e) => e.activity?.path)).toEqual([...Array(9).fill(undefined), "src/f9.ts"]);
    expect(all()).toHaveLength(10);
    await lease.close();
  });

  it("events 250 ms or more after the burst's first start a new burst and keep their own activity", async () => {
    const clock = manualClock(T0);
    const { client, all } = recording();
    const lease = startLease({ client, clock, runId: RUN, leaseGeneration: 1 });
    lease.push(use(0, 0));
    lease.push(use(1, 249));
    lease.push(use(2, 250));
    lease.push(use(3, 400));
    await lease.flush();
    expect(all().map((e) => e.activity?.path)).toEqual([undefined, "src/f1.ts", undefined, "src/f3.ts"]);
    await lease.close();
  });

  it("an event already sent is not taken back: the next one in its window still carries its activity", async () => {
    const clock = manualClock(T0);
    const { client, all } = recording();
    const lease = startLease({ client, clock, runId: RUN, leaseGeneration: 1 });
    lease.push(use(0, 0));
    await lease.flush();
    lease.push(use(1, 100));
    await lease.flush();
    expect(all().map((e) => e.activity?.path)).toEqual(["src/f0.ts", "src/f1.ts"]);
    await lease.close();
  });
});

describe("stage marks go out once each", () => {
  it("a repeat of a stage is dropped, whatever its seq", async () => {
    const clock = manualClock(T0);
    const { client, all } = recording();
    const lease = startLease({ client, clock, runId: RUN, leaseGeneration: 1 });
    lease.push({ seq: 0, ts: at(0), type: "stage", stage: "workspace_ready" });
    lease.push({ seq: 1, ts: at(1), type: "stage", stage: "workspace_ready" });
    lease.push({ seq: 2, ts: at(2), type: "stage", stage: "cloned" });
    lease.push({ seq: 3, ts: at(3), type: "stage", stage: "writing_result" });
    lease.push({ seq: 4, ts: at(4), type: "stage", stage: "writing_result" });
    await lease.flush();
    expect(all().map((e) => `${e.type}:${e.seq}:${e.stage}`)).toEqual(["stage:0:workspace_ready", "stage:2:cloned", "stage:3:writing_result"]);
    await lease.close();
  });
});

describe("flush timing (fake clock)", () => {
  it("an activity event waiting is sent within 2 seconds, and not before", async () => {
    const clock = manualClock(T0);
    const rec = recording();
    rec.bindClock(() => clock.now().getTime() - T0);
    const lease = startLease({ client: rec.client, clock, runId: RUN, leaseGeneration: 1, heartbeatMs: 1e9 });
    expect(ACTIVITY_FLUSH_INTERVAL_MS).toBe(2_000);
    lease.push(use(0, 0));
    await clock.advance(1_999, 1);
    expect(rec.batches).toEqual([]);
    await clock.advance(1, 1);
    expect(rec.batches).toHaveLength(1);
    expect(rec.batches[0]!.at).toBe(2_000);
    await lease.close();
  });

  it("a stage mark alone also brings the flush to 2 seconds", async () => {
    const clock = manualClock(T0);
    const rec = recording();
    const lease = startLease({ client: rec.client, clock, runId: RUN, leaseGeneration: 1, heartbeatMs: 1e9 });
    lease.push({ seq: 0, ts: at(0), type: "stage", stage: "cloned" });
    await clock.advance(2_000, 100);
    expect(rec.batches).toHaveLength(1);
    await lease.close();
  });

  it("an idle run (events with no activity) still flushes at 5 seconds", async () => {
    const clock = manualClock(T0);
    const rec = recording();
    rec.bindClock(() => clock.now().getTime() - T0);
    const lease = startLease({ client: rec.client, clock, runId: RUN, leaseGeneration: 1, heartbeatMs: 1e9 });
    expect(EVENT_FLUSH_INTERVAL_MS).toBe(5_000);
    lease.push(use(0, 0, false));
    await clock.advance(4_900, 100);
    expect(rec.batches).toEqual([]);
    await clock.advance(100, 100);
    expect(rec.batches).toHaveLength(1);
    expect(rec.batches[0]!.at).toBe(5_000);
    await lease.close();
  });

  it("an activity event over the cap (sent bare) does not bring the short flush", async () => {
    const clock = manualClock(T0);
    const rec = recording();
    const lease = startLease({ client: rec.client, clock, runId: RUN, leaseGeneration: 1, heartbeatMs: 1e9, flushMs: 1e9 });
    for (let i = 0; i < 400; i++) lease.push(use(i, i * 300));
    await lease.flush();
    await clock.advance(2_000, 500); // the short flush the first 400 armed has run
    const before = rec.batches.length;
    lease.push(use(400, 400 * 300));
    await clock.advance(10_000, 500);
    expect(rec.batches.length).toBe(before);
    await lease.close();
  });
});
