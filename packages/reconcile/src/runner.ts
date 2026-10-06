import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

/** One job's own time budget. */
export const JOB_BUDGET_MS = 60_000;
/** The whole tick's budget; stays inside the route's 300 s maxDuration. */
export const TICK_BUDGET_MS = 240_000;
/** How long a taken lease holds. Longer than a job budget, so a job that is still inside its budget never loses it. */
export const LEASE_SECONDS = 90;
/**
 * A finished job is next due at (interval - slack) from now. The cron fires on a fixed minute but a tick can start a
 * little early or late, and a job due exactly one interval after it finished would be missed by a tick that starts a
 * few seconds earlier, which would silently stretch every 24 h job to 30 h. The slack is capped at a tenth of the
 * interval in SQL.
 */
export const DUE_SLACK_SECONDS = 600;
/** Lap time above this many intervals is a breach. */
export const LAP_ALERT_FACTOR = 2;

/** The shape of `reportError` from `@fx/telemetry`; the tick takes it as a dependency so this package does no I/O of its own. */
export type ReportError = (err: unknown, ctx: { stage: string; route: string; code?: string }) => void;

export const RECONCILE_ROUTE = '/api/cron/reconcile';

/** A per-run allowance of outside calls (GitHub, Stripe, a provider). A job asks before each call and stops when told no. */
export interface CallBudget {
  readonly limit: number;
  readonly used: number;
  /** Spend `n` calls; false (and nothing spent) when that would go over the limit. */
  take(n?: number): boolean;
}

export interface JobContext {
  pool: Pool;
  /** Where the last run stopped, or null for a fresh pass. */
  cursor: string | null;
  /** Aborted when the job's time budget runs out. A job that makes outside calls passes it on. */
  signal: AbortSignal;
  calls: CallBudget;
  /** Milliseconds left in this job's budget (never past the tick's end). */
  msLeft(): number;
  /** Record progress. If the job is cut off, the runner saves the last checkpoint as the cursor. */
  checkpoint(cursor: string | null): void;
}

export interface JobResult {
  /** The cursor to resume from; null when the pass is complete. */
  cursor: string | null;
  /** True when the cursor wrapped: the job covered its whole estate. A job that stopped on a budget returns false. */
  wrapped: boolean;
  /**
   * A result the job itself decided. `not_configured`: the job's outside credential is absent, so it did nothing.
   * `error`: the job already reported a failure and stopped, and its cursor (the progress made before it) is kept,
   * which a thrown error would not do. Either one means the pass did not complete, so `wrapped` is ignored.
   */
  code?: 'not_configured' | 'error';
}

export interface ReconcileJob {
  /** Must match a seeded reconcile_jobs row. At most 29 characters, so `reconcile.<name>` fits a report stage. */
  name: string;
  /** Per-run budget of outside calls; 0 for a job that calls nothing outside. */
  maxCalls: number;
  run(ctx: JobContext): Promise<JobResult>;
}

export type JobOutcome = 'ok' | 'budget' | 'error' | 'disabled' | 'not_due' | 'skipped' | 'not_configured';

export interface TickSummary {
  enabled: boolean;
  results: { job: string; result: JobOutcome }[];
}

export interface Timer {
  promise: Promise<void>;
  cancel(): void;
}

export interface TickDeps {
  /** The platform_ops pool. */
  pool: Pool;
  jobs: readonly ReconcileJob[];
  /** False is the kill switch: every job records `disabled` and nothing runs. */
  enabled: boolean;
  reportError: ReportError;
  /** Milliseconds clock for the budgets. Tests pass a fake. */
  now?: () => number;
  /** Starts a timer that resolves after `ms`. Tests pass a fake. */
  timer?: (ms: number) => Timer;
  jobBudgetMs?: number;
  tickBudgetMs?: number;
  leaseSeconds?: number;
}

function realTimer(ms: number): Timer {
  let handle: NodeJS.Timeout | undefined;
  const promise = new Promise<void>((resolve) => {
    handle = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => clearTimeout(handle) };
}

function newCallBudget(limit: number): CallBudget {
  let used = 0;
  return {
    limit,
    get used() {
      return used;
    },
    take(n = 1) {
      if (used + n > limit) return false;
      used += n;
      return true;
    },
  };
}

const TIMED_OUT = Symbol('timed_out');

/**
 * One cron tick. Jobs run in the order given, one at a time. A job runs only when this tick wins its lease with a
 * single atomic UPDATE (due, and the lease empty or expired); a second tick running at the same moment gets no row back
 * and skips it. Every failure goes to `reportError`, and nothing here echoes an error message into the database: the result
 * column holds only a short code.
 */
export async function runTick(deps: TickDeps): Promise<TickSummary> {
  const now = deps.now ?? Date.now;
  const timer = deps.timer ?? realTimer;
  const jobBudgetMs = deps.jobBudgetMs ?? JOB_BUDGET_MS;
  const tickBudgetMs = deps.tickBudgetMs ?? TICK_BUDGET_MS;
  const leaseSeconds = deps.leaseSeconds ?? LEASE_SECONDS;
  const me = `tick-${randomUUID()}`;
  const results: TickSummary['results'] = [];

  if (!deps.enabled) {
    // The kill switch: record it, change nothing else, call nothing outside.
    const names = deps.jobs.map((job) => job.name);
    try {
      await deps.pool.query(`UPDATE reconcile_jobs SET last_result_code = 'disabled' WHERE name = ANY($1::text[])`, [names]);
    } catch (err) {
      deps.reportError(err, { stage: 'reconcile.disabled', route: RECONCILE_ROUTE });
    }
    return { enabled: false, results: names.map((job) => ({ job, result: 'disabled' as const })) };
  }

  const tickStart = now();
  for (const job of deps.jobs) {
    if (now() - tickStart >= tickBudgetMs) {
      results.push({ job: job.name, result: 'skipped' });
      continue;
    }
    results.push({ job: job.name, result: await runOne(job) });
  }
  return { enabled: true, results };

  async function runOne(job: ReconcileJob): Promise<JobOutcome> {
    const stage = `reconcile.${job.name}`;
    let startCursor: string | null;
    try {
      // The one atomic step that decides who runs the job: due, and the lease empty or expired. Without the expiry
      // test a second tick would take a lease that is still held.
      const lease = await deps.pool.query<{ cursor: string | null }>(
        `UPDATE reconcile_jobs
            SET lease_owner = $2, lease_expires_at = now() + make_interval(secs => $3)
          WHERE name = $1
            AND next_due_at <= now()
            AND (lease_expires_at IS NULL OR lease_expires_at < now())
        RETURNING cursor`,
        [job.name, me, leaseSeconds],
      );
      if (lease.rowCount === 0) return 'not_due';
      startCursor = lease.rows[0]!.cursor;
    } catch (err) {
      deps.reportError(err, { stage, route: RECONCILE_ROUTE });
      return 'error';
    }

    const jobStart = now();
    const deadline = Math.min(jobStart + jobBudgetMs, tickStart + tickBudgetMs);
    const abort = new AbortController();
    let latest = startCursor;
    const ctx: JobContext = {
      pool: deps.pool,
      cursor: startCursor,
      signal: abort.signal,
      calls: newCallBudget(job.maxCalls),
      msLeft: () => Math.max(0, deadline - now()),
      checkpoint: (cursor) => {
        latest = cursor;
      },
    };

    let outcome: JobOutcome;
    let cursor: string | null;
    let wrapped = false;
    const budgetTimer = timer(Math.max(0, deadline - now()));
    try {
      const running = job.run(ctx);
      const raced = await Promise.race([running, budgetTimer.promise.then((): typeof TIMED_OUT => TIMED_OUT)]);
      if (raced === TIMED_OUT) {
        // The job did not stop in time. Keep its last checkpoint and let the next tick continue; this is not an error.
        abort.abort();
        running.catch(() => {
          // fx-swallow-ok: the job was cut off by its budget; a late failure of an abandoned run has nowhere to go
        });
        outcome = 'budget';
        cursor = latest;
      } else {
        wrapped = raced.wrapped && raced.code === undefined;
        cursor = wrapped ? null : raced.cursor;
        outcome = raced.code ?? (wrapped ? 'ok' : 'budget');
      }
    } catch (err) {
      deps.reportError(err, { stage, route: RECONCILE_ROUTE });
      outcome = 'error';
      cursor = startCursor;
    } finally {
      budgetTimer.cancel();
    }

    try {
      // Guarded by the lease owner: a tick whose lease already expired and was taken over writes nothing.
      const done = await deps.pool.query(
        `UPDATE reconcile_jobs
            SET cursor = $3,
                last_result_code = $4,
                last_ok_at = CASE WHEN $4 IN ('ok', 'budget') THEN now() ELSE last_ok_at END,
                last_full_pass_at = CASE WHEN $5::boolean THEN now() ELSE last_full_pass_at END,
                next_due_at = CASE WHEN $5::boolean
                                   THEN greatest(now(), now() + make_interval(secs => interval_seconds)
                                                        - make_interval(secs => least($6::int, interval_seconds / 10)))
                                   ELSE now() END,
                lease_owner = NULL, lease_expires_at = NULL
          WHERE name = $1 AND lease_owner = $2`,
        [job.name, me, cursor, outcome, wrapped, DUE_SLACK_SECONDS],
      );
      if (done.rowCount === 0) {
        deps.reportError(new Error('reconcile lease lost before the result was saved'), { stage, route: RECONCILE_ROUTE, code: 'lease_lost' });
      }
    } catch (err) {
      deps.reportError(err, { stage, route: RECONCILE_ROUTE });
      return 'error';
    }
    return outcome;
  }
}

export interface LapTime {
  name: string;
  intervalSeconds: number;
  /** Seconds since the last full pass (or since the job was created, if it never completed one). */
  lapSeconds: number;
  /** True when no full pass has ever completed. */
  neverCompleted: boolean;
  /** Lap time above twice the interval: the per-run budget is too small for the estate. */
  breach: boolean;
  lastResultCode: string | null;
  lastOkAt: Date | null;
}

export function isLapBreach(lapSeconds: number, intervalSeconds: number): boolean {
  return lapSeconds > LAP_ALERT_FACTOR * intervalSeconds;
}

/** What the digest and the launch check read: every job's lap time, from database time. */
export async function readLapTimes(pool: Pool): Promise<LapTime[]> {
  const { rows } = await pool.query<{
    name: string;
    interval_seconds: number;
    lap: number;
    never: boolean;
    last_result_code: string | null;
    last_ok_at: Date | null;
  }>(
    `SELECT name, interval_seconds, last_result_code, last_ok_at,
            last_full_pass_at IS NULL AS never,
            EXTRACT(EPOCH FROM (now() - COALESCE(last_full_pass_at, created_at)))::float8 AS lap
       FROM reconcile_jobs ORDER BY name`,
  );
  return rows.map((row) => ({
    name: row.name,
    intervalSeconds: row.interval_seconds,
    lapSeconds: row.lap,
    neverCompleted: row.never,
    breach: isLapBreach(row.lap, row.interval_seconds),
    lastResultCode: row.last_result_code,
    lastOkAt: row.last_ok_at,
  }));
}
