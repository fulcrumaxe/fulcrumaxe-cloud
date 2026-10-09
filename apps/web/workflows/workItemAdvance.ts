import { sleep } from "workflow";
import type { AdvanceRunStart, AdvanceStartArgs, AdvanceTriageResult } from "@fx/worker";
import { getWorker } from "../lib/worker";
import { getIssueReader } from "../lib/github/issueRead";
import { openInstallationHttp } from "../lib/github/installationHttp";
import { publishLightSpecBody, startLightSpecBody, type LightPublished } from "../lib/advanceLightSteps";
import { loadBody, runOutcomeBody, startClassifyBody, triageBody, type ClassifyOutcome, type LoadedAdvance, type TriageLoaded } from "../lib/advanceSteps";
import { buildBody, buildFailedBody, buildOutcomeBody, cancelRunBody, panelBody, specBody, stageBody, type BuildRunOutcome, type StepOutcome } from "../lib/advanceStageSteps";
import {
  cancelBody,
  eventBody,
  findPrBody,
  mergeGateBody,
  prFoundBody,
  recordRoundBody,
  reviewLoadBody,
  reviewPlanBody,
  reviewerOutcomeBody,
  startFixBody,
  startReviewerBody,
  type FixOut,
  type GateOut,
  type PrLookup,
  type ReviewCtx,
  type ReviewLoaded,
  type ReviewPlanOut,
  type ReviewerOutcome,
  type RoundOut,
  type StartedReviewer,
} from "../lib/advanceReviewSteps";

/**
 * D#483 P1 + P2 + P3: the stage driver for one approved work item, as a durable workflow so it can wait on an agent run
 * for as long as the run takes. The entry is chosen by where the item is when the person approves it (the one table in
 * @fx/core's work-items/advance.ts says which):
 *
 *   Triaged:        load the item and its issue -> a trusted label, or one classify run, decides the category -> the
 *                   pipeline's triage (the discussion, the root item that becomes the issue's one card) -> for a critical
 *                   or feature item, the panel and the Spec. The item ends at Spec ready. (A project is planned, not
 *                   specified: the driver stops there and says so.)
 *   Discussing:     the same panel and Spec, again: the item was left without a Spec by a panel or Spec step that failed.
 *   Spec ready:     the build. The executor runs on the published Spec; the pull request it opens moves the item (the
 *                   webhook); then the review below follows in the same workflow.
 *   PR open (pr_opened, changes_requested, review_passed):
 *                   the review. The required reviewers run on the pull request's EXACT head commit; every verdict of the
 *                   head is gathered, then recorded (passes first, so a needs-fix is never overwritten by a later pass).
 *                   All passed: the merge gate. A needs-fix: an executor fix round that RESUMES the build's sandbox and
 *                   session, then the review again on the new head. A fix that pushed nothing, a reviewer's `fail`, and
 *                   the fix-round limit used each stop the driver with a recorded outcome.
 *
 * Rules this file keeps (each learned live):
 *  - A workflow body cannot import a Node module, so it imports no value from a package. Every prompt and all I/O are
 *    inside the `"use step"` functions below, which call plain bodies in ../lib.
 *  - Waiting on an agent run is a durable sleep plus a status read, never a held connection.
 *  - One step has a function time limit; a panel round plus the PM does not fit in it, so the panel and the Spec are TWO
 *    steps (packages/pipeline/src/advance/specFlow.ts pins the arithmetic), and every run is keyed, so a step the platform
 *    cuts short and replays follows the runs it already started instead of starting new ones.
 *  - Steps are idempotent. Reviewer runs are keyed by (head, role); a fix run by (head, approval); the build by the Spec
 *    version and the approval; the PM run by the approval. A second press of Approve while any run is live is refused
 *    (409) before it gets here, and a replay finds the runs it already started.
 *  - Every refusal is data with a fixed reason code (never a throw, which the service would retry). Every exit logs one
 *    `advance.*` line with ids and fixed codes only, and the decisions the insight view shows are recorded as driver
 *    events (a fixed vocabulary, no text): no issue text, no label text, no login, no model output.
 *  - The Spec the person approved is the Spec used: its version is read when the workflow starts and pinned for the build
 *    and every review step.
 */

/**
 * D#6 C12 A3: every wait below counts only the time a run is NOT queued on a runner. A queued runner run (`pending`, and
 * `runtime = 'runner'`) sits there until a runner on the customer's machine claims it; that is waiting for a person's
 * machine, not for work, so it does not use up the budget meant for the work. The time slept after such a read goes to
 * `pendingWaited` instead of `waited`, and `pendingWaited` has its own ceiling (RUNNER_PENDING_CEILING_MS): reaching it ends
 * the wait exactly like the normal wait timeout does (the loop exits not done, and the existing timeout path runs), so no
 * wait is unbounded. A `pending` run of any other runtime is never credited: it counts against the normal budget.
 */

/** Same value as `RUNNER_PENDING_CEILING_MS` in @fx/pipeline (a test pins it): the runner queue TTL of 72 hours plus a one hour margin. A workflow body imports no value from a package, so it is repeated here. */
const RUNNER_PENDING_CEILING_MS = 73 * 3_600_000;

/**
 * D#6 C29: the word a panel or Spec step answers with when it hands control back because its seats or the PM are queued on (or
 * running on) a runner and the step's own time is used up. Same value as `QUEUED_ON_RUNNER` in @fx/pipeline (a test pins it).
 */
const QUEUED_ON_RUNNER = "queued_on_runner";
/**
 * The step time a hand-back means was spent waiting. Same value as `STEP_YIELD_MS` in @fx/pipeline (a test pins it). Each call that
 * answers `waiting` is credited this much on top of the sleep, so `RUNNER_PENDING_CEILING_MS` bounds the real wait and not just the sleeps.
 */
const STEP_YIELD_MS = 180_000;

/** How often a waiting workflow reads the classify run's status. */
const POLL_MS = 20_000;
/** Past this, the workflow gives up waiting (the run's own timeout is shorter). */
const CLASSIFY_WAIT_MS = 15 * 60_000;
/** How often the build waits read the executor run (a run lasts up to four hours). */
const BUILD_POLL_MS = 60_000;
/** The run's own ceiling is 240 minutes and its watchdog adds five; the workflow gives up a little after that. */
const BUILD_WAIT_MS = 250 * 60_000;
/** After a run that succeeded, how long to wait for the pull request to reach the item (the webhook is a moment behind). */
const PR_GRACE_POLL_MS = 20_000;
const PR_GRACE_POLLS = 9;
/** Reviewer runs: how often they are read, and how long a review may take before the driver cancels it and counts it as a fail. */
const REVIEW_POLL_MS = 30_000;
const REVIEW_WAIT_MS = 45 * 60_000;
/**
 * A bound on review rounds in one workflow, so no path loops. The real bound is the fix-round limit (from the plan data), enforced by
 * the round decision; this one must exceed it (a test pins MAX_REVIEW_ROUNDS >= the fix-round limit + 2): the rounds, one more
 * review of the last fix, and a review of a head that moved under the merge gate.
 */
const MAX_REVIEW_ROUNDS = 6;
/** The fixed codes "Check the build" records when its lookup could not decide (the activity route turns them into a notice sentence). */
const CHECK_UNAVAILABLE = "check_build_unavailable";
const CHECK_AMBIGUOUS = "check_build_ambiguous";
/**
 * A start that meets a reaper claim on the executor's sandbox (the worker answers `start_sandbox_reaping`, nothing written) waits and
 * starts again: Build again must not fail because a delete was in flight. The waits add up to 705 s, past the claim's own
 * 10-minute expiry, so the last try always sees an expired claim. Eight retries; the build step is keyed, so a replay is safe.
 */
const BUILD_REAPING_BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 120_000, 120_000, 120_000, 120_000];
const BUILD_REAPING_REASON = "start_sandbox_reaping";
/** The short-Spec PM run: one run reading a repository, like the classify run. */
const LIGHT_SPEC_WAIT_MS = 20 * 60_000;

export async function advanceLoadStep(accountId: string, workItemId: string): Promise<LoadedAdvance> {
  "use step";
  return loadBody(await getWorker(), getIssueReader(), accountId, workItemId);
}

export async function advanceStartClassifyStep(accountId: string, workItemId: string, haltEpoch: number, actionId: string, loaded: TriageLoaded): Promise<AdvanceRunStart> {
  "use step";
  return startClassifyBody(await getWorker(), accountId, workItemId, haltEpoch, actionId, loaded);
}

export async function advanceRunOutcomeStep(accountId: string, runId: string): Promise<ClassifyOutcome> {
  "use step";
  return runOutcomeBody(await getWorker(), accountId, runId);
}

export async function advanceTriageStep(accountId: string, workItemId: string, loaded: TriageLoaded, category: string): Promise<AdvanceTriageResult> {
  "use step";
  return triageBody(await getWorker(), accountId, { workItemId, loaded, category });
}

/** The panel: round 1 and, if a seat asks for it or dissents, the one challenge round. */
export async function advancePanelStep(accountId: string, userId: string, workItemId: string, haltEpoch: number): Promise<StepOutcome> {
  "use step";
  return panelBody(await getWorker(), { accountId, userId, workItemId, haltEpoch });
}

/** The pipeline's Spec step: re-enters the panel (all finished), runs the PM, publishes the Spec. `actionId` names this attempt's PM run. */
export async function advanceSpecStep(accountId: string, userId: string, workItemId: string, haltEpoch: number, actionId: string): Promise<StepOutcome> {
  "use step";
  return specBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, actionId);
}

/** Starts the executor and records Spec ready -> In progress once the run exists. `pinned` is the Spec version the person approved. */
export async function advanceBuildStep(accountId: string, userId: string, workItemId: string, haltEpoch: number, actionId: string, pinned: number | null): Promise<StepOutcome> {
  "use step";
  return buildBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, actionId, pinned);
}

export async function advanceBuildOutcomeStep(accountId: string, runId: string): Promise<BuildRunOutcome> {
  "use step";
  return buildOutcomeBody(await getWorker(), accountId, runId);
}

export async function advanceStageStep(accountId: string, workItemId: string): Promise<string | null> {
  "use step";
  return stageBody(await getWorker(), accountId, workItemId);
}

/** Records a build that ended without a pull request as Needs human. `reason` is a run status or a fixed word. */
export async function advanceBuildFailedStep(accountId: string, workItemId: string, runId: string | null, reason: string, attempt?: string): Promise<StepOutcome> {
  "use step";
  return buildFailedBody(await getWorker(), accountId, workItemId, runId, reason, attempt);
}

/** Stops a live run of the item (the wait for it ran out). The existing cancel path, as the approver. Safe on a finished run. */
export async function advanceCancelStep(accountId: string, userId: string, workItemId: string, runId: string): Promise<void> {
  "use step";
  return cancelRunBody(await getWorker(), { accountId, userId, workItemId, haltEpoch: 0 }, runId);
}

/** One structured line: a fixed event code and ids/codes. Never text from the issue or from a model. */
export async function advanceLogStep(event: string, fields: Record<string, string | number | boolean | null>): Promise<void> {
  "use step";
  console.info(JSON.stringify({ event, ...fields }));
}

type EventFields = Parameters<typeof eventBody>[2];

/** One recorded fact of the item (the fixed vocabulary of @fx/core's driverEvents). A repeat of the same key writes nothing. */
export async function advanceEventStep(accountId: string, userId: string, workItemId: string, event: EventFields): Promise<void> {
  "use step";
  return eventBody(await getWorker(), { accountId, userId, workItemId, haltEpoch: 0 }, event);
}

// ---- the short Spec (small, bug, doc: no panel) ---------------------------------------------------------------------

export async function advanceStartLightSpecStep(accountId: string, userId: string, workItemId: string, haltEpoch: number, input: { category: string; title: string; body: string }, actionId: string): Promise<AdvanceRunStart> {
  "use step";
  return startLightSpecBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, input, actionId);
}

/** Publishes the short Spec from the finished PM run. The PM's text stays in the run. */
export async function advanceLightSpecPublishStep(accountId: string, userId: string, workItemId: string, haltEpoch: number, runId: string, actionId: string): Promise<LightPublished> {
  "use step";
  return publishLightSpecBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, runId, actionId);
}

// ---- review steps ---------------------------------------------------------------------------------------------------

export async function advanceReviewLoadStep(accountId: string, userId: string, workItemId: string, haltEpoch: number, pinned: number | null): Promise<ReviewLoaded> {
  "use step";
  return reviewLoadBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, pinned);
}

export async function advanceFindPrStep(ctx: Pick<ReviewCtx, "repoId" | "owner" | "name" | "issue" | "executionMode" | "recordedPr">): Promise<PrLookup> {
  "use step";
  return findPrBody(openInstallationHttp, ctx);
}

/** "Check the build" found the pull request while the item sits at In progress: records PR opened so the review can record. Answers the stage after. */
export async function advancePrFoundStep(accountId: string, userId: string, workItemId: string, haltEpoch: number, prNumber: number): Promise<string | null> {
  "use step";
  return prFoundBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, prNumber);
}

export async function advanceReviewPlanStep(accountId: string, userId: string, workItemId: string, haltEpoch: number, ctx: Pick<ReviewCtx, "tier" | "debaterEnabled">, pr: { number: number; headSha: string; securityCodes: string[] }, flagged: boolean): Promise<ReviewPlanOut> {
  "use step";
  return reviewPlanBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, ctx, pr, flagged);
}

export async function advanceStartReviewerStep(
  accountId: string,
  userId: string,
  workItemId: string,
  haltEpoch: number,
  ctx: ReviewCtx,
  pr: { number: number; headSha: string; baseRef: string; branch: string },
  role: string,
  prior: Array<{ role: string; runId: string }>,
): Promise<StartedReviewer> {
  "use step";
  return startReviewerBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, ctx, pr, role, prior);
}

export async function advanceReviewerOutcomeStep(accountId: string, runId: string): Promise<ReviewerOutcome> {
  "use step";
  return reviewerOutcomeBody(await getWorker(), accountId, runId);
}

export async function advanceRecordRoundStep(
  accountId: string,
  userId: string,
  workItemId: string,
  haltEpoch: number,
  input: { headSha: string; prNumber: number; requiredRoles: string[]; verdicts: Array<{ role: string; runId: string; verdict: string }> },
): Promise<RoundOut> {
  "use step";
  return recordRoundBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, input);
}

export async function advanceStartFixStep(
  accountId: string,
  userId: string,
  workItemId: string,
  haltEpoch: number,
  ctx: ReviewCtx,
  pr: { number: number; headSha: string; branch: string },
  actionId: string,
  round: number,
  failing: Array<{ role: string; runId: string }>,
): Promise<FixOut> {
  "use step";
  return startFixBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, ctx, pr, actionId, round, failing);
}

export async function advanceMergeGateStep(accountId: string, userId: string, workItemId: string, haltEpoch: number, prNumber: number): Promise<GateOut> {
  "use step";
  return mergeGateBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, prNumber);
}

type Result = { status: string; detail?: string };

export async function workItemAdvanceWorkflow(started: AdvanceStartArgs): Promise<Result> {
  "use workflow";
  // A workflow started before the halt marker existed replays without a haltEpoch: read as 0, the epoch of an item never halted.
  const args: AdvanceStartArgs = { ...started, haltEpoch: (started as { haltEpoch?: number }).haltEpoch ?? 0 };
  const { accountId, workItemId, actionId } = args;

  const loaded = await advanceLoadStep(accountId, workItemId);
  if (!loaded.ok) {
    await advanceLogStep("advance.failed", { work_item_id: workItemId, at: "load", reason: loaded.reason });
    return { status: "failed", detail: loaded.reason };
  }
  // The Spec the person approved: the version read when the approval was performed (carried in the arguments), else the one
  // this load read. A newer version appearing since refuses the build and the review.
  const pinned = (read: number | null): number | null => (args.specVersion !== undefined ? args.specVersion : read);
  if (loaded.mode === "build") return buildPhase(args, pinned(loaded.specVersion));
  // Build again, for an item at Needs a person: a fresh build, unless a pull request is still open for the issue's branch.
  if (loaded.mode === "rebuild") return rebuildPhase(args, pinned(loaded.specVersion), { repoId: loaded.repoId, owner: loaded.owner, name: loaded.name, issue: loaded.number, executionMode: loaded.executionMode, recordedPr: loaded.recordedPr });
  if (loaded.mode === "review") return reviewPhase(args, pinned(loaded.specVersion));
  // An item left at In progress with nothing running: look for its pull request (found: the review; none: Needs human).
  if (loaded.mode === "check_build") return checkBuildPhase(args, pinned(loaded.specVersion), loaded.executorRunId);
  // The pipeline's own root item, left at Discussing without a Spec: the panel and the Spec once more.
  if (loaded.mode === "spec") return specPhase(args, workItemId);
  // A small, bug or doc item the pipeline triaged earlier and has no Spec: the short Spec again, from the issue as it reads now.
  if (loaded.mode === "light") return lightPhase(args, workItemId, { category: loaded.category, title: loaded.title, body: loaded.body });

  let category: string;
  if (loaded.decided !== null) {
    // A label a trusted actor applied decided it: no run, no spend. The log line is the record.
    category = loaded.decided;
    await advanceLogStep("advance.label_decided", { work_item_id: workItemId, category });
  } else {
    const started = await advanceStartClassifyStep(accountId, workItemId, args.haltEpoch, actionId, loaded);
    if (!started.ok) {
      if (isHaltReason(started.reason)) return haltedEnd(args, "classify_start");
      await advanceLogStep("advance.failed", { work_item_id: workItemId, at: "classify_start", reason: started.reason });
      return { status: "failed", detail: `classify_refused:${started.reason}` };
    }
    let waited = 0;
    let outcome = await advanceRunOutcomeStep(accountId, started.runId);
    let pendingWaited = 0;
    while (!outcome.done && waited < CLASSIFY_WAIT_MS && pendingWaited < RUNNER_PENDING_CEILING_MS) {
      const queued = outcome.queuedOnRunner;
      await sleep(POLL_MS);
      if (queued) pendingWaited += POLL_MS;
      else waited += POLL_MS;
      outcome = await advanceRunOutcomeStep(accountId, started.runId);
    }
    if (!outcome.done) {
      await advanceLogStep("advance.failed", { work_item_id: workItemId, run_id: started.runId, at: "classify_wait", reason: "wait_timeout" });
      return { status: "failed", detail: "classify_wait_timeout" };
    }
    const word = outcome.category;
    await advanceLogStep("advance.classified", { work_item_id: workItemId, run_id: started.runId, run_status: outcome.status, has_category: word !== null, hints: loaded.hints.length });
    if (outcome.status !== "succeeded" || word === null) {
      await advanceLogStep("advance.failed", { work_item_id: workItemId, run_id: started.runId, at: "classify", reason: outcome.status !== "succeeded" ? `run_${outcome.status}` : "no_category" });
      return { status: "failed", detail: outcome.status !== "succeeded" ? `classify_${outcome.status}` : "classify_no_category" };
    }
    category = word;
  }

  const triaged = await advanceTriageStep(accountId, workItemId, loaded, category);
  await advanceLogStep(triaged.status === "triaged" ? "advance.triaged" : "advance.stopped", {
    work_item_id: workItemId,
    at: "triage",
    status: triaged.status,
    reason: triaged.reason ?? null,
    root_id: triaged.workItemId ?? null,
    stage: triaged.stage ?? null,
  });
  if (triaged.status === "triaged" && triaged.stage === "discussing" && triaged.workItemId) {
    // A project is planned, not specified: the panel runs for critical and feature work only. This is a stop, not a failure.
    if (triaged.category === "project") {
      await advanceLogStep("advance.stopped", { work_item_id: triaged.workItemId, at: "spec", reason: "project_not_specified" });
      await advanceEventStep(accountId, args.userId, triaged.workItemId, { kind: "stopped", dedupeKey: `project:${actionId}`, code: "project_not_specified" });
      return { status: "stopped", detail: "project_not_specified" };
    }
    return specPhase(args, triaged.workItemId);
  }
  // Small, bug and doc run no panel: the project manager writes a short Spec straight from the issue, then the build.
  if (triaged.status === "triaged" && triaged.stage === "triaged" && triaged.workItemId && (triaged.category === "small" || triaged.category === "bug" || triaged.category === "doc")) {
    return lightPhase(args, triaged.workItemId, { category: triaged.category, title: loaded.title, body: loaded.body });
  }
  // A question stays at Triaged, answered in its thread.
  return { status: triaged.status, detail: triaged.reason };
}

/** The panel, then the Spec, for the pipeline's root item. Ends at Spec ready, or with the pipeline's own outcome. */
async function specPhase(args: AdvanceStartArgs, rootId: string): Promise<Result> {
  const { accountId, userId, actionId } = args;

  // D#6 C29: on a runner repository a step hands control back (`waiting`) instead of overrunning its time limit. No run was
  // stopped: sleep, then call the same step again (every run is keyed, so it follows the ones already started). The time spent
  // counts toward the pending ceiling and never toward a work budget; the seats' and the PM's own budgets are measured from their
  // runs' records, so a re-entry does not reset them.
  let pendingWaited = 0;
  const reenter = async (call: () => Promise<StepOutcome>): Promise<StepOutcome> => {
    let out = await call();
    while (out.status === "waiting" && out.reason === QUEUED_ON_RUNNER && pendingWaited < RUNNER_PENDING_CEILING_MS) {
      await sleep(POLL_MS);
      pendingWaited += POLL_MS + STEP_YIELD_MS;
      out = await call();
    }
    return out;
  };

  const panel = await reenter(() => advancePanelStep(accountId, userId, rootId, args.haltEpoch));
  await advanceLogStep(panel.status === "completed" ? "advance.panelled" : "advance.failed", {
    work_item_id: rootId,
    at: "panel",
    status: panel.status,
    reason: panel.reason,
    complete: panel.complete,
    missing: panel.missing,
  });
  // A seat that did not post is not a failure here: the Spec records it as "DID NOT POST". Only a refusal ends the run.
  if (isHaltReason(panel.reason)) return haltedEnd(args, "panel");
  if (panel.status !== "completed") return { status: "failed", detail: panel.status === "waiting" && panel.reason === QUEUED_ON_RUNNER ? "panel_wait_timeout" : `panel_${panel.status}:${panel.reason ?? "none"}` };

  const spec = await reenter(() => advanceSpecStep(accountId, userId, rootId, args.haltEpoch, actionId));
  if (spec.status === "waiting" && spec.reason === QUEUED_ON_RUNNER) {
    // Still queued when the ceiling was reached: the pipeline's own wait limit, like every other wait here.
    await advanceLogStep("advance.failed", { work_item_id: rootId, at: "spec", reason: "wait_timeout" });
    return { status: "failed", detail: "spec_wait_timeout" };
  }
  if (spec.status === "published") {
    await advanceLogStep("advance.spec_ready", { work_item_id: rootId, at: "spec", version: spec.version, stage: spec.stage });
    return { status: "spec_ready" };
  }
  await advanceLogStep(spec.status === "refused" ? "advance.failed" : "advance.stopped", { work_item_id: rootId, at: "spec", status: spec.status, reason: spec.reason });
  if (isHaltReason(spec.reason)) return haltedEnd(args, "spec");
  // needs_owner_action (the Spec is too large to store) and external_requires_human are the pipeline's own outcomes.
  if (spec.status === "refused") return { status: "failed", detail: `spec_${spec.reason ?? "none"}` };
  return { status: spec.status, detail: spec.reason ?? undefined };
}

/**
 * The short Spec for a small, bug or doc item (`rootId` is the pipeline's card for the issue), then the build. The PM first
 * judges whether the request can be built as written; `not_feasible` stops BEFORE anything is published or built, leaving
 * the item at Triaged with the PM's explanation as its run's summary and the stop as a recorded fact. Approving again after
 * the issue was edited runs a fresh PM (the run is keyed per approval).
 */
async function lightPhase(args: AdvanceStartArgs, rootId: string, issue: { category: string; title: string; body: string }): Promise<Result> {
  const { accountId, userId, actionId } = args;
  const started = await advanceStartLightSpecStep(accountId, userId, rootId, args.haltEpoch, issue, actionId);
  if (!started.ok) {
    if (isHaltReason(started.reason)) return haltedEnd(args, "light_spec_start");
    await advanceLogStep("advance.failed", { work_item_id: rootId, at: "light_spec_start", reason: started.reason });
    return { status: "failed", detail: `light_spec_refused:${started.reason}` };
  }
  let waited = 0;
  let outcome = await advanceBuildOutcomeStep(accountId, started.runId);
  let pendingWaited = 0;
  while (!outcome.done && waited < LIGHT_SPEC_WAIT_MS && pendingWaited < RUNNER_PENDING_CEILING_MS) {
    const queued = outcome.queuedOnRunner;
    await sleep(POLL_MS);
    if (queued) pendingWaited += POLL_MS;
    else waited += POLL_MS;
    outcome = await advanceBuildOutcomeStep(accountId, started.runId);
  }
  if (!outcome.done) {
    await advanceCancelStep(accountId, userId, rootId, outcome.tailRunId);
    await advanceLogStep("advance.stopped", { work_item_id: rootId, at: "light_spec", reason: "wait_timeout" });
    return { status: "light_spec_failed", detail: "wait_timeout" };
  }
  if (outcome.status !== "succeeded") {
    await advanceLogStep("advance.stopped", { work_item_id: rootId, at: "light_spec", reason: `run_${outcome.status}` });
    return { status: "light_spec_failed", detail: `run_${outcome.status}` };
  }
  const published = await advanceLightSpecPublishStep(accountId, userId, rootId, args.haltEpoch, started.runId, actionId);
  if (published.status === "not_feasible") {
    await advanceLogStep("advance.stopped", { work_item_id: rootId, at: "light_spec", reason: "not_feasible" });
    return { status: "not_feasible" };
  }
  if (isHaltReason(published.reason)) return haltedEnd(args, "light_spec");
  if (published.status !== "published") {
    await advanceLogStep("advance.stopped", { work_item_id: rootId, at: "light_spec", reason: published.reason ?? "refused" });
    return { status: "light_spec_refused", detail: published.reason ?? undefined };
  }
  await advanceLogStep("advance.spec_ready", { work_item_id: rootId, at: "light_spec", version: published.version });
  // The Spec is published: the build, pinned to this version, then the review. The pipeline's card for the issue is the root.
  return buildPhase({ ...args, workItemId: rootId }, published.version);
}

/**
 * Build again, for an item at Needs a person that still has its Spec. The sandbox executor's branch is `fx/issue-<n>` (a runner run's pull request is the one its run recorded), and a pull
 * request still open for it is somebody's work in review (the review stage handed the item over, or a person opened one): a
 * fresh build would replace its branch under it. So the driver looks first. Open: it stops with a recorded code and starts
 * nothing (close that pull request on GitHub, then press the button again). None open: the build, exactly as for Spec ready
 * but from `needs_human` (its own run key, so the failed run is never reused). A lookup that failed decides nothing: it stops
 * too, since a build must not start on a guess.
 */
async function rebuildPhase(args: AdvanceStartArgs, pinned: number | null, repo: Pick<ReviewCtx, "repoId" | "owner" | "name" | "issue" | "executionMode" | "recordedPr">): Promise<Result> {
  const found = await advanceFindPrStep(repo);
  if (found.ok) {
    await stopped(args, "rebuild_pr", "rebuild_pr_open", { pr: found.number });
    return { status: "stopped", detail: "rebuild_pr_open" };
  }
  if (found.reason !== "no_open_pr") {
    await stopped(args, "rebuild_pr", "rebuild_check_unavailable");
    return { status: "stopped", detail: "rebuild_check_unavailable" };
  }
  return buildPhase(args, pinned);
}

/** The build for an item at Spec ready: start the executor, wait for it, then review the pull request it opened. */
async function buildPhase(args: AdvanceStartArgs, pinned: number | null): Promise<Result> {
  const { accountId, userId, workItemId, actionId } = args;

  let started = await advanceBuildStep(accountId, userId, workItemId, args.haltEpoch, actionId, pinned);
  for (let i = 0; started.reason === BUILD_REAPING_REASON && i < BUILD_REAPING_BACKOFF_MS.length; i++) {
    await advanceLogStep("advance.build_waiting", { work_item_id: workItemId, at: "build_start", reason: "sandbox_reaping", attempt: i + 1 });
    await sleep(BUILD_REAPING_BACKOFF_MS[i]!);
    started = await advanceBuildStep(accountId, userId, workItemId, args.haltEpoch, actionId, pinned);
  }
  if (isHaltReason(started.reason)) return haltedEnd(args, "build_start");
  if (started.status !== "started" || started.runId === null) {
    // Nothing was spent and the item did not move: it stays at Spec ready, where it can be approved again. The refusal is
    // recorded as a fact of the item (by the worker).
    await advanceLogStep("advance.failed", { work_item_id: workItemId, at: "build_start", status: started.status, reason: started.reason });
    return { status: "failed", detail: `build_refused:${started.reason ?? "none"}` };
  }
  const runId = started.runId;
  await advanceLogStep("advance.build_started", { work_item_id: workItemId, run_id: runId });

  let waited = 0;
  let outcome = await advanceBuildOutcomeStep(accountId, runId);
  let pendingWaited = 0;
  while (!outcome.done && waited < BUILD_WAIT_MS && pendingWaited < RUNNER_PENDING_CEILING_MS) {
    const queued = outcome.queuedOnRunner;
    await sleep(BUILD_POLL_MS);
    if (queued) pendingWaited += BUILD_POLL_MS;
    else waited += BUILD_POLL_MS;
    outcome = await advanceBuildOutcomeStep(accountId, runId);
  }
  if (!outcome.done) {
    // The wait ran out. The run must not keep going (and spending) behind a card that says Needs human.
    // A run that was lost or hit a usage limit has a follow-up: the run still going is the end of that chain, not the one started here.
    await advanceCancelStep(accountId, userId, workItemId, outcome.tailRunId);
    const recorded = await advanceBuildFailedStep(accountId, workItemId, outcome.tailRunId, "wait_timeout");
    await buildStopped(args, outcome.tailRunId, "build_wait_timeout");
    await advanceLogStep("advance.failed", { work_item_id: workItemId, run_id: runId, at: "build_wait", reason: "wait_timeout", recorded: recorded.status });
    return { status: "failed", detail: "build_wait_timeout" };
  }
  await advanceLogStep("advance.build_ended", { work_item_id: workItemId, run_id: runId, run_status: outcome.status, has_summary: outcome.hasSummary });
  if (outcome.status !== "succeeded") {
    // The run recorded is the end of the chain: the one whose summary and failure say why (a lost or limited run's child, or the last run when no child could be made).
    const recorded = await advanceBuildFailedStep(accountId, workItemId, outcome.tailRunId, outcome.status);
    await buildStopped(args, outcome.tailRunId, `build_run_${outcome.status}`);
    await advanceLogStep("advance.failed", { work_item_id: workItemId, run_id: runId, at: "build", reason: `run_${outcome.status}`, recorded: recorded.status });
    return { status: "failed", detail: `build_${outcome.status}` };
  }

  // The run says it finished. The pull request it opened reaches the item through the webhook; give it a moment.
  let stage = await advanceStageStep(accountId, workItemId);
  for (let i = 0; i < PR_GRACE_POLLS && stage === "in_progress"; i++) {
    await sleep(PR_GRACE_POLL_MS);
    stage = await advanceStageStep(accountId, workItemId);
  }
  if (stage === "in_progress") {
    // The webhook may never move the item: it reads "Closes #N" in the PR body, and a runner's pull request carries fixed text
    // with no issue reference. Look for the pull request the way "Check the build" does before calling it missing.
    const looked = await findBuiltPr(args, pinned);
    if ("end" in looked) return looked.end;
    stage = looked.stage;
  }
  if (stage === "in_progress") {
    // The run succeeded and opened no pull request (live: the Spec said the work was not buildable, and the executor
    // correctly made none). The item goes to Needs human; the executor's own summary, in the run, is the reason.
    const recorded = await advanceBuildFailedStep(accountId, workItemId, outcome.tailRunId, "no_pull_request");
    await buildStopped(args, outcome.tailRunId, "build_no_pull_request");
    await advanceLogStep("advance.failed", { work_item_id: workItemId, run_id: runId, at: "build_pr", reason: "no_pull_request", recorded: recorded.status });
    return { status: "failed", detail: "build_no_pull_request" };
  }
  await advanceLogStep("advance.built", { work_item_id: workItemId, run_id: runId, stage });
  // The pull request is open: the reviewers are next, in this same workflow.
  if (stage === "pr_opened" || stage === "changes_requested" || stage === "review_passed") return reviewPhase(args, pinned);
  return { status: "built", detail: stage ?? undefined };
}

/**
 * The build's fallback when the webhook has not moved the item: the same lookup "Check the build" uses (the item's review
 * context, then the open pull request by branch or by what a runner's `done` recorded). Found: the item moves to PR opened
 * and the stage after is answered. None open: the stage stays In progress, so the caller reports `no_pull_request` as before.
 * A lookup that decided nothing ends the driver with the same fixed codes "Check the build" records.
 */
async function findBuiltPr(args: AdvanceStartArgs, pinned: number | null): Promise<{ stage: string | null } | { end: Result }> {
  const { accountId, userId, workItemId } = args;
  const loaded = await advanceReviewLoadStep(accountId, userId, workItemId, args.haltEpoch, pinned);
  if (!loaded.ok && isHaltReason(loaded.reason)) return { end: await haltedEnd(args, "build_pr_load") };
  if (!loaded.ok) {
    await stopped(args, "build_pr_load", CHECK_UNAVAILABLE);
    return { end: { status: "failed", detail: `check_build_${loaded.reason}` } };
  }
  const ctx: ReviewCtx = { repoId: loaded.repoId, owner: loaded.owner, name: loaded.name, issue: loaded.issue, tier: loaded.tier, specVersion: loaded.specVersion, debaterEnabled: loaded.debaterEnabled, executionMode: loaded.executionMode, recordedPr: loaded.recordedPr };
  const found = await advanceFindPrStep(ctx);
  if (found.ok) return { stage: await advancePrFoundStep(accountId, userId, workItemId, args.haltEpoch, found.number) };
  if (found.reason === "no_open_pr") return { stage: "in_progress" };
  await stopped(args, "build_pr", found.reason === "ambiguous_pr" ? CHECK_AMBIGUOUS : CHECK_UNAVAILABLE);
  return { end: { status: "no_pr", detail: found.reason } };
}

/**
 * "Check the build", for an item at In progress with no run live (its build ended, or its workflow was lost, and nobody
 * recorded what came of it). The executor's pull request (`fx/issue-<n>`, or the one a runner run recorded) is looked for: found, the item is moved to PR opened
 * if the webhook never did, and the review follows in this same workflow; none open, the item goes to Needs human against the
 * executor's newest run, whose own summary says why. A lookup that failed (GitHub unavailable, an ambiguous answer) decides
 * nothing: the driver stops and the item stays where it is.
 */
async function checkBuildPhase(args: AdvanceStartArgs, pinned: number | null, executorRunId: string | null): Promise<Result> {
  const { accountId, userId, workItemId, actionId } = args;
  const loaded = await advanceReviewLoadStep(accountId, userId, workItemId, args.haltEpoch, pinned);
  if (!loaded.ok && isHaltReason(loaded.reason)) return haltedEnd(args, "check_build_load");
  if (!loaded.ok) {
    await stopped(args, "check_build_load", CHECK_UNAVAILABLE);
    return { status: "failed", detail: `check_build_${loaded.reason}` };
  }
  const ctx: ReviewCtx = { repoId: loaded.repoId, owner: loaded.owner, name: loaded.name, issue: loaded.issue, tier: loaded.tier, specVersion: loaded.specVersion, debaterEnabled: loaded.debaterEnabled, executionMode: loaded.executionMode, recordedPr: loaded.recordedPr };
  const found = await advanceFindPrStep(ctx);
  if (found.ok) {
    const stage = await advancePrFoundStep(accountId, userId, workItemId, args.haltEpoch, found.number);
    await advanceLogStep("advance.build_checked", { work_item_id: workItemId, found: true, pr: found.number, stage });
    // Only an item now at a pull-request stage can be reviewed; anything else (closed meanwhile) is left alone.
    if (stage !== "pr_opened" && stage !== "changes_requested" && stage !== "review_passed") return { status: "unchanged", detail: stage ?? undefined };
    return reviewPhase(args, pinned);
  }
  if (found.reason !== "no_open_pr") {
    // The lookup failed, so nothing is decided and the item keeps its stage. The stop is recorded under a fixed code the card
    // reads (the activity route's notice), so the person sees that the check did not complete and can press the button again.
    await stopped(args, "check_build_pr", found.reason === "ambiguous_pr" ? CHECK_AMBIGUOUS : CHECK_UNAVAILABLE);
    return { status: "no_pr", detail: found.reason };
  }
  // No pull request: a person must look. Recorded against the executor's newest run (whose summary is the reason shown), or
  // with no run at all when the item never had an executor run.
  const recorded = await advanceBuildFailedStep(accountId, workItemId, executorRunId, "no_pull_request", actionId);
  await buildStopped(args, executorRunId, "build_no_pull_request");
  await advanceLogStep("advance.build_checked", { work_item_id: workItemId, found: false, run_id: executorRunId, recorded: recorded.status });
  return { status: "failed", detail: "build_no_pull_request" };
}

/** A build that ended without a pull request, as a fact of the item: a fixed code and the executor's run, whose summary says why. */
async function buildStopped(args: AdvanceStartArgs, runId: string | null, code: string): Promise<void> {
  await advanceEventStep(args.accountId, args.userId, args.workItemId, { kind: "stopped", dedupeKey: `build:${runId ?? args.actionId}`, code: code.replace(/[^a-z0-9_]/g, "_").slice(0, 64), ...(runId === null ? {} : { runId }) });
}

interface Verdict {
  role: string;
  runId: string;
  verdict: string;
  securityNeeded: boolean;
}

/** Waits for one reviewer run. A run still going when the wait ends is cancelled and counts as a fail (a review that could not finish is not a pass). */
async function waitForReviewer(accountId: string, userId: string, workItemId: string, role: string, runId: string): Promise<Verdict> {
  let waited = 0;
  let out = await advanceReviewerOutcomeStep(accountId, runId);
  let pendingWaited = 0;
  while (!out.done && waited < REVIEW_WAIT_MS && pendingWaited < RUNNER_PENDING_CEILING_MS) {
    const queued = out.queuedOnRunner;
    await sleep(REVIEW_POLL_MS);
    if (queued) pendingWaited += REVIEW_POLL_MS;
    else waited += REVIEW_POLL_MS;
    out = await advanceReviewerOutcomeStep(accountId, runId);
  }
  if (!out.done) {
    await advanceCancelStep(accountId, userId, workItemId, out.tailRunId);
    await advanceLogStep("advance.review_wait_timeout", { work_item_id: workItemId, run_id: runId, role });
    return { role, runId, verdict: "fail", securityNeeded: false };
  }
  return { role, runId, verdict: out.verdict, securityNeeded: out.securityNeeded };
}

/** Starts the given roles in parallel (each keyed by head and role) and waits for each; a role that could not start has no verdict. */
async function runReviewers(args: AdvanceStartArgs, ctx: ReviewCtx, pr: { number: number; headSha: string; baseRef: string; branch: string }, roles: string[], prior: Array<{ role: string; runId: string }>, round: number): Promise<{ verdicts: Verdict[]; refused: string[] }> {
  const { accountId, userId, workItemId } = args;
  const started = await Promise.all(roles.map((role) => advanceStartReviewerStep(accountId, userId, workItemId, args.haltEpoch, ctx, pr, role, prior)));
  await advanceLogStep("advance.review_started", {
    work_item_id: workItemId,
    round,
    pr: pr.number,
    head: pr.headSha.slice(0, 12),
    started: started.filter((s) => s.runId !== null).map((s) => s.role).join(","),
    refused: started.filter((s) => s.runId === null).map((s) => `${s.role}:${s.reason ?? "none"}`).join(","),
  });
  const verdicts: Verdict[] = [];
  for (const s of started) {
    if (s.runId !== null) verdicts.push(await waitForReviewer(accountId, userId, workItemId, s.role, s.runId));
  }
  return { verdicts, refused: started.filter((s) => s.runId === null).map((s) => s.role) };
}

/** The two answers a step gives when the item was halted: still halted, or halted and resumed since this workflow started. */
const isHaltReason = (reason: string | null | undefined): boolean => reason === "item_halted" || reason === "halted_since_approval";

/** A halt ends this workflow with one recorded stop. It never retries and never polls: only a person's later approval starts a new one. */
async function haltedEnd(args: AdvanceStartArgs, at: string): Promise<Result> {
  await stopped(args, at, "halted");
  return { status: "stopped", detail: "halted" };
}

/** A fact of the item: the driver stopped, and why. One per approval and reason. */
async function stopped(args: AdvanceStartArgs, at: string, code: string, extra: { head?: string; pr?: number; round?: number } = {}): Promise<void> {
  const { accountId, userId, workItemId, actionId } = args;
  if (isHaltReason(code)) code = "halted";
  await advanceLogStep("advance.stopped", { work_item_id: workItemId, at, reason: code });
  await advanceEventStep(accountId, userId, workItemId, {
    kind: "stopped",
    dedupeKey: `stop:${actionId}:${at}:${code}`.slice(0, 200),
    code: code.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^[^a-z]+/, "x").slice(0, 64),
    ...(extra.head ? { headSha: extra.head } : {}),
    ...(extra.pr ? { prNumber: extra.pr } : {}),
    ...(extra.round !== undefined ? { round: extra.round } : {}),
  });
}

/**
 * The review of an open pull request: reviewers on the head, all verdicts gathered, then recorded; the merge gate when
 * everyone passed; a fix round (a RESUME of the build's session) when someone asked for changes; then the review again on
 * the new head. See the file header for every way it stops.
 */
async function reviewPhase(args: AdvanceStartArgs, pinned: number | null): Promise<Result> {
  const { accountId, userId, workItemId, actionId } = args;

  const loaded = await advanceReviewLoadStep(accountId, userId, workItemId, args.haltEpoch, pinned);
  if (!loaded.ok && isHaltReason(loaded.reason)) return haltedEnd(args, "review_load");
  if (!loaded.ok) {
    await stopped(args, "review_load", loaded.reason);
    return { status: "failed", detail: `review_${loaded.reason}` };
  }
  const ctx: ReviewCtx = { repoId: loaded.repoId, owner: loaded.owner, name: loaded.name, issue: loaded.issue, tier: loaded.tier, specVersion: loaded.specVersion, debaterEnabled: loaded.debaterEnabled, executionMode: loaded.executionMode, recordedPr: loaded.recordedPr };

  for (let attempt = 0; attempt < MAX_REVIEW_ROUNDS; attempt++) {
    const found = await advanceFindPrStep(ctx);
    if (!found.ok) {
      await stopped(args, "review_pr", found.reason);
      return { status: "no_pr", detail: found.reason };
    }
    const pr = { number: found.number, headSha: found.headSha, baseRef: found.baseRef, branch: found.branch };

    // Who must review this head: code and acceptance always; security when the item is critical, the diff touches a
    // security surface, or (below) the code reviewer asks for it; the debater when the repo's role setting allows it.
    let plan = await advanceReviewPlanStep(accountId, userId, workItemId, args.haltEpoch, ctx, found, false);
    const roundOne = plan.roles.filter((r) => r !== "debater");
    const first = await runReviewers(args, ctx, pr, roundOne, [], attempt);
    const verdicts = [...first.verdicts];
    let refused = [...first.refused];

    // The code reviewer's "security review needed" flag adds the security reviewer for this head.
    if (verdicts.some((v) => v.role === "code-reviewer" && v.securityNeeded)) {
      plan = await advanceReviewPlanStep(accountId, userId, workItemId, args.haltEpoch, ctx, found, true);
      const extra = plan.roles.filter((r) => r !== "debater" && !roundOne.includes(r));
      if (extra.length > 0) {
        const more = await runReviewers(args, ctx, pr, extra, [], attempt);
        verdicts.push(...more.verdicts);
        refused = [...refused, ...more.refused];
      }
    }

    // The debater tries to refute a pass: it runs only after everyone else has passed.
    const others = plan.roles.filter((r) => r !== "debater");
    let debaterRan = false;
    if (plan.roles.includes("debater") && refused.length === 0 && others.every((r) => verdicts.some((v) => v.role === r && v.verdict === "pass"))) {
      const passes = verdicts.filter((v) => v.verdict === "pass").map((v) => ({ role: v.role, runId: v.runId }));
      debaterRan = true;
      const debate = await runReviewers(args, ctx, pr, ["debater"], passes, attempt);
      verdicts.push(...debate.verdicts);
      refused = [...refused, ...debate.refused];
    }

    // Every verdict is in: record them, passes first and non-passes last, in ONE step.
    const round = await advanceRecordRoundStep(accountId, userId, workItemId, args.haltEpoch, {
      headSha: pr.headSha,
      prNumber: pr.number,
      // The debater is required only once it has been started: it runs after everyone else passed, so a needs-fix from
      // another reviewer must start a fix round, not stop as "incomplete" for want of a debater verdict. (The merge gate
      // still demands its pass: it reads the full plan.)
      requiredRoles: plan.roles.filter((r) => r !== "debater" || debaterRan),
      verdicts: verdicts.map((v) => ({ role: v.role, runId: v.runId, verdict: v.verdict })),
    });
    await advanceLogStep("advance.reviewed", { work_item_id: workItemId, round: attempt, pr: pr.number, head: pr.headSha.slice(0, 12), decision: round.decision, recorded: round.recorded.join(",") });

    if (round.decision === "halted") return haltedEnd(args, "review");
    if (round.decision === "all_passed") {
      const gate = await advanceMergeGateStep(accountId, userId, workItemId, args.haltEpoch, pr.number);
      await advanceLogStep("advance.merge_gate", { work_item_id: workItemId, pr: pr.number, outcome: gate.outcome, reasons: gate.reasons.join(","), status: gate.status });
      // The head moved while the gate ran: review the new head.
      if (gate.outcome === "head_moved") continue;
      if (gate.outcome === "error" || gate.outcome === "refused") await stopped(args, "merge_gate", gate.reasons[0] ?? gate.outcome, { head: pr.headSha, pr: pr.number });
      return { status: gate.outcome, detail: gate.reasons.join(",") || undefined };
    }
    if (round.decision === "escalated") {
      await advanceLogStep("advance.stopped", { work_item_id: workItemId, at: "review", reason: "max_fix_rounds" });
      return { status: "escalated", detail: "max_fix_rounds" };
    }
    if (round.decision === "reviewer_fail") {
      await advanceLogStep("advance.stopped", { work_item_id: workItemId, at: "review", reason: "reviewer_fail" });
      return { status: "needs_human", detail: "reviewer_fail" };
    }
    if (round.decision !== "fix") {
      // incomplete (a required reviewer could not start) or refused: nothing is decided, nothing is merged.
      await stopped(args, "review", refused.length > 0 ? `not_started_${refused[0]}` : round.decision, { head: pr.headSha, pr: pr.number });
      return { status: "needs_human", detail: refused.length > 0 ? `reviewer_not_started:${refused.join(",")}` : round.decision };
    }

    // A fix round: the executor RESUMES the build's sandbox and session with the findings, then the head is read again.
    const failing = verdicts.filter((v) => v.verdict !== "pass").map((v) => ({ role: v.role, runId: v.runId }));
    const fix = await advanceStartFixStep(accountId, userId, workItemId, args.haltEpoch, ctx, pr, actionId, round.nextRound ?? round.round + 1, failing);
    if (isHaltReason(fix.reason)) return haltedEnd(args, "fix");
    if (!fix.ok || fix.runId === null) {
      await advanceLogStep("advance.stopped", { work_item_id: workItemId, at: "fix", reason: fix.reason ?? "none" });
      return { status: "fix_refused", detail: fix.reason ?? undefined };
    }
    let waited = 0;
    let fixed = await advanceBuildOutcomeStep(accountId, fix.runId);
    let pendingWaited = 0;
    while (!fixed.done && waited < BUILD_WAIT_MS && pendingWaited < RUNNER_PENDING_CEILING_MS) {
      const queued = fixed.queuedOnRunner;
      await sleep(BUILD_POLL_MS);
      if (queued) pendingWaited += BUILD_POLL_MS;
      else waited += BUILD_POLL_MS;
      fixed = await advanceBuildOutcomeStep(accountId, fix.runId);
    }
    if (!fixed.done) {
      await advanceCancelStep(accountId, userId, workItemId, fixed.tailRunId);
      await advanceEventStep(accountId, userId, workItemId, { kind: "fix_round_failed", dedupeKey: `fixfail:${pr.headSha}:${actionId}`, code: "wait_timeout", headSha: pr.headSha, runId: fix.runId });
      return { status: "fix_failed", detail: "wait_timeout" };
    }
    await advanceLogStep("advance.fixed", { work_item_id: workItemId, round: round.nextRound ?? round.round + 1, run_id: fix.runId, run_status: fixed.status });
    if (fixed.status !== "succeeded") {
      await advanceEventStep(accountId, userId, workItemId, { kind: "fix_round_failed", dedupeKey: `fixfail:${pr.headSha}:${actionId}`, code: `run_${fixed.status}`.replace(/[^a-z0-9_]/g, "_"), headSha: pr.headSha, runId: fix.runId });
      return { status: "fix_failed", detail: fixed.status };
    }
    // A fix that did not move the PR's head pushed nothing: stop and say so. Never review the same commit in a loop.
    const after = await advanceFindPrStep(ctx);
    if (!after.ok) {
      await stopped(args, "review_pr", after.reason);
      return { status: "no_pr", detail: after.reason };
    }
    if (after.headSha === pr.headSha) {
      await advanceEventStep(accountId, userId, workItemId, { kind: "fix_pushed_nothing", dedupeKey: `nothing:${pr.headSha}:${actionId}`, headSha: pr.headSha, prNumber: pr.number, runId: fix.runId });
      await advanceLogStep("advance.stopped", { work_item_id: workItemId, at: "fix", reason: "fix_pushed_nothing", head: pr.headSha.slice(0, 12) });
      return { status: "fix_pushed_nothing" };
    }
  }
  await stopped(args, "review", "review_rounds_used");
  return { status: "needs_human", detail: "review_rounds_used" };
}
