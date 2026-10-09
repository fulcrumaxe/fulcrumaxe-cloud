import type { Pool } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { RUNNER_QUEUE_TTL_MS, isRunnerMode, writeRunStatus } from "@fx/runner";

/**
 * D#6 R2b (correction C12 sections 2.9 and 5): the runner queue sweep. A run for a `runner_local` repo waits in `pending`
 * until a runner claims it. If none does by the job's `expires_at` (72 hours after dispatch), this moves it to `timed_out`
 * with the reason `queue_ttl`, through the same compare-and-set writer every status change uses, so the move records its
 * `run.status_changed` event and a run someone else moved first (a claim, a cancel) is left alone.
 *
 * Cross-tenant, so it is for the cron only and never callable from a user request (it takes no input). It lists the waiting
 * runner runs through `agent_run_list_pending_runner_runs` (0734), oldest first, and then handles each under that run's own
 * tenant context. The exact expiry is read from the signed job there: the lister runs as a login that may not read the job.
 * A run that has no job yet falls back to `created_at` plus the queue time, so a run whose job was never written is still
 * cleaned up.
 *
 * Race backstop (correction C24 section 2): switching a repo off `runner_local` cancels its pending runner runs in the switch's own
 * transaction, but a dispatch that read the old mode can insert one just after the switch commits. So each tick also cancels,
 * whatever the run's age, a pending runner run whose repo is now in another mode (`sandbox`), with the failure reason
 * `execution_mode_changed` and through the same writer: it would otherwise wait out its 72 hours, never claimed. A run whose repo
 * row is gone is not touched here (no mode change ended it; its queue time does). Only runs the lister returns are looked at, and
 * the lister is oldest first and limited to 50, so a run behind 50 older waiting runs is reached once those are claimed or end.
 *
 * Requeue is the existing `retry_run` (no new path). A retry of a run that ended this way keeps the same model (C12 A5; the
 * retry module already refuses to escalate on `queue_ttl`).
 *
 * Idempotent and safe to overlap: two ticks racing on a run both read `pending`, one wins the compare-and-set and the other
 * counts it as `skipped`.
 */

/** The most waiting runs one tick looks at (the lister allows 50). */
export const RUNNER_QUEUE_SWEEP_BATCH = 50;

export interface RunnerQueueSweepResult {
  /** Waiting runner runs this tick looked at. */
  listed: number;
  /** Runs moved to `timed_out` by this tick. */
  expired: number;
  /** Runs cancelled because their repo is no longer `runner_local` (the race backstop). */
  cancelled: number;
  /** Runs still inside their queue time. */
  waiting: number;
  /** Runs that were no longer waiting when looked at again, or that another writer moved first. */
  skipped: number;
  failed: number;
  /** When work known to remain becomes due (epoch ms): the earliest end of a queue time, or soon when the batch was full or a run failed. Null when no run is waiting. */
  nextDueAt: number | null;
}

export interface RunnerQueueSweeper {
  /** One tick. For the cron only: it works across tenants. */
  sweepRunnerQueue(): Promise<RunnerQueueSweepResult>;
}

export interface RunnerQueueSweepDeps {
  /** Milliseconds since the epoch; tests inject a fixed clock. */
  now?: () => number;
  /** How soon a tick looks again after a failure. */
  retryDelayMs?: number;
  onError?: (runId: string, error: unknown) => void;
}

interface Waiting {
  account_id: string;
  run_id: string;
  created_at: Date;
}

/** Package-internal: `pool` is the runner login's pool and is captured here, never exposed. */
export function createRunnerQueueSweeper(pool: Pool, deps: RunnerQueueSweepDeps = {}): RunnerQueueSweeper {
  const now = deps.now ?? Date.now;
  return {
    async sweepRunnerQueue() {
      const result: RunnerQueueSweepResult = { listed: 0, expired: 0, cancelled: 0, waiting: 0, skipped: 0, failed: 0, nextDueAt: null };
      const { rows } = await pool.query<Waiting>("SELECT account_id, run_id, created_at FROM agent_run_list_pending_runner_runs($1)", [RUNNER_QUEUE_SWEEP_BATCH]);
      result.listed = rows.length;
      let earliest: number | null = null;
      for (const row of rows) {
        try {
          const state = await withTenant(pool, row.account_id, async (client) => {
            const found = await client.query<{ status: string; expires_at: string | null; repo_mode: string | null }>(
              `SELECT a.status, a.job_signed #>> '{job,expires_at}' AS expires_at,
                      (SELECT g.execution_mode FROM repos g WHERE g.id = a.dispatch_repo_id AND g.account_id = a.account_id) AS repo_mode
                 FROM agent_runs a WHERE a.id = $1 AND a.account_id = $2`,
              [row.run_id, row.account_id],
            );
            return found.rows[0];
          });
          if (!state || state.status !== "pending") {
            result.skipped++;
            continue;
          }
          if (state.repo_mode !== null && !isRunnerMode(state.repo_mode)) {
            const moved = await writeRunStatus(pool, { accountId: row.account_id, runId: row.run_id, from: "pending", to: "cancelled", failureReason: "execution_mode_changed" });
            if (moved.updated) result.cancelled++;
            else result.skipped++;
            continue;
          }
          const parsed = state.expires_at === null ? Number.NaN : Date.parse(state.expires_at);
          const expiresAt = Number.isFinite(parsed) ? parsed : row.created_at.getTime() + RUNNER_QUEUE_TTL_MS;
          if (expiresAt > now()) {
            result.waiting++;
            earliest = earliest === null ? expiresAt : Math.min(earliest, expiresAt);
            continue;
          }
          const written = await writeRunStatus(pool, { accountId: row.account_id, runId: row.run_id, from: "pending", to: "timed_out", failureReason: "queue_ttl" });
          if (written.updated) result.expired++;
          else result.skipped++;
        } catch (error) {
          // fx-swallow-ok: counted as failed and handed to onError (the worker logs a fixed code and the run id); the next tick looks again
          result.failed++;
          deps.onError?.(row.run_id, error);
        }
      }
      // A full batch may have left more behind, and a failure should be tried again soon; otherwise the next run to expire.
      if (result.failed > 0) result.nextDueAt = now() + (deps.retryDelayMs ?? 5 * 60_000);
      else if (rows.length >= RUNNER_QUEUE_SWEEP_BATCH && result.expired + result.cancelled + result.skipped > 0) result.nextDueAt = now();
      else result.nextDueAt = earliest;
      return result;
    },
  };
}
