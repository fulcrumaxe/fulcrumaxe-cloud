import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { MARKER_GRACE_MS, markWorkPending, setPendingHooks } from "@fx/core/src/pendingWork";
import { makeRegion, storeOf, type FakeRegion } from "../../../../test/support/runtimeCacheFake";
import { handoffSweepHandler, PASS_GAP_MS, type HandoffSweepHandlerDeps } from "./handler";

/** D#599 HO-2b: the cron's route layer behind the pending-work marker, no database (the sweep's own cases are packages/worker/test/runHandoffs.pg.test.ts). */
const SECRET = "test-cron-secret";
const NONE = { listed: 0, completed: 0, failed: 0, waiting: 0, errors: 0, nextDueAt: null as number | null };
const KEY = "pending:handoff-sweep";
const clock = { value: Date.parse("2026-10-11T12:00:00Z") };
let region: FakeRegion;

function setup(over: Partial<HandoffSweepHandlerDeps> = {}, sweep: () => Promise<typeof NONE> = async () => NONE) {
  const sweepRunHandoffs = vi.fn(sweep);
  const getWorker = vi.fn(async (): Promise<{ sweepRunHandoffs: typeof sweepRunHandoffs } | null> => ({ sweepRunHandoffs }));
  // Each sleep advances the shared clock, as real time would.
  const sleep = vi.fn(async (ms: number) => { clock.value += ms; });
  const log = vi.fn();
  return { sweepRunHandoffs, getWorker, sleep, log, deps: { cronSecret: SECRET, getWorker, log, sleep, now: () => clock.value, ...over } satisfies HandoffSweepHandlerDeps };
}
const req = (authorization: string | null) => new NextRequest("https://example.test/api/cron/handoff-sweep", { method: "GET", headers: authorization === null ? {} : { authorization } });
const run = (s: ReturnType<typeof setup>) => handoffSweepHandler(req(`Bearer ${SECRET}`), s.deps);
const marker = (): number | null => {
  const e = region.entries.get(KEY);
  return e ? (JSON.parse(e.json) as number) : null;
};

beforeEach(() => {
  region = makeRegion(clock);
  setPendingHooks({ store: storeOf(region) });
  // A recent last-connect, so the half-hour backstop is not what opens the gate.
  region.entries.set("lastrun:handoff-sweep", { json: JSON.stringify(clock.value), expiresAt: clock.value + 3_600_000 });
});
afterEach(() => setPendingHooks(null));

describe("GET /api/cron/handoff-sweep", () => {
  it.each([
    ["no header", null, SECRET],
    ["a wrong secret", "Bearer nope", SECRET],
    ["a customer API token", "Bearer fxat_notarealcronsecretatall000000000000000", SECRET],
    ["an unset secret", "Bearer ", ""],
  ])("401s with %s and builds no worker", async (_n, header, secret) => {
    const s = setup({ cronSecret: secret });
    expect((await handoffSweepHandler(req(header), s.deps)).status).toBe(401);
    expect(s.getWorker).not.toHaveBeenCalled();
  });

  it("an idle platform (no marker) builds no worker and opens no connection, on either pass", async () => {
    const s = setup();
    expect(await (await run(s)).json()).toEqual({ passes: [{ skipped: true }, { skipped: true }] });
    expect(s.getWorker).not.toHaveBeenCalled();
    expect(s.sweepRunHandoffs).not.toHaveBeenCalled();
  });

  it("a handoff due now wakes it: both passes sweep, 30 s apart, and the marker is rewritten to the deadline still ahead", async () => {
    expect(PASS_GAP_MS).toBe(30_000);
    const T = clock.value;
    await markWorkPending("handoff-sweep", { since: T });
    const ahead = T + 4 * 60_000;
    const s = setup({}, async () => ({ ...NONE, listed: 1, waiting: 1, nextDueAt: ahead }));
    const res = await run(s);
    expect(await res.json()).toEqual({ passes: [{ configured: true, listed: 1, completed: 0, failed: 0, waiting: 1, errors: 0 }, { skipped: true }] });
    // The first pass connected and moved the marker to the deadline; the second, 30 s later, is not yet due.
    expect(s.sweepRunHandoffs).toHaveBeenCalledTimes(1);
    expect(s.sleep.mock.calls).toEqual([[30_000]]);
    expect(marker()).toBe(ahead);
  });

  it("a sweep that finds nothing live clears the marker, so the next invocation connects to nothing", async () => {
    // A marker younger than the grace is kept (its writer may not have committed yet), so this one is older.
    await markWorkPending("handoff-sweep", { since: clock.value - 2 * MARKER_GRACE_MS });
    const s = setup();
    await run(s);
    expect(s.sweepRunHandoffs).toHaveBeenCalledTimes(1);
    expect(marker()).toBeNull();
    const s2 = setup();
    await run(s2);
    expect(s2.getWorker).not.toHaveBeenCalled();
  });

  it("a sweep that has to come back soon (GitHub could not be asked) keeps the marker due, and both passes sweep", async () => {
    await markWorkPending("handoff-sweep", { since: clock.value });
    const s = setup({}, async () => ({ ...NONE, listed: 1, waiting: 1, nextDueAt: clock.value + 30_000 }));
    await run(s);
    expect(s.sweepRunHandoffs).toHaveBeenCalledTimes(2);
  });

  it("a worker that is not configured answers so, once, and clears nothing it did not read", async () => {
    await markWorkPending("handoff-sweep", { since: clock.value });
    const s = setup({ getWorker: vi.fn(async () => null) });
    const body = (await (await run(s)).json()) as { passes: unknown[] };
    expect(body.passes[0]).toEqual({ configured: false });
    expect(s.log).toHaveBeenCalledWith("handoff sweep: worker not configured");
  });
});
