import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKSTOP_MS,
  MARKER_GRACE_MS,
  CLOCK_SKEW_MS,
  MARKER_TTL_SECONDS,
  STORE_TIMEOUT_MS,
  finishTick,
  gateLine,
  markRunnerWork,
  markWorkPending,
  RUNNER_WORK_TTL_SECONDS,
  readRunnerDue,
  remarkRunnerDue,
  runnerWorkDueKeyFor,
  runnerWorkKeyFor,
  runnerCheckKeyFor,
  recordRunnerCheck,
  readRunnerReplyHints,
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
    // marker + last run read; the only write is CRON-OBS-1's tick time for this call (no marker or last-run write on a skipped tick)
    expect(region.calls).toEqual({ get: 2, set: 1, delete: 0 });
    expect([...region.entries.keys()].filter((k) => k.startsWith("tick:"))).toEqual(["tick:api-sweep"]);
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

const HOUR = 60 * MIN;
const ACTIVITY = "activity:any";
const SWEEPS = ["api-sweep", "run-action-sweep", "compute-settle-sweep", "runner-sweeper", "invariant-sweep"] as const;
const START = 1_800_000_000_000; // a multiple of both slot lengths, so a test's minute 0 is a slot start

/** Marks the deployment busy (or not) without touching any sweep's marker. */
function setActivity(at: number | null): void {
  if (at === null) region.entries.delete(ACTIVITY);
  else region.entries.set(ACTIVITY, { json: JSON.stringify(at), expiresAt: clock.value + 24 * HOUR });
}

/** One cron tick for one sweep at the current fake time; returns whether it connected. */
async function minute(name: (typeof SWEEPS)[number] | "reconcile"): Promise<boolean> {
  const run = vi.fn(async () => ({ result: "swept", workFound: false, nextDueAt: null }));
  await runGatedTick(name, run, (l) => logs.push(l), () => clock.value);
  return run.mock.calls.length === 1;
}

/** Steps a wall clock minute by minute and lists the minutes (counted from `from`) at which `name` connected. */
async function connectMinutes(name: (typeof SWEEPS)[number] | "reconcile", from: number, minutes: number): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < minutes; i++) {
    clock.value = from + i * MIN;
    if (await minute(name)) out.push(i);
  }
  return out;
}

describe("the backstop is aligned to wall-clock slots", () => {
  it("busy deployment: a sweep connects at the first tick of each 30-minute slot, whatever minute it last ran", async () => {
    setActivity(START);
    clock.value = START + 7 * MIN; // first ever tick, mid-slot: no record, so it connects
    expect(await minute("api-sweep")).toBe(true);
    clock.value = START + 29 * MIN;
    expect(await minute("api-sweep")).toBe(false); // 22 minutes since its last run, same slot
    clock.value = START + 30 * MIN;
    expect(await minute("api-sweep")).toBe(true); // 23 minutes since its last run, but a slot boundary has passed
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ reason: "backstop", marker: "miss", last_run: "hit", connected: true, backstop_ms: 30 * MIN });
    clock.value = START + 59 * MIN + 59_999;
    expect(await minute("api-sweep")).toBe(false);
    clock.value = START + 60 * MIN;
    expect(await minute("api-sweep")).toBe(true);
  });

  it("idle deployment: slots are an hour long", async () => {
    expect(await minute("api-sweep")).toBe(true); // START, first tick
    const minutes = await connectMinutes("api-sweep", START + MIN, 3 * 60);
    expect(minutes.map((m) => m + 1)).toEqual([60, 120, 180]);
    const lastConnect = logs.map((l) => JSON.parse(l)).filter((l) => l.connected).at(-1);
    expect(lastConnect).toMatchObject({ reason: "backstop", connected: true, backstop_ms: HOUR }); // the line names the slot actually used
  });

  it("work seen more than 24 hours ago no longer counts; work seen within the day does", async () => {
    setActivity(START - 24 * HOUR - 1); // idle: one ms past the window
    expect(await minute("api-sweep")).toBe(true);
    clock.value = START + 30 * MIN;
    expect(await minute("api-sweep")).toBe(false); // idle: still in the hour slot
    setActivity(clock.value - 24 * HOUR + MIN);
    expect(await minute("api-sweep")).toBe(true); // busy: the half-hour boundary counts
  });

  it("every sweep, however its own last run drifted, connects in the same minutes of the same slots", async () => {
    setActivity(START);
    // Each sweep starts at its own minute, so their last runs are all different.
    const offsets = [3, 11, 17, 23, 29];
    for (const [i, name] of SWEEPS.entries()) {
      clock.value = START + offsets[i]! * MIN;
      expect(await minute(name)).toBe(true);
    }
    const from = START + 30 * MIN;
    const perSweep = new Map<string, number[]>();
    // Interleave the sweeps the way the crons do: every sweep gets a tick every minute.
    for (let i = 0; i < 4 * 60; i++) {
      clock.value = from + i * MIN;
      setActivity(clock.value); // keep it busy for the whole window
      for (const name of SWEEPS) if (await minute(name)) perSweep.set(name, [...(perSweep.get(name) ?? []), i]);
    }
    for (const name of SWEEPS) expect(perSweep.get(name), name).toEqual([0, 30, 60, 90, 120, 150, 180, 210]);
  });

  it("a last-run miss is overdue, then the sweep is on the slot grid", async () => {
    setActivity(START);
    clock.value = START + 12 * MIN;
    expect(await minute("api-sweep")).toBe(true);
    region.entries.delete("lastrun:api-sweep"); // evicted
    clock.value = START + 14 * MIN;
    expect(await minute("api-sweep")).toBe(true);
    clock.value = START + 20 * MIN;
    expect(await minute("api-sweep")).toBe(false);
    clock.value = START + 30 * MIN;
    expect(await minute("api-sweep")).toBe(true);
  });

  it("a marker still connects on the tick after its time, whatever the slot", async () => {
    expect(await minute("api-sweep")).toBe(true);
    clock.value = START + 41 * MIN;
    await markWorkPending("api-sweep", { now: clock.value });
    clock.value += MIN;
    expect(await minute("api-sweep")).toBe(true);
    expect(JSON.parse(logs.at(-1)!).reason).toBe("marker");
  });

  it("the activity key is read only when it can change the answer", async () => {
    expect(await minute("api-sweep")).toBe(true);
    region.calls = { get: 0, set: 0, delete: 0 };
    clock.value = START + 10 * MIN;
    await minute("api-sweep");
    expect(region.calls.get).toBe(2); // same half-hour slot: marker + last run only
    clock.value = START + 31 * MIN;
    await minute("api-sweep");
    expect(region.calls.get).toBe(5); // crossed a half-hour boundary: marker, last run, activity
  });

  it("an unreadable activity key counts as busy, so the half-hour slot applies", async () => {
    expect(await minute("api-sweep")).toBe(true);
    clock.value = START + 31 * MIN;
    region.throwing = true;
    expect((await readTickGate("api-sweep", clock.value)).connect).toBe(true);
  });

  it("paused keeps the plain 12-hour elapsed rule, not slots", async () => {
    const run = vi.fn(async () => ({ result: "swept", workFound: false, nextDueAt: null }));
    const paused = (at: number) => runGatedTick("api-sweep", run, () => {}, () => at, {});
    vi.stubEnv("FX_STAGING_PAUSED", "1");
    try {
      await paused(START + 5 * MIN);
      await paused(START + 5 * MIN + 12 * HOUR - 1);
      expect(run).toHaveBeenCalledTimes(1);
      await paused(START + 5 * MIN + 12 * HOUR);
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("an idle sweep's last-run record outlives the longest slot, so it does not read as a miss and connect early", async () => {
    expect(await minute("reconcile")).toBe(true);
    const entry = region.entries.get("lastrun:reconcile")!;
    expect(entry.expiresAt - clock.value).toBeGreaterThan(4 * HOUR);
  });
});

describe("the reconciler runs every fourth slot while nothing marks it", () => {
  it("busy: once every 2 hours, on the slot grid", async () => {
    setActivity(START);
    clock.value = START + 5 * MIN;
    expect(await minute("reconcile")).toBe(true); // first tick
    const from = START + 30 * MIN;
    const minutes: number[] = [];
    for (let i = 0; i < 6 * 60; i++) {
      clock.value = from + i * MIN;
      setActivity(clock.value);
      if (await minute("reconcile")) minutes.push(i);
    }
    expect(minutes).toEqual([90, 210, 330]); // the 2-hour slots at START + 2h, 4h, 6h
  });

  it("idle: once every 4 hours", async () => {
    expect(await minute("reconcile")).toBe(true);
    const minutes = await connectMinutes("reconcile", START + MIN, 9 * 60);
    expect(minutes.map((m) => m + 1)).toEqual([240, 480]);
    const lastConnect = logs.map((l) => JSON.parse(l)).filter((l) => l.connected).at(-1);
    expect(lastConnect).toMatchObject({ reason: "backstop", connected: true, backstop_ms: 4 * HOUR });
  });

  it("an installation marker runs it on the next tick, then it goes back to the slow grid", async () => {
    setActivity(START);
    expect(await minute("reconcile")).toBe(true);
    clock.value = START + 40 * MIN;
    await markWorkPending("reconcile", { now: clock.value });
    clock.value += MIN;
    expect(await minute("reconcile")).toBe(true);
    expect(JSON.parse(logs.at(-1)!).reason).toBe("marker");
    clock.value = START + 2 * HOUR - MIN;
    setActivity(clock.value);
    expect(await minute("reconcile")).toBe(false); // still in the 2-hour slot of the marker run
    clock.value = START + 2 * HOUR;
    expect(await minute("reconcile")).toBe(true);
  });
});

describe("what keeps the half-hour slots", () => {
  it("a writer's marker records activity for 24 hours", async () => {
    await markWorkPending("api-sweep", { now: clock.value });
    const entry = region.entries.get(ACTIVITY)!;
    expect(JSON.parse(entry.json)).toBe(clock.value);
    expect(entry.expiresAt - clock.value).toBe(24 * HOUR);
  });

  it("a connecting tick that found work records it; one that found none does not", async () => {
    await tick({ workFound: false });
    expect(region.entries.has(ACTIVITY)).toBe(false);
    await tick({ workFound: true }, { force: true });
    expect(JSON.parse(region.entries.get(ACTIVITY)!.json)).toBe(clock.value);
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

describe("markRunnerWork: the per-account runner-work hint", () => {
  const ACCT = "11111111-1111-4111-8111-111111111111";
  const OTHER = "22222222-2222-4222-8222-222222222222";
  let stdout: string[];
  beforeEach(() => {
    stdout = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void stdout.push(String(line)));
  });
  afterEach(() => vi.restoreAllMocks());

  it("stores 'work since now' under the account's own key, as a number with a bounded life, and touches no other account", async () => {
    const set = vi.fn(async () => {});
    setPendingHooks({ store: { get: async () => null, set, delete: async () => {} } });
    await markRunnerWork(ACCT, { now: clock.value });
    expect(set).toHaveBeenCalledWith(runnerWorkKeyFor(ACCT), clock.value, RUNNER_WORK_TTL_SECONDS);
    expect(runnerWorkKeyFor(ACCT)).not.toBe(runnerWorkKeyFor(OTHER));
    expect(runnerWorkKeyFor(ACCT)).not.toBe("pending:api-sweep");
  });

  it("keeps the epoch as the latest bump and the due value as the minimum not-yet-passed due time", async () => {
    const get = (k: string) => storeOf(region).get(k);
    await markRunnerWork(ACCT, { now: clock.value });
    await markRunnerWork(ACCT, { since: clock.value + 5 * MIN, now: clock.value });
    await markRunnerWork(ACCT, { since: clock.value + 9 * MIN, now: clock.value }); // later: does not replace the earlier future due time
    expect(await get(runnerWorkDueKeyFor(ACCT))).toBe(clock.value + 5 * MIN);
    await markRunnerWork(ACCT, { since: clock.value + 2 * MIN, now: clock.value });
    expect(await get(runnerWorkDueKeyFor(ACCT))).toBe(clock.value + 2 * MIN);
    expect(await get(runnerWorkKeyFor(ACCT))).toBe(clock.value); // a future due time never touches the epoch
    await markRunnerWork(ACCT, { now: clock.value + 3 * MIN });
    expect(await get(runnerWorkKeyFor(ACCT))).toBe(clock.value + 3 * MIN);
    // the earlier due time has now passed, so a new future one replaces it
    await markRunnerWork(ACCT, { since: clock.value + 20 * MIN, now: clock.value + 3 * MIN });
    expect(await get(runnerWorkDueKeyFor(ACCT))).toBe(clock.value + 20 * MIN);
  });

  it("the consumer re-derives: after the first due time is consumed, the later one is written back; an earlier future value did not drop it", async () => {
    const get = (k: string) => storeOf(region).get(k);
    const first = clock.value + 5 * MIN;
    const second = clock.value + 9 * MIN;
    await markRunnerWork(ACCT, { since: first, now: clock.value });
    await markRunnerWork(ACCT, { since: second, now: clock.value });
    expect(await get(runnerWorkDueKeyFor(ACCT))).toBe(first);
    expect(await readRunnerDue(ACCT)).toBe(first);
    await remarkRunnerDue(ACCT, second); // what the claim does with the next future claimable_after from the database
    expect(await readRunnerDue(ACCT)).toBe(second);
    await remarkRunnerDue(ACCT, null); // nothing left in the future: the stored value is deleted
    expect(await readRunnerDue(ACCT)).toBeNull();
    setPendingHooks({ store: { get: async () => null, set: async () => {}, delete: async () => { throw new Error("cache down"); } } });
    await expect(remarkRunnerDue(ACCT, null)).resolves.toBeUndefined(); // a failed delete is swallowed, stdout only
    expect(stdout.some((l) => l.includes("runner_work.mark_failed"))).toBe(true);
    install(region);
    expect(await readRunnerDue(OTHER)).toBeNull();
  });

  it("hands the write to keepAlive, and does nothing without a store or without an account", async () => {
    const kept: Promise<unknown>[] = [];
    install(region, { keepAlive: (p) => void kept.push(p) });
    await markRunnerWork(ACCT);
    expect(kept).toHaveLength(1);
    await markRunnerWork("");
    expect(kept).toHaveLength(1);
    setPendingHooks(null);
    await expect(markRunnerWork(ACCT)).resolves.toBeUndefined();
  });

  it("never throws or rejects when the store or keepAlive fails, and reports to stdout only (no hooks.reportError, which opens the database)", async () => {
    const reportError = vi.fn();
    const failing = { get: async () => { throw new Error("cache down"); }, set: async () => { throw new Error("cache down"); }, delete: async () => {} };
    setPendingHooks({ store: failing, reportError, keepAlive: () => { throw new Error("no context"); } });
    await expect(markRunnerWork(ACCT)).resolves.toBeUndefined();
    await expect(markRunnerWork(ACCT, { since: clock.value + MIN, now: clock.value })).resolves.toBeUndefined();
    expect(reportError).not.toHaveBeenCalled();
    expect(stdout.filter((l) => l.includes("runner_work.mark_failed")).length).toBe(4);
  });

  it("a store that never answers is dropped after the bound", async () => {
    const hang = <T>(): Promise<T> => new Promise<T>(() => {});
    setPendingHooks({ store: { get: () => hang<unknown>(), set: () => hang<void>(), delete: () => hang<void>() } });
    const started = Date.now();
    await markRunnerWork(ACCT);
    expect(Date.now() - started).toBeLessThan(STORE_TIMEOUT_MS * 4);
  });

  // D#6 PING-CONSUMERS: ignored work is judged from the rows, so a bump writes the epoch alone: no second key, no read before the write.
  it("a bump writes the epoch only, with no read and no second key", async () => {
    const get = vi.fn(async () => null);
    const set = vi.fn(async () => {});
    setPendingHooks({ store: { get, set, delete: async () => {} } });
    await markRunnerWork(ACCT, { now: clock.value });
    expect(get).not.toHaveBeenCalled();
    expect(set.mock.calls).toEqual([[runnerWorkKeyFor(ACCT), clock.value, RUNNER_WORK_TTL_SECONDS]]);
  });

  it("records a person's check per runner and reads the hints back in one round; a miss or a failure is no value", async () => {
    const R1 = "33333333-3333-4333-8333-333333333333";
    const R2 = "44444444-4444-4444-8444-444444444444";
    expect(await readRunnerReplyHints(ACCT, [R1])).toEqual({ checks: new Map() });
    expect(await recordRunnerCheck(R1, clock.value)).toBe(true);
    await markRunnerWork(ACCT, { now: clock.value });
    expect(await readRunnerReplyHints(ACCT, [R1, R2, R1])).toEqual({ checks: new Map([[R1, clock.value]]) });
    expect(await storeOf(region).get(runnerCheckKeyFor(R1))).toBe(clock.value);
    setPendingHooks({ store: { get: async () => { throw new Error("cache down"); }, set: async () => { throw new Error("cache down"); }, delete: async () => {} } });
    expect(await recordRunnerCheck(R1, clock.value)).toBe(false);
    expect(await readRunnerReplyHints(ACCT, [R1])).toEqual({ checks: new Map() });
    setPendingHooks(null);
    expect(await recordRunnerCheck(R1, clock.value)).toBe(false);
    expect(await readRunnerReplyHints(ACCT, [R1])).toEqual({ checks: new Map() });
  });
});
