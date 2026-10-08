import { waitUntil } from "@vercel/functions";
import { createVercelKeepAlive, createWorker, productionVercelCredentials, type CreateWorkerOptions, type RunnerClaimFacade, type RunnerDoneFacade, type RunnerLeaseFacade, type RunnerLeaseSweeper, type RunnerNoticeSweeper, type RunnerQueueSweeper, type Worker } from "@fx/worker";
import type { SandboxReapWorker } from "@fx/reconcile";
import { buildPreviewPrompt, markBuildNeedsHuman, publishLightSpec, runPanelForItem, runSpecForItem, startBuildForItem, triageIssueItem, type RunActionsWorker } from "@fx/pipeline";
import { getAuthorCheck } from "./github/authorCheck";
import { createAppRepoVisibility } from "./github/repoVisibility";
import { createAppContinuationBase } from "./github/runnerPullRequest";
import { createStartAdvance } from "./advance";
import { createReviewDeps } from "./advanceReview";
import { createFollow, createHooksPort } from "./hooks";
import type { AdvanceWorker } from "./advanceSteps";
import type { ReviewWorker } from "./advanceReviewSteps";
import type { LightPublishWorker } from "./advanceLightSteps";

/**
 * D#2 H14c-3b: the one place apps/web calls `createWorker()`.
 *
 * The options provider returns NULL until both VERCEL_TEAM_ID and VERCEL_PROJECT_ID are set
 * (blank counts as unset). While it returns null, `getWorker()` is null: the run-action
 * routes answer 503, the kick acknowledges and performs nothing, and the sweep logs
 * "run actions: worker not configured" and returns 200. Once both are set the options
 * carry the production Vercel credentials (each token is read from the invocation that
 * needs it) and the production hooks port (lib/hooks.ts) with the follower starter, so a started run is
 * followed to its end by apps/web/workflows/agentRunFollow.ts.
 *
 * `createWorker` memoises the worker, so every route and every workflow step shares one.
 * Only `@fx/worker`'s public entry is imported here, never its internals.
 */

/** What one compute-settle tick reports (the runner's counts; the real `Worker` is checked against this shape at `getWorker`'s return). */
export interface ComputeSettleSweepWorker {
  sweepComputeSettle(): Promise<{ listed: number; settled: number; deleted: number; failed: number; skipped: number; lost?: { listed: number }; outside?: { listed: number; waiting: number } }>;
}

/** What one runner-queue tick reports (D#6 R2b): the worker's `sweepRunnerQueue`, checked against this shape at `getWorker`'s return. */
export type RunnerQueueSweepWorker = RunnerQueueSweeper & RunnerNoticeSweeper;

/** What the runner sweeper tick asks of the worker: the queue time (R2b-2), the lease and wall-clock work (R2b-3) and the waiting notices. */
export type RunnerSweepWorker = RunnerQueueSweeper & RunnerLeaseSweeper & RunnerNoticeSweeper;

/** What the web app asks of the worker: the pipeline's run-action port, the compute-settle tick, the runner lease-fail method (D#6 R2a), the runner queue tick (R2b) and the sandbox reaper's two methods (SANDBOX-REAPER-1b; the reconcile cron calls them). */
export type AppWorker = RunActionsWorker & ComputeSettleSweepWorker & AdvanceWorker & ReviewWorker & LightPublishWorker & RunnerLeaseFacade & RunnerClaimFacade & RunnerDoneFacade & RunnerSweepWorker & SandboxReapWorker;

export type WorkerOptionsProvider = () => CreateWorkerOptions | null;

const productionProvider: WorkerOptionsProvider = () => {
  const env = process.env;
  if (!env.VERCEL_TEAM_ID?.trim() || !env.VERCEL_PROJECT_ID?.trim()) return null;
  return { vercel: productionVercelCredentials(env), ports: { hooks: createHooksPort(), authorCheck: getAuthorCheck, follow: createFollow(), repoVisibility: createAppRepoVisibility(), continuationBase: createAppContinuationBase() }, previewPrompt: buildPreviewPrompt, advance: { startAdvance: createStartAdvance(), triage: triageIssueItem, panel: runPanelForItem, spec: runSpecForItem, build: startBuildForItem, buildFailed: markBuildNeedsHuman, review: createReviewDeps(), lightSpec: publishLightSpec }, targetOverrides: { keepAlive: createVercelKeepAlive(waitUntil) } };
};

let provider: WorkerOptionsProvider = productionProvider;
let factory: (options: CreateWorkerOptions) => Promise<Worker> = createWorker;

/** True when the provider yields options (a worker can be built). */
export function workerConfigured(): boolean {
  return provider() !== null;
}

/**
 * D#2 H14c-3-3a: whether the onboarding preview may be offered. Three things must all hold: the flag
 * FX_ONBOARDING_PREVIEW is exactly "on" (unset, blank or anything else is off, and the flag stays unset
 * everywhere until the live smoke turns it on for the staging project; it is never keyed to VERCEL_ENV), a worker can be built, and the options carry the
 * prompt builder. Synchronous, because the API's seam is (it cannot await `getWorker()`).
 */
export function previewEnabled(): boolean {
  if (process.env.FX_ONBOARDING_PREVIEW !== "on") return false;
  const options = provider();
  return options !== null && options.previewPrompt !== undefined;
}

/** The worker, typed as the structural ports above (this return is where tsc checks the real `Worker` against it). Null when not configured. */
export async function getWorker(): Promise<AppWorker | null> {
  const options = provider();
  return options === null ? null : factory(options);
}

/** Test seam: swap the provider and/or the factory; call with no argument to restore the production wiring. */
export function setWorkerWiringForTests(wiring?: { provider?: WorkerOptionsProvider; createWorker?: typeof factory }): void {
  provider = wiring?.provider ?? productionProvider;
  factory = wiring?.createWorker ?? createWorker;
}
