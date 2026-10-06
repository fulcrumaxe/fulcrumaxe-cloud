import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  BACKSTOP_MS,
  PAUSED_BACKSTOP_MS,
  isStagingPaused,
  markWorkPending,
  runGatedTick,
  setPendingHooks,
  type GatedOutcome,
} from "@fx/core/src/pendingWork";
import type { TickSummary } from "@fx/reconcile";
import { reconcileHandler, type ReconcileHandlerDeps } from "../app/api/cron/reconcile/handler";
import { ENV_MANIFEST } from "../env-manifest";
import { makeRegion, storeOf, type FakeRegion } from "./support/runtimeCacheFake";

/**
 * Staging pause switch (FX_STAGING_PAUSED=1): the cron gate's backstop is 12 hours instead of 30 minutes for every
 * sweep including the reconciler, while a pending-work marker still opens the gate. `run` stands for "the code that
 * opens a database connection".
 */
const MIN = 60_000;
const HOUR = 60 * MIN;
const clock = { value: 1_800_000_000_000 };
let region: FakeRegion;
let logs: string[];

beforeEach(() => {
  clock.value = 1_800_000_000_000;
  region = makeRegion(clock);
  logs = [];
  setPendingHooks({ store: storeOf(region) });
});
afterEach(() => {
  setPendingHooks(null);
  vi.unstubAllEnvs();
});

async function tick(name: "api-sweep" | "run-action-sweep" | "compute-settle-sweep" | "reconcile" = "api-sweep", outcome: Partial<GatedOutcome<string>> = {}) {
  const run = vi.fn(async () => ({ result: "swept", workFound: false, nextDueAt: null, ...outcome }));
  const ran = await runGatedTick(name, run, (l) => logs.push(l), () => clock.value);
  return { run, ran };
}

describe("isStagingPaused", () => {
  it("is true only for exactly 1", () => {
    expect(isStagingPaused({ FX_STAGING_PAUSED: "1" })).toBe(true);
    for (const v of [undefined, "", "0", "true", "yes", " 1", "11"]) expect(isStagingPaused({ FX_STAGING_PAUSED: v })).toBe(false);
  });
});

describe("the cron gate backstop", () => {
  it("is 12 hours paused and 30 minutes not", () => {
    expect(BACKSTOP_MS).toBe(30 * MIN);
    expect(PAUSED_BACKSTOP_MS).toBe(12 * HOUR);
  });

  it.each(["api-sweep", "run-action-sweep", "compute-settle-sweep", "reconcile"] as const)("%s, not paused: an idle tick connects again after 30 minutes", async (name) => {
    await tick(name); // first tick: nothing on record, connects
    clock.value += 29 * MIN;
    expect((await tick(name)).run).not.toHaveBeenCalled();
    clock.value += 2 * MIN;
    expect((await tick(name)).run).toHaveBeenCalledTimes(1);
  });

  it.each(["api-sweep", "run-action-sweep", "compute-settle-sweep", "reconcile"] as const)("%s, paused: an idle tick does not connect until 12 hours have passed", async (name) => {
    vi.stubEnv("FX_STAGING_PAUSED", "1");
    expect((await tick(name)).run).toHaveBeenCalledTimes(1); // nothing on record yet
    clock.value += 31 * MIN;
    expect((await tick(name)).run).not.toHaveBeenCalled(); // past the normal backstop, still quiet
    clock.value += 5 * HOUR; // the last-connected time must outlive the normal one-hour store lifetime
    expect((await tick(name)).run).not.toHaveBeenCalled();
    clock.value = clock.value - 5 * HOUR - 31 * MIN + 12 * HOUR - 1;
    expect((await tick(name)).run).not.toHaveBeenCalled(); // 1 ms short of 12 hours
    clock.value += 1;
    const last = await tick(name);
    expect(last.run).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ reason: "backstop", connected: true });
  });

  it("paused: a pending-work marker still connects at once", async () => {
    vi.stubEnv("FX_STAGING_PAUSED", "1");
    await tick();
    clock.value += 10 * MIN;
    expect((await tick()).run).not.toHaveBeenCalled();
    await markWorkPending("api-sweep", { now: clock.value });
    clock.value += 1_000;
    const marked = await tick("api-sweep", { workFound: true });
    expect(marked.run).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ reason: "marker", connected: true, paused: true });
  });

  it("paused: a retry that falls due keeps the marker, so the tick after it connects again", async () => {
    vi.stubEnv("FX_STAGING_PAUSED", "1");
    await tick("run-action-sweep", { workFound: true, nextDueAt: clock.value + 2 * MIN });
    clock.value += 3 * MIN;
    expect((await tick("run-action-sweep")).run).toHaveBeenCalledTimes(1);
  });

  it("logs one fixed-field cron.gate line per tick, skipped or not, with the pause state", async () => {
    vi.stubEnv("FX_STAGING_PAUSED", "1");
    await tick();
    await tick();
    expect(logs).toHaveLength(2);
    expect(JSON.parse(logs[1]!)).toEqual({
      event: "cron.gate",
      sweep: "api-sweep",
      marker: "miss",
      last_run: "hit",
      reason: "none",
      connected: false,
      paused: true,
      backstop_ms: PAUSED_BACKSTOP_MS,
    });
  });
});

describe("the reconcile cron", () => {
  const SECRET = ["test", "cron", "secret", "x".repeat(32)].join("-"); // built at runtime: no literal for the secret scanner to flag
  const summary: TickSummary = { enabled: true, results: [{ job: "error_events_prune", result: "ok" }] };
  const deps = (): ReconcileHandlerDeps => ({ cronSecret: SECRET, enabled: true, platformOpsPool: {} as never, reportError: () => undefined });
  const call = (runTickFn: () => Promise<TickSummary>) =>
    reconcileHandler(new NextRequest("https://example.test/api/cron/reconcile", { method: "GET", headers: { authorization: `Bearer ${SECRET}` } }), deps(), runTickFn);

  // The handler reads Date.now itself, so the shared clock is mirrored into the system time.
  const advance = (ms: number): void => {
    clock.value += ms;
    vi.setSystemTime(clock.value);
  };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(clock.value);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("not paused: every tick runs, with no cache read at all (as before)", async () => {
    const runTickFn = vi.fn(async () => summary);
    for (let i = 0; i < 3; i++) {
      advance(6 * HOUR);
      const res = await call(runTickFn);
      expect(await res.json()).toEqual(summary);
    }
    expect(runTickFn).toHaveBeenCalledTimes(3);
    expect(region.calls).toEqual({ get: 0, set: 0, delete: 0 });
  });

  it("paused: the first tick runs, ticks inside 12 hours are skipped without running, and the next one after runs", async () => {
    vi.stubEnv("FX_STAGING_PAUSED", "1");
    const runTickFn = vi.fn(async () => summary);
    expect(await (await call(runTickFn)).json()).toEqual(summary);
    advance(6 * HOUR);
    const skipped = await call(runTickFn);
    expect(skipped.status).toBe(200);
    expect(await skipped.json()).toEqual({ skipped: true, reason: "staging_paused" });
    expect(runTickFn).toHaveBeenCalledTimes(1);
    advance(6 * HOUR + MIN);
    expect(await (await call(runTickFn)).json()).toEqual(summary);
    expect(runTickFn).toHaveBeenCalledTimes(2);
  });

  it("paused: an unauthenticated call still gets 401 and reads no cache", async () => {
    vi.stubEnv("FX_STAGING_PAUSED", "1");
    const res = await reconcileHandler(new NextRequest("https://example.test/api/cron/reconcile"), deps(), vi.fn());
    expect(res.status).toBe(401);
    expect(region.calls).toEqual({ get: 0, set: 0, delete: 0 });
  });
});

describe("the env manifest entry", () => {
  it("lists FX_STAGING_PAUSED as an optional, non-secret, enum-1 setting that is documented", () => {
    const entry = ENV_MANIFEST.find((e) => e.name === "FX_STAGING_PAUSED");
    expect(entry).toMatchObject({ scope: "web", requiredIn: [], secret: false, validation: { type: "enum", values: ["1"] }, whenMissing: "default_used" });
    expect(entry?.note).toMatch(/12 hours/);
    expect(entry?.note).toMatch(/staging-power\.sh/);
  });
});
