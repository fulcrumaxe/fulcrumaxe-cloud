import type { PoolClient } from "pg";
import { MAX_HEAVY_CAPACITY, MAX_LIGHT_CAPACITY, MAX_TOTAL_CAPACITY } from "@fulcrumaxe/runner-protocol";
import { RUNNER_OFFLINE_AFTER_SECONDS } from "@fx/runner-cloud";
import { RUNNER_PLAN_ID, runnerLimitsFor, type HostedRunnerLimits } from "@fx/spend";
import type { RunnerLimits } from "./runnerLimits.js";

/**
 * D#605 FL-12a: the most runner runs an account may have running at once, in all, of the heavy class, and on one repository. The claim
 * reads it under the account's claim lock, so the counts it is compared with cannot be raced past it.
 *
 * - The runner plan has a flat figure from the plan data (`runnerLimits`), whatever its runners declare.
 * - A hosted plan has min(the account's setting, what its LIVE runners can hold). The setting is the account's accepted row, else the plan
 *   data's defaults. A runner is live when it is not revoked, was heard from within `RUNNER_OFFLINE_AFTER_SECONDS` and is not holding back
 *   its claims; offline, revoked and paused runners add nothing, and adding a runner raises the ceiling only up to the setting, never past it.
 *   A runner's capacity is the one it declared on its claim, clamped to the per-runner 8 in all and 4 heavy, or 1 when it declared none.
 * - Plan data that cannot give the figures, or a plan it does not know, is a ceiling of 0: nothing is handed out (fail closed).
 *
 * To count a runner that FL-1 can pause or drain, add it to `LIVE_RUNNER_PREDICATE`: nothing else here changes.
 */
export interface AccountCeiling {
  total: number;
  heavy: number;
  /** Runs on one repository; null where the plan has no per-repo figure (the runner plan). */
  perRepo: number | null;
}

export type HostedLimitsSource = (plan: string) => HostedRunnerLimits;

/** The default source: the plan data. Throws when it cannot say, which the ceiling reads as 0. */
export const hostedLimitsFromPlanData: HostedLimitsSource = (plan) => {
  const limits = runnerLimitsFor(plan);
  if (!("hosted" in limits)) throw new Error("not a hosted plan");
  return limits;
};

const FAIL_CLOSED: AccountCeiling = { total: 0, heavy: 0, perRepo: 0 };

/** Which runners hold capacity right now. $1 is the clock, $2 the offline window in seconds, $3 the runner that is claiming (live by being here). */
const LIVE_RUNNER_PREDICATE = `r.revoked_at IS NULL
      AND (r.id = $3::uuid OR r.last_seen_at > $1::timestamptz - make_interval(secs => $2))
      AND (c.claim_paused_until IS NULL OR c.claim_paused_until <= $1::timestamptz)`;

/** The capacity one runner's row reads as: its declared light and heavy limits clamped as the runner list clamps them, else 1. */
const RUNNER_CAPACITY_SQL = `CASE WHEN c.declared THEN LEAST(LEAST(c.light_limit, ${MAX_LIGHT_CAPACITY}) + LEAST(c.heavy_limit, ${MAX_HEAVY_CAPACITY}), ${MAX_TOTAL_CAPACITY}) ELSE 1 END`;

export async function accountCeiling(
  client: PoolClient,
  input: { accountId: string; claimingRunnerId: string; nowMs: number; runnerPlan: RunnerLimits; hosted: HostedLimitsSource },
): Promise<AccountCeiling> {
  const plan = (await client.query<{ plan: string }>("SELECT plan FROM accounts WHERE id = $1", [input.accountId])).rows[0]?.plan;
  if (plan === undefined) return FAIL_CLOSED;
  if (plan === RUNNER_PLAN_ID) {
    return { total: input.runnerPlan.maxConcurrentRunnerJobs, heavy: input.runnerPlan.maxConcurrentHeavyRunnerJobs, perRepo: null };
  }
  let defaults: HostedRunnerLimits;
  try {
    defaults = input.hosted(plan);
  } catch {
    // fx-swallow-ok: unavailable plan data is a refusal to hand out work (fail closed), not a crash; startup reports the missing key
    return FAIL_CLOSED;
  }
  const stored = (await client.query<{ total_jobs: number; per_repo_jobs: number }>("SELECT total_jobs, per_repo_jobs FROM account_runner_concurrency WHERE account_id = $1", [input.accountId])).rows[0];
  const live = await client.query<{ capacity: string | null }>(
    `SELECT sum(COALESCE(${RUNNER_CAPACITY_SQL}, 1)) AS capacity
       FROM runners r LEFT JOIN runner_capacity c ON c.runner_id = r.id AND c.account_id = r.account_id
      WHERE r.account_id = $4::uuid AND ${LIVE_RUNNER_PREDICATE}`,
    [new Date(input.nowMs), RUNNER_OFFLINE_AFTER_SECONDS, input.claimingRunnerId, input.accountId],
  );
  const capacity = Number(live.rows[0]?.capacity ?? 0);
  const total = Math.min(stored?.total_jobs ?? defaults.defaultAccountJobs, capacity);
  return { total, heavy: total, perRepo: Math.min(stored?.per_repo_jobs ?? defaults.defaultPerRepoJobs, total) };
}
