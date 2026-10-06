import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { LostRunOutcome } from "../src/executionTarget.js";
import { configureErrorReporter } from "@fx/telemetry";
import { SANDBOX_MAX_TIMEOUT_MS } from "../src/sandboxPort.js";
import { LOST_RUN_STALE_MS, LOST_RUN_WORST_CASE_MS, LOST_SWEEP_BATCH_SIZE, LOST_SWEEP_TIME_BUDGET_MS, sweepLostRuns } from "../src/lostRunSweep.js";

/** The lost-run sweep's tally, isolation and time budget, over a fake list. The database side is in agentLaunchDurability.pg.test.ts. */

const row = (n: number, extra: Record<string, unknown> = {}) => ({
  account_id: `00000000-0000-4000-8000-00000000000${n}`,
  run_id: `00000000-0000-4000-8000-0000000001${n}0`,
  role: "code-reviewer",
  dispatch_repo_id: null,
  dispatch_pr_number: null,
  sandbox_requested_at: new Date(Date.now() - 600_000),
  ...extra,
});

function poolOf(rows: unknown[]) {
  const asked: { sql: string; params: unknown[] }[] = [];
  const pool = {
    async query(sql: string, params: unknown[]) {
      asked.push({ sql, params });
      return { rows };
    },
  } as unknown as Pool;
  return { pool, asked };
}

describe("sweepLostRuns", () => {
  it("the stale age is the longest sandbox timeout", () => {
    expect(LOST_RUN_STALE_MS).toBe(SANDBOX_MAX_TIMEOUT_MS);
  });

  it("a run older than the longest sandbox timeout is still looked at but is not counted as running, so it cannot keep the cron's marker for ever", async () => {
    const asked: string[] = [];
    const result = await sweepLostRuns({
      pool: poolOf([row(1), row(2, { sandbox_requested_at: new Date(Date.now() - 2 * SANDBOX_MAX_TIMEOUT_MS) })]).pool,
      target: { settleIfLost: async (run) => (asked.push(run.id), "unknown" as const) },
    });
    expect(asked).toHaveLength(2);
    expect(result).toMatchObject({ listed: 1, stale: 1, unknown: 2 });
  });

  it("counts a run whose sandbox was requested moments ago as listed (the cron keeps its marker) but does not look at it", async () => {
    const asked: string[] = [];
    const result = await sweepLostRuns({
      pool: poolOf([row(1), row(2, { sandbox_requested_at: new Date(Date.now() - 5_000) })]).pool,
      target: { settleIfLost: async (run) => (asked.push(run.id), "alive" as const) },
    });
    expect(asked).toEqual([row(1).run_id]);
    expect(result).toMatchObject({ listed: 2, young: 1, alive: 1 });
  });

  it("only starts a run that can still finish inside the budget: the worst case is a margin", async () => {
    let now = 0;
    const target = { settleIfLost: async () => ((now += 30), "alive" as const) };
    const two = await sweepLostRuns({ pool: poolOf([row(1), row(2)]).pool, clock: () => now, timeBudgetMs: 100, runWorstCaseMs: 60, target });
    expect(two).toMatchObject({ listed: 2, alive: 2, skipped: 0 });
    now = 0;
    const three = await sweepLostRuns({ pool: poolOf([row(1), row(2), row(3)]).pool, clock: () => now, timeBudgetMs: 100, runWorstCaseMs: 60, target });
    expect(three).toMatchObject({ alive: 2, skipped: 1 });
    // The real constants leave room to start runs, and the tick's total stays under the budget by construction.
    expect(LOST_SWEEP_TIME_BUDGET_MS - LOST_RUN_WORST_CASE_MS).toBeGreaterThan(30_000);
  });

  it("reports an unknown answer through the error reporter, once per tick", async () => {
    const reports: string[] = [];
    configureErrorReporter({ service: "t", write: (line) => void reports.push(line) });
    await sweepLostRuns({ pool: poolOf([row(1), row(2)]).pool, runWorstCaseMs: 0, target: { settleIfLost: async () => "unknown" } });
    expect(reports.filter((l) => l.includes("run.lost_sweep"))).toHaveLength(1);
    configureErrorReporter({ service: "app" });
  });

  it("lists with the batch size and the minimum age, and tallies each outcome", async () => {
    const { pool, asked } = poolOf([row(1), row(2), row(3)]);
    const answers: LostRunOutcome[] = ["settled", "alive", "unknown"];
    const result = await sweepLostRuns({ pool, target: { settleIfLost: async () => answers.shift()! } });
    expect(asked[0]!.sql).toContain("agent_run_list_running");
    expect(asked[0]!.params).toEqual([LOST_SWEEP_BATCH_SIZE]); // every running run is listed (age 0): the age is applied here, so young ones still count as running
    expect(result).toEqual({ listed: 3, young: 0, stale: 0, settled: 1, alive: 1, unknown: 1, failed: 0, skipped: 0 });
  });

  it("rebuilds the run from the row (identity only) and one failing run does not stop the others", async () => {
    const { pool } = poolOf([row(1, { role: "executor", dispatch_repo_id: "r-1", dispatch_pr_number: "42" }), row(2)]);
    const seen: unknown[] = [];
    const errors: string[] = [];
    const result = await sweepLostRuns({
      pool,
      onError: (id) => errors.push(id),
      target: {
        async settleIfLost(run) {
          seen.push({ id: run.id, role: run.role, repoId: run.repoId, pr: run.pr });
          if (seen.length === 1) throw new Error("provider down");
          return "settled";
        },
      },
    });
    expect(seen[0]).toMatchObject({ role: "executor", repoId: "r-1", pr: 42 });
    expect(result).toMatchObject({ listed: 2, settled: 1, failed: 1 });
    expect(errors).toEqual([row(1).run_id]);
  });

  it("stops starting runs when its time budget is used, and says how many it left", async () => {
    const { pool } = poolOf([row(1), row(2), row(3)]);
    let now = 0;
    const result = await sweepLostRuns({
      pool,
      clock: () => now,
      timeBudgetMs: 10,
      runWorstCaseMs: 0,
      target: {
        async settleIfLost() {
          now += 8;
          return "alive";
        },
      },
    });
    expect(result).toMatchObject({ listed: 3, alive: 2, skipped: 1 });
  });
});
