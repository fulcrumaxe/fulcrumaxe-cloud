import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVITY_KEY,
  BACKSTOP_MS,
  CRON_TICK_TTL_SECONDS,
  IDLE_BACKSTOP_MS,
  PAUSED_BACKSTOP_MS,
  CONNECTS_WHILE_PAUSED,
  SWEEP_NAMES,
  SWEEP_SCHEDULE_MS,
  effectiveBackstopMs,
  readCronCache,
  runGatedTick,
  setPendingHooks,
  type SweepName,
} from "@fx/core/src/pendingWork";
import { handoffSweepHandler } from "../app/api/cron/handoff-sweep/handler";
import { invariantSweepHandler } from "../app/api/cron/invariant-sweep/handler";
import { readCronLiveness } from "../lib/cronLiveness";
import { healthResponse } from "../app/api/health/handler";
import { GET } from "../app/api/health/route";
import { makeRegion, storeOf, type FakeRegion } from "./support/runtimeCacheFake";

/**
 * CRON-OBS-1: every cron call leaves its time in the no-database store; a tick that connects also reports through `recordConnected`;
 * the operator view of /api/health carries both ages and the public body does not change.
 */
const MIN = 60_000;
const clock = { value: Date.parse("2026-10-27T12:00:00Z") };
let region: FakeRegion;
const connected: Array<[SweepName, number]> = [];

function install(): void {
  setPendingHooks({
    store: storeOf(region),
    recordConnected: async (name, at) => {
      connected.push([name, at]);
    },
  });
}
const tickOf = (name: SweepName): number | null => {
  const e = region.entries.get(`tick:${name}`);
  return e ? (JSON.parse(e.json) as number) : null;
};

beforeEach(() => {
  region = makeRegion(clock);
  connected.length = 0;
  install();
});
afterEach(() => {
  setPendingHooks(null);
  vi.unstubAllEnvs();
});

describe("a cron call records its tick", () => {
  it.each(SWEEP_NAMES)("%s: a call that ends at the gate still writes its tick, with the gate's own two reads and no database report", async (name) => {
    region.entries.set(`lastrun:${name}`, { json: JSON.stringify(clock.value), expiresAt: clock.value + 3_600_000 * 8 });
    const run = vi.fn(async () => ({ result: "x", workFound: false, nextDueAt: null }));
    const out = await runGatedTick(name, run, () => {}, () => clock.value);
    expect(out).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(tickOf(name)).toBe(clock.value);
    expect(region.entries.get(`tick:${name}`)!.expiresAt).toBe(clock.value + CRON_TICK_TTL_SECONDS * 1000);
    expect(connected).toEqual([]); // a skipped tick opens no connection, so it reports none
  });

  it("a call that connects (no last-run on record: the backstop) writes the tick AND reports the connection once", async () => {
    const run = vi.fn(async () => ({ result: "x", workFound: false, nextDueAt: null }));
    await runGatedTick("reconcile", run, () => {}, () => clock.value);
    expect(run).toHaveBeenCalledTimes(1);
    expect(tickOf("reconcile")).toBe(clock.value);
    expect(connected).toEqual([["reconcile", clock.value]]);
  });

  it("a signed kick is not a cron call: it records no tick (a dead cron must not look alive because of kicks)", async () => {
    const run = vi.fn(async () => ({ result: "x", workFound: false, nextDueAt: null }));
    await runGatedTick("api-sweep", run, () => {}, () => clock.value, { force: true });
    expect(tickOf("api-sweep")).toBeNull();
    expect(connected).toEqual([["api-sweep", clock.value]]); // it did connect
  });

  it("a failing cache write or database report never fails the tick", async () => {
    const reports: string[] = [];
    setPendingHooks({
      store: { get: async () => null, set: async () => Promise.reject(new Error("cache down")), delete: async () => {} },
      recordConnected: async () => Promise.reject(new Error("db down")),
      reportError: (_e, stage) => void reports.push(stage),
    });
    const run = vi.fn(async () => ({ result: "ok", workFound: false, nextDueAt: null }));
    expect(await runGatedTick("api-sweep", run, () => {}, () => clock.value)).toEqual({ result: "ok" });
    expect(reports).toEqual(expect.arrayContaining(["pending_work.tick", "pending_work.tick_db"]));
  });

  it("with no hooks installed nothing is written and nothing throws", async () => {
    setPendingHooks(null);
    const run = vi.fn(async () => ({ result: "ok", workFound: false, nextDueAt: null }));
    expect(await runGatedTick("api-sweep", run, () => {}, () => clock.value)).toEqual({ result: "ok" });
  });

  it("the handoff cron makes two passes per call and records ONE tick", async () => {
    vi.stubEnv("CRON_SECRET", "s");
    region.entries.set("lastrun:handoff-sweep", { json: JSON.stringify(clock.value), expiresAt: clock.value + 3_600_000 });
    const sets: string[] = [];
    const store = storeOf(region);
    setPendingHooks({ store: { ...store, set: (k, v, t) => (sets.push(k), store.set(k, v, t)) } });
    const res = await handoffSweepHandler(
      new NextRequest("https://example.test/api/cron/handoff-sweep", { headers: { authorization: "Bearer s" } }),
      { cronSecret: "s", getWorker: async () => null, log: () => {}, sleep: async () => {}, now: () => clock.value },
    );
    expect(res.status).toBe(200);
    expect(sets.filter((k) => k === "tick:handoff-sweep")).toHaveLength(1);
  });

  it("the invariant cron records its tick while staging is paused, and again when it is not, with no worker built", async () => {
    const getWorker = vi.fn(async () => null);
    const mk = (paused: boolean) =>
      invariantSweepHandler(new NextRequest("https://example.test/api/cron/invariant-sweep", { headers: { authorization: "Bearer s" } }), {
        cronSecret: "s",
        getWorker,
        log: () => {},
        sleep: async () => {},
        paused: () => paused,
        now: () => clock.value,
      });
    expect(await (await mk(true)).json()).toEqual({ skipped: true, reason: "paused" });
    expect(tickOf("invariant-sweep")).toBe(clock.value);
    expect(getWorker).not.toHaveBeenCalled();
    clock.value += MIN;
    region.entries.set("lastrun:invariant-sweep", { json: JSON.stringify(clock.value), expiresAt: clock.value + 3_600_000 });
    await mk(false);
    expect(tickOf("invariant-sweep")).toBe(clock.value);
    expect(getWorker).not.toHaveBeenCalled(); // the gate was closed
  });

  it("an unauthenticated call records nothing", async () => {
    const res = await invariantSweepHandler(new NextRequest("https://example.test/api/cron/invariant-sweep"), {
      cronSecret: "s",
      getWorker: async () => null,
      log: () => {},
      now: () => clock.value,
    });
    expect(res.status).toBe(401);
    expect(region.calls.set).toBe(0);
  });
});

describe("the schedule table is the one in vercel.json", () => {
  it("matches, sweep by sweep (the smallest gap between the minutes a cron fires in)", () => {
    const cfg = JSON.parse(readFileSync(join(__dirname, "..", "vercel.json"), "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    const gap = (minuteField: string): number => {
      if (minuteField === "*") return 1;
      const step = /^\*\/(\d+)$/.exec(minuteField);
      if (step) return Number(step[1]);
      const list = minuteField.split(",").map(Number).sort((a, b) => a - b);
      return Math.min(...list.map((m, i) => (i === 0 ? list[0]! + 60 - list[list.length - 1]! : m - list[i - 1]!)));
    };
    const fromJson = Object.fromEntries(cfg.crons.map((c) => [c.path.replace("/api/cron/", ""), gap(c.schedule.split(" ")[0]!) * MIN]));
    expect(fromJson).toEqual(SWEEP_SCHEDULE_MS);
  });
});

describe("effectiveBackstopMs", () => {
  it("is 30 minutes active, 60 idle, 4x for the reconciler, and a flat 12 hours while paused", () => {
    expect(effectiveBackstopMs("api-sweep", { paused: false, idle: false })).toBe(BACKSTOP_MS);
    expect(effectiveBackstopMs("api-sweep", { paused: false, idle: true })).toBe(IDLE_BACKSTOP_MS);
    expect(effectiveBackstopMs("reconcile", { paused: false, idle: false })).toBe(4 * BACKSTOP_MS);
    expect(effectiveBackstopMs("reconcile", { paused: false, idle: true })).toBe(4 * IDLE_BACKSTOP_MS);
    expect(effectiveBackstopMs("reconcile", { paused: true, idle: false })).toBe(PAUSED_BACKSTOP_MS);
    expect(effectiveBackstopMs("api-sweep", { paused: true, idle: true })).toBe(PAUSED_BACKSTOP_MS);
  });
});

describe("readCronLiveness", () => {
  it("reports cache age and connected age per sweep; a cache miss and a missing row are null; idle follows the activity key", async () => {
    region.entries.set("tick:api-sweep", { json: JSON.stringify(clock.value - 3 * MIN), expiresAt: clock.value + MIN });
    const pool = { query: vi.fn(async () => ({ rows: [{ sweep: "api-sweep", tick: clock.value - 20 * MIN, connected: clock.value - 20 * MIN }, { sweep: "reconcile", tick: clock.value - 5 * MIN, connected: clock.value - 5 * MIN }] })) };
    const live = await readCronLiveness(clock.value, pool as never, false);
    expect(live).toMatchObject({ paused: false, idle: true, cache: true, vercel_env: null });
    expect((await readCronLiveness(clock.value, pool as never, false, { VERCEL_ENV: "production" })).vercel_env).toBe("production");
    expect(live.sweeps["api-sweep"]).toEqual({ schedule_ms: 5 * MIN, connects_while_paused: true, backstop_ms: IDLE_BACKSTOP_MS, tick_age_ms: 3 * MIN, connected_age_ms: 20 * MIN });
    expect(live.sweeps.reconcile).toEqual({ schedule_ms: 15 * MIN, connects_while_paused: true, backstop_ms: 4 * IDLE_BACKSTOP_MS, tick_age_ms: null, connected_age_ms: 5 * MIN });
    expect(live.sweeps["merge-queue-sweep"]).toEqual({ schedule_ms: MIN, connects_while_paused: true, backstop_ms: IDLE_BACKSTOP_MS, tick_age_ms: null, connected_age_ms: null });
    region.entries.set(ACTIVITY_KEY, { json: JSON.stringify(clock.value - MIN), expiresAt: clock.value + MIN });
    expect((await readCronLiveness(clock.value, pool as never, false)).sweeps["api-sweep"]!.backstop_ms).toBe(BACKSTOP_MS);
    expect((await readCronLiveness(clock.value, pool as never, true)).sweeps["api-sweep"]!.backstop_ms).toBe(PAUSED_BACKSTOP_MS);
  });

  it("an unreadable table leaves connected ages null instead of failing", async () => {
    const pool = { query: vi.fn(async () => Promise.reject(new Error("no table"))) };
    const live = await readCronLiveness(clock.value, pool as never, false);
    expect(live.sweeps["api-sweep"]!.connected_age_ms).toBeNull();
  });

  it("reports connects_while_paused: false for the invariant sweep alone, from the table next to the schedules", async () => {
    const live = await readCronLiveness(clock.value, null, true);
    expect(Object.entries(live.sweeps).filter(([, v]) => !v.connects_while_paused).map(([k]) => k)).toEqual(["invariant-sweep"]);
    expect(Object.keys(CONNECTS_WHILE_PAUSED).sort()).toEqual([...SWEEP_NAMES].sort());
  });

  it("a malformed DATABASE_URL_PLATFORM_OPS, or a pool factory that throws, gives null connected ages and not a thrown error", async () => {
    vi.resetModules();
    vi.stubEnv("DATABASE_URL_PLATFORM_OPS", "::not a url::");
    const fresh = await import("../lib/cronLiveness");
    const live = await fresh.readCronLiveness(clock.value, undefined, false);
    expect(Object.values(live.sweeps).every((s) => s.connected_age_ms === null)).toBe(true);
    vi.resetModules();
    vi.doMock("@fx/db/src/pool", () => ({
      createPool: () => {
        throw new Error("bad url");
      },
    }));
    vi.stubEnv("DATABASE_URL_PLATFORM_OPS", "postgres://x@127.0.0.1:1/none");
    const thrower = await import("../lib/cronLiveness");
    expect((await thrower.readCronLiveness(clock.value, undefined, false)).sweeps["api-sweep"]!.connected_age_ms).toBeNull();
    vi.doUnmock("@fx/db/src/pool");
  });

  it("reads the cache with no database when no pool is given", async () => {
    const live = await readCronLiveness(clock.value, null, false);
    expect(Object.keys(live.sweeps)).toEqual([...SWEEP_NAMES]);
    expect((await readCronCache(clock.value)).store).toBe(true);
  });
});

describe("/api/health", () => {
  const OPERATOR = "o".repeat(40); // built, not a literal: a fixture that is obviously not a credential
  const live = { paused: false, idle: true, cache: true, vercel_env: "production", sweeps: {} };

  it("the public body is byte-for-byte the same with and without the cron argument; the operator branch alone carries it", async () => {
    const plain = await healthResponse({}, null, clock.value).json();
    expect(await healthResponse({}, null, clock.value, live).json()).toEqual(plain);
    expect(await healthResponse({ CRON_SECRET: OPERATOR }, `Bearer ${"w".repeat(40)}`, clock.value, live).json()).not.toHaveProperty("cron");
    expect(await healthResponse({ CRON_SECRET: OPERATOR }, `Bearer ${OPERATOR}`, clock.value, live).json()).toHaveProperty("cron", live);
    expect(await healthResponse({ CRON_SECRET: OPERATOR }, `Bearer ${OPERATOR}`, clock.value).json()).not.toHaveProperty("cron");
  });

  it("the route reads the cron ages only for the operator who asks with ?cron=1", async () => {
    vi.stubEnv("CRON_SECRET", OPERATOR);
    region.entries.set("tick:api-sweep", { json: JSON.stringify(Date.now() - MIN), expiresAt: Date.now() + 10 * MIN });
    const call = (url: string, auth: string | null) => GET(new NextRequest(url, { headers: auth ? { authorization: auth } : {} }));
    const anon = await call("https://example.test/api/health?cron=1", null);
    expect(anon).not.toBeInstanceOf(Promise);
    expect(await anon.json()).not.toHaveProperty("cron");
    const wrong = await call("https://example.test/api/health?cron=1", "Bearer nope");
    expect(await wrong.json()).not.toHaveProperty("cron");
    const operatorPlain = await call("https://example.test/api/health", `Bearer ${OPERATOR}`);
    expect(await operatorPlain.json()).not.toHaveProperty("cron");
    const body = (await (await call("https://example.test/api/health?cron=1", `Bearer ${OPERATOR}`)).json()) as { cron: { sweeps: Record<string, { tick_age_ms: number | null }> } };
    expect(body.cron.sweeps["api-sweep"]!.tick_age_ms).toBeGreaterThanOrEqual(MIN);
    expect(Object.keys(body.cron.sweeps)).toEqual([...SWEEP_NAMES]);
  });
});
