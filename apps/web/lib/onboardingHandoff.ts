import { waitUntil } from "@vercel/functions";
import { reportError as reportErrorDefault } from "@fx/telemetry";
import type { ReconcileHandlerDeps } from "../app/api/cron/reconcile/handler";

/**
 * D#845 Ruling 122: the onboarding hand-offs a person is waiting on act right after the request or webhook that made them due, and the reconcile tick is only the backstop.
 *
 *   `push ok` report  -> the install pull request (the runner's progress route calls `installPrNow` after it has answered)
 *   install PR merged -> the finish phase (Discussions, team-log issue, the twin's files), then the first engine session start (the GitHub webhook calls `finishNow` after it has answered)
 *
 * Both run the very steps the tick runs (`setupInstallStep`, `setupFinishStep`, and the same first-start pass), over the same claims: each claim is taken under a database lease, so an immediate pass and a tick that race
 * never both act, and a pass that fails (GitHub down, the database) leaves its claim for the lease to lapse and the tick to redo. Nothing here throws into the request; a failure is reported by code on stdout/error events.
 */

/** Setups one immediate pass takes before it stops: a handful can be due together, and the tick finishes whatever is left. */
export const HANDOFF_MAX_SETUPS = 5;
/** The time the first-start pass after a finish may spend. */
export const HANDOFF_START_BUDGET_MS = 20_000;

export interface HandoffDeps {
  /** The reconcile route's own deps (platform_ops pool, GitHub ports, the first-start pass). Built lazily so a request that needs nothing opens nothing. */
  reconcile: () => Promise<ReconcileHandlerDeps>;
  /** The step builders of the reconcile route (loaded lazily: the route's module graph is not part of every runner or webhook request). */
  steps: () => Promise<Pick<typeof import("../app/api/cron/reconcile/handler"), "setupInstallStep" | "setupFinishStep">>;
  /** Keeps the work alive after the response. */
  keepAlive: (work: Promise<unknown>) => void;
  reportError: (err: unknown, ctx: { stage: string; code?: string }) => void;
}

function keepAliveDefault(work: Promise<unknown>): void {
  try {
    waitUntil(work);
  } catch {
    // fx-swallow-ok: no request context (a build step, a test); the work was already started and runs on the event loop
  }
}

export const defaultHandoffDeps: HandoffDeps = {
  reconcile: async () => (await import("../app/api/cron/reconcile/handler")).defaultReconcileDeps(),
  steps: () => import("../app/api/cron/reconcile/handler"),
  keepAlive: keepAliveDefault,
  reportError: (err, ctx) => reportErrorDefault(err, { ...ctx, route: "onboarding_handoff" }),
};

/** One immediate pass of the install pull request step: takes due setups one at a time (each under its lease) until none is left, GitHub could not be asked, or the pass is spent. */
export async function drainInstallPr(deps: HandoffDeps = defaultHandoffDeps): Promise<void> {
  try {
    const reconcile = await deps.reconcile();
    const step = (await deps.steps()).setupInstallStep(reconcile);
    for (let i = 0; i < HANDOFF_MAX_SETUPS; i += 1) {
      if ((await step(reconcile.platformOpsPool)) !== "done") return;
    }
  } catch (err) {
    // the claim stays leased for the tick to redo once the lease lapses
    deps.reportError(err, { stage: "onboarding.handoff_install_pr", code: "internal_error" });
  }
}

/** One immediate pass of the finish step, then the first-start pass for the sessions it made due. A failure leaves the claim to the tick. */
export async function drainSetupFinish(deps: HandoffDeps = defaultHandoffDeps): Promise<void> {
  try {
    const reconcile = await deps.reconcile();
    const step = (await deps.steps()).setupFinishStep(reconcile);
    let finished = 0;
    for (let i = 0; i < HANDOFF_MAX_SETUPS; i += 1) {
      if ((await step(reconcile.platformOpsPool)) !== "done") break;
      finished += 1;
    }
    if (finished === 0 || !reconcile.engineSystemStarts) return;
    const deadline = Date.now() + HANDOFF_START_BUDGET_MS;
    await reconcile.engineSystemStarts({ msLeft: () => Math.max(0, deadline - Date.now()) });
  } catch (err) {
    deps.reportError(err, { stage: "onboarding.handoff_finish", code: "internal_error" });
  }
}

/** Starts the install pull request pass and keeps it alive past the response. Never throws, never waits. */
export function installPrNow(deps: HandoffDeps = defaultHandoffDeps): void {
  deps.keepAlive(drainInstallPr(deps));
}

/** Starts the finish pass and keeps it alive past the response. Never throws, never waits. */
export function finishNow(deps: HandoffDeps = defaultHandoffDeps): void {
  deps.keepAlive(drainSetupFinish(deps));
}
