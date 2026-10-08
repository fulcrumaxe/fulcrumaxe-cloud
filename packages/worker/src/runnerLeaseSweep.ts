import type { Pool } from "pg";
import { RUNNER_MAX_RUN_WALL_CLOCK_MS } from "@fulcrumaxe/runner-protocol";
import { withTenant } from "@fx/db/src/withTenant.js";
import { writeRunStatus, writeRunStatusOn, type FailureReason } from "@fx/runner";
import { leaseVerdict } from "./runnerClaims.js";
import { runnerLimits, type RunnerLimitsSource } from "./runnerLimits.js";
import { JOBLESS_FAIL_AFTER_MS, JOBLESS_RETRY_AFTER_MS, requestFollowUp, settleFollowUp, type FollowUpOutcome, type FollowUpPorts } from "./runnerFollowUp.js";

/**
 * D#6 R2b-3 (C14 section 4, C21 section 4): the lease and wall-clock half of the runner sweeper. A run a runner holds is
 * `running` with a lease that ends 90 seconds after the last claim, heartbeat or accepted event batch. The routes already
 * answer 409 `{continue:false}` from the lease's end, whether or not a sweep has run; this tick makes the run's status say
 * the same:
 *
 *   - lease ended         `running -> failed`, reason `runner_lost`, and the run that follows it (below);
 *   - 2 hours since start `running -> timed_out`, reason `wall_clock_limit`;
 *   - runner revoked      `running -> failed`, reason `runner_revoked` (the revoke request does this itself; this finishes the job
 *                         if that call failed, since a revoked runner stops heartbeating and would otherwise hold the run forever).
 *
 * Every decision is made by the same fence the routes use (`agent_run_runner_lease`, 0754), under the run's row lock and in
 * the same transaction as the status write, so a heartbeat that lands between the list and the write wins and the run is left
 * alone. A lease is lost AT `lease_expires_at`, not when this tick happens to run: `now` is injected, and a run is lost when
 * `lease_expires_at <= now`.
 *
 * The run after a loss. In the same transaction as the `runner_lost` move, the database definer `runner_follow_up_run` makes
 * the pending child (claimable at once), or answers `exhausted` when the run and its earlier runs have now been lost twice.
 * After the commit, a created child is dispatched through the runner target, and an exhausted run fails its work item
 * with the code of the allowance that ran out (`runner_lost` after two losses, `runner_usage_limit` after eight usage limits;
 * C22 section 8) through the stage driver's failure path. A wall-clock timeout and a revocation make no child.
 *
 * Runs with no job (C22 section 3). A pending runner run is claimable only once its signed job is written. One that is still
 * without a job is either mid-dispatch or its dispatch died. Each tick, after the lease work: a follow-up child (a jobless run
 * whose parent is a failed runner run that ended `runner_lost` or `usage_limit`, the same step the chain walk takes) that is two
 * minutes old or more is dispatched again through the same port, once (a job is written once only, so a slow first dispatch is
 * not undone, and a child whose job is already there is left alone). A fix-round resume run or a retry also has a parent, but its
 * dispatch is not this port's to redo (it would be sent from the parent's job, as a fresh run), so it keeps only the failure:
 * any pending runner run that is fifteen minutes old without a job is moved `pending -> failed` with `internal_error` through
 * the facade, for first runs and every kind of child. The stage driver then finds a childless failed run, and the work item ends.
 * The 72 hour queue time is no longer how this case ends. The tick looks at the oldest 50 pending runs WITHOUT a job across
 * tenants (`agent_run_list_jobless_runner_runs`): the queue sweep's lister would also return runs that have a job and may wait
 * 72 hours for a runner, and enough of those in any account would hide every jobless run from this work.
 *
 * Cross-tenant, for the cron only: it takes no input. Idempotent and safe to overlap.
 */

export const RUNNER_LEASE_SWEEP_BATCH = 50;

/** The reasons that make a failed runner run get a follow-up (a "follow-up hop", C22 section 5); the same two `advanceRunOutcome` follows. */
const FOLLOW_UP_HOP_REASONS = ["runner_lost", "usage_limit"];

/** The run id handed to `onError` for a failure that belongs to no run (the list itself). */
const NIL_RUN_ID = "00000000-0000-0000-0000-000000000000";

export interface RunnerLeaseSweepResult {
  /** Running runner runs this tick looked at. */
  leasesListed: number;
  /** Moved to `failed` with `runner_lost`. */
  lost: number;
  /** Of `lost`, the ones that got a follow-up run. */
  followUpsCreated: number;
  /** Of `lost`, the ones lost for the second time: no child, and the work item is failed. */
  followUpsExhausted: number;
  /** Follow-ups whose dispatch (or work-item failure) could not be done after the commit; reported through `onError`. */
  followUpsFailed: number;
  /** Follow-up children without a job whose dispatch was tried again (two minutes old or more). */
  joblessRetried: number;
  /** Pending runner runs without a job that were failed `internal_error` (fifteen minutes old or more). */
  joblessFailed: number;
  /** Runs (or the list) the no-job work could not settle this tick, reported through `onError`; the next tick looks again. Counted apart from `leasesFailed`. */
  joblessErrors: number;
  /** Moved to `failed` with `runner_revoked`. */
  revoked: number;
  /** Moved to `timed_out` for the wall clock. */
  wallClockTimedOut: number;
  /** Runs whose lease still held. */
  held: number;
  /** Runs that were no longer the listed runner's, or that another writer moved first. */
  leasesSkipped: number;
  leasesFailed: number;
  /** When the next lease or wall clock ends (epoch ms); soon after a failure or a full batch; null when no run is held. */
  nextDueAt: number | null;
}

export interface RunnerLeaseSweeper {
  /** One tick. For the cron only: it works across tenants. */
  sweepRunnerLeases(): Promise<RunnerLeaseSweepResult>;
}

export interface RunnerLeaseSweepDeps {
  now?: () => number;
  /** The wall-clock figure per account (C21 section 8). Defaults to `runnerLimits`. */
  limits?: RunnerLimitsSource;
  /** Dispatches a follow-up run, or fails the work item. Absent: the child is made without a job and the queue sweep expires it. */
  followUp?: FollowUpPorts;
  retryDelayMs?: number;
  onError?: (runId: string, error: unknown) => void;
}

interface Listed {
  account_id: string;
  run_id: string;
  runner_id: string;
  lease_generation: number;
  lease_expires_at: Date | null;
  started_at: Date | null;
}

type Outcome = { kind: "lost"; followUp: FollowUpOutcome } | { kind: "revoked" | "timed_out" | "skipped" } | { kind: "held"; dueAt: number };

/** Package-internal: `pool` is the runner login's pool and is captured here, never exposed. */
export function createRunnerLeaseSweeper(pool: Pool, deps: RunnerLeaseSweepDeps = {}): RunnerLeaseSweeper {
  const now = deps.now ?? Date.now;
  const limits = deps.limits ?? runnerLimits;

  /** The jobless-run work described above. Returns the earliest time a run still waiting will need looking at again (epoch ms), or `earliest` when there is none sooner, and whether the list came back full. */
  async function sweepJoblessRuns(result: RunnerLeaseSweepResult, earliest: number | null, at: Date): Promise<{ due: number | null; full: boolean }> {
    let due = earliest;
    const soonest = (t: number) => {
      due = due === null ? t : Math.min(due, t);
    };
    let waiting: { account_id: string; run_id: string; created_at: Date }[];
    try {
      waiting = (await pool.query<{ account_id: string; run_id: string; created_at: Date }>("SELECT account_id, run_id, created_at FROM agent_run_list_jobless_runner_runs($1)", [RUNNER_LEASE_SWEEP_BATCH])).rows;
    } catch (error) {
      // fx-swallow-ok: counted as failed and handed to onError; the lease work above is already done and the next tick looks again
      result.joblessErrors++;
      deps.onError?.(NIL_RUN_ID, error);
      return { due, full: false };
    }
    const full = waiting.length >= RUNNER_LEASE_SWEEP_BATCH;
    for (const row of waiting) {
      try {
        const state = await withTenant(pool, row.account_id, async (client) => {
          // `follow_up_child`: the parent is a failed runner run whose last move to `failed` recorded runner_lost or usage_limit (C22 section 5's hop test, as advanceRunOutcome and the definer apply it).
          const { rows } = await client.query<{ status: string; jobless: boolean; follow_up_child: boolean }>(
            `SELECT a.status, (a.job_signed IS NULL) AS jobless,
                    COALESCE((SELECT p.status = 'failed' AND p.runtime = 'runner'
                                     AND COALESCE((SELECT e.payload->>'failureReason' FROM run_events e
                                                    WHERE e.account_id = $2 AND e.run_id = p.id AND e.kind = 'run.status_changed' AND e.payload->>'to' = 'failed'
                                                    ORDER BY e.seq DESC LIMIT 1), '') = ANY($3)
                                FROM agent_runs p WHERE p.id = a.parent_run_id AND p.account_id = $2), false) AS follow_up_child
               FROM agent_runs a WHERE a.id = $1 AND a.account_id = $2`,
            [row.run_id, row.account_id, FOLLOW_UP_HOP_REASONS],
          );
          return rows[0];
        });
        if (!state || state.status !== "pending" || !state.jobless) continue;
        const age = at.getTime() - row.created_at.getTime();
        if (age >= JOBLESS_FAIL_AFTER_MS) {
          const written = await writeRunStatus(pool, { accountId: row.account_id, runId: row.run_id, from: "pending", to: "failed", failureReason: "internal_error" });
          if (written.updated) result.joblessFailed++;
          continue;
        }
        if (state.follow_up_child && age >= JOBLESS_RETRY_AFTER_MS && deps.followUp) {
          // The port fails the child itself when the dispatch cannot be done, and treats a job that appeared meanwhile as success.
          await deps.followUp.dispatchChild({ accountId: row.account_id, runId: row.run_id });
          result.joblessRetried++;
          soonest(row.created_at.getTime() + JOBLESS_FAIL_AFTER_MS);
          continue;
        }
        soonest(row.created_at.getTime() + (state.follow_up_child && deps.followUp ? JOBLESS_RETRY_AFTER_MS : JOBLESS_FAIL_AFTER_MS));
      } catch (error) {
        // fx-swallow-ok: counted as failed and handed to onError (a fixed code and the run id); the next tick looks again
        result.joblessErrors++;
        deps.onError?.(row.run_id, error);
      }
    }
    return { due, full };
  }

  return {
    async sweepRunnerLeases() {
      const result: RunnerLeaseSweepResult = {
        leasesListed: 0,
        lost: 0,
        followUpsCreated: 0,
        followUpsExhausted: 0,
        followUpsFailed: 0,
        joblessRetried: 0,
        joblessFailed: 0,
        joblessErrors: 0,
        revoked: 0,
        wallClockTimedOut: 0,
        held: 0,
        leasesSkipped: 0,
        leasesFailed: 0,
        nextDueAt: null,
      };
      const at = new Date(now());
      // The list orders by what is due soonest; the class default is only an ordering hint, the fence below uses the account's own figure.
      const { rows } = await pool.query<Listed>("SELECT * FROM agent_run_list_running_runner_runs($1, $2)", [RUNNER_LEASE_SWEEP_BATCH, RUNNER_MAX_RUN_WALL_CLOCK_MS]);
      result.leasesListed = rows.length;
      let earliest: number | null = null;
      for (const row of rows) {
        try {
          const wallClockMs = limits(row.account_id).maxRunWallClockMs;
          const outcome = await withTenant(pool, row.account_id, async (client): Promise<Outcome> => {
            const input = { accountId: row.account_id, runnerId: row.runner_id, runId: row.run_id, leaseGeneration: row.lease_generation };
            const verdict = await leaseVerdict(client, input, at, 0, wallClockMs);
            const move = async (to: "failed" | "timed_out", failureReason: FailureReason, kind: "revoked" | "timed_out"): Promise<Outcome> => {
              const written = await writeRunStatusOn(client, { accountId: row.account_id, runId: row.run_id, from: "running", to, failureReason });
              return { kind: written.updated ? kind : "skipped" };
            };
            if (verdict === "expired") {
              const written = await writeRunStatusOn(client, { accountId: row.account_id, runId: row.run_id, from: "running", to: "failed", failureReason: "runner_lost" });
              if (!written.updated) return { kind: "skipped" };
              // In this transaction: the child commits with the move or not at all.
              return { kind: "lost", followUp: await requestFollowUp(client, row.run_id) };
            }
            if (verdict === "revoked") return move("failed", "runner_revoked", "revoked");
            if (verdict === "wall_clock") return move("timed_out", "wall_clock_limit", "timed_out");
            if (verdict !== "ok") return { kind: "skipped" };
            // Held. The row is locked by the check above, so what is read now is what a heartbeat left.
            const fresh = await client.query<{ lease_expires_at: Date; started_at: Date | null }>("SELECT lease_expires_at, started_at FROM agent_runs WHERE id = $1 AND account_id = $2", [row.run_id, row.account_id]);
            const lease = fresh.rows[0]!.lease_expires_at.getTime();
            const wall = fresh.rows[0]!.started_at === null ? Number.POSITIVE_INFINITY : fresh.rows[0]!.started_at.getTime() + wallClockMs;
            return { kind: "held", dueAt: Math.min(lease, wall) };
          });
          if (outcome.kind === "held") {
            result.held++;
            earliest = earliest === null ? outcome.dueAt : Math.min(earliest, outcome.dueAt);
          } else if (outcome.kind === "lost") {
            result.lost++;
            if (outcome.followUp.kind === "created") result.followUpsCreated++;
            else if (outcome.followUp.kind === "exhausted") result.followUpsExhausted++;
            // After the commit. A failure here is counted and reported; the loss itself is recorded and stays recorded.
            if (deps.followUp) {
              await settleFollowUp(deps.followUp, row.account_id, row.run_id, outcome.followUp).catch((error: unknown) => {
                result.followUpsFailed++;
                deps.onError?.(row.run_id, error);
              });
            }
          } else if (outcome.kind === "revoked") result.revoked++;
          else if (outcome.kind === "timed_out") result.wallClockTimedOut++;
          else result.leasesSkipped++;
        } catch (error) {
          // fx-swallow-ok: counted as failed and handed to onError (the worker logs a fixed code and the run id); the next tick looks again
          result.leasesFailed++;
          deps.onError?.(row.run_id, error);
        }
      }
      const jobless = await sweepJoblessRuns(result, earliest, at);
      earliest = jobless.due;
      const moved = result.lost + result.revoked + result.wallClockTimedOut + result.leasesSkipped + result.joblessFailed;
      if (result.leasesFailed > 0 || result.joblessErrors > 0) result.nextDueAt = now() + (deps.retryDelayMs ?? 5 * 60_000);
      // A full list means more may be hidden behind it; come back at once when this tick made room (moved runs off the lease list, or failed runs off the jobless one).
      else if ((rows.length >= RUNNER_LEASE_SWEEP_BATCH && moved > 0) || (jobless.full && result.joblessFailed > 0)) result.nextDueAt = now();
      else result.nextDueAt = earliest;
      return result;
    },
  };
}
