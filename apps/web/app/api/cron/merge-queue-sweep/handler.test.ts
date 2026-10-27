import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { markWorkPending, setPendingHooks } from "@fx/core/src/pendingWork";
import { makeRegion, storeOf, type FakeRegion } from "../../../../test/support/runtimeCacheFake";
import { mergeQueueSweepHandler, type MergeQueueSweepHandlerDeps } from "./handler";

/**
 * D#519 MQ3-b: the merge queue sweep's route layer. Auth first (an unset secret fails closed), then the pending-work marker: with no
 * marker the tick calls nothing and opens no connection. The sweep itself is packages/pipeline/test/mergeQueue/tick.pg.test.ts.
 */
const SECRET = "test-cron-secret";
const RECHECK = 330_000;
const clock = { value: Date.parse("2026-10-27T12:00:00Z") };
const KEY = "pending:merge-queue-sweep";
let region: FakeRegion;

beforeEach(() => {
  region = makeRegion(clock);
  setPendingHooks({ store: storeOf(region) });
  region.entries.set("lastrun:merge-queue-sweep", { json: JSON.stringify(clock.value), expiresAt: clock.value + 3_600_000 });
});
afterEach(() => setPendingHooks(null));

const counts = (over: Partial<{ listed: number; reclaimed: number; ticked: number; failed: number }> = {}) => ({ listed: 0, reclaimed: 0, ticked: 0, failed: 0, ...over });
function setup(result: ReturnType<typeof counts> | null = counts()) {
  const sweep = vi.fn(async () => result);
  const deps = { cronSecret: SECRET, sweep, recheckMs: RECHECK, log: vi.fn(), now: () => clock.value } satisfies MergeQueueSweepHandlerDeps;
  return { sweep, deps };
}
const req = (authorization: string | null) => new NextRequest("https://example.test/api/cron/merge-queue-sweep", { method: "GET", headers: authorization === null ? {} : { authorization } });
const marker = (): number | null => {
  const e = region.entries.get(KEY);
  return e ? (JSON.parse(e.json) as number) : null;
};

describe("GET /api/cron/merge-queue-sweep", () => {
  it.each([
    ["no header", null, SECRET],
    ["a wrong secret", "Bearer nope", SECRET],
    ["a customer API token", "Bearer fxat_notarealcronsecretatall000000000000000", SECRET],
    ["an unset secret", "Bearer ", ""],
  ])("answers 401 with %s and runs nothing", async (_n, header, secret) => {
    await markWorkPending("merge-queue-sweep", { since: clock.value });
    const s = setup();
    const res = await mergeQueueSweepHandler(req(header), { ...s.deps, cronSecret: secret });
    expect(res.status).toBe(401);
    expect(s.sweep).not.toHaveBeenCalled();
    expect(marker()).toBe(clock.value);
  });

  it("with no pending marker the sweep is not called: no worker, no connection", async () => {
    const s = setup();
    const res = await mergeQueueSweepHandler(req(`Bearer ${SECRET}`), s.deps);
    expect(await res.json()).toEqual({ skipped: true, reason: "no_pending_work" });
    expect(s.sweep).not.toHaveBeenCalled();
  });

  it("with a marker and nothing to do, one pass runs and clears the marker, so an idle platform stays idle", async () => {
    await markWorkPending("merge-queue-sweep", { since: clock.value - 120_000 });
    const s = setup(counts());
    const res = await mergeQueueSweepHandler(req(`Bearer ${SECRET}`), s.deps);
    expect(await res.json()).toEqual({ configured: true, listed: 0, reclaimed: 0, ticked: 0, failed: 0 });
    expect(s.sweep).toHaveBeenCalledTimes(1);
    expect(marker()).toBeNull();
  });

  it("a repo that still had work asks to be looked at again a little after the lease, and the idle ticks between call nothing", async () => {
    await markWorkPending("merge-queue-sweep", { since: clock.value - 120_000 });
    const s = setup(counts({ listed: 1, ticked: 1 }));
    expect(await (await mergeQueueSweepHandler(req(`Bearer ${SECRET}`), s.deps)).json()).toMatchObject({ configured: true, listed: 1, ticked: 1 });
    expect(marker()).toBe(clock.value + RECHECK);
    expect(await (await mergeQueueSweepHandler(req(`Bearer ${SECRET}`), s.deps)).json()).toEqual({ skipped: true, reason: "no_pending_work" });
    expect(s.sweep).toHaveBeenCalledTimes(1);
  });

  it("a repo whose tick failed is looked at again; an unconfigured worker answers configured: false and keeps no marker", async () => {
    await markWorkPending("merge-queue-sweep", { since: clock.value - 120_000 });
    await mergeQueueSweepHandler(req(`Bearer ${SECRET}`), setup(counts({ failed: 1 })).deps);
    expect(marker()).toBe(clock.value + RECHECK);
    await markWorkPending("merge-queue-sweep", { since: clock.value - 120_000 });
    const none = setup(null);
    expect(await (await mergeQueueSweepHandler(req(`Bearer ${SECRET}`), none.deps)).json()).toEqual({ configured: false });
    expect(marker()).toBeNull();
  });
});
