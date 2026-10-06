import type { Pool } from "pg";
import type { ExecutionRun } from "./executionTarget.js";
import type { Role } from "./types.js";
import { DEFAULT_SDK_CALL_TIMEOUT_MS } from "./vercelSandboxPort.js";

/**
 * D#2 COMPUTE-SETTLE CS-2b-1: the deferred settle sweep. Vercel reports a stopped sandbox's CPU and network late, so a
 * run that ended without full figures keeps its compute reservation OPEN with `compute_settle_due_at` set. Each tick
 * (ten minutes apart, D#454 H3c) lists the due runs across tenants (`compute_settle_list_due`, 0691: oldest first), re-reads each
 * run's persisted session ids through `settleRunCompute`, and settles it: 'measured' as soon as every figure is in,
 * else at the deadline with the best tier left.
 *
 * Idempotent, not exclusive: two overlapping ticks may both read the same run, but `settleRunCompute` re-reads the
 * open rows under the per-budget advisory locks, so only one writes. The observable is settle-once and delete-once:
 * the sandbox is deleted only by the tick whose settle WROTE the row. No transaction or lock is held across a provider
 * read, and the runs are handled one after another so a slow read never holds a pooled connection for the others.
 */

/** How long after the recorded stop the provider is waited on for its figures. */
export const SETTLE_DEADLINE_MS = 15 * 60_000;

/** The most runs one tick takes (the definer enforces the same ceiling). */
export const SWEEP_BATCH_SIZE = 50;

/** A tick's time budget: budget + one worst-case run must stay under the cron route's 800 s ceiling. */
export const SWEEP_TIME_BUDGET_MS = 600_000;

/**
 * The longest one run can take, on the path with the most provider calls (a settle whose measure read is slow, then
 * the backstop delete): the settle's open and its measure read, then the delete's open and its delete, each bounded
 * by one SDK call timeout.
 */
export const SWEEP_RUN_WORST_CASE_MS = 4 * DEFAULT_SDK_CALL_TIMEOUT_MS;

/** The slice of `SandboxTarget` the sweep drives. */
export interface ComputeSettler {
  settleRunCompute(run: ExecutionRun, opts: { deadlinePassed: boolean; sweep: true }): Promise<{ wrote: boolean }>;
  deleteSettledSandbox(run: ExecutionRun, opts?: { backstop?: boolean }): Promise<void>;
}

export interface SweepDeps {
  pool: Pool;
  target: ComputeSettler;
  now?: () => Date;
  /** Milliseconds from a monotonic source; injectable for tests. Default `performance.now()`. */
  clock?: () => number;
  /** How long a tick may spend before it stops starting runs. Default `SWEEP_TIME_BUDGET_MS`. */
  timeBudgetMs?: number;
  /** Called with the run id and the error for every failure the tick moved past. */
  onError?: (runId: string, err: unknown) => void;
}

export interface SweepResult {
  /** Runs this tick looked at. */
  listed: number;
  /** Runs whose ledger row THIS tick wrote. */
  settled: number;
  /** Settled runs whose sandbox clean-up completed (an already-gone sandbox, or a persistent one left alone, counts as done). */
  deleted: number;
  /** Runs whose settle or delete failed; a failed settle leaves the run due. */
  failed: number;
  /** Listed runs left untouched (still due) because the tick ran out of its time budget. */
  skipped: number;
}

interface DueRow {
  account_id: string;
  run_id: string;
  role: Role;
  dispatch_repo_id: string | null;
  dispatch_pr_number: string | null;
  sandbox_stopped_at: Date | null;
  compute_settle_due_at: Date;
}

export async function sweepComputeSettle(deps: SweepDeps): Promise<SweepResult> {
  const now = deps.now ?? (() => new Date());
  const result: SweepResult = { listed: 0, settled: 0, deleted: 0, failed: 0, skipped: 0 };
  const { rows } = await deps.pool.query<DueRow>(
    `SELECT account_id, run_id, role, dispatch_repo_id, dispatch_pr_number::text AS dispatch_pr_number, sandbox_stopped_at, compute_settle_due_at
       FROM compute_settle_list_due($1)`,
    [SWEEP_BATCH_SIZE],
  );
  result.listed = rows.length;

  const clock = deps.clock ?? (() => performance.now());
  const started = clock();
  const budgetMs = deps.timeBudgetMs ?? SWEEP_TIME_BUDGET_MS;
  for (const [index, row] of rows.entries()) {
    // Out of time: the runs not yet started stay due and untouched for the next tick.
    if (clock() - started + SWEEP_RUN_WORST_CASE_MS > budgetMs) {
      result.skipped = rows.length - index;
      break;
    }
    const run = runOf(row);
    // The wait is counted from the recorded stop; a run that never recorded one is counted from when it became due.
    const deadlinePassed = now().getTime() >= (row.sandbox_stopped_at ?? row.compute_settle_due_at).getTime() + SETTLE_DEADLINE_MS;
    // A delete failure other than 404/410 on the healthy path leaves a stopped (non-billing) sandbox: SANDBOX-REAPER retries it.
    const deleteQuietly = async (backstop = false): Promise<void> => {
      try {
        await deps.target.deleteSettledSandbox(run, { backstop });
        result.deleted++;
      } catch (err) {
        result.failed++;
        deps.onError?.(run.id, err);
      }
    };
    try {
      const { wrote } = await deps.target.settleRunCompute(run, { deadlinePassed, sweep: true });
      if (wrote) {
        result.settled++;
        await deleteQuietly();
      }
    } catch (err) {
      result.failed++;
      deps.onError?.(run.id, err);
      // Back the run off so a settle that keeps throwing cannot crowd newer due runs out of the batch. A throw only:
      // a settle still waiting for figures (wrote=false) is not a failure. If this write fails, the run stays due.
      try {
        await recordSettleFailed(deps.pool, run);
      } catch (markErr) {
        deps.onError?.(run.id, markErr);
      }
      // Backstop: past the deadline a stopped sandbox is not left to run up cost because its settle keeps failing.
      // The run stays due, and a later successful settle deletes again (an already-gone sandbox counts as done).
      if (deadlinePassed) await deleteQuietly(true);
    }
  }
  return result;
}

/** Records one failed settle of the run under its own tenant context (`agent_run_settle_failed`, 0694). */
async function recordSettleFailed(pool: Pool, run: ExecutionRun): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config($1, $2, true)", ["app.account_id", run.accountId]);
    await client.query("SELECT agent_run_settle_failed($1::uuid, $2::uuid)", [run.accountId, run.id]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.query("RESET app.account_id").catch(() => {});
    client.release();
  }
}

/** The run as `cancelRun` rebuilds it: only the identity matters to a settle (the rest are placeholders). */
function runOf(row: DueRow): ExecutionRun {
  return {
    id: row.run_id,
    accountId: row.account_id,
    role: row.role,
    product: "team",
    repoId: row.dispatch_repo_id ?? undefined,
    pr: row.dispatch_pr_number ? Number(row.dispatch_pr_number) : undefined,
    roleCard: "",
    prompt: "",
    model: "",
    capUsd: 0,
    spend: { plan: "starter" },
  };
}
