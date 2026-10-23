import net from "node:net";
import tls from "node:tls";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { markWorkPending, setPendingHooks } from "@fx/core/src/pendingWork";
import { makeRegion, storeOf, type FakeRegion } from "../../../../test/support/runtimeCacheFake";
import { branchCleanupHandler, type BranchCleanupHandlerDeps } from "./handler";

/**
 * D#598 P1f-5d, acceptance 5: the cron's route layer behind the pending-work marker. With no marker the tick builds no worker, runs no statement and
 * makes no outbound call. The worker is a stand-in that asks the counting pool for the due list the way the real sweep's first statement does (this app
 * cannot import the worker's internals); the sweep itself is packages/worker/test/branchCleanup.pg.test.ts and the list packages/db/test/branch-cleanup-lister.pg.test.ts.
 */
const SECRET = "test-cron-secret";
const KEY = "pending:branch-cleanup";
const clock = { value: Date.parse("2026-10-22T12:00:00Z") };
let region: FakeRegion;

/** A pool that records every statement and answers the due list with `rows`. */
function countingPool(rows: Array<{ account_id: string; work_item_id: string }> = []) {
  const statements: string[] = [];
  const pool = { query: vi.fn(async (sql: string) => (statements.push(sql), { rows })) } as unknown as Pool;
  return { pool, statements };
}

function setup(over: Partial<BranchCleanupHandlerDeps> = {}, pool = countingPool()) {
  const github = vi.fn(async () => {
    throw new Error("no GitHub client in a test that must open none");
  });
  /** One statement for the list; an item that is listed cannot be read on the counting pool, so it is counted failed and asked for again in 15 minutes. */
  const sweepSpy = vi.fn(async (_input: { github: BranchCleanupHandlerDeps["github"] }) => {
    const { rows } = (await pool.pool.query("SELECT account_id, work_item_id FROM branch_cleanup_list_due($1::integer)", [50])) as unknown as { rows: unknown[] };
    return { configured: true, listed: rows.length, deleted: 0, left: 0, recorded: 0, failed: rows.length, nextDueAt: rows.length > 0 ? clock.value + 15 * 60_000 : null };
  });
  /** D#598: the stale pull-request sweep's stand-in: one statement for its list, as the real sweep's first one. */
  const prSweepSpy = vi.fn(async (_input: { github: NonNullable<BranchCleanupHandlerDeps["prState"]> }) => {
    const { rows } = (await pool.pool.query("SELECT account_id, work_item_id FROM pr_slot_reconcile_list_due($1::integer)", [50])) as unknown as { rows: unknown[] };
    return { listed: rows.length, moved: 0, unchanged: 0, failed: 0 };
  });
  const getWorker = vi.fn(async () => ({ sweepBranchCleanups: sweepSpy, sweepPrSlotHolders: prSweepSpy }));
  const log = vi.fn();
  return { ...pool, github, getWorker, log, prSweepSpy, deps: { cronSecret: SECRET, getWorker, github, log, now: () => clock.value, ...over } satisfies BranchCleanupHandlerDeps };
}
const req = (authorization: string | null) => new NextRequest("https://example.test/api/cron/branch-cleanup", { method: "GET", headers: authorization === null ? {} : { authorization } });
const marker = (): number | null => {
  const e = region.entries.get(KEY);
  return e ? (JSON.parse(e.json) as number) : null;
};

/** Anything that would leave the process: the global fetch and a raw socket connect (the net-guard's pinned connector sits on these). */
let outboundCalls: number;
beforeEach(() => {
  region = makeRegion(clock);
  setPendingHooks({ store: storeOf(region) });
  region.entries.set("lastrun:branch-cleanup", { json: JSON.stringify(clock.value), expiresAt: clock.value + 3_600_000 });
  outboundCalls = 0;
  const count = () => {
    outboundCalls += 1;
    throw new Error("outbound call in a test that must make none");
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(count as never);
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(count as never);
  vi.spyOn(tls, "connect").mockImplementation(count as never);
});
afterEach(() => {
  setPendingHooks(null);
  vi.restoreAllMocks();
});

describe("GET /api/cron/branch-cleanup", () => {
  it.each([
    ["no header", null, SECRET],
    ["a wrong secret", "Bearer nope", SECRET],
    ["a customer API token", "Bearer fxat_notarealcronsecretatall000000000000000", SECRET],
    ["an unset secret", "Bearer ", ""],
  ])("answers 401 with %s and does nothing: no worker, no statement, no outbound call, no marker change", async (_n, header, secret) => {
    await markWorkPending("branch-cleanup", { since: clock.value });
    const s = setup({ cronSecret: secret });
    const res = await branchCleanupHandler(req(header), s.deps);
    expect(res.status).toBe(401);
    expect(s.getWorker).not.toHaveBeenCalled();
    expect(s.statements).toEqual([]);
    expect(outboundCalls).toBe(0);
    expect(marker()).toBe(clock.value);
  });

  it("acceptance 5: with no pending marker the sweep builds no worker, opens no connection (no statement) and makes no outbound call", async () => {
    const s = setup();
    const res = await branchCleanupHandler(req(`Bearer ${SECRET}`), s.deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: true, reason: "no_pending_work" });
    expect(s.getWorker).not.toHaveBeenCalled();
    expect(s.statements).toHaveLength(0);
    expect(s.github).not.toHaveBeenCalled();
    expect(outboundCalls).toBe(0);
  });

  it("with a marker and nothing waiting, one call makes exactly one statement (the list), opens no GitHub client, and clears the marker", async () => {
    await markWorkPending("branch-cleanup", { since: clock.value - 120_000 });
    const s = setup();
    const res = await branchCleanupHandler(req(`Bearer ${SECRET}`), s.deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: true, listed: 0, deleted: 0, left: 0, recorded: 0, failed: 0 });
    expect(s.statements).toHaveLength(1);
    expect(s.statements[0]).toContain("branch_cleanup_list_due");
    expect(s.github).not.toHaveBeenCalled();
    expect(outboundCalls).toBe(0);
    expect(marker()).toBeNull();
  });

  it("a pass that could not finish an item asks to be looked at again 15 minutes on, and the idle ticks between make no statement", async () => {
    await markWorkPending("branch-cleanup", { since: clock.value - 120_000 });
    const s = setup({}, countingPool([{ account_id: "11111111-1111-4111-8111-111111111111", work_item_id: "22222222-2222-4222-8222-222222222222" }]));
    const res = await branchCleanupHandler(req(`Bearer ${SECRET}`), s.deps);
    expect(await res.json()).toMatchObject({ configured: true, listed: 1 });
    expect(marker()).toBe(clock.value + 15 * 60_000);
    const before = s.statements.length;
    expect(await (await branchCleanupHandler(req(`Bearer ${SECRET}`), s.deps)).json()).toEqual({ skipped: true, reason: "no_pending_work" });
    expect(s.statements).toHaveLength(before);
  });

  it("D#598: a tick that connects also runs the stale pull-request sweep with the read-only opener, reports its counts, and leaves the marker to the cleanup", async () => {
    await markWorkPending("branch-cleanup", { since: clock.value - 120_000 });
    const prState = vi.fn(async () => {
      throw new Error("no GitHub client in a test that must open none");
    });
    const s = setup({ prState });
    const res = await branchCleanupHandler(req(`Bearer ${SECRET}`), s.deps);
    expect(await res.json()).toEqual({ configured: true, listed: 0, deleted: 0, left: 0, recorded: 0, failed: 0, prSlots: { listed: 0, moved: 0, unchanged: 0, failed: 0 } });
    expect(s.prSweepSpy).toHaveBeenCalledWith({ github: prState });
    expect(s.statements.map((x) => x.match(/[a-z_]+_list_due/)?.[0])).toEqual(["branch_cleanup_list_due", "pr_slot_reconcile_list_due"]);
    expect(marker()).toBeNull();
    // A sweep that throws is a fixed line and a flag, never a failed cleanup tick.
    await markWorkPending("branch-cleanup", { since: clock.value - 120_000 });
    s.prSweepSpy.mockRejectedValueOnce(new Error("boom"));
    const again = await branchCleanupHandler(req(`Bearer ${SECRET}`), s.deps);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ configured: true, prSlots: { failed: true } });
    expect(s.log).toHaveBeenCalledWith("branch cleanup: stale pull-request sweep failed");
  });

  it("D#598: with no marker the stale pull-request sweep does not run either, and without the opener it is never asked for", async () => {
    const s = setup({ prState: vi.fn() as never });
    expect(await (await branchCleanupHandler(req(`Bearer ${SECRET}`), s.deps)).json()).toEqual({ skipped: true, reason: "no_pending_work" });
    expect(s.prSweepSpy).not.toHaveBeenCalled();
    await markWorkPending("branch-cleanup", { since: clock.value - 120_000 });
    const t = setup();
    await branchCleanupHandler(req(`Bearer ${SECRET}`), t.deps);
    expect(t.prSweepSpy).not.toHaveBeenCalled();
  });

  it("an unconfigured worker is reported, not an error", async () => {
    await markWorkPending("branch-cleanup", { since: clock.value });
    const s = setup();
    s.getWorker.mockResolvedValueOnce(null as never);
    const res = await branchCleanupHandler(req(`Bearer ${SECRET}`), s.deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false });
  });
});
