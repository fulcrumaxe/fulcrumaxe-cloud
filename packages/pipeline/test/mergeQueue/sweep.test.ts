import { describe, expect, it, vi } from "vitest";
import { sweepMergeQueue, type SweepTarget } from "../../src/mergeQueue/sweep.js";

vi.mock("@fx/telemetry", () => ({ reportError: vi.fn() }));
vi.mock("../../src/mergeQueue/store.js", () => ({ reclaimExpiredLeases: vi.fn() }));

import { reportError } from "@fx/telemetry";
import { reclaimExpiredLeases } from "../../src/mergeQueue/store.js";

/** D#519 MQ2: the sweep's own behaviour with the database faked out (the real thing is in queue.pg.test.ts). */
const A: SweepTarget = { accountId: "a1", repoId: "r1" };
const B: SweepTarget = { accountId: "a2", repoId: "r2" };

describe("sweepMergeQueue", () => {
  it("one repo that throws does not hold back the rest, and is reported with a fixed stage", async () => {
    vi.mocked(reclaimExpiredLeases).mockReset();
    vi.mocked(reportError).mockReset();
    vi.mocked(reclaimExpiredLeases).mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce([{ id: "e" } as never]);
    const ticked: string[] = [];
    const out = await sweepMergeQueue({
      listTargets: async () => [A, B],
      inTenant: async (_id, fn) => fn({} as never),
      tick: async (t) => void ticked.push(t.repoId),
    });
    expect(out).toEqual({ listed: 2, reclaimed: 1, ticked: 1, failed: 1 });
    expect(ticked).toEqual(["r2"]);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(vi.mocked(reportError).mock.calls[0]![1]).toEqual({ stage: "merge_queue.sweep" });
  });

  it("without a tick it only reclaims", async () => {
    vi.mocked(reclaimExpiredLeases).mockReset();
    vi.mocked(reclaimExpiredLeases).mockResolvedValue([]);
    const out = await sweepMergeQueue({ listTargets: async () => [A], inTenant: async (_id, fn) => fn({} as never) });
    expect(out).toEqual({ listed: 1, reclaimed: 0, ticked: 0, failed: 0 });
  });

  it("passes the injected clock and the limit to the lister", async () => {
    const listTargets = vi.fn(async () => []);
    const now = new Date("2026-10-15T10:00:00Z");
    await sweepMergeQueue({ listTargets, inTenant: async (_id, fn) => fn({} as never), now, limit: 7 });
    expect(listTargets).toHaveBeenCalledWith(now, 7);
  });

  it("D#694 B6-4: the reconcile runs before each tick on what is left of the sweep's read budget, and a throw from it is reported and never stops the tick", async () => {
    vi.mocked(reclaimExpiredLeases).mockReset();
    vi.mocked(reportError).mockReset();
    vi.mocked(reclaimExpiredLeases).mockResolvedValue([]);
    const order: string[] = [];
    const budgets: Array<[string, number]> = [];
    const out = await sweepMergeQueue({
      listTargets: async () => [A, B, { accountId: "a3", repoId: "r3" }],
      inTenant: async (_id, fn) => fn({} as never),
      reconcileReads: 4,
      reconcile: async (t, max) => {
        budgets.push([t.repoId, max]);
        order.push(`reconcile:${t.repoId}`);
        if (t.repoId === "r2") throw new Error("boom");
        return { reads: t.repoId === "r1" ? 3 : max, settled: 1, escalated: 0 };
      },
      tick: async (t) => void order.push(`tick:${t.repoId}`),
    });
    expect(budgets).toEqual([["r1", 4], ["r2", 1], ["r3", 1]]);
    expect(order).toEqual(["reconcile:r1", "tick:r1", "reconcile:r2", "tick:r2", "reconcile:r3", "tick:r3"]);
    expect(out).toEqual({ listed: 3, reclaimed: 0, ticked: 3, failed: 0, reconcileReads: 4, reconciled: 2, reconcileEscalated: 0 });
    expect(vi.mocked(reportError).mock.calls.map((c) => c[1])).toEqual([{ stage: "merge_queue.reconcile" }]);
  });

  it("D#694 B6-4: with the budget spent the reconcile is not called for the next repos", async () => {
    vi.mocked(reclaimExpiredLeases).mockReset();
    vi.mocked(reclaimExpiredLeases).mockResolvedValue([]);
    const reconcile = vi.fn(async (_t: SweepTarget, max: number) => ({ reads: max, settled: 0, escalated: 0 }));
    await sweepMergeQueue({ listTargets: async () => [A, B], inTenant: async (_id, fn) => fn({} as never), reconcileReads: 2, reconcile });
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});
