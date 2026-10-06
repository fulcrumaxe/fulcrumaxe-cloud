import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { isStagingPaused, runGatedTick } from "@fx/core/src/pendingWork";
import { createPool } from "@fx/db/src/pool";
import { reportError } from "@fx/telemetry";
import { githubInstallationsJobFromEnv } from "../../../../lib/github/installationReconcile";
import { reconcileStripeClient, stripeKeyIsLive, stripeReconcileKeyFromEnv } from "@fx/billing";
import { applyFetchedSubscription } from "@fx/billing/subscriptionSync";
import {
  buildReconcileJobs,
  createStripeSubscriptionsJob,
  runTick,
  type ReconcileJob,
  type ReportError,
  type TickDeps,
  type TickSummary,
} from "@fx/reconcile";

/**
 * The reconciler cron (every 6 hours, at minute 7). Same shape as the other cron handlers: route.ts stays thin, this
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
    return runTickFn({
      pool: deps.platformOpsPool,
      jobs: buildReconcileJobs({
        githubInstallations: githubInstallationsJobFromEnv(deps.platformOpsPool, deps.reportError),
        stripeSubscriptions: stripeSubscriptionsJobFromEnv(deps.platformOpsPool, deps.reportError),
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
