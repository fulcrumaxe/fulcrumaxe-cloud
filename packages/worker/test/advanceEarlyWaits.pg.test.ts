import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createPool } from "@fx/db/src/pool.js";
import { seedAccount, type SeedRefs } from "@fx/db/test/helpers/seed.js";
import { createAdvanceModule, type AdvanceModuleDeps, type AdvanceStepResult } from "../src/advance.js";

const marks = vi.hoisted(() => ({ calls: [] as Array<[string, unknown]> }));
vi.mock("@fx/core/src/pendingWork.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@fx/core/src/pendingWork.js")>()),
  markWorkPending: vi.fn(async (name: string, opts: unknown) => void marks.calls.push([name, opts])),
}));

/**
 * D#483 S5-k1c [pg]: the two things the worker adds for the starts before the build. The Spec step takes the number of the ask and hands it to the pipeline only
 * when it is above the first; and a waiting fact for a spending-limit pause, written through `advanceRecordEvent`, tells the parked-stage sweep there is work (like the
 * build's own fact does), while any other fact does not.
 */
describe("advance: the starts before the build under a spending limit [pg]", { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let writerPool: Pool;
  beforeAll(async () => {
    adminPool = createPool(process.env.WORKER_DATABASE_URL!);
    admin = await adminPool.connect();
    writerPool = createPool(process.env.WORKER_DATABASE_URL_RUN_WRITER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, writerPool]) await p.end();
  });
  beforeEach(() => {
    marks.calls.length = 0;
  });

  let n = 31000;
  async function item(a: SeedRefs, stage: string): Promise<string> {
    const id = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', $4, $5)", [id, a.accountId, a.repoId, stage, n++]);
    return id;
  }
  function module(over: Partial<AdvanceModuleDeps> = {}) {
    const specCalls: unknown[][] = [];
    const deps = {
      starter: { start: async () => ({ runId: randomUUID() }) },
      resolveRunSeat: vi.fn(),
      startAdvance: async () => undefined,
      triage: null,
      spec: (async (_pool: Pool, ...rest: unknown[]) => {
        specCalls.push(rest);
        return { status: "refused", reason: "account_budget_reached" } as AdvanceStepResult;
      }) as never,
      registry: {} as never,
      ...over,
    } as AdvanceModuleDeps;
    return { m: createAdvanceModule(writerPool, deps), specCalls };
  }
  const who = (a: SeedRefs, w: string) => ({ accountId: a.accountId, userId: a.userId, workItemId: w, haltEpoch: 0 });

  it("the Spec step: the first ask passes no attempt; a later ask passes it; a bad one is refused before anything is asked", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a, "discussing");
    const approval = randomUUID();
    const { m, specCalls } = module();
    await m.advanceSpec(who(a, w), approval);
    await m.advanceSpec(who(a, w), approval, 0);
    expect(await m.advanceSpec(who(a, w), approval, 3)).toEqual({ status: "refused", reason: "account_budget_reached" });
    expect(specCalls.map((c) => c[c.length - 1])).toEqual([{ attempt: approval }, { attempt: approval }, { attempt: approval, spendAttempt: 3 }]);
    for (const bad of [-1, 1.5, 100_001, Number.NaN]) expect(await m.advanceSpec(who(a, w), approval, bad)).toEqual({ status: "refused", reason: "invalid_input" });
    expect(specCalls).toHaveLength(3);
  });

  it("a waiting fact for a limit pause tells the sweep there is work; other facts do not", async () => {
    const a = await seedAccount(admin, randomUUID());
    const w = await item(a, "triaged");
    const { m } = module();
    expect(await m.advanceRecordEvent(who(a, w), { kind: "stage_waiting", stage: "classify", code: "account_budget_reached", attempt: 0, dedupeKey: "k1" })).toEqual({ recorded: true });
    expect(marks.calls.map((c) => c[0])).toEqual(["stage-resume-sweep"]);
    // The sweep's first look is just after the workflow's own four hours.
    const since = (marks.calls[0]![1] as { since: number }).since;
    expect(since).toBeGreaterThan(Date.now() + 3.9 * 3_600_000);
    // A repeat of the same fact writes nothing and marks nothing; a slot wait, a stop and a bad value mark nothing.
    await m.advanceRecordEvent(who(a, w), { kind: "stage_waiting", stage: "classify", code: "account_budget_reached", attempt: 0, dedupeKey: "k1" });
    await m.advanceRecordEvent(who(a, w), { kind: "stage_waiting", stage: "build", code: "waiting_for_build_slot_repo", attempt: 0, dedupeKey: "k2" });
    await m.advanceRecordEvent(who(a, w), { kind: "stopped", code: "classify_refused", dedupeKey: "k3" });
    await m.advanceRecordEvent(who(a, w), { kind: "stage_waiting", stage: "nonsense" as never, code: "account_budget_reached", dedupeKey: "k4" });
    expect(marks.calls).toHaveLength(1);
    const rows = await admin.query("SELECT kind, stage, code, attempt FROM work_item_driver_events WHERE work_item_id = $1 ORDER BY seq", [w]);
    expect(rows.rows).toEqual([
      { kind: "stage_waiting", stage: "classify", code: "account_budget_reached", attempt: 0 },
      { kind: "stage_waiting", stage: "build", code: "waiting_for_build_slot_repo", attempt: 0 },
      { kind: "stopped", stage: null, code: "classify_refused", attempt: null },
    ]);
  });
});
