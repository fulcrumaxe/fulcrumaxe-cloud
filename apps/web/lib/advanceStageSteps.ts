import type { AdvanceFacade, AdvanceRunOutcome, AdvanceStepResult, DecisionStepCode, PlanePublish, StartGateStepInput, StartGateStepOut } from "@fx/worker";
import { isQueuedOnRunner, type AdvanceWorker } from "./advanceSteps";

/**
 * D#483 P2: the bodies of the stage driver's panel, Spec and build steps (apps/web/workflows/workItemAdvance.ts holds
 * the directives and calls these). Plain async functions over the injected worker, like ./advanceSteps.ts, so they run
 * in a test without the Workflow service.
 *
 * Every refusal is DATA with a fixed reason code, never a throw: a step that throws is retried by the Workflow service,
 * and none of these refusals gets better by retrying.
 */

/** Who a pipeline step runs for: the workflow's own arguments. */
export interface StepWho {
  accountId: string;
  userId: string;
  workItemId: string;
  /** The halt epoch the workflow started under; a step under an older one is refused (halted_since_approval). */
  haltEpoch: number;
}

/**
 * What the workflow keeps of a pipeline step (panel, Spec, build): fixed words and numbers only. Nothing a model wrote
 * is in it, so nothing of the sort reaches the workflow's event history or a log line.
 */
export interface StepOutcome {
  status: string;
  reason: string | null;
  stage: string | null;
  version: number | null;
  complete: boolean | null;
  missing: number | null;
  runId: string | null;
}

function outcomeOf(out: AdvanceStepResult): StepOutcome {
  return {
    status: out.status,
    reason: out.reason ?? null,
    stage: out.stage ?? null,
    version: out.version ?? null,
    complete: out.complete ?? null,
    missing: out.missingRoles?.length ?? null,
    runId: out.runId ?? null,
  };
}
const refused = (reason: string): StepOutcome => ({ status: "refused", reason, stage: null, version: null, complete: null, missing: null, runId: null });

/** The panel (round 1 and the one challenge round). A seat that failed is the pipeline's own outcome (complete: false), not an error. */
export async function panelBody(worker: AdvanceWorker | null, who: StepWho): Promise<StepOutcome> {
  if (!worker) return refused("worker_unavailable");
  return outcomeOf(await worker.advancePanel(who));
}

/** The pipeline's Spec step (it re-enters the panel, runs the PM and publishes the Spec). */
export async function specBody(worker: AdvanceWorker | null, who: StepWho, attempt?: string, spendAttempt?: number): Promise<StepOutcome> {
  if (!worker) return refused("worker_unavailable");
  // D#483 S5-k1c: the first ask carries no attempt number (the call is exactly what it was before); only a later ask after a spending-limit denial names one.
  return outcomeOf(spendAttempt === undefined || spendAttempt === 0 ? await worker.advanceSpec(who, attempt) : await worker.advanceSpec(who, attempt, spendAttempt));
}

/** Starts the executor for an item at spec_ready. The approval (the action) names the run, so a replay finds it and a fresh approval after a refusal asks again. `pinnedVersion` is the Spec version the person approved. */
export async function buildBody(worker: AdvanceWorker | null, who: StepWho, actionId: string, pinnedVersion?: number | null, spendAttempt?: number): Promise<StepOutcome> {
  if (!worker) return refused("worker_unavailable");
  // The first ask carries no attempt (the call is exactly what it was before S5-k1); only a later ask after a spend denial names one.
  return outcomeOf(spendAttempt === undefined ? await worker.advanceBuild(who, actionId, pinnedVersion ?? undefined) : await worker.advanceBuild(who, actionId, pinnedVersion ?? undefined, spendAttempt));
}

/** Stops a live build run (the wait for it ran out): the existing cancel path, as the approver. Safe on a finished run. */
export async function cancelRunBody(worker: Pick<AdvanceFacade, "advanceCancel"> | null, who: StepWho, runId: string): Promise<void> {
  if (!worker) return;
  await worker.advanceCancel(who, runId);
}

/** Stops every live run the panel or the Spec step started for the item (the wait for them ran out and the workflow holds no run id). Safe when none is live. */
export async function cancelStepRunsBody(worker: Pick<AdvanceFacade, "advanceCancelStepRuns"> | null, who: StepWho, step: "panel" | "spec", actionId: string): Promise<void> {
  if (!worker) return;
  await worker.advanceCancelStepRuns(who, step, actionId);
}

/** How the executor run stands: the status, and whether its envelope carries the plain-text summary the prompt required. The summary itself stays in the run. */
export interface BuildRunOutcome {
  status: string;
  done: boolean;
  hasSummary: boolean;
  /** The run is `pending` on a runner (a queued runner run): the workflow credits that wait to the pending ceiling, not to the work budget. */
  queuedOnRunner: boolean;
  /**
   * The run this outcome is about: the end of the follow-up chain that starts at the run asked about (D#6 R2b-3, C22 section 7). A
   * runner run that was lost or hit a usage limit is followed by a child, and the status above is the child's. This is the id to
   * cancel when the wait runs out, and the one a failure is recorded against. The id asked about when the run is gone.
   */
  tailRunId: string;
  /** The fixed reason a failed RUNNER run carries (`no_commit`: it ended with the agent done and nothing pushed). Absent for any other run. */
  failureReason?: string | null;
}

/** D#6 R-CHK-3: what the driver keeps of a check fix round: fixed words and a run id. `escalated` is the plan's fix-round limit (the item goes to Needs human). */
export interface CheckFixOut {
  status: "started" | "escalated" | "refused";
  runId: string | null;
  reason: string | null;
}

/** Starts the fix round that follows a build run whose approved check failed (`failureReason: check_failed`). */
export async function checkFixBody(worker: Pick<AdvanceFacade, "advanceStartCheckFix"> | null, who: StepWho, failedRunId: string): Promise<CheckFixOut> {
  if (!worker) return { status: "refused", runId: null, reason: "worker_unavailable" };
  const out = await worker.advanceStartCheckFix(who, failedRunId);
  if (out.ok) return { status: "started", runId: out.runId, reason: null };
  return { status: out.reason === "check_rounds_used" ? "escalated" : "refused", runId: null, reason: out.reason };
}

/** D#598 P1f-5c: the worker's settle for a paired sandbox build. Optional, so a worker built without it (or a test double) leaves the outcome as it always was. */
export type BuildSettler = Partial<Pick<PlanePublish, "settlePairedBuild">>;

export async function buildOutcomeBody(worker: (AdvanceWorker & BuildSettler) | null, accountId: string, runId: string): Promise<BuildRunOutcome> {
  if (!worker) return { status: "missing", done: true, hasSummary: false, queuedOnRunner: false, tailRunId: runId };
  const out: AdvanceRunOutcome = await worker.advanceRunOutcome(accountId, runId);
  // D#598 P1f-5c (Q1): the executor of a paired SANDBOX build has pushed its branch to the private repo and opened nothing. Once it has succeeded, the platform opens the private
  // pull request and publishes the public change, before the driver looks for the pull request. The worker does nothing for any run it does not recognise, and a replay of this
  // step is harmless (the pull request is reused, the attempt exists). Nothing here changes the outcome that is returned.
  if (out.done && out.status === "succeeded" && out.runtime !== "runner" && worker.settlePairedBuild) {
    try {
      await worker.settlePairedBuild({ accountId, executorRunId: out.tailRunId ?? runId });
    } catch (err) {
      // fx-swallow-ok: the settle is best effort beside the driver; a failure leaves the existing "no pull request" outcome, and the log line is the trace
      console.warn(JSON.stringify({ event: "advance.paired_build_settle_failed", run_id: out.tailRunId ?? runId, error: err instanceof Error ? err.name : "unknown" }));
    }
  }
  const summary = out.envelope?.summary;
  return { status: out.status, done: out.done, hasSummary: typeof summary === "string" && summary.trim().length > 0, queuedOnRunner: isQueuedOnRunner(out), tailRunId: out.tailRunId ?? runId, ...(out.failureReason ? { failureReason: out.failureReason } : {}) };
}

export type DecisionWorker = Pick<AdvanceFacade, "advanceDecision">;

/**
 * D#7 DP4b-2: after a succeeded executor run (the build, or a fix round), reads the decisions it reported or asked about. One fixed word back, never model
 * text: `parked` ends the workflow (an ask is waiting for a person), a halt ends it the halted way, anything else lets it carry on as before.
 */
export async function decisionBody(worker: DecisionWorker | null, who: StepWho, runId: string): Promise<DecisionStepCode> {
  if (!worker) return "none";
  return worker.advanceDecision(who.accountId, who.userId, who.workItemId, who.haltEpoch, runId);
}

/**
 * D#7 start gate (b): the start decision for the advance a person filed. Fixed words only cross into the workflow: `proceed`, or the reason it stopped. No worker:
 * the advance stops (`blocked`), because a start that cannot be recorded does not happen.
 */
export async function startGateBody(worker: Pick<AdvanceFacade, "advanceStartGate"> | null, who: StepWho, input: StartGateStepInput): Promise<StartGateStepOut> {
  if (!worker) return { proceed: false, reason: "blocked", blockedBy: "worker_unavailable" };
  return worker.advanceStartGate(who, input);
}

/** The item's stage now, or null (gone, or no worker). */
export async function stageBody(worker: AdvanceWorker | null, accountId: string, workItemId: string): Promise<string | null> {
  if (!worker) return null;
  return (await worker.advanceLoadItem(accountId, workItemId))?.stage ?? null;
}

/** The run statuses that end a run without success. */
const FAILED_RUN_STATUSES = ["failed", "timed_out", "cancelled", "killed_spend", "refused_spend", "missing"];

/**
 * The code a failed RUNNER run is recorded under (C22 section 8): the two ways a chain of follow-up runs runs out get codes of their
 * own, and any other failed run is `run_failed`.
 */
export function runnerFailureCode(failureReason: string | null | undefined): string {
  if (failureReason === "runner_lost") return "runner_lost";
  if (failureReason === "usage_limit") return "runner_usage_limit";
  return "run_failed";
}

/**
 * Records a build that ended without a pull request as needs_human. `reason` is the run's status (it becomes `run_<status>`)
 * or one of the fixed words `no_pull_request` and `wait_timeout`; the pipeline accepts only its own list of codes. A `failed`
 * RUNNER run (`runId` is the end of its follow-up chain, so it has no child) is recorded as `runner_lost` or `runner_usage_limit`
 * when that is why it failed, and as `run_failed` otherwise. The worker's write is idempotent: whichever of the driver and the
 * sweeper records the item first wins, and the other finds it no longer in progress.
 */
export async function buildFailedBody(worker: AdvanceWorker | null, accountId: string, workItemId: string, runId: string | null, reason: string, attempt?: string): Promise<StepOutcome> {
  if (!worker) return refused("worker_unavailable");
  let code = FAILED_RUN_STATUSES.includes(reason) ? `run_${reason}` : reason;
  if (reason === "failed" && runId !== null) {
    const run: AdvanceRunOutcome = await worker.advanceRunOutcome(accountId, runId);
    if (run.runtime === "runner") code = runnerFailureCode(run.failureReason);
  }
  return outcomeOf(await worker.advanceBuildFailed(accountId, workItemId, runId, code, ...(attempt === undefined ? [] : [attempt])));
}
