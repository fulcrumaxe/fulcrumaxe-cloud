import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { ASK_WITHDRAW_MAX_BATCHES, sweepAskWithdrawals } from "../src/askWithdrawSweep.js";
import { buildWorker, type BuildWorkerOptions, type WorkerPorts } from "../src/compositionRoot.js";
import type { WorkerPools } from "../src/pools.js";

/** D#7 DP4b-1 (R-7-DP4b-3): the sweep's batching, counting and failure behaviour on fakes; the database half is decision-ask-withdraw.pg.test.ts in @fx/db. */

type Moved = { o_ask_id: string; o_reason: string };
const fake = (batches: Array<Moved[] | Error>): { pool: Pool; calls: Array<[string, unknown[]]> } => {
  const calls: Array<[string, unknown[]]> = [];
  let i = 0;
  const pool = {
    async query(sql: string, params: unknown[]) {
      calls.push([sql, params]);
      const next = batches[i++] ?? [];
      if (next instanceof Error) throw next;
      return { rows: next };
    },
  } as unknown as Pool;
  return { pool, calls };
};
const ids = (n: number, reason = "item_closed", from = 0): Moved[] => Array.from({ length: n }, (_, k) => ({ o_ask_id: `ask-${from + k}`, o_reason: reason }));

describe("sweepAskWithdrawals", () => {
  it("calls decision_ask_withdraw with the limit, counts by reason, and stops at the first short batch", async () => {
    const { pool, calls } = fake([[...ids(1, "item_closed"), ...ids(1, "item_halted", 1), ...ids(1, "superseded", 2)]]);
    const warns: string[] = [];
    const out = await sweepAskWithdrawals({ pool, warn: (l) => warns.push(l), limit: 10 });
    expect(out).toEqual({ withdrawn: 3, byReason: { item_closed: 1, item_halted: 1, superseded: 1 }, failed: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toContain("decision_ask_withdraw($1::integer)");
    expect(calls[0]![1]).toEqual([10]);
    expect(warns.map((l) => JSON.parse(l))).toEqual([{ event: "decision.ask_withdrawn", item_closed: 1, item_halted: 1, superseded: 1, total: 3 }]);
  });

  it("nothing to do is one call, no line", async () => {
    const { pool, calls } = fake([[]]);
    const warns: string[] = [];
    expect(await sweepAskWithdrawals({ pool, warn: (l) => warns.push(l) })).toMatchObject({ withdrawn: 0, failed: false });
    expect(calls).toHaveLength(1);
    expect(warns).toEqual([]);
  });

  it("a full batch asks for another, up to the batch bound per tick", async () => {
    const { pool, calls } = fake(Array.from({ length: 20 }, (_, k) => ids(2, "item_closed", k * 2)));
    const out = await sweepAskWithdrawals({ pool, warn: () => undefined, limit: 2 });
    expect(calls).toHaveLength(ASK_WITHDRAW_MAX_BATCHES);
    expect(out.withdrawn).toBe(2 * ASK_WITHDRAW_MAX_BATCHES);
    const small = fake(Array.from({ length: 20 }, (_, k) => ids(2, "superseded", k * 2)));
    await sweepAskWithdrawals({ pool: small.pool, warn: () => undefined, limit: 2, maxBatches: 2 });
    expect(small.calls).toHaveLength(2);
  });

  it("never throws: a failed batch is counted, the earlier batches still count, and the line holds no driver text", async () => {
    const { pool } = fake([ids(2, "item_closed", 0), new Error("connect ECONNREFUSED db.internal:5432 as receipt-user secret-pw")]);
    const warns: string[] = [];
    const out = await sweepAskWithdrawals({ pool, warn: (l) => warns.push(l), limit: 2 });
    expect(out).toEqual({ withdrawn: 2, byReason: { item_closed: 2, item_halted: 0, superseded: 0 }, failed: true });
    expect(warns.map((l) => JSON.parse(l).event)).toEqual(["decision.ask_withdraw_failed", "decision.ask_withdrawn"]);
    expect(warns.join("\n")).not.toMatch(/db\.internal|receipt-user|secret-pw|ECONN/);
  });

  it("an unknown reason from the database is a failed batch, never a counted withdrawal", async () => {
    const { pool } = fake([[{ o_ask_id: "x", o_reason: "because" }]]);
    const out = await sweepAskWithdrawals({ pool, warn: () => undefined });
    expect(out).toMatchObject({ withdrawn: 0, failed: true });
  });
});

describe("the tick: the invariant sweep also runs the withdrawal on the RECEIPT pool", () => {
  const ports: WorkerPorts = {
    decryptTenantKey: async () => "k",
    modelConnection: { get: async () => { throw new Error("not used"); } },
    connectionStatus: { markBroken: async () => {}, markCreditsExhausted: async () => {} },
    hooks: { resume: async () => {} },
  };
  function build(receipt: Pool, runner: Pool): Promise<Awaited<ReturnType<typeof buildWorker>>> {
    const pools: WorkerPools = { runnerPool: runner, platformOpsPool: {} as Pool, receiptPool: receipt, close: async () => {} };
    const options: BuildWorkerOptions = {
      env: { FX_GH_FORWARD_SUFFIX: "fixture.test", FX_GH_FORWARD_HOST: "gh-proxy.fixture.test" },
      vercel: { teamId: "t", projectId: "p", getToken: async () => "tok" },
      ports,
      createPools: async () => pools,
    };
    return buildWorker(options);
  }

  it("sweepInvariants asks the receipt pool for the withdrawal and the approval-request housekeeping, and the runner pool only for the invariant rules", async () => {
    const receipt = fake([[], [{ o_expired: 0, o_arguments_purged: 0, o_idempotency_purged: 0, o_instances_purged: 0 } as never]]);
    const runner = { async query(sql: string) { if (/decision_ask_withdraw|aap_sweep/.test(sql)) throw new Error("the runner pool must not run the withdrawal or the approval-request sweep"); return { rows: [] }; } } as unknown as Pool;
    const worker = await build(receipt.pool, runner);
    const result = await worker.sweepInvariants();
    expect(result.failed).toBe(0);
    expect(receipt.calls.map((c) => c[0])).toEqual([expect.stringContaining("decision_ask_withdraw"), expect.stringContaining("aap_sweep")]);
  });

  it("a failing withdrawal does not fail the invariant sweep's result", async () => {
    const receipt = fake([new Error("receipt login unreachable")]);
    const runner = { async query() { return { rows: [] }; } } as unknown as Pool;
    const worker = await build(receipt.pool, runner);
    await expect(worker.sweepInvariants()).resolves.toMatchObject({ failed: 0 });
  });
});
