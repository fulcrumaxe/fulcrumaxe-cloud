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
import { reconcileHandler, reconcileNextDueAt, type ReconcileHandlerDeps } from "../app/api/cron/reconcile/handler";
import { ENV_MANIFEST } from "../env-manifest";
import { makeRegion, storeOf, type FakeRegion } from "./support/runtimeCacheFake";

/**
 * Staging pause switch (FX_STAGING_PAUSED=1): the cron gate's backstop is 12 hours instead of 30 minutes for every
 * sweep including the reconciler, while a pending-work marker still opens the gate. (Unpaused, the backstop is wall-clock slots: see pendingWork.test.ts.) `run` stands for "the code that
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

  it.each(["api-sweep", "run-action-sweep", "compute-settle-sweep"] as const)("%s, not paused: with work seen today, an idle tick connects again at the next half-hour slot", async (name) => {
    region.entries.set("activity:any", { json: JSON.stringify(clock.value), expiresAt: clock.value + 24 * HOUR });
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
  const deps = (): ReconcileHandlerDeps => ({ cronSecret: SECRET, enabled: true, platformOpsPool: { query: async () => ({ rows: [{ pending: false }] }) } as never, reportError: () => undefined });
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

  it("not paused: the first tick runs, later ticks in the same slot are skipped, and an installation marker runs the next one", async () => {
    const runTickFn = vi.fn(async () => summary);
    expect(await (await call(runTickFn)).json()).toEqual(summary);
    advance(15 * MIN);
    const skipped = await call(runTickFn);
    expect(await skipped.json()).toEqual({ skipped: true, reason: "not_due" });
    expect(runTickFn).toHaveBeenCalledTimes(1);
    await markWorkPending("reconcile", { now: clock.value }); // what the GitHub installation webhook does
    advance(MIN);
    expect(await (await call(runTickFn)).json()).toEqual(summary);
    expect(runTickFn).toHaveBeenCalledTimes(2);
  });

  it("not paused: with no marker it runs once per four-hour idle cycle", async () => {
    const runTickFn = vi.fn(async () => summary);
    await call(runTickFn);
    for (let i = 0; i < 16; i++) {
      advance(15 * MIN); // the real cron cadence
      await call(runTickFn);
    }
    expect(runTickFn).toHaveBeenCalledTimes(2); // the first tick, and the one at the four-hour boundary
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

// The 15-minute reconcile jobs behind the gate: they keep their cadence while they have work, and only then.
describe("the reconcile cron keeps the 15-minute jobs on their cadence while they have work", () => {
  const SECRET = ["test", "cron", "secret", "y".repeat(32)].join("-");
  const NOW = 1_800_000_000_000 + 7 * MIN;
  /** A fake platform_ops pool over the two reads reconcileNextDueAt makes. */
  function fakePool(opts: { creditsBroken: boolean; creditsAgeSeconds?: number; dueAt: Record<string, number> }) {
    const queries: string[] = [];
    return {
      queries,
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        queries.push(sql);
        if (sql.includes("FROM model_connections")) return { rows: [{ broken: opts.creditsBroken, age: opts.creditsBroken ? (opts.creditsAgeSeconds ?? 0) : null }] };
        const names = (params?.[0] ?? []) as string[];
        return { rows: names.map((n) => ({ name: n, due: opts.dueAt[n]! })) };
      }),
    };
  }
  const summaryWith = (terminal: string): TickSummary => ({ enabled: true, results: [{ job: "sandbox_reap_terminal", result: terminal as never }, { job: "model_credits_revalidate", result: "ok" }] });

  it("a connection still broken for credits makes the credits job's due time the next look", async () => {
    const pool = fakePool({ creditsBroken: true, dueAt: { model_credits_revalidate: NOW + 14 * MIN } });
    expect(await reconcileNextDueAt(pool as never, summaryWith("ok"), NOW)).toBe(NOW + 14 * MIN);
  });

  it("a break under 2 hours old keeps the 15-minute cadence (the job's own due time)", async () => {
    const pool = fakePool({ creditsBroken: true, creditsAgeSeconds: 2 * 3600 - 1, dueAt: { model_credits_revalidate: NOW + 14 * MIN } });
    expect(await reconcileNextDueAt(pool as never, summaryWith("ok"), NOW)).toBe(NOW + 14 * MIN);
  });

  it("a break 2 hours old or more is looked at hourly: an hour from this look, never earlier than the job's own due time", async () => {
    for (const age of [2 * 3600, 30 * 3600]) {
      const pool = fakePool({ creditsBroken: true, creditsAgeSeconds: age, dueAt: { model_credits_revalidate: NOW + 14 * MIN } });
      expect(await reconcileNextDueAt(pool as never, summaryWith("ok"), NOW)).toBe(NOW + 60 * MIN);
    }
    const late = fakePool({ creditsBroken: true, creditsAgeSeconds: 3 * 3600, dueAt: { model_credits_revalidate: NOW + 90 * MIN } });
    expect(await reconcileNextDueAt(late as never, summaryWith("ok"), NOW)).toBe(NOW + 90 * MIN);
  });

  it("a revalidate success or a new break resets: the state is derived, so the next look is 15 minutes again (cleared leaves no due time at all)", async () => {
    const backedOff = fakePool({ creditsBroken: true, creditsAgeSeconds: 5 * 3600, dueAt: { model_credits_revalidate: NOW + 14 * MIN } });
    expect(await reconcileNextDueAt(backedOff as never, summaryWith("ok"), NOW)).toBe(NOW + 60 * MIN);
    const newBreak = fakePool({ creditsBroken: true, creditsAgeSeconds: 0, dueAt: { model_credits_revalidate: NOW + 14 * MIN } });
    expect(await reconcileNextDueAt(newBreak as never, summaryWith("ok"), NOW)).toBe(NOW + 14 * MIN);
    const cleared = fakePool({ creditsBroken: false, dueAt: {} });
    expect(await reconcileNextDueAt(cleared as never, summaryWith("ok"), NOW)).toBeNull();
  });

  it("a backed-off credits job does not hold back a reap pass that is due sooner", async () => {
    const pool = fakePool({ creditsBroken: true, creditsAgeSeconds: 5 * 3600, dueAt: { model_credits_revalidate: NOW + 14 * MIN, sandbox_reap_terminal: NOW + 5 * MIN } });
    expect(await reconcileNextDueAt(pool as never, summaryWith("budget"), NOW)).toBe(NOW + 5 * MIN);
  });

  it("a reap pass that stopped on its budget, or was not yet due, is looked at again at its due time (never in the past)", async () => {
    for (const terminal of ["budget", "not_due"]) {
      const pool = fakePool({ creditsBroken: false, dueAt: { sandbox_reap_terminal: NOW - 5 * MIN } });
      expect(await reconcileNextDueAt(pool as never, summaryWith(terminal), NOW)).toBe(NOW);
    }
  });

  it("idle: nothing broken and a finished reap pass leave no due time, so the reconciler stays on the slow cadence", async () => {
    const pool = fakePool({ creditsBroken: false, dueAt: {} });
    expect(await reconcileNextDueAt(pool as never, summaryWith("ok"), NOW)).toBeNull();
    expect(await reconcileNextDueAt(pool as never, summaryWith("disabled"), NOW)).toBeNull();
  });

  it("a failed next-due read fails toward the work: the gate looks again in 15 minutes, and the failure is reported", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(clock.value);
    vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const reports: string[] = [];
      const pool = { query: vi.fn(async () => { throw new Error("db down"); }) };
      const runTickFn = vi.fn(async (): Promise<TickSummary> => ({ enabled: true, results: [] }));
      const call = () =>
        reconcileHandler(new NextRequest("https://example.test/api/cron/reconcile", { method: "GET", headers: { authorization: `Bearer ${SECRET}` } }), { cronSecret: SECRET, enabled: true, platformOpsPool: pool as never, reportError: (_e, c) => void reports.push(c.stage) }, runTickFn);
      await call();
      expect(reports).toEqual(["reconcile.next_due"]);
      clock.value += 14 * MIN;
      vi.setSystemTime(clock.value);
      await call();
      expect(runTickFn).toHaveBeenCalledTimes(1); // not yet: 14 minutes
      clock.value += 2 * MIN;
      vi.setSystemTime(clock.value);
      await call();
      expect(runTickFn).toHaveBeenCalledTimes(2); // the 15-minute retry came due, long before the slow cadence
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("end to end: a top-up pause is re-checked at the 15-minute cron tick, and a quiet deployment is not woken", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(clock.value);
    vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      let broken = true;
      const dueAt = () => clock.value + 14 * MIN; // the credits job was due 15 minutes (less its slack) after its last pass
      const pool = { query: vi.fn(async (sql: string) => (sql.includes("FROM model_connections") ? { rows: [{ broken, age: broken ? 0 : null }] } : { rows: [{ name: "model_credits_revalidate", due: dueAt() }] })) };
      const runTickFn = vi.fn(async (): Promise<TickSummary> => ({ enabled: true, results: [{ job: "model_credits_revalidate", result: "ok" }] }));
      const call = () =>
        reconcileHandler(new NextRequest("https://example.test/api/cron/reconcile", { method: "GET", headers: { authorization: `Bearer ${SECRET}` } }), { cronSecret: SECRET, enabled: true, platformOpsPool: pool as never, reportError: () => undefined }, runTickFn);
      const advance = (ms: number): void => {
        clock.value += ms;
        vi.setSystemTime(clock.value);
      };
      await call(); // first tick connects; a connection is broken for credits
      let runs = 1;
      for (let i = 0; i < 4; i++) {
        advance(15 * MIN);
        await call();
        runs += 1; // every cron tick connects while the connection is broken
        expect(runTickFn).toHaveBeenCalledTimes(runs);
      }
      broken = false; // the top-up landed and the last pass cleared it
      advance(15 * MIN);
      await call();
      runs += 1;
      expect(runTickFn).toHaveBeenCalledTimes(runs); // that tick still ran (its due time came from the previous pass)
      for (let i = 0; i < 6; i++) {
        advance(15 * MIN);
        await call();
      }
      expect(runTickFn).toHaveBeenCalledTimes(runs); // back on the slow cadence: no more connections inside the same hour slot
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});
