import type { Pool } from "pg";
import type { ExecutionRun, LostRunOutcome } from "./executionTarget.js";
import { reportError } from "@fx/telemetry";
import { LOST_CONFIRM_DELAY_MS } from "./targets/sandboxTarget.js";
import type { Role } from "./types.js";
import { DEFAULT_SDK_CALL_TIMEOUT_MS } from "./vercelSandboxPort.js";

/**
 * The lost-run sweep. A run that is `running` while its sandbox was stopped or deleted from outside never reaches its own
 * finalize: the stream that would call it ended with the invocation that held it. The follower catches such a run while
 * it is followed, but a run followed by an older deployment's workflow (or one whose follower is gone) would stay
 * `running` for good. Each tick (a minute apart) lists runs that have been `running` a while across tenants
 * (`agent_run_list_running`, 0704; it lists every running run and the sweep applies the age), asks the run's target whether its sandbox is still there, and settles the ones that
 * are not, as failed with `sandbox_stopped`.
 *
 * Idempotent, not exclusive: `settleIfLost` re-reads the run's status and finalizes through the compare-and-set writer, so
 * two overlapping ticks (or the follower) settle a run once. A provider that cannot answer leaves the run for a later tick.
 * The runs are handled one after another, no connection is held across a provider call, and the tick stops starting runs
 * when its time budget is used.
 */

/** A run whose sandbox was requested more recently than this is left alone: its sandbox may still be coming up. */
export const LOST_RUN_MIN_AGE_SECONDS = 120;

/** The longest any sandbox lives (the plan maximum, `SANDBOX_MAX_TIMEOUT_MS`; a test pins them equal): a run older than this is not counted as running. */
export const LOST_RUN_STALE_MS = 24 * 60 * 60_000;

/** The most runs one tick looks at (the definer enforces 50). */
export const LOST_SWEEP_BATCH_SIZE = 20;

/**
 * The most one run can take on the longest path: two looks (a provider read and a row read each), the pause between them,
 * and a settle (stop, counters, measure with its re-reads, delete), each provider call bounded by one SDK call timeout.
 */
export const LOST_RUN_WORST_CASE_MS = 6 * DEFAULT_SDK_CALL_TIMEOUT_MS + LOST_CONFIRM_DELAY_MS + 5_000;

/** A tick's time budget: no run is started unless it can still finish inside it, so a tick never runs longer than this. */
export const LOST_SWEEP_TIME_BUDGET_MS = 250_000;

/** The slice of a target the sweep drives. */
export interface LostRunSettler {
  settleIfLost(run: ExecutionRun): Promise<LostRunOutcome>;
}

export interface LostSweepDeps {
  pool: Pool;
  target: LostRunSettler;
  /** Milliseconds from a monotonic source; injectable for tests. Default `performance.now()`. */
  clock?: () => number;
  timeBudgetMs?: number;
  now?: () => number;
  /** Tests only: the worst case one run is assumed to take, default `LOST_RUN_WORST_CASE_MS`. */
  runWorstCaseMs?: number;
  /** Called with the run id and the error for every failure the tick moved past. */
  onError?: (runId: string, err: unknown) => void;
}

export interface LostSweepResult {
  /** Running runs this tick listed (young ones included): while any exist the cron keeps its marker. */
  listed: number;
  /** Listed runs too young to look at. */
  young: number;
  /** Running runs older than the longest sandbox timeout: still looked at, but not counted in `listed`, so a run nobody can answer for cannot keep the cron's marker (and the database awake) for ever. */
  stale: number;
  /** Runs settled as failed because their sandbox was stopped or gone. */
  settled: number;
  /** Runs whose sandbox is still running. */
  alive: number;
  /** Runs the provider could not answer for; a later tick looks again. */
  unknown: number;
  failed: number;
  /** Listed runs not started because the tick ran out of its time budget. */
  skipped: number;
}

interface RunningRow {
  account_id: string;
  run_id: string;
  role: Role;
  dispatch_repo_id: string | null;
  dispatch_pr_number: string | null;
  sandbox_requested_at: Date;
}

export async function sweepLostRuns(deps: LostSweepDeps): Promise<LostSweepResult> {
  const result: LostSweepResult = { listed: 0, young: 0, stale: 0, settled: 0, alive: 0, unknown: 0, failed: 0, skipped: 0 };
  const { rows } = await deps.pool.query<RunningRow>(
    `SELECT account_id, run_id, role, dispatch_repo_id, dispatch_pr_number::text AS dispatch_pr_number, sandbox_requested_at
       FROM agent_run_list_running($1, 0)`,
    [LOST_SWEEP_BATCH_SIZE],
  );
  result.listed = rows.length;
  const clock = deps.clock ?? (() => performance.now());
  const started = clock();
  const budgetMs = deps.timeBudgetMs ?? LOST_SWEEP_TIME_BUDGET_MS;
  const now = (deps.now ?? Date.now)();
  result.stale = rows.filter((r) => now - r.sandbox_requested_at.getTime() > LOST_RUN_STALE_MS).length;
  result.listed = rows.length - result.stale;
  for (const [index, row] of rows.entries()) {
    // A run whose sandbox was requested moments ago may still be coming up: it is counted as running, not looked at.
    if (now - row.sandbox_requested_at.getTime() < LOST_RUN_MIN_AGE_SECONDS * 1000) {
      result.young++;
      continue;
    }
    if (clock() - started + (deps.runWorstCaseMs ?? LOST_RUN_WORST_CASE_MS) > budgetMs) {
      result.skipped = rows.length - index;
      break;
    }
    try {
      const outcome = await deps.target.settleIfLost(runOf(row));
      if (outcome === "settled") result.settled++;
      else if (outcome === "alive") result.alive++;
      else result.unknown++;
    } catch (err) {
      // fx-swallow-ok: counted as failed and handed to onError (the worker logs a fixed code and the run id); the next tick looks again
      result.failed++;
      deps.onError?.(row.run_id, err);
    }
  }
  // A provider that keeps answering "unknown" would otherwise show only as a number in the cron response.
  if (result.unknown > 0) reportError(new Error("lost-run check: provider could not answer"), { stage: "run.lost_sweep" });
  return result;
}

/** The run as `cancelRun` rebuilds it: only the identity matters to a settle (the rest are placeholders). */
function runOf(row: RunningRow): ExecutionRun {
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
