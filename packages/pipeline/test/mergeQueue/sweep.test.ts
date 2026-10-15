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
});
