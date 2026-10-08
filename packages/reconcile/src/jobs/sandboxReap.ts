import { RECONCILE_ROUTE, type JobContext, type JobResult, type ReconcileJob, type ReportError } from '../runner.js';

/**
 * D#2 SANDBOX-REAPER-1b (C82): the reaper's sweeps as reconcile jobs. A job here holds the `reconcile_jobs` lease on the
 * platform_ops pool (the runner does that) and does all of the reaper's database and provider work through the worker facade, on the
 * runner login: `sweepSandboxReap` and `sandboxInventory`. This package never sees a pool, a login or a sandbox port; it takes
 * plain data in and gives plain data back (a grep test keeps it that way). The lease only stops two ticks running the same job at
 * once; the row-level idempotency (the claim, in the database) is the worker side's, and neither stands in for the other.
 *
 * The kill switch is `FX_SANDBOX_REAP_MODE`, read by the cron handler and handed in as `mode`: `off` makes every job here return at
 * once with the result `disabled` and never call the worker; `dry_run` (the default when unset) and `on` go to the worker.
 * Any other value means `off`, and each pass reports `sandbox_reap_mode_invalid`. `FX_RECONCILE_ENABLED=0` still stops everything,
 * before a job is reached.
 */

export type SandboxReapMode = 'off' | 'dry_run' | 'on';

export interface SandboxReapModeSetting {
  mode: SandboxReapMode;
  /** False when the setting held a value that is none of the three (the mode is then `off`). */
  valid: boolean;
}

/**
 * Unset (or empty) is `dry_run`: a fresh environment never deletes until someone opts in. Exactly `off`, `dry_run` or `on` is itself.
 * Anything else, including a different case or spacing, is `off` and not valid, so a typo fails closed and is reported.
 */
export function parseSandboxReapMode(raw: string | undefined): SandboxReapModeSetting {
  if (raw === undefined || raw === '') return { mode: 'dry_run', valid: true };
  if (raw === 'off' || raw === 'dry_run' || raw === 'on') return { mode: raw, valid: true };
  return { mode: 'off', valid: false };
}

/** The sweep's input and result: the worker's `SweepSandboxReapInput` and `SweepSandboxReapResult`, restated as plain data. */
export interface SandboxReapSweepInput {
  pass: 'terminal' | 'ephemeral' | 'idle';
  mode: 'dry_run' | 'on';
  /** Epoch milliseconds. */
  now: number;
  cursor: string | null;
  maxCalls: number;
  timeBudgetMs: number;
}

export interface SandboxReapSweepResult {
  cursor: string | null;
  wrapped: boolean;
  callsUsed: number;
  deleted: number;
  stopped: number;
  skipped: number;
  candidates: { accountId: string; sandboxName: string; reason: string }[];
  alerts: string[];
  orphans: number;
}

export interface SandboxInventorySummary {
  accounts: number;
  live: number;
  stoppedExecutor: number;
  stoppedEphemeral: number;
  orphans: number;
  alerts: string[];
}

/** The only two things the reaper jobs may ask of the worker. A type-level test keeps this list from growing. */
export interface SandboxReapWorker {
  sweepSandboxReap(input: SandboxReapSweepInput): Promise<SandboxReapSweepResult>;
  sandboxInventory(input: { now: number }): Promise<SandboxInventorySummary>;
}

export interface SandboxReapJobDeps {
  mode: SandboxReapModeSetting;
  reportError: ReportError;
  /** Epoch milliseconds clock; tests pass a fake. */
  now?: () => number;
}

/** Provider calls one terminal or ephemeral pass may make (C81 criterion 11). */
export const SANDBOX_REAP_CALLS_PER_RUN = 60;
/** The inventory reads at most this many list pages in all (two prefixes, `INVENTORY_MAX_PAGES_PER_PREFIX` of @fx/runner each). */
export const SANDBOX_INVENTORY_CALLS_PER_RUN = 200;

export const SANDBOX_REAP_TERMINAL_JOB = 'sandbox_reap_terminal';
export const SANDBOX_REAP_EPHEMERAL_JOB = 'sandbox_reap_ephemeral';
export const SANDBOX_INVENTORY_JOB = 'sandbox_inventory';

/**
 * What every sandbox job does before it reaches the worker: the kill switch, then the unconfigured check. Returns the result to give
 * back, or null when the job should go on. Each case reports through `reportError` and returns the cursor it was given, unchanged.
 */
export function sandboxJobGate(job: string, ctx: JobContext, worker: SandboxReapWorker | null, deps: SandboxReapJobDeps): JobResult | null {
  const stage = `reconcile.${job}`;
  if (!deps.mode.valid) deps.reportError(new Error('FX_SANDBOX_REAP_MODE is not off, dry_run or on; the sandbox jobs are off'), { stage, route: RECONCILE_ROUTE, code: 'sandbox_reap_mode_invalid' });
  if (deps.mode.mode === 'off') return { cursor: ctx.cursor, wrapped: false, code: 'disabled' };
  if (worker === null) {
    deps.reportError(new Error('the sandbox worker is not configured; the sandbox jobs did nothing'), { stage, route: RECONCILE_ROUTE, code: 'sandbox_reap_unconfigured' });
    return { cursor: ctx.cursor, wrapped: false, code: 'not_configured' };
  }
  return null;
}

function reapPassJob(name: string, pass: 'terminal' | 'ephemeral', worker: SandboxReapWorker | null, deps: SandboxReapJobDeps): ReconcileJob {
  const stage = `reconcile.${name}`;
  return {
    name,
    maxCalls: SANDBOX_REAP_CALLS_PER_RUN,
    async run(ctx) {
      const gate = sandboxJobGate(name, ctx, worker, deps);
      if (gate !== null || worker === null) return gate ?? { cursor: ctx.cursor, wrapped: false, code: 'not_configured' };
      const mode = deps.mode.mode === 'on' ? 'on' : 'dry_run';
      const result = await worker.sweepSandboxReap({
        pass,
        mode,
        now: (deps.now ?? Date.now)(),
        cursor: ctx.cursor,
        maxCalls: ctx.calls.limit - ctx.calls.used,
        timeBudgetMs: ctx.msLeft(),
      });
      // Charge what the pass spent, save where it stopped, and report each alert once.
      ctx.calls.take(result.callsUsed);
      ctx.checkpoint(result.cursor);
      for (const alert of result.alerts) deps.reportError(new Error(`sandbox reaper: ${alert}`), { stage, route: RECONCILE_ROUTE, code: alert });
      return { cursor: result.cursor, wrapped: result.wrapped };
    },
  };
}

/**
 * The reaper's pass jobs: `sandbox_reap_terminal` (the end-of-item pass, every 15 minutes by its seeded interval) and
 * `sandbox_reap_ephemeral` (the 1-day safety net, daily). REAPER-2 adds `sandbox_reap_idle` here. With a null worker (the sandbox
 * credentials are not configured) each reports `sandbox_reap_unconfigured` and does nothing.
 */
export function sandboxReapJobs(worker: SandboxReapWorker | null, deps: SandboxReapJobDeps): ReconcileJob[] {
  return [reapPassJob(SANDBOX_REAP_TERMINAL_JOB, 'terminal', worker, deps), reapPassJob(SANDBOX_REAP_EPHEMERAL_JOB, 'ephemeral', worker, deps)];
}
