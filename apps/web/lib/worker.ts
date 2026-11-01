import { waitUntil } from "@vercel/functions";
import { createVercelKeepAlive, createWorker, productionVercelCredentials, type CreateWorkerOptions, type RunnerClaimFacade, type RunnerDoneFacade, type RunnerGitTicketFacade, type RunnerPlanePushFacade, type RunnerLeaseFacade, type RunnerLeaseSweeper, type RunHandoffs, type InvariantSweeper, type RunnerNoticeSweeper, type RunnerQueueSweeper, type PlanePublish, type Worker, type AdvanceFacade } from "@fx/worker";
import type { SandboxReapWorker } from "@fx/reconcile";
import { buildPreviewPrompt, parsePreviewResult, buildAnalystPrompt, parseAnalystOutput, buildVerifierPrompt, recordFromOutput, markBuildNeedsHuman, readBuildWaitReason, publishLightSpec, publishAmendment, publishRespec, runPanelForItem, runSpecForItem, triageIssueItem, type RunActionsWorker } from "@fx/pipeline";
import { autoStartOptions } from "./autoStartPrice";
import { getAuthorCheck } from "./github/authorCheck";
import { openDiscoverySource, openVerifyReader } from "./github/planSource";
import { createAppRepoVisibility } from "./github/repoVisibility";
import { createBuildWithRepoMap } from "./github/repoMap";
import { createPrStateReader } from "./github/prState";
import { openReceiptBlockHttp } from "./github/receiptBlock";
import { createReversalGitOpeners } from "./github/reversalGit";
import { createAppBranchSync, createAppContinuationBase } from "./github/runnerPullRequest";
import { createPlanePublishPorts } from "./github/planePublish";
import { createAppContinuationBinding } from "./github/continuationBinding";
import { createStartAdvance } from "./advance";
import { createCapacity } from "./capacity";
import { createReviewDeps } from "./advanceReview";
import { createFollow, createHooksPort } from "./hooks";
import type { AdvanceWorker } from "./advanceSteps";
import type { DecisionWorker } from "./advanceStageSteps";
import type { ReviewWorker } from "./advanceReviewSteps";
import type { LightPublishWorker } from "./advanceLightSteps";
import type { RespecPublishWorker } from "./advanceRespecSteps";

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

/** What the run handoff sweep cron asks of the worker (D#599 HO-2b). */
export type HandoffSweepWorker = Pick<RunHandoffs, "sweepRunHandoffs">;

/** What the invariant sweep cron asks of the worker (D#597 CC-8). */
export type InvariantSweepWorker = InvariantSweeper;

/** What the parked-stage sweep cron asks of the worker (D#483 S5-k1b). */
export type StageResumeSweepWorker = Pick<Worker, "sweepParkedStages">;

/** What the setup-request check cron asks of the worker (D#598 P8b): one pass of the check sweep (the worker keeps the run-writer pool). */
export type SetupRequestCheckWorker = Pick<Worker, "sweepSetupRequestChecks">;

/** What the decision-ask answer route asks of the worker (D#598 P8c-2a): the answer runs on the worker's receipt pool, which is never handed out. */
export type DecisionAskAnswerWorker = Pick<Worker, "answerDecisionAsk">;

/** What the sub-item approve route asks of the worker (D#483 S5-b2a): the approval runs on the worker's receipt pool, which is never handed out. */
export type SubItemApprovalWorker = Pick<Worker, "approveSubItem">;

/** What the reverse and confirm routes ask of the worker (D#7 DP7-2e): both write on the worker's receipt pool, which is never handed out. */
export type ReversalWorker = Pick<Worker, "requestReversal" | "confirmReversal" | "retryReversal">;

/** What the branch cleanup cron asks of the worker (D#598 P1f-5d): one pass of the cleanup sweep, and (D#598) one pass of the stale pull-request sweep. */
export type BranchCleanupWorker = Pick<Worker, "sweepBranchCleanups" | "sweepPrSlotHolders">;

/** What the claim verifier cron asks of the worker (D#483 S4-b2b): first the discovery schedule pass (S5-g2: queues each due repository's sweep discovery and, when its head moved, its analysis), then one pass of the discovery drain (S4-c2), one pass of the verifier sweep, the analysis pass (S4-f3: runs the queued analyses), then (S5-b1a-2) one pass of the auto-start gate. */
export type ProposalVerifySweepWorker = Pick<Worker, "sweepDiscoverySchedule" | "sweepDiscoveryQueue" | "sweepProposalVerification" | "sweepDocsCodeAnalysis" | "sweepAutoStart">;

/** What the web app asks of the worker: the pipeline's run-action port, the compute-settle tick, the runner lease-fail method (D#6 R2a), the runner queue tick (R2b) and the sandbox reaper's two methods (SANDBOX-REAPER-1b; the reconcile cron calls them). */
export type AppWorker = RunActionsWorker & ComputeSettleSweepWorker & AdvanceWorker & DecisionWorker & ReviewWorker & LightPublishWorker & RespecPublishWorker & RunnerLeaseFacade & RunnerClaimFacade & RunnerDoneFacade & RunnerGitTicketFacade & RunnerPlanePushFacade & RunnerSweepWorker & HandoffSweepWorker & Pick<RunHandoffs, "completeHandoffOnDone"> & InvariantSweepWorker & StageResumeSweepWorker & SetupRequestCheckWorker & BranchCleanupWorker & ProposalVerifySweepWorker & DecisionAskAnswerWorker & SubItemApprovalWorker & ReversalWorker & Pick<PlanePublish, "retryPublish" | "openPublicPullRequest"> & SandboxReapWorker & Pick<AdvanceFacade, "advanceCancelStepRuns" | "advanceStartGate" | "advanceFixGate" | "advanceContinue" | "capacityClaimPass"> & Pick<Worker, "reconcilePrHolder" | "planeMerge" | "withRunnerPool" | "wakeMergeGate">;

export type WorkerOptionsProvider = () => CreateWorkerOptions | null;

const productionProvider: WorkerOptionsProvider = () => {
  const env = process.env;
  if (!env.VERCEL_TEAM_ID?.trim() || !env.VERCEL_PROJECT_ID?.trim()) return null;
  return { vercel: productionVercelCredentials(env), ports: { hooks: createHooksPort(), authorCheck: getAuthorCheck, follow: createFollow(), repoVisibility: createAppRepoVisibility(), continuationBase: createAppContinuationBase(), branchSync: createAppBranchSync(), continuationBinding: createAppContinuationBinding(), planePublish: createPlanePublishPorts(env) }, previewPrompt: buildPreviewPrompt, verify: { prompt: buildVerifierPrompt, record: recordFromOutput, github: openVerifyReader }, analysis: { prompt: buildAnalystPrompt, parse: parseAnalystOutput }, discovery: { openSource: openDiscoverySource, previewResult: parsePreviewResult }, autoStart: autoStartOptions, receiptBlock: { connect: openReceiptBlockHttp }, reversal: createReversalGitOpeners(), advance: { startAdvance: createStartAdvance(), capacity: createCapacity, triage: triageIssueItem, panel: runPanelForItem, spec: runSpecForItem, build: createBuildWithRepoMap(), buildFailed: markBuildNeedsHuman, buildWaitReason: readBuildWaitReason, prState: createPrStateReader(), review: createReviewDeps(), lightSpec: publishLightSpec, respec: publishRespec, amendSpec: publishAmendment }, targetOverrides: { keepAlive: createVercelKeepAlive(waitUntil) } };
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
