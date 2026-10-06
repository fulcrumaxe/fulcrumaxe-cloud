import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKSTOP_MS,
  MARKER_GRACE_MS,
  CLOCK_SKEW_MS,
  MARKER_TTL_SECONDS,
  STORE_TIMEOUT_MS,
  finishTick,
  gateLine,
  markWorkPending,
  readTickGate,
  runGatedTick,
  setPendingHooks,
  type GatedOutcome,
} from "@fx/core/src/pendingWork";
import { makeRegion, storeOf, type FakeRegion } from "./support/runtimeCacheFake";

/**
 * D#454 H3c: the no-database gate behind the sweep crons, against a Runtime Cache fake that is regional, TTL-bound,
 * evictable and silent on failure (support/runtimeCacheFake.ts). `run` stands for "the code that opens a connection":
 * a tick that ends at the gate must never call it.
 */
const MIN = 60_000;
const clock = { value: 1_800_000_000_000 };
let region: FakeRegion;
let logs: string[];

function install(r: FakeRegion, extra: { kick?: () => void; keepAlive?: (p: Promise<unknown>) => void } = {}): void {
  setPendingHooks({ store: storeOf(r), ...extra });
}

/** A tick whose "database work" is the returned spy; `outcome` is what the sweep would report. */
async function tick(outcome: Partial<GatedOutcome<string>> = {}, opts: { force?: boolean } = {}) {
  const run = vi.fn(async () => ({ result: "swept", workFound: false, nextDueAt: null, ...outcome }));
  const ran = await runGatedTick("api-sweep", run, (l) => logs.push(l), () => clock.value, opts);
  return { run, ran };
}

beforeEach(() => {
  clock.value = 1_800_000_000_000;
  region = makeRegion(clock);
  logs = [];
  install(region);
});
afterEach(() => setPendingHooks(null));

describe("a tick with no pending work", () => {
  it("makes ZERO database connections: run is never called, and the line says why", async () => {
    // A recent connect is on record (the first tick after a deploy would otherwise be a backstop connect).
    await tick();
    const { run, ran } = await tick();
    expect(run).not.toHaveBeenCalled();
    expect(ran).toBeNull();
    expect(JSON.parse(logs.at(-1)!)).toEqual({ event: "cron.gate", sweep: "api-sweep", marker: "miss", last_run: "hit", reason: "none", connected: false, paused: false, backstop_ms: BACKSTOP_MS });
  });

  it("reads the marker before anything else: the gate decision is made from the store alone", async () => {
    await tick();
    region.calls = { get: 0, set: 0, delete: 0 };
    await tick();
    expect(region.calls).toEqual({ get: 2, set: 0, delete: 0 }); // marker + last run, nothing written
  });
});

describe("a writer that enqueues work", () => {
  it("sets the marker and the next tick connects, then the marker is spent", async () => {
    await tick(); // establishes a recent connect
    clock.value += 10 * MIN;
    await markWorkPending("api-sweep", { now: clock.value });
    clock.value += 2 * MIN; // past the marker's grace window
    const { run } = await tick({ workFound: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ reason: "marker", marker: "hit", connected: true, work_found: true });
    const after = await tick();
    expect(after.run).not.toHaveBeenCalled();
  });

  it("keeps a marker that is younger than the grace window, so a writer that had not committed yet is not lost", async () => {
    await tick();
    clock.value += 10 * MIN;
    await markWorkPending("api-sweep", { now: clock.value });
    clock.value += MARKER_GRACE_MS / 2;
    await tick(); // the tick found nothing (the row was not committed yet)
    clock.value += 5 * MIN;
    const next = await tick({ workFound: true });
    expect(next.run).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logs.at(-1)!).reason).toBe("marker");
  });

  it("is not overwritten by the tick that was running when the marker was written", async () => {
    await tick();
    clock.value += 10 * MIN;
    await markWorkPending("api-sweep", { now: clock.value });
    clock.value += 2 * MIN;
    const midTick: Partial<GatedOutcome<string>> = { nextDueAt: null };
    const run = vi.fn(async () => {
      clock.value += 1000;
      await markWorkPending("api-sweep", { now: clock.value }); // a writer, during the sweep
      return { result: "swept", workFound: true, nextDueAt: null, ...midTick };
    });
    await runGatedTick("api-sweep", run, (l) => logs.push(l), () => clock.value);
    clock.value += 2 * MIN;
    const next = await tick({ workFound: true });
    expect(next.run).toHaveBeenCalledTimes(1);
  });

  it("holds work that becomes due later (a webhook retry) until it is due, and an earlier marker is never pushed later", async () => {
    await tick();
    clock.value += MIN;
    await markWorkPending("api-sweep", { since: clock.value + 4 * MIN, now: clock.value });
    expect((await tick()).run).not.toHaveBeenCalled();
    clock.value += 4 * MIN;
    expect((await tick({ workFound: true })).run).toHaveBeenCalledTimes(1);

    await markWorkPending("api-sweep", { now: clock.value }); // due now
    await markWorkPending("api-sweep", { since: clock.value + 20 * MIN, now: clock.value }); // later: must not override
    clock.value += 2 * MIN;
    expect((await tick({ workFound: true })).run).toHaveBeenCalledTimes(1);
  });

  it("a tick that finds work still waiting leaves a marker for when it is due", async () => {
    await tick();
    clock.value += 10 * MIN;
    await markWorkPending("api-sweep", { now: clock.value });
    clock.value += 2 * MIN;
    await tick({ workFound: true, nextDueAt: clock.value + 5 * MIN });
    clock.value += 4 * MIN;
    expect((await tick()).run).not.toHaveBeenCalled();
    clock.value += 2 * MIN;
    expect((await tick({ workFound: true })).run).toHaveBeenCalledTimes(1);
  });

  it("never throws into the writer when the store throws, and hands the write to keepAlive", async () => {
    const kept: Array<Promise<unknown>> = [];
    const kick = vi.fn();
    install(region, { keepAlive: (p) => kept.push(p), kick });
    region.throwing = true;
    await expect(markWorkPending("api-sweep", { kick: true })).resolves.toBeUndefined();
    expect(kept).toHaveLength(1);
    expect(kick).toHaveBeenCalledWith("api-sweep");
    await markWorkPending("run-action-sweep");
    expect(kick).toHaveBeenCalledTimes(1); // only when asked
  });

  it("does nothing, and costs nothing, when no store is installed", async () => {
    setPendingHooks(null);
    await expect(markWorkPending("api-sweep", { kick: true })).resolves.toBeUndefined();
  });
});

describe("the 30-minute backstop", () => {
  it("connects with no marker once the last connect is 30 minutes old, and not before", async () => {
    await tick();
    clock.value += BACKSTOP_MS - MIN;
    expect((await tick()).run).not.toHaveBeenCalled();
    clock.value += MIN;
    const { run } = await tick();
    expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ reason: "backstop", marker: "miss", connected: true });
  });

  it("the first tick after a deploy (no record of a connect) connects", async () => {
    expect((await tick()).run).toHaveBeenCalledTimes(1);
  });
});

describe("what Runtime Cache really does", () => {
  it("a cold region misses the marker; the tick there connects once on the backstop path, and then skips", async () => {
    const regionB = makeRegion(clock);
    await tick(); // region A (the default) connects and records it
    clock.value += 10 * MIN;
    await markWorkPending("api-sweep", { now: clock.value }); // written in A
    clock.value += 2 * MIN;
    install(regionB); // the cron's tick runs in B: it sees nothing, neither marker nor last run
    const first = await tick({ workFound: true });
    expect(first.run).toHaveBeenCalledTimes(1); // the work was NOT lost: backstop path
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ reason: "backstop", marker: "miss", last_run: "miss", work_found: true });
    clock.value += 5 * MIN;
    expect((await tick()).run).not.toHaveBeenCalled(); // now B knows when it last connected
  });

  it("an evicted or expired last-run record makes the next tick connect (fail toward doing the work)", async () => {
    await tick();
    region.entries.clear();
    expect((await tick()).run).toHaveBeenCalledTimes(1);
    clock.value += MARKER_TTL_SECONDS * 1000 + 1;
    expect((await tick()).run).toHaveBeenCalledTimes(1);
  });

  it("an expired marker reads as a miss", async () => {
    await tick();
    await markWorkPending("api-sweep", { now: clock.value });
    clock.value += MARKER_TTL_SECONDS * 1000 + 1;
    const gate = await readTickGate("api-sweep", clock.value);
    expect(gate.marker).toBe("miss");
  });

  it("a failing cache answers null like the real client: the tick connects and nothing throws", async () => {
    await tick();
    region.failing = true;
    const { run } = await tick({ workFound: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ reason: "backstop", marker: "miss", last_run: "miss" });
  });

  it("a cache that throws is an error read, the tick connects, and finishing swallows the failure", async () => {
    region.throwing = true;
    const { run } = await tick({ workFound: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ marker: "error", last_run: "error", connected: true });
    await expect(finishTick(await readTickGate("api-sweep", clock.value), null, clock.value)).resolves.toBeUndefined();
  });

  it("stores the marker as a number with the documented TTL, never as a string of unbounded life", async () => {
    await markWorkPending("run-action-sweep", { now: 42_000 });
    const entry = region.entries.get("pending:run-action-sweep")!;
    expect(JSON.parse(entry.json)).toBe(42_000);
    expect(entry.expiresAt - clock.value).toBe(MARKER_TTL_SECONDS * 1000);
  });
});

describe("a signed kick", () => {
  it("connects with no marker, and still tidies up after itself", async () => {
    await tick();
    const { run } = await tick({ workFound: true }, { force: true });
    expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ reason: "kick", connected: true });
  });
});

describe("a store that never answers", () => {
  const hang = <T>(): Promise<T> => new Promise<T>(() => {});
  const hangingStore = { get: () => hang<unknown>(), set: () => hang<void>(), delete: () => hang<void>() };
  const settles = async (work: Promise<unknown>): Promise<void> => {
    const started = Date.now();
    await work;
    expect(Date.now() - started).toBeLessThan(STORE_TIMEOUT_MS * 4); // bounded, not left to the function's maxDuration
  };

  it("the gate reads it as an error and the tick connects", async () => {
    setPendingHooks({ store: hangingStore });
    let gate!: Awaited<ReturnType<typeof readTickGate>>;
    await settles((async () => (gate = await readTickGate("api-sweep", clock.value)))());
    expect(gate).toMatchObject({ connect: true, reason: "backstop", marker: "error", lastRun: "error" });
  });

  it("finishing a tick returns", async () => {
    setPendingHooks({ store: hangingStore });
    await settles(finishTick({ name: "api-sweep", connect: true, reason: "backstop", marker: "error", markerValue: null, lastRun: "error", paused: false }, clock.value + MIN, clock.value));
  });

  it("a writer's marker write is dropped after the bound and never rejects", async () => {
    setPendingHooks({ store: hangingStore });
    await settles(markWorkPending("api-sweep"));
    await settles(markWorkPending("api-sweep", { since: clock.value + MIN, now: clock.value })); // the read-before-set path
  });
});

describe("a store failure is reported, not only absorbed", () => {
  const failing = { get: async () => { throw new Error("cache down"); }, set: async () => { throw new Error("cache down"); }, delete: async () => {} };

  it("a gate read, a finishing tick and a writer each report once per failing call with their own stage", async () => {
    const reportError = vi.fn();
    setPendingHooks({ store: failing, reportError });
    await readTickGate("api-sweep", clock.value);
    expect(reportError.mock.calls.map((c) => c[1])).toEqual(["pending_work.read", "pending_work.read"]);
    reportError.mockClear();
    await finishTick({ name: "api-sweep", connect: true, reason: "backstop", marker: "error", markerValue: null, lastRun: "error", paused: false }, null, clock.value);
    expect(reportError.mock.calls.map((c) => c[1])).toEqual(["pending_work.finish"]);
    reportError.mockClear();
    await markWorkPending("api-sweep");
    expect(reportError.mock.calls.map((c) => c[1])).toEqual(["pending_work.write"]);
  });

  it("a timeout is reported too", async () => {
    const reportError = vi.fn();
    setPendingHooks({ store: { get: () => new Promise(() => {}), set: () => new Promise(() => {}), delete: () => new Promise(() => {}) }, reportError });
    await markWorkPending("api-sweep");
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("timed out") }), "pending_work.write");
  });

  it("a failing hook is reported and never reaches the writer", async () => {
    const reportError = vi.fn();
    setPendingHooks({ store: { get: async () => null, set: async () => {}, delete: async () => {} }, keepAlive: () => { throw new Error("no context"); }, reportError });
    await expect(markWorkPending("api-sweep")).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), "pending_work.hook");
  });

  it("with no reporter installed nothing changes", async () => {
    setPendingHooks({ store: failing });
    await expect(readTickGate("api-sweep", clock.value)).resolves.toMatchObject({ connect: true });
  });
});

describe("a last-connect time from the future", () => {
  it("beyond clock skew counts as overdue, so the backstop cannot be suppressed by a bad value", async () => {
    region.entries.set("lastrun:api-sweep", { json: JSON.stringify(clock.value + CLOCK_SKEW_MS + 1), expiresAt: clock.value + MIN });
    expect((await readTickGate("api-sweep", clock.value)).reason).toBe("backstop");
  });

  it("within skew is a recent connect", async () => {
    region.entries.set("lastrun:api-sweep", { json: JSON.stringify(clock.value + CLOCK_SKEW_MS - 1), expiresAt: clock.value + MIN });
    expect((await readTickGate("api-sweep", clock.value)).reason).toBe("none");
  });
});

describe("the hit-rate log line", () => {
  it("separates a marker that did its job from work the marker missed", () => {
    const hit = JSON.parse(gateLine({ name: "api-sweep", connect: true, reason: "marker", marker: "hit", markerValue: 1, lastRun: "hit", paused: false }, true));
    const missed = JSON.parse(gateLine({ name: "api-sweep", connect: true, reason: "backstop", marker: "miss", markerValue: null, lastRun: "miss", paused: false }, true));
    expect([hit.reason, hit.work_found]).toEqual(["marker", true]);
    expect([missed.reason, missed.work_found]).toEqual(["backstop", true]);
  });
});
