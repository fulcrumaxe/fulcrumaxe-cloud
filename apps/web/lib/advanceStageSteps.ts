import type { AdvanceFacade, AdvanceRunOutcome, AdvanceStepResult } from "@fx/worker";
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
export async function specBody(worker: AdvanceWorker | null, who: StepWho, attempt?: string): Promise<StepOutcome> {
  if (!worker) return refused("worker_unavailable");
  return outcomeOf(await worker.advanceSpec(who, attempt));
}

/** Starts the executor for an item at spec_ready. The approval (the action) names the run, so a replay finds it and a fresh approval after a refusal asks again. `pinnedVersion` is the Spec version the person approved. */
export async function buildBody(worker: AdvanceWorker | null, who: StepWho, actionId: string, pinnedVersion?: number | null): Promise<StepOutcome> {
  if (!worker) return refused("worker_unavailable");
  return outcomeOf(await worker.advanceBuild(who, actionId, pinnedVersion ?? undefined));
}

/** Stops a live build run (the wait for it ran out): the existing cancel path, as the approver. Safe on a finished run. */
export async function cancelRunBody(worker: Pick<AdvanceFacade, "advanceCancel"> | null, who: StepWho, runId: string): Promise<void> {
  if (!worker) return;
  await worker.advanceCancel(who, runId);
}

/** How the executor run stands: the status, and whether its envelope carries the plain-text summary the prompt required. The summary itself stays in the run. */
export interface BuildRunOutcome {
  status: string;
  done: boolean;
  hasSummary: boolean;
  /** The run is `pending` on a runner (a queued runner run): the workflow credits that wait to the pending ceiling, not to the work budget. */
  queuedOnRunner: boolean;
}

export async function buildOutcomeBody(worker: AdvanceWorker | null, accountId: string, runId: string): Promise<BuildRunOutcome> {
  if (!worker) return { status: "missing", done: true, hasSummary: false, queuedOnRunner: false };
  const out: AdvanceRunOutcome = await worker.advanceRunOutcome(accountId, runId);
  const summary = out.envelope?.summary;
  return { status: out.status, done: out.done, hasSummary: typeof summary === "string" && summary.trim().length > 0, queuedOnRunner: isQueuedOnRunner(out) };
}

/** The item's stage now, or null (gone, or no worker). */
export async function stageBody(worker: AdvanceWorker | null, accountId: string, workItemId: string): Promise<string | null> {
  if (!worker) return null;
  return (await worker.advanceLoadItem(accountId, workItemId))?.stage ?? null;
}

/** The run statuses that end a run without success. */
const FAILED_RUN_STATUSES = ["failed", "timed_out", "cancelled", "killed_spend", "refused_spend", "missing"];

/**
 * Records a build that ended without a pull request as needs_human. `reason` is the run's status (it becomes `run_<status>`)
 * or one of the fixed words `no_pull_request` and `wait_timeout`; the pipeline accepts only its own list of codes.
 */
export async function buildFailedBody(worker: AdvanceWorker | null, accountId: string, workItemId: string, runId: string | null, reason: string, attempt?: string): Promise<StepOutcome> {
  if (!worker) return refused("worker_unavailable");
  const code = FAILED_RUN_STATUSES.includes(reason) ? `run_${reason}` : reason;
  return outcomeOf(await worker.advanceBuildFailed(accountId, workItemId, runId, code, ...(attempt === undefined ? [] : [attempt])));
}
