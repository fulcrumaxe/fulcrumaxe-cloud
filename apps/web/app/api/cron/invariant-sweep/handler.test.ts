import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { markWorkPending, setPendingHooks } from "@fx/core/src/pendingWork";
import { makeRegion, storeOf, type FakeRegion } from "../../../../test/support/runtimeCacheFake";
import { COVER_MS, invariantSweepHandler, PASS_GAP_MS, type InvariantSweepHandlerDeps } from "./handler";

/** D#597 CC-8: the cron's route layer behind the pending-work marker, no database (the rules' own cases are packages/worker/test/invariantSweep.pg.test.ts). */
const SECRET = "test-cron-secret";
const COUNTS = { checked: 2, raised: { stage_not_moved: 0, usage_not_recorded: 0 }, failed: 0 };
const KEY = "pending:invariant-sweep";
const clock = { value: Date.parse("2026-10-10T12:00:00Z") };
let region: FakeRegion;

function setup(over: Partial<InvariantSweepHandlerDeps> = {}) {
  const sweepInvariants = vi.fn(async () => COUNTS);
  const getWorker = vi.fn(async (): Promise<{ sweepInvariants: typeof sweepInvariants } | null> => ({ sweepInvariants }));
  // Each sleep advances the shared clock, as real time would.
  const sleep = vi.fn(async (ms: number) => { clock.value += ms; });
  const log = vi.fn();
  return { sweepInvariants, getWorker, sleep, log, deps: { cronSecret: SECRET, getWorker, log, sleep, paused: () => false, now: () => clock.value, ...over } satisfies InvariantSweepHandlerDeps };
}
const req = (authorization: string | null) => new NextRequest("https://example.test/api/cron/invariant-sweep", { method: "GET", headers: authorization === null ? {} : { authorization } });
const run = (s: ReturnType<typeof setup>) => invariantSweepHandler(req(`Bearer ${SECRET}`), s.deps);
const marker = (): number | null => {
  const e = region.entries.get(KEY);
  return e ? (JSON.parse(e.json) as number) : null;
};

beforeEach(() => {
  region = makeRegion(clock);
  setPendingHooks({ store: storeOf(region) });
  // A recent last-connect, so the half-hour backstop is not what opens the gate.
  region.entries.set("lastrun:invariant-sweep", { json: JSON.stringify(clock.value), expiresAt: clock.value + 3_600_000 });
});
afterEach(() => setPendingHooks(null));

describe("GET /api/cron/invariant-sweep", () => {
  it.each([
    ["no header", null, SECRET],
    ["a wrong secret", "Bearer nope", SECRET],
    ["a customer API token", "Bearer fxat_notarealcronsecretatall000000000000000", SECRET],
    ["an unset secret", "Bearer ", ""],
  ])("401s with %s and builds no worker", async (_n, header, secret) => {
    const s = setup({ cronSecret: secret });
    expect((await invariantSweepHandler(req(header), s.deps)).status).toBe(401);
    expect(s.getWorker).not.toHaveBeenCalled();
  });

  it("an idle platform (no marker) builds no worker and opens no connection, on either pass", async () => {
    const s = setup();
    const res = await run(s);
    expect(await res.json()).toEqual({ configured: true, passes: [{ skipped: true }, { skipped: true }] });
    expect(s.getWorker).not.toHaveBeenCalled();
    expect(s.sweepInvariants).not.toHaveBeenCalled();
  });

  it("a completed run wakes it: both passes sweep, 30 s apart, and the marker stays while the cover lasts", async () => {
    expect(PASS_GAP_MS).toBe(30_000);
    const T = clock.value;
    await markWorkPending("invariant-sweep", { now: T });
    const s = setup();
    const res = await run(s);
    expect(await res.json()).toEqual({ configured: true, passes: [COUNTS, COUNTS] });
    expect(s.sweepInvariants).toHaveBeenCalledTimes(2);
    expect(s.sleep.mock.calls).toEqual([[30_000]]);
    expect(marker()).toBe(T); // 30 s after completion: still covered, and the age keeps counting from the completion
  });

  it("after the cover has passed, the pass that connects clears the marker and the next invocation connects to nothing", async () => {
    const T = clock.value;
    await markWorkPending("invariant-sweep", { now: T });
    clock.value = T + COVER_MS + 1_000;
    const s = setup();
    await run(s);
    expect(s.sweepInvariants).toHaveBeenCalledTimes(1); // pass 1 connected; the marker is cleared, so pass 2 (30 s later) is skipped
    expect(marker()).toBeNull();
    const s2 = setup();
    await run(s2);
    expect(s2.getWorker).not.toHaveBeenCalled();
  });

  it("a newer completion restarts the cover", async () => {
    const T = clock.value;
    await markWorkPending("invariant-sweep", { now: T });
    clock.value = T + 100_000;
    await markWorkPending("invariant-sweep", { now: clock.value });
    expect(marker()).toBe(T + 100_000);
  });

  it("ends before reading the marker while the staging project is paused", async () => {
    await markWorkPending("invariant-sweep", { now: clock.value });
    const reads = region.calls.get;
    const s = setup({ paused: () => true });
    expect(await (await run(s)).json()).toEqual({ skipped: true, reason: "paused" });
    expect(s.getWorker).not.toHaveBeenCalled();
    expect(region.calls.get).toBe(reads);
  });

  it("answers 200 and sweeps nothing while no worker is configured", async () => {
    await markWorkPending("invariant-sweep", { now: clock.value });
    const s = setup({ getWorker: async () => null });
    expect(await (await run(s)).json()).toEqual({ configured: false, passes: [] });
    expect(s.log).toHaveBeenCalledWith("invariant sweep: worker not configured");
  });

  it("is scheduled every minute in vercel.json, so two passes make a 30 second cadence", () => {
    const config = JSON.parse(readFileSync(new URL("../../../../vercel.json", import.meta.url), "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    expect(config.crons.filter((c) => c.path === "/api/cron/invariant-sweep")).toEqual([{ path: "/api/cron/invariant-sweep", schedule: "* * * * *" }]);
  });
});
