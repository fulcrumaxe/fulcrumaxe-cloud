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
/**
 * The reconcile gate lets an idle reconciler connect only every fourth hourly slot (4 hours). Two jobs are seeded at 900 s and keep that
 * cadence by events instead: the code that creates their work marks the reconciler, and a tick that leaves such work behind reports their due
 * time (the reconcile handler in apps/web). While one of them has work, its lap is judged against its own interval, as for any job (breach
 * at 30 minutes). While it has none, nothing is waiting and the reconciler may sleep, so its lap is judged against this idle cadence.
 */
export const IDLE_RECONCILE_CADENCE_SECONDS = 4 * 60 * 60;
/** The two 15-minute jobs that sit behind the reconcile gate. */
export const FAST_RECONCILE_JOBS = ['sandbox_reap_terminal', 'model_credits_revalidate'] as const;
const GATED_FAST_JOBS: ReadonlySet<string> = new Set(FAST_RECONCILE_JOBS);

/** How long after a connection breaks for out-of-credit the credits job keeps its 15-minute cadence. */
export const CREDITS_FAST_WINDOW_SECONDS = 2 * 60 * 60;
/** After that window the credits job is looked at hourly until the connection changes. */
export const CREDITS_BACKED_OFF_CADENCE_SECONDS = 60 * 60;

/** What the credits job has to re-check: whether any connection is broken for out-of-credit, and how long ago the newest of those breaks happened. */
export interface CreditsBreak {
  broken: boolean;
  /** Seconds (database time) since the most recent credits break, or null when nothing is broken for credits. */
  ageSeconds: number | null;
  /**
   * True once every credits break is older than CREDITS_FAST_WINDOW_SECONDS: nobody has topped up for a while, so the 15-minute re-check
   * (which keeps the database awake) drops to hourly. A new break, or a top-up that clears the row, changes this by itself, because it is
   * derived from `model_connections.broken_at` and holds no stamp of its own.
   */
  backedOff: boolean;
}

/**
 * The credits state in one read. The newest break decides the cadence, so a connection that breaks while an older one is still broken puts the
 * job back on 15 minutes; a row broken before `broken_at` existed carries the migration's backfill time, and a null (never expected) counts as new.
 */
export async function readCreditsBreak(pool: Pick<Pool, 'query'>): Promise<CreditsBreak> {
  const { rows } = await pool.query<{ broken: boolean; age: number | null }>(
    `SELECT count(*) > 0 AS broken,
            EXTRACT(EPOCH FROM (now() - max(COALESCE(broken_at, now()))))::float8 AS age
       FROM model_connections
      WHERE status = 'broken' AND last_error_code = 'credits_exhausted'`,
  );
  const broken = rows[0]?.broken === true;
  const age = broken && typeof rows[0]?.age === 'number' ? rows[0].age : null;
  return { broken, ageSeconds: age, backedOff: age !== null && age >= CREDITS_FAST_WINDOW_SECONDS };
}

/** True while any model connection is broken for out-of-credit: the credits job has something to re-check. */
export async function hasBrokenCredits(pool: Pick<Pool, 'query'>): Promise<boolean> {
  return (await readCreditsBreak(pool)).broken;
}

/**
 * The interval a job's lap is judged against: its seeded one, except for a gated 15-minute job with nothing to do, which is judged
 * against the idle reconcile cadence, and the credits job while its re-check is backed off to hourly, which is judged against that hour
 * (so a stuck job still alerts at twice its effective cadence). `hasWork` is whether that job has work now (see jobsWithWork).
 */
export function lapBasisSeconds(name: string, intervalSeconds: number, hasWork: boolean, creditsBackedOff: boolean = false): number {
  if (!GATED_FAST_JOBS.has(name)) return intervalSeconds;
  if (!hasWork) return Math.max(intervalSeconds, IDLE_RECONCILE_CADENCE_SECONDS);
  return name === 'model_credits_revalidate' && creditsBackedOff ? Math.max(intervalSeconds, CREDITS_BACKED_OFF_CADENCE_SECONDS) : intervalSeconds;
}

/** What the work reads may assume about the environment. */
export interface WorkOptions {
  /**
   * Whether a terminal reap pass would delete what it finds (the sandbox reaper's effective mode is `on`). Under `off` or `dry_run` the pass leaves
   * every candidate in place, so pending candidates are not work the job can finish and must not make it look stuck. The database setting
   * (`sandbox_reap_settings.mode`) is read here and can only turn this off. Absent means the environment allows it.
   */
  reapDeletes?: boolean;
}

/** True when the reaper's terminal pass has settled sandboxes it could delete and is not stopped by the database setting. A failed read counts as no work (never a false alarm). */
async function terminalReapPending(pool: Pick<Pool, 'query'>, opts: WorkOptions, since: Date | null): Promise<boolean> {
  if (opts.reapDeletes === false) return false;
  try {
    const mode = await pool.query<{ mode: string | null }>('SELECT mode FROM sandbox_reap_settings');
    if (mode.rows.length !== 1 || mode.rows[0]?.mode === 'off' || mode.rows[0]?.mode === 'dry_run') return false;
    const { rows } = await pool.query<{ pending: boolean }>('SELECT sandbox_reap_terminal_pending($1::timestamptz) AS pending', [since]);
    return rows[0]?.pending === true;
  } catch {
    // fx-swallow-ok: an unreadable probe means "no extra work known"; the budget rule above still applies and a stall alert is never raised from a failed read
    return false;
  }
}

async function workState(pool: Pick<Pool, 'query'>, opts: WorkOptions = {}): Promise<{ working: ReadonlySet<string>; creditsBackedOff: boolean }> {
  const out = new Set<string>();
  const credits = await readCreditsBreak(pool);
  if (credits.broken) out.add('model_credits_revalidate');
  const { rows } = await pool.query<{ last_result_code: string | null; last_full_pass_at: Date | null }>("SELECT last_result_code, last_full_pass_at FROM reconcile_jobs WHERE name = 'sandbox_reap_terminal'");
  const job = rows[0];
  if (job !== undefined && (job.last_result_code === 'budget' || (await terminalReapPending(pool, opts, job.last_result_code === 'ok' ? job.last_full_pass_at : null)))) out.add('sandbox_reap_terminal');
  return { working: out, creditsBackedOff: credits.backedOff };
}

/**
 * Which gated jobs have work, from what the platform_ops login can see. Credits: a connection broken for out-of-credit. Terminal reap: the job's
 * last pass stopped on its budget (`last_result_code = 'budget'`), or the database says a settled finished sandbox the last full pass has not yet seen
 * is waiting (the one-boolean probe `sandbox_reap_terminal_pending(last_full_pass_at)`: no budget stop needed, no row shown). While the pass is failing
 * (a last result that is neither `ok` nor `budget`) the time is NULL, so every pending candidate counts: a pass that keeps failing has not looked at any of them.
 */
export async function jobsWithWork(pool: Pick<Pool, 'query'>, opts: WorkOptions = {}): Promise<ReadonlySet<string>> {
  return (await workState(pool, opts)).working;
}

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
   * which a thrown error would not do. `breaker_tripped`: a job refused to apply a mass change (the installation job's detach
   * breaker); the job restarts its pass next time. `disabled`: the job's own switch is off (the sandbox reaper's mode), so it did nothing
   * and kept its cursor. Each one means the pass did not complete, so `wrapped` is ignored.
   */
  code?: 'not_configured' | 'error' | 'breaker_tripped' | 'disabled';
}

export interface ReconcileJob {
  /** Must match a seeded reconcile_jobs row. At most 29 characters, so `reconcile.<name>` fits a report stage. */
  name: string;
  /** Per-run budget of outside calls; 0 for a job that calls nothing outside. */
  maxCalls: number;
  run(ctx: JobContext): Promise<JobResult>;
}

export type JobOutcome = 'ok' | 'budget' | 'error' | 'disabled' | 'not_due' | 'skipped' | 'not_configured' | 'breaker_tripped';

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
export async function readLapTimes(pool: Pool, opts: WorkOptions = {}): Promise<LapTime[]> {
  return (await readLapState(pool, opts)).laps;
}

/** The laps and the set of jobs with work from one read of the work state (the probe and the settings read run once). */
export async function readLapState(pool: Pool, opts: WorkOptions = {}): Promise<{ laps: LapTime[]; working: ReadonlySet<string> }> {
  const { working, creditsBackedOff } = await workState(pool, opts);
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
  const laps = rows.map((row) => ({
    name: row.name,
    intervalSeconds: row.interval_seconds,
    lapSeconds: row.lap,
    neverCompleted: row.never,
    breach: isLapBreach(row.lap, lapBasisSeconds(row.name, row.interval_seconds, working.has(row.name), creditsBackedOff)),
    lastResultCode: row.last_result_code,
    lastOkAt: row.last_ok_at,
  }));
  return { laps, working };
}
