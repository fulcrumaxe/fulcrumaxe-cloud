import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isStagingPaused, runGatedTick } from "@fx/core/src/pendingWork";
import { createPool } from "@fx/db/src/pool";
import { reportError } from "@fx/telemetry";
import { githubInstallationsJobFromEnv } from "../../../../lib/github/installationReconcile";
import { githubReposJobFromEnv } from "../../../../lib/github/repoReconcile";
import { reconcileStripeClient, stripeKeyIsLive, stripeReconcileKeyFromEnv } from "@fx/billing";
import { applyFetchedSubscription } from "@fx/billing/subscriptionSync";
import { envKekSource, fetchValidationHttpClient, healthCheck } from "@fx/model-connection";
import {
  buildReconcileJobs,
  createModelKeyHealthJob,
  createStripeSubscriptionsJob,
  effectiveSandboxReapMode,
  parseSandboxReapMode,
  RECONCILE_ROUTE,
  runTick,
  sandboxInventoryJob,
  sandboxReapJobs,
  type ReconcileJob,
  type ReportError,
  type SandboxReapDbSetting,
  type SandboxReapWorker,
  type TickDeps,
  type TickSummary,
} from "@fx/reconcile";
import { getWorker } from "../../../../lib/worker";

/**
 * The reconciler cron (every 15 minutes, at minutes 7, 22, 37 and 52; each job has its own seeded interval, so the slower jobs
 * still run on theirs). Same shape as the other cron handlers: route.ts stays thin, this
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
    apply: (subscription, clock) => applyFetchedSubscription({ platformOpsPool: pool, livemode }, subscription, clock),
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
    getWorker,
    readSandboxReapDbMode: () => readSandboxReapDbMode(cachedPlatformOpsPool!),
  };
}

/** Constant-time comparison against the configured secret; an unset secret fails closed. */
function isAuthorized(authHeader: string | null, cronSecret: string): boolean {
  if (!cronSecret || !authHeader) {
    return false;
  }
  const expected = Buffer.from(`Bearer ${cronSecret}`, "utf8");
  const actual = Buffer.from(authHeader, "utf8");
  if (expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

export async function reconcileHandler(
  req: NextRequest,
  injected?: ReconcileHandlerDeps,
  runTickFn: (deps: TickDeps) => Promise<TickSummary> = runTick,
): Promise<NextResponse> {
  // Check the secret before building the real deps, so an unauthenticated call never opens a database pool.
  const cronSecret = injected ? injected.cronSecret : (process.env.CRON_SECRET ?? "");
  if (!isAuthorized(req.headers.get("authorization"), cronSecret)) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
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
    return runTickFn({
      pool: deps.platformOpsPool,
      jobs: buildReconcileJobs({
        githubInstallations: githubInstallationsJobFromEnv(deps.platformOpsPool, deps.reportError),
        githubRepos: githubReposJobFromEnv(deps.platformOpsPool, deps.reportError),
        stripeSubscriptions: stripeSubscriptionsJobFromEnv(deps.platformOpsPool, deps.reportError),
        modelKeyHealth: modelKeyHealthJobFromEnv(deps.platformOpsPool, deps.reportError),
        sandbox: [...sandboxReapJobs(worker, sandboxDeps), sandboxInventoryJob(worker, sandboxDeps)],
      }),
      enabled: deps.enabled,
      reportError: deps.reportError,
    });
  };
  // Normally every tick runs (the reconciler has no pending-work marker). While staging is paused the same no-database
  // gate used by the sweeps applies, so a tick connects only when 12 hours have passed since the last one; the
  // deps (and so the pool) are built inside `run`, after the gate.
  if (!isStagingPaused()) {
    return NextResponse.json(await run(), { status: 200 });
  }
  const ran = await runGatedTick("reconcile", async () => ({ result: await run(), workFound: true, nextDueAt: null }));
  if (ran === null) return NextResponse.json({ skipped: true, reason: "staging_paused" }, { status: 200 });
  return NextResponse.json(ran.result, { status: 200 });
}
