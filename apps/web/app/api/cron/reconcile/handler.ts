import { NextRequest, NextResponse } from "next/server";
import { isStagingPaused, MARKER_HORIZON_MS, runGatedTick } from "@fx/core/src/pendingWork";
import { drainOperateQueue, issueSystemStarts, issueSystemStops } from "@fx/runner-cloud";
import { createPool } from "@fx/db/src/pool";
import { queueActivationDiscovery } from "../../../../lib/discoveryWake";
import { createErrorReporter, reportError } from "@fx/telemetry";
import { opsAlertSinkFromEnv } from "../../../../lib/opsAlertSink";
import { githubInstallationsJobFromEnv } from "../../../../lib/github/installationReconcile";
import { githubReposJobFromEnv } from "../../../../lib/github/repoReconcile";
import { reconcileStripeClient, stripeKeyIsLive, stripeReconcileKeyFromEnv } from "@fx/billing";
import { applyFetchedSubscription } from "@fx/billing/subscriptionSync";
import { envKekSource, fetchValidationHttpClient, healthCheck, revalidateCreditsExhausted } from "@fx/model-connection";
import {
  buildReconcileJobs,
  checkStalls,
  createModelCreditsRevalidateJob,
  createModelKeyHealthJob,
  createStripeSubscriptionsJob,
  effectiveSandboxReapMode,
  CREDITS_BACKED_OFF_CADENCE_SECONDS,
  FAST_RECONCILE_JOBS,
  parseSandboxReapMode,
  readCreditsBreak,
  RECONCILE_ROUTE,
  runTick,
  sandboxInventoryJob,
  createEngineSessionStarts,
  createEngineSessionStops,
  createMachineServerSweep,
  createSetupInstallPrJob,
  type EngineSessionStartsPass,
  type EngineSessionStopsPass,
  createSetupFinishJob,
  type SetupFinishStep,
  setupFinishPending,
  type SetupInstallStep,
  setupInstallPending,
  type MachineSweepStart,
  sandboxReapJobs,
  type OpsAlertSink,
  type ReconcileJob,
  type ReportError,
  type SandboxReapDbSetting,
  type SandboxReapWorker,
  type TickDeps,
  type TickSummary,
} from "@fx/reconcile";
import { claimSetupFinish, claimSetupInstall, completeSetupFinish, completeSetupInstall, type SetupFinishPort, type SetupInstallPort } from "@fx/runner-cloud";
import { createAppRunPullRequestPort } from "../../../../lib/github/runnerPullRequest";
import { getWorker } from "../../../../lib/worker";
import { startMachineSweep } from "../../../../lib/machineServers";
import { cronAuthorized } from "../../../../lib/cronAuth";

const [TERMINAL_JOB, CREDITS_JOB, INSTALL_JOB, FINISH_JOB] = FAST_RECONCILE_JOBS;

/** How far ahead the gate looks again when the 15-minute jobs' state could not be read: their own cadence, so a read failure never lets work wait. */
const FAST_JOB_RETRY_MS = 15 * 60_000;

/**
 * When the gate should next connect for the 15-minute jobs (FAST_RECONCILE_JOBS in @fx/reconcile: the reconcile gate lets an unmarked
 * reconciler connect on every fourth backstop slot, so they keep their cadence by events instead), or null when neither has anything left to do.
 *  - model_credits_revalidate has work while any connection is still broken for out-of-credit (the pass re-checks it; a top-up clears it). Every 15 minutes for
 *    the first 2 hours after the latest break, then hourly until the connection changes, so an account that never tops up lets the database sleep between looks;
 *  - sandbox_reap_terminal has work left when its pass this tick stopped on a budget, or was skipped as not yet due (its last pass was under
 *    15 minutes ago, so the marker that woke us came too early to run it): either way the next look is at the job's own due time.
 * The due time is the job's `next_due_at`, never earlier than now. Reads two small rows with the pool the tick already holds.
 */
export async function reconcileNextDueAt(pool: Pick<TickDeps["pool"], "query">, summary: TickSummary, now: number = Date.now()): Promise<number | null> {
  const fast = await fastJobsNextDueAt(pool, summary, now);
  const grace = await engineGraceNextDueAt(pool, now);
  return fast === null ? grace : grace === null ? fast : Math.min(fast, grace);
}

/**
 * D#845 ON-13a5: the earliest end of a payment grace (7 days after `past_due_since`) of an account with a live engine, so the gate connects at that tick and the stop pass ends its sessions: coverage reads the clock, and
 * nothing happens at the moment the grace runs out, so without this the sessions would stop only at the next backstop. Never earlier than now, and clamped to the marker horizon (a later tick reads it again when it is further off).
 */
async function engineGraceNextDueAt(pool: Pick<TickDeps["pool"], "query">, now: number): Promise<number | null> {
  const { rows } = await pool.query<{ due?: number | null }>("SELECT (EXTRACT(EPOCH FROM engine_system_stop_next_due()) * 1000)::float8 AS due");
  const due = rows[0]?.due;
  if (typeof due !== "number" || !Number.isFinite(due)) return null;
  return Math.min(Math.max(due, now), now + MARKER_HORIZON_MS);
}

async function fastJobsNextDueAt(pool: Pick<TickDeps["pool"], "query">, summary: TickSummary, now: number): Promise<number | null> {
  const pending: string[] = [];
  const terminal = summary.results.find((r) => r.job === TERMINAL_JOB)?.result;
  if (terminal === "budget" || terminal === "not_due") pending.push(TERMINAL_JOB);
  const credits = await readCreditsBreak(pool);
  if (credits.broken) pending.push(CREDITS_JOB);
  // D#845 ON-8f2a: a pushed install whose pull request is not yet opened (the pass failed to reach GitHub, or has not run since the push report marked us).
  if (await setupInstallPending(pool)) pending.push(INSTALL_JOB);
  // D#845 ON-13a4: a merged install whose Discussions and team-log issue are not made yet (or a seed failure inside its retry window).
  if (await setupFinishPending(pool)) pending.push(FINISH_JOB);
  if (pending.length === 0) return null;
  const { rows } = await pool.query<{ name: string; due: number }>(
    "SELECT name, (EXTRACT(EPOCH FROM next_due_at) * 1000)::float8 AS due FROM reconcile_jobs WHERE name = ANY($1::text[])",
    [pending],
  );
  const dues = rows.filter((r) => typeof r.due === "number" && Number.isFinite(r.due));
  // Credits that nobody has topped up for 2 hours are looked at hourly, not every 15 minutes: the job's own due time is the floor, and an hour from this look is the
  // other. A top-up, a revalidate success or a fresh break moves broken_at (see readCreditsBreak), so the 15-minute cadence returns by itself.
  const backedOffDue = now + CREDITS_BACKED_OFF_CADENCE_SECONDS * 1000;
  let due: number | null = null;
  for (const name of pending) {
    const own = dues.find((r) => r.name === name)?.due;
    let at = typeof own === "number" ? Math.max(own, now) : now;
    if (name === CREDITS_JOB && credits.backedOff) at = Math.max(at, backedOffDue);
    due = due === null ? at : Math.min(due, at);
  }
  return due;
}

/**
 * The reconciler cron (every 15 minutes, at minutes 7, 22, 37 and 52; each job has its own seeded interval, so the slower jobs
 * still run on theirs). A tick first passes the no-database gate: unmarked it connects on every fourth backstop slot only, and it connects on
 * the next cron tick after a marker (an installation change, a sandbox reaching a final state, a credits failure) or after a due time left by
 * the 15-minute jobs. Same shape as the other cron handlers: route.ts stays thin, this
 * file holds the logic, and handler.test.ts is a fast route-layer test with no real Postgres. The lease, budget, cursor
 * and lap-time behaviour is @fx/reconcile's own real-Postgres suite.
 *
 * Auth: Vercel sends `Authorization: Bearer <CRON_SECRET>` itself. Only that secret is accepted; a customer's API token
 * is just a wrong value here. Limits live in the runner, not the route: a lease per job, 60 s per job, 240 s per tick,
 * and a per-run budget of outside calls per job.
 */

export interface ReconcileHandlerDeps {
  cronSecret: string;
  /** Kill switch. Anything but the exact value "0" in FX_RECONCILE_ENABLED leaves the jobs on. */
  enabled: boolean;
  platformOpsPool: TickDeps["pool"];
  reportError: ReportError;
  /** D#845 MC-7: starts the queued orphan sweep of one credential. Absent (a test double): the sweep job reports not_configured. */
  startMachineSweep?: ((a: MachineSweepStart) => Promise<unknown>) | undefined;
  /** D#845 ON-8f2a: the GitHub port of the install pull request step, built when a setup is due. Absent: the app port. */
  setupInstallPort?: (() => SetupInstallPort) | undefined;
  /**
   * D#845 ON-13a5: one pass of the system stop issuer (a session whose operate switch is off, whose repo is unticked or whose engine plan ended). Absent (a test double): the job reports not_configured. defaultReconcileDeps
   * supplies it over the platform_ops pool and the worker's job signer, which answers null while that key is not configured.
   */
  engineSystemStops?: ((scope: { msLeft: () => number }) => Promise<EngineSessionStopsPass>) | undefined;
  /** D#845 ON-13c1: one pass of the system first start (an installed project whose engine is due its first session). Absent (a test double): the job reports not_configured. defaultReconcileDeps supplies it. */
  engineSystemStarts?: ((scope: { msLeft: () => number }) => Promise<EngineSessionStartsPass>) | undefined;
  /** D#845 ON-13a4: the GitHub port of the finish step, built when a setup is due. Absent: the app port. */
  setupFinishPort?: (() => SetupFinishPort) | undefined;
  /** The raw FX_SANDBOX_REAP_MODE: unset is dry_run, off | dry_run | on are themselves, anything else is off (and reported). */
  sandboxReapMode?: string | undefined;
  /**
   * The sandbox reaper's worker facade (the same getWorker() the compute-settle handler uses; this file never reads the runner
   * login). Called only for a tick that runs, after the secret check. Null while the worker is not configured: the sandbox jobs then
   * report sandbox_reap_unconfigured and the others still run. Absent (a test double that does not exercise the sandbox jobs) is the same as null;
   * defaultReconcileDeps always supplies it.
   */
  getWorker?(): Promise<SandboxReapWorker | null>;
  /**
   * Reads `sandbox_reap_settings.mode` (C85). Called at the start of every reap pass, never cached. Absent (a test double) is NULL, no override;
   * defaultReconcileDeps always supplies it, over the platform_ops pool.
   */
  readSandboxReapDbMode?(): Promise<SandboxReapDbSetting>;
  /** The ops alert sink for a stalled job. Absent: built from the environment (null while not configured, which turns the alerts off). A test double passes its own or null. */
  opsAlertSink?: OpsAlertSink | null;
  /**
   * D#483 S5-k3b-2c: the capacity queue's backstop, one claim pass on this 15-minute tick (the other triggers are a waiting item's own ask and a followed sandbox run reaching its end).
   * Absent (a test double): none. defaultReconcileDeps supplies it over the worker, which answers null while it is not configured.
   */
  capacityPass?(): Promise<unknown>;
}

const stdoutOnly = createErrorReporter({ service: "web" });

/** A stall check or sink failure: one coded stdout line. Not the process-wide reporter, which would write error_events (same rule as the cron gate store). */
function stallSinkError(err: unknown): void {
  stdoutOnly.reportError(err, { stage: "reconcile.stall_alert", code: "internal_error" });
}

/**
 * The database half of the reaper's kill switch. One row is expected; no row, an error or a value that is none of the three is
 * `unreadable`, which the jobs read as `off` (fail closed) and report as sandbox_reap_mode_unreadable.
 */
export async function readSandboxReapDbMode(pool: Pick<TickDeps["pool"], "query">): Promise<SandboxReapDbSetting> {
  try {
    const { rows } = await pool.query<{ mode: string | null }>("SELECT mode FROM sandbox_reap_settings");
    const row = rows.length === 1 ? rows[0] : undefined;
    if (!row) return "unreadable";
    if (row.mode === null || row.mode === "off" || row.mode === "dry_run" || row.mode === "on") return row.mode;
    return "unreadable";
  } catch {
    // fx-swallow-ok: the failed read is the result (unreadable), which the sandbox jobs report as sandbox_reap_mode_unreadable on every pass
    return "unreadable";
  }
}

/**
 * The Stripe job, built from STRIPE_RECONCILE_KEY (a restricted, read-only key; never STRIPE_SECRET_KEY). With no usable
 * key the job still exists and records `not_configured` on each tick, so the digest and the launch check can show it.
 */
export function stripeSubscriptionsJobFromEnv(pool: TickDeps["pool"], report: ReportError): ReconcileJob {
  const key = stripeReconcileKeyFromEnv();
  if (!key) return createStripeSubscriptionsJob({ stripe: null, apply: async () => ({ applied: false }), reportError: report });
  const livemode = stripeKeyIsLive(key);
  return createStripeSubscriptionsJob({
    stripe: reconcileStripeClient(key),
    apply: async (subscription, clock) => {
      const result = await applyFetchedSubscription({ platformOpsPool: pool, livemode }, subscription, clock);
      // D#483 S4-c: queue the account's install discovery for a paying subscription, under the subscription id the webhook uses, so a
      // lost webhook or a hook that threw is backfilled and a subscription already queued is a no-op. A failure never fails the apply.
      const paying = result.activated ?? result.live;
      if (paying && process.env.DATABASE_URL_APP_USER) {
        try {
          cachedAppUserPool ??= createPool(requireEnv("DATABASE_URL_APP_USER"));
          await queueActivationDiscovery(cachedAppUserPool, paying.accountId, paying.subscriptionId);
        } catch (err) {
          reportError(err, { stage: "reconcile.stripe_subscriptions.discovery", route: RECONCILE_ROUTE });
        }
      }
      return result;
    },
    reportError: report,
  });
}

let cachedAppUserPool: ReturnType<typeof createPool> | undefined;

/**
 * The model-key health job. It opens each customer's key as app_user (through the tenant scope) and writes through the
 * platform_ops pool, so it needs DATABASE_URL_APP_USER and the key-encryption key. With either absent the job still
 * exists and records `not_configured` on each tick; the app pool is only opened when the job first has a key to check.
 */
export function modelKeyHealthJobFromEnv(pool: TickDeps["pool"], report: ReportError): ReconcileJob {
  // The key-encryption source is asked for its current key once: it throws for a version below 1, an unset key and a
  // key that is not 32 bytes, and any of those means this job cannot run (and must not bring the tick down).
  let kek: ReturnType<typeof envKekSource> | null = null;
  try {
    const source = envKekSource();
    source.keyFor(source.currentVersion());
    kek = source;
  } catch {
    // fx-swallow-ok: an unusable key-encryption key is the not_configured case, and the error text names no value
  }
  if (!process.env.DATABASE_URL_APP_USER || !kek) return createModelKeyHealthJob({ check: null, reportError: report });
  const readyKek = kek;
  const httpClient = fetchValidationHttpClient();
  return createModelKeyHealthJob({
    check: async (accountId, connectionId) => {
      cachedAppUserPool ??= createPool(requireEnv("DATABASE_URL_APP_USER"));
      return healthCheck({ pool: cachedAppUserPool, platformOpsPool: pool, httpClient, kek: readyKek }, accountId, connectionId);
    },
    reportError: report,
  });
}

/**
 * D#483 S5-k2: the credits re-validation job, built from the same environment as the key health job (app_user database and key-encryption key), with
 * the same `not_configured` result when either is absent. It makes the same one validation call per connection, through the same client.
 */
export function modelCreditsRevalidateJobFromEnv(pool: TickDeps["pool"], report: ReportError): ReconcileJob {
  let kek: ReturnType<typeof envKekSource> | null = null;
  try {
    const source = envKekSource();
    source.keyFor(source.currentVersion());
    kek = source;
  } catch {
    // fx-swallow-ok: an unusable key-encryption key is the not_configured case, and the error text names no value
  }
  if (!process.env.DATABASE_URL_APP_USER || !kek) return createModelCreditsRevalidateJob({ revalidate: null, reportError: report });
  const readyKek = kek;
  const httpClient = fetchValidationHttpClient();
  return createModelCreditsRevalidateJob({
    revalidate: async (accountId, connectionId) => {
      cachedAppUserPool ??= createPool(requireEnv("DATABASE_URL_APP_USER"));
      return revalidateCreditsExhausted({ pool: cachedAppUserPool, platformOpsPool: pool, httpClient, kek: readyKek }, accountId, connectionId);
    },
    reportError: report,
  });
}

let cachedPlatformOpsPool: ReturnType<typeof createPool> | undefined;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

export function defaultReconcileDeps(): ReconcileHandlerDeps {
  if (!cachedPlatformOpsPool) {
    cachedPlatformOpsPool = createPool(requireEnv("DATABASE_URL_PLATFORM_OPS"));
  }
  return {
    cronSecret: process.env.CRON_SECRET ?? "",
    enabled: process.env.FX_RECONCILE_ENABLED !== "0",
    platformOpsPool: cachedPlatformOpsPool,
    reportError,
    sandboxReapMode: process.env.FX_SANDBOX_REAP_MODE,
    startMachineSweep,
    engineSystemStops: (scope) =>
      issueSystemStops({ pool: cachedPlatformOpsPool!, engineCommandSigner: async () => (await getWorker())?.engineCommandSigner ?? null, reportError }, scope),
    // The operate queue (ON-13c2) is drained first, then the first starts of finished installs: one job, one time budget, one signer.
    engineSystemStarts: async (scope) => {
      const deps = { pool: cachedPlatformOpsPool!, engineCommandSigner: async () => (await getWorker())?.engineCommandSigner ?? null, pullRequests: createAppRunPullRequestPort, reportError };
      const queued = await drainOperateQueue(deps, scope);
      const first = await issueSystemStarts(deps, scope);
      return { not_configured: queued.not_configured && first.not_configured, issued: queued.issued + first.issued, results: [...queued.results, ...first.results] };
    },
    getWorker,
    readSandboxReapDbMode: () => readSandboxReapDbMode(cachedPlatformOpsPool!),
    capacityPass: async () => (await getWorker())?.capacityClaimPass(),
  };
}

/**
 * D#845 ON-8f2a (Ruling 83): one pass of the install pull request step for the reconcile job: claims the oldest due setup (platform_ops, under its lease) and does it. A claim of an impossible shape is reported and left to its
 * lease; a GitHub that could not be asked ends the pass (`retry`). The port is built the first time a setup is due, so an idle tick opens no GitHub client.
 */
export function setupInstallStep(deps: Pick<ReconcileHandlerDeps, "reportError" | "setupInstallPort">): SetupInstallStep {
  let port: SetupInstallPort | undefined;
  return async (pool) => {
    const claim = await claimSetupInstall(pool);
    if (claim === null) return "none";
    if (claim === "malformed") {
      deps.reportError(new Error("setup install claim malformed"), { stage: "reconcile.setup_install_pr", route: RECONCILE_ROUTE, code: "internal_error" });
      return "done";
    }
    port ??= (deps.setupInstallPort ?? createAppRunPullRequestPort)();
    const outcome = await completeSetupInstall({ pool, port }, claim);
    return outcome === "retry" ? "retry" : "done";
  };
}

/** D#845 ON-13a4 (Ruling 93): one pass of the finish phase for the reconcile job: claims the oldest due setup (platform_ops, under its lease) and does it. The port is built the first time a setup is due. */
export function setupFinishStep(deps: Pick<ReconcileHandlerDeps, "reportError" | "setupFinishPort">): SetupFinishStep {
  let port: SetupFinishPort | undefined;
  return async (pool) => {
    const claim = await claimSetupFinish(pool);
    if (claim === null) return "none";
    if (claim === "malformed") {
      deps.reportError(new Error("setup finish claim malformed"), { stage: "reconcile.setup_finish", route: RECONCILE_ROUTE, code: "internal_error" });
      return "done";
    }
    port ??= (deps.setupFinishPort ?? createAppRunPullRequestPort)();
    const outcome = await completeSetupFinish({ pool, port }, claim);
    return outcome === "retry" ? "retry" : "done";
  };
}

export async function reconcileHandler(
  req: NextRequest,
  injected?: ReconcileHandlerDeps,
  runTickFn: (deps: TickDeps) => Promise<TickSummary> = runTick,
): Promise<NextResponse> {
  // Check the secret before building the real deps, so an unauthenticated call never opens a database pool.
  const cronSecret = injected ? injected.cronSecret : (process.env.CRON_SECRET ?? "");
  if (!cronAuthorized("/api/cron/reconcile", req.headers.get("authorization"), cronSecret)) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  let nextDueAt: number | null = null;
  const run = async (): Promise<TickSummary> => {
    const deps = injected ?? defaultReconcileDeps();
    // The sandbox jobs reach the reaper only through the worker. Under either kill switch (FX_RECONCILE_ENABLED=0, or the mode off or
    // unusable) the worker is never asked for, so nothing is built or opened. A worker that fails to build costs the sandbox jobs
    // their run (they report sandbox_reap_unconfigured) and nothing else.
    const sandbox = parseSandboxReapMode(deps.sandboxReapMode);
    const worker = !deps.enabled || sandbox.mode === "off" ? null : await (deps.getWorker?.() ?? Promise.resolve(null)).catch((err: unknown) => {
      deps.reportError(err, { stage: "reconcile.sandbox_worker", route: RECONCILE_ROUTE });
      return null;
    });
    // C85: the mode in force for a reap pass is the stricter of the environment and the database setting, worked out at the start of each pass.
    const sandboxDeps = {
      mode: sandbox,
      reportError: deps.reportError,
      effectiveMode: async () => effectiveSandboxReapMode(deps.sandboxReapMode, (await deps.readSandboxReapDbMode?.()) ?? null),
    };
    const summary = await runTickFn({
      pool: deps.platformOpsPool,
      jobs: buildReconcileJobs({
        githubInstallations: githubInstallationsJobFromEnv(deps.platformOpsPool, deps.reportError),
        githubRepos: githubReposJobFromEnv(deps.platformOpsPool, deps.reportError),
        stripeSubscriptions: stripeSubscriptionsJobFromEnv(deps.platformOpsPool, deps.reportError),
        modelKeyHealth: modelKeyHealthJobFromEnv(deps.platformOpsPool, deps.reportError),
        modelCreditsRevalidate: modelCreditsRevalidateJobFromEnv(deps.platformOpsPool, deps.reportError),
        machine: [createMachineServerSweep(deps.startMachineSweep ?? null), createEngineSessionStops(deps.engineSystemStops ?? null)],
        setupInstall: createSetupInstallPrJob(setupInstallStep(deps)),
        setupFinish: createSetupFinishJob(setupFinishStep(deps)),
        engineStarts: createEngineSessionStarts(deps.engineSystemStarts ?? null),
        sandbox: [...sandboxReapJobs(worker, sandboxDeps), sandboxInventoryJob(worker, sandboxDeps)],
      }),
      enabled: deps.enabled,
      reportError: deps.reportError,
    });
    // Work the 15-minute jobs left behind keeps the gate connecting at their cadence; a failed read falls back to the slow cadence (reported).
    try {
      nextDueAt = summary.enabled ? await reconcileNextDueAt(deps.platformOpsPool, summary) : null;
    } catch (err) {
      // Unknown means "maybe work": look again at the jobs' own cadence rather than letting the slow cadence sit on it.
      nextDueAt = Date.now() + FAST_JOB_RETRY_MS;
      deps.reportError(err, { stage: "reconcile.next_due", route: RECONCILE_ROUTE });
    }
    // D#483 S5-k3b-2c: the capacity queue's backstop. A failure is reported and never fails the tick.
    if (summary.enabled && deps.capacityPass) {
      try {
        await deps.capacityPass();
      } catch (err) {
        deps.reportError(err, { stage: "reconcile.capacity_pass", route: RECONCILE_ROUTE });
      }
    }
    // D#6 STALL-ALERT-FAST: on this connection, announce a job that has work and has stopped passing (and its recovery). It never fails the tick,
    // never writes error_events (a sink failure is one stdout line), and keeps the tick connecting while a notice is outstanding so recovery is noticed.
    if (summary.enabled) {
      try {
        const stalls = await checkStalls({ pool: deps.platformOpsPool, sink: deps.opsAlertSink === undefined ? opsAlertSinkFromEnv() : deps.opsAlertSink, onSinkError: stallSinkError, work: { reapDeletes: sandbox.mode === "on" } });
        // The database is kept awake only for real work: a job stalled WITH work and no due time of its own gets the 15-minute look. A non-null due (including
        // the credits job's hourly back-off) is never shortened, and a failed recovery post never schedules a tick; the next normal tick retries it.
        if (stalls.stalled.length > 0 && nextDueAt === null) nextDueAt = Date.now() + FAST_JOB_RETRY_MS;
      } catch (err) {
        // fx-swallow-ok: reported to stdout by stallSinkError; the stall check must never fail the tick or write error_events
        stallSinkError(err);
      }
    }
    return summary;
  };
  // Every tick goes through the gate (see the header above). What the jobs find must not keep the busy-deployment slots alive by itself,
  // so the tick reports workFound false; only the due time left by the 15-minute jobs is carried forward.
  const ran = await runGatedTick("reconcile", async () => {
    const result = await run();
    return { result, workFound: false, nextDueAt };
  });
  if (ran === null) return NextResponse.json({ skipped: true, reason: isStagingPaused() ? "staging_paused" : "not_due" }, { status: 200 });
  return NextResponse.json(ran.result, { status: 200 });
}
