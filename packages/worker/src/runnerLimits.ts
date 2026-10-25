import { RUNNER_MAX_RUN_WALL_CLOCK_MS } from "@fulcrumaxe/runner-protocol";
import { RUNNER_PLAN_ID, runnerLimitsFor } from "@fx/spend";
import { withTenant } from "@fx/db/src/withTenant.js";
import type { Pool } from "pg";

/**
 * D#6 R2b-3 (C21 section 8): the two runner limits the lease code reads, behind ONE function. Claim reads
 * `maxConcurrentRunnerJobs` and the fence and the sweeper read `maxRunWallClockMs`; nothing else in this package names the
 * figures. Both come from the runner plan's data (`runnerLimitsFor`, D#6 R2b criterion 12), the same reader that serves the
 * register limit and the daily limit, so there is no second copy of a plan figure.
 *
 * Plan data that is missing, or predates the runner tier, fails closed (C21 section 9): the concurrency is 0, so claim hands
 * out no run, while the wall clock stays at the class constant so a run already in flight is still timed out. A missing figure
 * never becomes an unlimited one.
 */
export interface RunnerLimits {
  /** Runner runs an account may have `running` at once; claim hands out no more. */
  maxConcurrentRunnerJobs: number;
  /** Of those, how many may be heavy (D#6 C43-2b). Plan data without the figure reads as 1: fail closed, never unlimited. */
  maxConcurrentHeavyRunnerJobs: number;
  /** How long a runner run may take from its start; a heartbeat past it is told to stop, and the sweeper times the run out. */
  maxRunWallClockMs: number;
}

export type RunnerLimitsSource = (accountId: string) => RunnerLimits;

export const runnerLimits: RunnerLimitsSource = (accountId) => {
  void accountId; // one runner plan for every account today
  try {
    const { maxConcurrentRunnerJobs, maxConcurrentHeavyRunnerJobs, maxRunWallClockMs } = runnerLimitsFor('runner');
    if (maxConcurrentHeavyRunnerJobs === undefined) warnHeavyFigureMissingOnce();
    return { maxConcurrentRunnerJobs, maxConcurrentHeavyRunnerJobs: maxConcurrentHeavyRunnerJobs ?? MISSING_HEAVY_FIGURE, maxRunWallClockMs };
  } catch {
    // fx-swallow-ok: unavailable plan data is a refusal to hand out work (fail closed), not a crash; the composition root reports it when it loads the data
    return { maxConcurrentRunnerJobs: 0, maxConcurrentHeavyRunnerJobs: 0, maxRunWallClockMs: RUNNER_MAX_RUN_WALL_CLOCK_MS };
  }
};

/** What a plan without `maxConcurrentHeavyRunnerJobs` allows: one heavy run at a time. */
export const MISSING_HEAVY_FIGURE = 1;
let warnedHeavyMissing = false;
/** Says once per process that the plan data has no heavy figure; the claim runs on 1 meanwhile. */
function warnHeavyFigureMissingOnce(): void {
  if (warnedHeavyMissing) return;
  warnedHeavyMissing = true;
  console.warn("runner plan data has no maxConcurrentHeavyRunnerJobs; the claim allows 1 heavy runner job per account");
}
/** Test hook: forget that the warning was given. */
export function resetHeavyFigureWarning(): void {
  warnedHeavyMissing = false;
}

/** The payment-failure grace window for a `past_due` account: the same seven days `reserve` allows (packages/spend/src/reserve.ts). */
const PAST_DUE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The daily cap on runner runs for one account. `accounts.plan` alone is not an entitlement (an unpaid signup defaults to a plan, and a
 * cancelled subscription keeps it), so no cap (`null`) needs both a subscription plan and a runnable account by the same test `reserve` uses:
 * the derived `accounts.status` is `active`, or it is `past_due` with `past_due_since` inside the grace window. A hold, a suspension, a pause,
 * an unsubscribed or cancelled account keeps the runner tier's figure from the plan data. Throws for a plan the data cannot answer for, or when
 * the row cannot be read: the target reads a throw as a refusal (fail closed).
 */
export function runsPerDayOfAccountPlan(pool: Pool, now: () => Date = () => new Date()): (accountId: string) => Promise<number | null> {
  return async (accountId) => {
    const row = await withTenant(pool, accountId, async (client) => (await client.query<{ plan: string; status: string; past_due_since: Date | null }>("SELECT plan, status, past_due_since FROM accounts WHERE id = $1", [accountId])).rows[0]);
    if (row === undefined) throw new Error("runner limits: the account has no plan row");
    const limits = runnerLimitsFor(row.plan);
    if ("runsPerDay" in limits) return limits.runsPerDay;
    const withinGrace = row.status === "past_due" && row.past_due_since !== null && row.past_due_since.getTime() > now().getTime() - PAST_DUE_GRACE_MS;
    if (row.status === "active" || withinGrace) return null;
    return runnerLimitsFor(RUNNER_PLAN_ID).runsPerDay;
  };
}
