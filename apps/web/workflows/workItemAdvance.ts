import { sleep } from "workflow";
import type { AdvanceContinueOut, AdvanceRunStart, AdvanceStartArgs, AdvanceTriageResult, DecisionStepCode, StartGateStepInput, StartGateStepOut } from "@fx/worker";
import { getWorker } from "../lib/worker";
import { getIssueReader } from "../lib/github/issueRead";
import { openInstallationHttp } from "../lib/github/installationHttp";
import { publishLightSpecBody, startLightSpecBody, type LightPublished } from "../lib/advanceLightSteps";
import { publishRespecBody, startRespecBody, type RespecPublished } from "../lib/advanceRespecSteps";
import { loadBody, runOutcomeBody, startClassifyBody, triageBody, type ClassifyOutcome, type LoadedAdvance, type TriageLoaded } from "../lib/advanceSteps";
import { buildBody, buildFailedBody, buildOutcomeBody, cancelRunBody, cancelStepRunsBody, checkFixBody, continueBody, type CheckFixOut, decisionBody, panelBody, specBody, stageBody, startGateBody, type BuildRunOutcome, type StepOutcome } from "../lib/advanceStageSteps";
import {
  cancelBody,
  eventBody,
  findPrBody,
  fixDescentBody,
  mergeGateBody,
  mergeOrderBody,
  prFoundBody,
  recordMergeOnlyBody,
  recordRoundBody,
  reviewLoadBody,
  reviewPlanBody,
  reviewRerunBody,
  reviewRunsBody,
  verifiedGateBody,
  reviewerOutcomeBody,
  startFixBody,
  startReviewerBody,
  type DescentOut,
  type FixOut,
  type GateOut,
  type MergeOrderOut,
  type MergeOnlyOut,
  type PrLookup,
  type ReviewCtx,
  type ReviewLoaded,
  type PrFound,
  type ReviewPlanOut,
  type ReviewerOutcome,
  type RerunOut,
  type RoundOut,
  type StartedReviewer,
  type VerifiedGateOut,
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
 *                   session, then the review again on the new head. A fix that proved no change needed (it ended with nothing pushed) sends the
 *                   reviewers that asked for it back to the SAME head, once per head; a second such fix on it, a reviewer's `fail`, and
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

/**
 * D#599 PL-2 (AC4): the failure reason of a run PL-1's item-scoped cancel ended because its item moved to the other side, and how many times one step
 * restarts after it. Same values as `PLACEMENT_CHANGED` and `PLACEMENT_RESTARTS_MAX` in @fx/worker (a test pins them). The restart is the same keyed start step
 * again: the worker picks the next key (`:p1`...) from the rows, so a replay of this step returns the restarted run and starts nothing.
 */
const PLACEMENT_CHANGED = "placement_changed";
const PLACEMENT_RESTARTS_MAX = 3;

/** How often a waiting workflow reads the classify run's status. */
const POLL_MS = 20_000;
/** Past this, the workflow gives up waiting (the run's own timeout is shorter). */
const CLASSIFY_WAIT_MS = 15 * 60_000;
/** How often the build waits read the executor run (a run lasts up to four hours). */
const BUILD_POLL_MS = 60_000;
/** The run's own ceiling is 240 minutes and its watchdog adds five; the workflow gives up a little after that. */
const BUILD_WAIT_MS = 250 * 60_000;
/**
 * D#2 H14c-3-3b-2 (C88 R1, section 3): the run statuses that end an executor run at a limit and may be continued; the most continuations of one work item (a
 * workflow body imports no value from a package, so a test holds this equal to `MAX_CONTINUATIONS_PER_WORK_ITEM`); and how a busy answer is waited out.
 */
const LIMIT_END_STATUSES: readonly string[] = ["timed_out", "killed_spend"];
const MAX_CONTINUATIONS_PER_WORK_ITEM = 10;
const CONTINUE_BUSY_SLEEP_MS = 30_000;
const CONTINUE_BUSY_RETRIES = 3;
/** D#6 R-CHK-3: a hard stop on check fix rounds in one driver run, above any `maxFixRounds()` the plan sets. The worker is what enforces the plan's limit. */
const CHECK_FIX_ROUNDS_CEILING = 20;
/** After a run that succeeded, how long to wait for the pull request to reach the item (the webhook is a moment behind). */
const PR_GRACE_POLL_MS = 20_000;
const PR_GRACE_POLLS = 9;
/** Reviewer runs: how often they are read, and how long a review may take before the driver cancels it and counts it as a fail. */
const REVIEW_POLL_MS = 30_000;
const REVIEW_WAIT_MS = 45 * 60_000;
/** D#598 P7b: how often a round that met unfinished CI or repo-wide guards asks again, and how long it waits before the driver stops (`ci_wait_timeout`). */
const CI_POLL_MS = 60_000;
/**
 * D#6 PUBLIC-MERGE PR2b: how often a workflow whose gate handed the merge to the customer's runner (`merge_delegated`) looks at the order, and the most looks it makes.
 * The order's own deadline (60 minutes, enforced by the step) ends the wait first; the count only bounds the loop. The polling exists only while an order is open.
 */
const MERGE_ORDER_POLL_MS = 30_000;
const MERGE_ORDER_MAX_POLLS = 130;
/** After the first ten minutes the round asks every two minutes: a long wait costs about half the GitHub calls. */
const CI_POLL_SLOW_MS = 120_000;
const CI_POLL_FAST_FOR_MS = 10 * 60_000;
const CI_WAIT_MS = 120 * 60_000;
/**
 * A bound on review rounds in one workflow, so no path loops. The real bound is the fix-round limit (from the plan data), enforced by
 * the round decision; this one must exceed it (a test pins MAX_REVIEW_ROUNDS >= the fix-round limit + 2): the rounds, one more
 * review of the last fix, and a review of a head that moved under the merge gate.
 */
const MAX_REVIEW_ROUNDS = 6;
/** D#6 R5b-2a: how many times one review waits out a cloud-verified pull request's quiet period (each wait is at most ten minutes) before the driver gives up. */
const MAX_QUIET_CHECKS = 36;
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
/**
 * D#483 S5-c1: the start answered that the item cannot take a build slot yet (packages/pipeline buildSlots.ts BUILD_WAIT_REASONS; a test holds the two lists
 * equal, because the workflow bundle imports no server package). Each poll leaves a `build_waiting` fact, and the slot module counts an item as waiting only while its latest one is under three polls old (a test holds the two numbers together).
 */
const BUILD_SLOT_WAIT_REASONS: readonly string[] = ["one_build_per_repo_until_d598", "waiting_for_build_slot_repo", "waiting_for_build_slot_account"];
const BUILD_SLOT_POLL_MS = 60_000;
const BUILD_SLOT_WAIT_MS = 4 * 3_600_000;
/**
 * D#483 S5-k1: the start answered that a spending limit denied the run (packages/pipeline reservationPauses.ts RESERVATION_PAUSE_REASONS; a test holds the two lists equal).
 * The item stays where it is and the workflow asks again every five minutes, up to four hours. Each ask is a new attempt (its own run key), because a denied start leaves a
 * keyed `refused_spend` run that a replay of the same key would find again; five minutes keeps those rows to 48 in the wait.
 */
const RESERVATION_PAUSE_REASONS: readonly string[] = ["account_budget_reached", "compute_cap_reached", "item_cap_reached", "run_limit_below_estimate", "envelope_reached", "model_credits_exhausted"];
const BUILD_SPEND_POLL_MS = 300_000;
const BUILD_SPEND_WAIT_MS = 4 * 3_600_000;
/** C44-7: the fixed reason when a second fix on one head also changed nothing. */
const NO_CHANGE_REPEATED = "fix_no_change_repeated";
/** The short-Spec PM run: one run reading a repository, like the classify run. */
const LIGHT_SPEC_WAIT_MS = 20 * 60_000;

export async function advanceLoadStep(accountId: string, workItemId: string): Promise<LoadedAdvance> {
  "use step";
  return loadBody(await getWorker(), getIssueReader(), accountId, workItemId);
}

export async function advanceStartClassifyStep(accountId: string, workItemId: string, haltEpoch: number, actionId: string, loaded: TriageLoaded, attempt?: number): Promise<AdvanceRunStart> {
  "use step";
  return startClassifyBody(await getWorker(), accountId, workItemId, haltEpoch, actionId, loaded, attempt);
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
export async function advanceSpecStep(accountId: string, userId: string, workItemId: string, haltEpoch: number, actionId: string, spendAttempt?: number): Promise<StepOutcome> {
  "use step";
  return specBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, actionId, spendAttempt);
}

/** Starts the executor and records Spec ready -> In progress once the run exists. `pinned` is the Spec version the person approved. */
export async function advanceBuildStep(accountId: string, userId: string, workItemId: string, haltEpoch: number, actionId: string, pinned: number | null, spendAttempt?: number): Promise<StepOutcome> {
  "use step";
  return buildBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, actionId, pinned, spendAttempt);
}

export async function advanceBuildOutcomeStep(accountId: string, runId: string): Promise<BuildRunOutcome> {
  "use step";
  return buildOutcomeBody(await getWorker(), accountId, runId);
}

/** D#6 R-CHK-3: the fix round after a build run whose approved check failed. */
export async function advanceCheckFixStep(accountId: string, userId: string, workItemId: string, haltEpoch: number, failedRunId: string): Promise<CheckFixOut> {
  "use step";
  return checkFixBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, failedRunId);
}

/**
 * D#2 H14c-3-3b-2 (C88 R1): an executor run the workflow waited on ended at a limit. Continues it when the customer's run limits allow. The answer is one fixed
 * word (and a run id); the step never throws for a refusal, and a replay answers the child the first pass started.
 */
export async function advanceContinueStep(accountId: string, userId: string, workItemId: string, haltEpoch: number, endedRunId: string): Promise<AdvanceContinueOut> {
  "use step";
  return continueBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, endedRunId);
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

/** D#7 DP4b-2: reads a succeeded executor run's decision fields. The answer is one fixed word (`parked`, a halt, or carry on). */
export async function advanceDecisionStep(accountId: string, userId: string, workItemId: string, haltEpoch: number, runId: string): Promise<DecisionStepCode> {
  "use step";
  return decisionBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, runId);
}

/** Stops a live run of the item (the wait for it ran out). The existing cancel path, as the approver. Safe on a finished run. */
export async function advanceCancelStep(accountId: string, userId: string, workItemId: string, runId: string): Promise<void> {
  "use step";
  return cancelRunBody(await getWorker(), { accountId, userId, workItemId, haltEpoch: 0 }, runId);
}

/** Stops the live runs of the panel or Spec step (their wait ran out), queued and unclaimed ones included, and the tail of each follow-up chain. */
export async function advanceCancelStepRunsStep(accountId: string, userId: string, workItemId: string, step: "panel" | "spec", actionId: string): Promise<void> {
  "use step";
  return cancelStepRunsBody(await getWorker(), { accountId, userId, workItemId, haltEpoch: 0 }, step, actionId);
}

/**
 * D#7 start gate (b): the start decision. The advance was filed by a person's click, so the click is the decision (a PERSON start receipt, never an ask);
 * only an item that came in small and that triage found larger is asked, and then the workflow ends waiting for the answer. The answer files the next
 * `advance_work_item` (keyed `startask:<ask id>`), which re-enters at the item's stage (the short Spec, or the panel) and does not come back here for a
 * small start: the pair is already started. Fixed words only.
 */
export async function advanceStartGateStep(accountId: string, userId: string, workItemId: string, haltEpoch: number, input: StartGateStepInput): Promise<StartGateStepOut> {
  "use step";
  return startGateBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, input);
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

export async function advanceStartLightSpecStep(accountId: string, userId: string, workItemId: string, haltEpoch: number, input: { category: string; title: string; body: string }, actionId: string, attempt?: number): Promise<AdvanceRunStart> {
  "use step";
  return startLightSpecBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, input, actionId, attempt);
}

/** Publishes the short Spec from the finished PM run. The PM's text stays in the run. */
export async function advanceLightSpecPublishStep(accountId: string, userId: string, workItemId: string, haltEpoch: number, runId: string, actionId: string): Promise<LightPublished> {
  "use step";
  return publishLightSpecBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, runId, actionId);
}

// ---- Re-spec (D#6 R4d-5b): the project manager's file list for a Spec that has none, then the next Spec version ----------

export async function advanceStartRespecStep(accountId: string, userId: string, workItemId: string, haltEpoch: number, specVersion: number | null, actionId: string, attempt?: number): Promise<AdvanceRunStart> {
  "use step";
  return startRespecBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, specVersion, actionId, attempt);
}

/** Publishes version N+1 (the same text plus the list) from the finished PM run. The PM's output stays in the run. */
export async function advanceRespecPublishStep(accountId: string, userId: string, workItemId: string, haltEpoch: number, runId: string, actionId: string, specVersion: number): Promise<RespecPublished> {
  "use step";
  return publishRespecBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, runId, actionId, specVersion);
}

// ---- review steps ---------------------------------------------------------------------------------------------------

export async function advanceReviewLoadStep(accountId: string, userId: string, workItemId: string, haltEpoch: number, pinned: number | null): Promise<ReviewLoaded> {
  "use step";
  return reviewLoadBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, pinned);
}

export async function advanceFindPrStep(ctx: Pick<ReviewCtx, "repoId" | "owner" | "name" | "issue" | "executionMode" | "prExecutionMode" | "recordedPr">): Promise<PrLookup> {
  "use step";
  return findPrBody(openInstallationHttp, ctx);
}

/** "Check the build" found the pull request while the item sits at In progress: records PR opened so the review can record. Answers the stage after. */
export async function advancePrFoundStep(accountId: string, userId: string, workItemId: string, haltEpoch: number, prNumber: number): Promise<string | null> {
  "use step";
  return prFoundBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, prNumber);
}

export async function advanceVerifiedGateStep(accountId: string, userId: string, workItemId: string, haltEpoch: number, pr: { number: number; headSha: string }, seenHead: string | null): Promise<VerifiedGateOut> {
  "use step";
  return verifiedGateBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, pr, seenHead);
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
  rereview = 0,
  attempt = 0,
): Promise<StartedReviewer> {
  "use step";
  return startReviewerBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, ctx, pr, role, prior, rereview, attempt);
}

/** D#483 S5-k1d: the reviewer runs of this head and re-review round that really started, so a restarted review asks only for the roles that have none. */
export async function advanceReviewRunsStep(accountId: string, userId: string, workItemId: string, haltEpoch: number, headSha: string, rereview: number): Promise<Array<{ role: string; runId: string }>> {
  "use step";
  return reviewRunsBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, headSha, rereview);
}

/** Whether a reviewer whose run ended without a verdict is started again, and under which attempt (bounded by the fix-round limit; see reviewRerunBody). */
export async function advanceReviewRerunStep(accountId: string, userId: string, workItemId: string, haltEpoch: number, headSha: string, rereview: number, role: string, ends: number): Promise<RerunOut> {
  "use step";
  return reviewRerunBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, headSha, rereview, role, ends);
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
  input: { headSha: string; prNumber: number; requiredRoles: string[]; verdicts: Array<{ role: string; runId: string; verdict: string; environmentFailure?: boolean; unverifiable?: boolean; noVerdict?: boolean; endCode?: string }> },
): Promise<RoundOut> {
  "use step";
  return recordRoundBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, input);
}

/** D#598 P7c: is this head only a merge of the base branch? If so (and its CI has finished) it is recorded as re-checked and the reviewers do not run. */
export async function advanceRecordMergeOnlyStep(
  accountId: string,
  userId: string,
  workItemId: string,
  haltEpoch: number,
  input: { headSha: string; prNumber: number; baseRef: string; requiredRoles: string[] },
): Promise<MergeOnlyOut> {
  "use step";
  return recordMergeOnlyBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, input);
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
  retry = 0,
  spendAttempt = 0,
  person = false,
): Promise<FixOut> {
  "use step";
  return startFixBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, ctx, pr, actionId, round, failing, retry, spendAttempt, person);
}

export async function advanceFixDescentStep(ctx: Pick<ReviewCtx, "repoId" | "owner" | "name" | "executionMode" | "prExecutionMode">, base: string, head: string): Promise<DescentOut> {
  "use step";
  return fixDescentBody(openInstallationHttp, ctx, base, head);
}

export async function advanceMergeOrderStep(accountId: string, userId: string, workItemId: string, haltEpoch: number): Promise<MergeOrderOut> {
  "use step";
  return mergeOrderBody(await getWorker(), { accountId, userId, workItemId, haltEpoch });
}

export async function advanceMergeGateStep(accountId: string, userId: string, workItemId: string, haltEpoch: number, prNumber: number): Promise<GateOut> {
  "use step";
  return mergeGateBody(await getWorker(), { accountId, userId, workItemId, haltEpoch }, prNumber);
}

type Result = { status: string; detail?: string };

/**
 * Null: go on. Otherwise the workflow's end: waiting for an answer, a hold, or a refusal (nothing was started, nothing was spent). The gate is asked on EVERY
 * entry. Whether the run is a person's click is the explicit fact `personFiled` (set only by the start a person's own session made), never the attempt number: a
 * restart by the parked-stage sweep or the slot wake asks as `unattended`, so it goes on only for a pair already started (or an item not gated), and otherwise the
 * dial decides, a hold stays, and no person receipt is recorded.
 */
async function startGatePhase(args: AdvanceStartArgs, itemId: string, input: Omit<StartGateStepInput, "origin">): Promise<Result | null> {
  const gateInput: StartGateStepInput = { ...input, origin: args.personFiled === true ? "person_click" : "unattended" };
  const out = await advanceStartGateStep(args.accountId, args.userId, itemId, args.haltEpoch, gateInput);
  // Going on leaves the receipt as its record and no log line; a stop says why.
  if (out.proceed) return null;
  await advanceLogStep("advance.start_gate_stopped", { work_item_id: itemId, at: gateInput.mode, reason: out.reason, blocked_by: out.blockedBy });
  if (out.reason === "asked") return { status: "waiting", detail: "start_ask_open" };
  if (out.reason === "held") return { status: "stopped", detail: "start_held" };
  return { status: "stopped", detail: `start_blocked:${out.blockedBy ?? "none"}` };
}

/** D#483 S5-k1c: the stages before the build that wait on a limit (packages/pipeline waitingStages.ts; a test holds the names). */
type EarlyWaitStage = "classify" | "spec" | "respec" | "panel";
/** D#483 S5-k1d: and the two after it, which wait on one head of the open pull request. */
type WaitStage = EarlyWaitStage | "review" | "fix_round";

/** The wait reason when an answer is a spending-limit denial (a named pause), else null: a start, a halt and every other refusal end the wait. */
const pauseOf = (reason: string | null | undefined): string | null => (typeof reason === "string" && RESERVATION_PAUSE_REASONS.includes(reason) ? reason : null);

/** The attempt number a restart by the parked-stage sweep begins at (0 on every start a person's approval makes). */
const firstAttemptOf = (args: AdvanceStartArgs): number => (Number.isSafeInteger(args.startAttempt) && args.startAttempt! > 0 ? args.startAttempt! : 0);

/**
 * D#483 S5-k1c: one start before the build, asked until a spending limit allows it. The first ask is attempt `first`; while a limit denies it the item stays
 * where it is, each denied ask leaves the stage's waiting fact, and the next ask (five minutes later, up to four hours) is a new attempt with its own run key.
 * Any answer that is not a limit pause (a start, a halt, `account_not_active`, any other refusal) ends the wait and is returned as it came. After the four hours a
 * pause is still the answer: the caller ends `<stage>_paused:<pause>`, which is no failure, and the sweep starts the stage again when the limit allows it.
 */
async function askUntilAllowed<T>(args: AdvanceStartArgs, stage: EarlyWaitStage, itemId: string, first: number, ask: (attempt: number) => Promise<T>, reasonOf: (answer: T) => string | null | undefined): Promise<{ answer: T; attempt: number; pause: string | null }> {
  let attempt = first;
  let waited = 0;
  let answer = await ask(attempt);
  for (;;) {
    const reason = reasonOf(answer);
    const pause = pauseOf(reason);
    if (pause === null) {
      // A restart by the sweep that ends in a refusal which is not a limit (and not a halt) leaves a stop after the waiting fact: the sweep reads it and does not
      // start the stage again every pass. A start a person's approval made ends as it always did, with no extra fact.
      if (first > 0 && typeof reason === "string" && !isHaltReason(reason)) await advanceEventStep(args.accountId, args.userId, itemId, { kind: "stopped", dedupeKey: `refused:${stage}:${args.actionId}:${attempt}`, code: `${stage}_refused` });
      return { answer, attempt, pause: null };
    }
    await advanceEventStep(args.accountId, args.userId, itemId, { kind: "stage_waiting", stage, code: pause, attempt, dedupeKey: `wait:${stage}:${args.actionId}:${attempt}` });
    if (waited >= BUILD_SPEND_WAIT_MS) return { answer, attempt, pause };
    if (attempt === first) await advanceLogStep("advance.stage_waiting", { work_item_id: itemId, at: `${stage}_start`, reason: pause });
    await sleep(BUILD_SPEND_POLL_MS);
    waited += BUILD_SPEND_POLL_MS;
    attempt += 1;
    answer = await ask(attempt);
  }
}

/** The workflow's end when the four hours are up and a limit still denies the start: not a failure, nothing stamped, the item where it was. */
async function pausedEnd(itemId: string, stage: WaitStage, pause: string, attempt: number): Promise<Result> {
  await advanceLogStep("advance.paused", { work_item_id: itemId, at: `${stage}_start`, reason: pause, attempt });
  return { status: "paused", detail: `${stage}_paused:${pause}` };
}

export async function workItemAdvanceWorkflow(started: AdvanceStartArgs): Promise<Result> {
  "use workflow";
  // A workflow started before the halt marker existed replays without a haltEpoch: read as 0, the epoch of an item never halted.
  const args: AdvanceStartArgs = { ...started, haltEpoch: (started as { haltEpoch?: number }).haltEpoch ?? 0 };
  const { accountId, workItemId, actionId } = args;

  // Re-spec (`respec_work_item`): not an advance. It needs no issue read and stops once the next Spec version is published.
  if (args.respec === true) return respecPhase(args);
  // D#7 DP11c: `resume_decision` has already started the resumed executor run. Follow it as a build is followed (outcome, decisions, pull request, review).
  if (args.resumeRunId !== undefined) return buildPhase(args, args.specVersion ?? null);

  const loaded = await advanceLoadStep(accountId, workItemId);
  if (!loaded.ok) {
    await advanceLogStep("advance.failed", { work_item_id: workItemId, at: "load", reason: loaded.reason });
    return { status: "failed", detail: loaded.reason };
  }
  // The Spec the person approved: the version read when the approval was performed (carried in the arguments), else the one
  // this load read. A newer version appearing since refuses the build and the review.
  const pinned = (read: number | null): number | null => (args.specVersion !== undefined ? args.specVersion : read);
  if (loaded.mode === "build") {
    const gate = await startGatePhase(args, workItemId, { mode: "build", category: null, cameInAs: null });
    return gate ?? buildPhase(args, pinned(loaded.specVersion));
  }
  // Build again, for an item at Needs a person: a fresh build, unless a pull request is still open for the issue's branch.
  if (loaded.mode === "rebuild") return rebuildPhase(args, pinned(loaded.specVersion), { repoId: loaded.repoId, owner: loaded.owner, name: loaded.name, issue: loaded.number, executionMode: loaded.executionMode, recordedPr: loaded.recordedPr, prExecutionMode: loaded.prExecutionMode }, loaded.reviewHold === true);
  if (loaded.mode === "review") return reviewPhase(args, pinned(loaded.specVersion));
  // An item left at In progress with nothing running: look for its pull request (found: the review; none: Needs human).
  if (loaded.mode === "check_build") return checkBuildPhase(args, pinned(loaded.specVersion), loaded.executorRunId);
  // The pipeline's own root item, left at Discussing without a Spec: the panel and the Spec once more.
  if (loaded.mode === "spec") {
    // A click on an item whose reclassify ask is still open (or was held) answers it or decides again; an item with no such pair goes straight on.
    const gate = await startGatePhase(args, workItemId, { mode: "spec", category: null, cameInAs: null });
    return gate ?? specPhase(args, workItemId, firstAttemptOf(args));
  }
  // A small, bug or doc item the pipeline triaged earlier and has no Spec: the short Spec again, from the issue as it reads now.
  if (loaded.mode === "light") {
    const gate = await startGatePhase(args, workItemId, { mode: "light", category: loaded.category, cameInAs: null });
    return gate ?? lightPhase(args, workItemId, { category: loaded.category, title: loaded.title, body: loaded.body }, firstAttemptOf(args));
  }

  let category: string;
  if (loaded.decided !== null) {
    // A label a trusted actor applied decided it: no run, no spend. The log line is the record.
    category = loaded.decided;
    await advanceLogStep("advance.label_decided", { work_item_id: workItemId, category });
  } else {
    const asked = await askUntilAllowed(args, "classify", workItemId, firstAttemptOf(args), (n) => advanceStartClassifyStep(accountId, workItemId, args.haltEpoch, actionId, loaded, n > 0 ? n : undefined), (r) => (r.ok ? null : r.reason));
    const started = asked.answer;
    if (!started.ok) {
      if (asked.pause !== null) return pausedEnd(workItemId, "classify", asked.pause, asked.attempt);
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
      // The run is stopped, not left to a runner that keeps answering its heartbeat: only a cancelled run is fenced (409) at the next one, so the runner ends its work.
      await advanceCancelStep(accountId, args.userId, workItemId, outcome.tailRunId ?? started.runId);
      await advanceLogStep("advance.failed", { work_item_id: workItemId, run_id: outcome.tailRunId ?? started.runId, at: "classify_wait", reason: "wait_timeout" });
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

  // The category the item came in as: one trusted label that named a small kind (bug, documentation, docs, small), and no trusted label asking for urgency. A label that
  // DECIDED the category leaves no hint, and nothing was reclassified. The names repeat packages/pipeline's DECISIVE_LABELS and ESCALATING_LABELS (a workflow imports no value).
  const labelKinds = new Set(loaded.hints.map((h) => h.toLowerCase()).map((h) => (h === "bug" ? "bug" : h === "documentation" || h === "docs" || h === "doc" ? "doc" : h === "small" ? "small" : "")).filter((k) => k !== ""));
  const urgent = loaded.hints.some((h) => ["critical", "urgent", "blocker", "security"].includes(h.toLowerCase()));
  const cameInAs: string | null = labelKinds.size === 1 && !urgent ? [...labelKinds][0]! : null;

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
    // An item that came in small, bug or doc (a trusted label said so) and that triage found larger is asked before the panel runs, click or not.
    if (cameInAs !== null && (triaged.category === "feature" || triaged.category === "critical")) {
      const gate = await startGatePhase(args, triaged.workItemId, { mode: "triage_end", category: triaged.category, cameInAs });
      if (gate !== null) return gate;
    }
    return specPhase(args, triaged.workItemId, 0);
  }
  // Small, bug and doc run no panel: the project manager writes a short Spec straight from the issue, then the build.
  if (triaged.status === "triaged" && triaged.stage === "triaged" && triaged.workItemId && (triaged.category === "small" || triaged.category === "bug" || triaged.category === "doc")) {
    const gate = await startGatePhase(args, triaged.workItemId, { mode: "triage_end", category: triaged.category, cameInAs });
    if (gate !== null) return gate;
    return lightPhase(args, triaged.workItemId, { category: triaged.category, title: loaded.title, body: loaded.body }, 0);
  }
  // A question stays at Triaged, answered in its thread.
  return { status: triaged.status, detail: triaged.reason };
}

/** The panel, then the Spec, for the pipeline's root item. Ends at Spec ready, or with the pipeline's own outcome. */
async function specPhase(args: AdvanceStartArgs, rootId: string, firstAttempt: number): Promise<Result> {
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

  // D#483 S5-k1e: a seat's start can be denied by a spending limit; the step then answers the pause as its refusal (the seats that posted stay posted) and is asked again,
  // which starts only the seats that were denied. After four hours the workflow ends `panel_paused:<pause>` and the sweep takes over.
  const panelAsk = await askUntilAllowed(args, "panel", rootId, firstAttemptOf(args), () => reenter(() => advancePanelStep(accountId, userId, rootId, args.haltEpoch)), (r) => (r.status === "refused" ? r.reason : null));
  const panel = panelAsk.answer;
  if (panelAsk.pause !== null) return pausedEnd(rootId, "panel", panelAsk.pause, panelAsk.attempt);
  // D#483 S5-k1e: the panel waited on a limit (this run's own waits, or a restart by the sweep) and no limit holds it now, whatever comes of the Spec. The fact is also written
  // when a sweep restart passes through the panel without it having waited (a spec or classify restart) and when the panel answered failed or halted; that is harmless, since
  // any later pause writes a newer waiting fact. Without a fact after the
  // last wait the sweep would restart a whole panel on every pass whenever the Spec step then ends without a stop (needs_owner_action, spec_too_large). The code is
  // packages/pipeline PANEL_WHOLE_CODE (a test holds the two equal); the panel entry lists `stopped` among its progress kinds.
  if (firstAttemptOf(args) > 0 || panelAsk.attempt > firstAttemptOf(args)) await advanceEventStep(accountId, userId, rootId, { kind: "stopped", dedupeKey: `panel_whole:${actionId}:${panelAsk.attempt}`, code: "panel_whole" });
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
  if (panel.status === "waiting" && panel.reason === QUEUED_ON_RUNNER) await advanceCancelStepRunsStep(accountId, userId, rootId, "panel", actionId);
  if (panel.status !== "completed") return { status: "failed", detail: panel.status === "waiting" && panel.reason === QUEUED_ON_RUNNER ? "panel_wait_timeout" : `panel_${panel.status}:${panel.reason ?? "none"}` };

  // D#483 S5-k1c: the PM's start can be denied by a spending limit; the Spec step then answers the pause as its refusal and is asked again.
  const specAsk = await askUntilAllowed(args, "spec", rootId, firstAttempt, (n) => reenter(() => advanceSpecStep(accountId, userId, rootId, args.haltEpoch, actionId, n > 0 ? n : undefined)), (r) => (r.status === "refused" ? r.reason : null));
  const spec = specAsk.answer;
  if (specAsk.pause !== null) return pausedEnd(rootId, "spec", specAsk.pause, specAsk.attempt);
  if (spec.status === "waiting" && spec.reason === QUEUED_ON_RUNNER) {
    // Still queued when the ceiling was reached: the pipeline's own wait limit, like every other wait here. The PM's run (and any panel run still live) is stopped, not left to a runner that claims it later.
    // (The Spec step re-enters the panel, so a panel seat may be the live run.)
    await advanceCancelStepRunsStep(accountId, userId, rootId, "spec", actionId);
    await advanceCancelStepRunsStep(accountId, userId, rootId, "panel", actionId);
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
async function lightPhase(args: AdvanceStartArgs, rootId: string, issue: { category: string; title: string; body: string }, firstAttempt: number): Promise<Result> {
  const { accountId, userId, actionId } = args;
  const asked = await askUntilAllowed(args, "spec", rootId, firstAttempt, (n) => advanceStartLightSpecStep(accountId, userId, rootId, args.haltEpoch, issue, actionId, n > 0 ? n : undefined), (r) => (r.ok ? null : r.reason));
  const started = asked.answer;
  if (!started.ok) {
    if (asked.pause !== null) return pausedEnd(rootId, "spec", asked.pause, asked.attempt);
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
  // The build asks from its own first attempt: a restart attempt of the short Spec's start is not the build's.
  const { startAttempt: _spent, ...forBuild } = args;
  return buildPhase({ ...forBuild, workItemId: rootId }, published.version);
}

/**
 * Re-spec (D#6 R4d-5b, C34 section 2.3), for an item at Spec ready or Needs a person whose newest Spec has no readable file list. The project manager runs in
 * file-list mode on the Spec version the person saw; its list is validated and the next version is published (the same text plus the list). From Needs a person
 * the publish also moves the item to Spec ready, in its own transaction. Nothing is built: the person presses Build again. A list that cannot be read publishes
 * nothing and is recorded as a fact of the item (the card's notice says so).
 */
async function respecPhase(args: AdvanceStartArgs): Promise<Result> {
  const { accountId, userId, workItemId, actionId } = args;
  const version = args.specVersion ?? null;
  const asked = await askUntilAllowed(args, "respec", workItemId, firstAttemptOf(args), (n) => advanceStartRespecStep(accountId, userId, workItemId, args.haltEpoch, version, actionId, n > 0 ? n : undefined), (r) => (r.ok ? null : r.reason));
  const started = asked.answer;
  if (!started.ok) {
    if (asked.pause !== null) return pausedEnd(workItemId, "respec", asked.pause, asked.attempt);
    if (isHaltReason(started.reason)) return haltedEnd(args, "respec_start");
    await advanceLogStep("advance.failed", { work_item_id: workItemId, at: "respec_start", reason: started.reason });
    return { status: "failed", detail: `respec_refused:${started.reason}` };
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
    await advanceCancelStep(accountId, userId, workItemId, outcome.tailRunId);
    await advanceLogStep("advance.stopped", { work_item_id: workItemId, at: "respec", reason: "wait_timeout" });
    return { status: "respec_failed", detail: "wait_timeout" };
  }
  if (outcome.status !== "succeeded") {
    await advanceLogStep("advance.stopped", { work_item_id: workItemId, at: "respec", reason: `run_${outcome.status}` });
    return { status: "respec_failed", detail: `run_${outcome.status}` };
  }
  const published = await advanceRespecPublishStep(accountId, userId, workItemId, args.haltEpoch, started.runId, actionId, version as number);
  if (isHaltReason(published.reason)) return haltedEnd(args, "respec");
  if (published.status !== "published") {
    await advanceLogStep("advance.stopped", { work_item_id: workItemId, at: "respec", reason: published.reason ?? "refused" });
    return { status: "respec_refused", detail: published.reason ?? undefined };
  }
  await advanceLogStep("advance.respec_published", { work_item_id: workItemId, at: "respec", version: published.version });
  return { status: "respec_published" };
}

/**
 * Build again, for an item at Needs a person that still has its Spec. The sandbox executor's branch is `fx/issue-<n>` (a runner run's pull request is the one its run recorded), and a pull
 * request still open for it is somebody's work in review (the review stage handed the item over, or a person opened one): a
 * fresh build would replace its branch under it. So the driver looks first. Open: it stops with a recorded code and starts
 * nothing (close that pull request on GitHub, then press the button again). None open: the build, exactly as for Spec ready
 * but from `needs_human` (its own run key, so the failed run is never reused). A lookup that failed decides nothing: it stops
 * too, since a build must not start on a guess.
 */
async function rebuildPhase(args: AdvanceStartArgs, pinned: number | null, repo: Pick<ReviewCtx, "repoId" | "owner" | "name" | "issue" | "executionMode" | "prExecutionMode" | "recordedPr">, reviewHold = false): Promise<Result> {
  const found = await advanceFindPrStep(repo);
  // A reviewer kept ending without a verdict and the pull request is still open: the person pressed Approve to review it again (the reviewers check its latest commit).
  if (found.ok && reviewHold) return reviewPhase(args, pinned);
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

  // D#483 S5-k1b: a restart by the parked-stage sweep begins at the next unused attempt, never the unsuffixed key (that key's run is the first `refused_spend` one).
  let spendAttempt = Number.isSafeInteger(args.startAttempt) && args.startAttempt! > 0 ? args.startAttempt! : 0;
  let started: StepOutcome =
    args.resumeRunId !== undefined
      ? { status: "started", reason: null, stage: null, version: null, complete: null, missing: null, runId: args.resumeRunId }
      : await advanceBuildStep(accountId, userId, workItemId, args.haltEpoch, actionId, pinned, spendAttempt > 0 ? spendAttempt : undefined);
  // Three waits, each with its own bound. A reaper claim on the sandbox: a few backoffs. No build slot (the person's concurrency setting, D#483 S5-c1): the
  // item stays at Spec ready and asks again every minute, up to four hours (as many polls as the run wait below already makes in one workflow, so no new event-count risk); a start that finds no slot has run nothing and spent nothing. A halt or any other
  // refusal ends the loop at once.
  let reapingTries = 0;
  let slotWaitedMs = 0;
  let lastSlotReason: string | null = null;
  // S5-k1: a spending limit denied the run. The item stays at Spec ready; every ask after the first is attempt 1, 2, ... (the run key).
  let spendWaitedMs = 0;
  let lastSpendReason: string | null = null;
  for (;;) {
    if (started.reason === BUILD_REAPING_REASON && reapingTries < BUILD_REAPING_BACKOFF_MS.length) {
      await advanceLogStep("advance.build_waiting", { work_item_id: workItemId, at: "build_start", reason: "sandbox_reaping", attempt: reapingTries + 1 });
      await sleep(BUILD_REAPING_BACKOFF_MS[reapingTries]!);
      reapingTries++;
    } else if (started.reason !== null && BUILD_SLOT_WAIT_REASONS.includes(started.reason) && slotWaitedMs < BUILD_SLOT_WAIT_MS) {
      // Logged when the reason first appears or changes, not on every poll: the poll itself leaves the liveness fact (the worker's `build_waiting` event).
      if (started.reason !== lastSlotReason) await advanceLogStep("advance.build_waiting", { work_item_id: workItemId, at: "build_start", reason: started.reason });
      lastSlotReason = started.reason;
      await sleep(BUILD_SLOT_POLL_MS);
      slotWaitedMs += BUILD_SLOT_POLL_MS;
    } else if (started.reason !== null && RESERVATION_PAUSE_REASONS.includes(started.reason) && spendWaitedMs < BUILD_SPEND_WAIT_MS) {
      if (started.reason !== lastSpendReason) await advanceLogStep("advance.build_waiting", { work_item_id: workItemId, at: "build_start", reason: started.reason });
      lastSpendReason = started.reason;
      await sleep(BUILD_SPEND_POLL_MS);
      spendWaitedMs += BUILD_SPEND_POLL_MS;
      spendAttempt++;
    } else break;
    started = await advanceBuildStep(accountId, userId, workItemId, args.haltEpoch, actionId, pinned, spendAttempt > 0 ? spendAttempt : undefined);
  }
  if (isHaltReason(started.reason)) return haltedEnd(args, "build_start");
  // D#483 S5-k1b: the four hours are up and a spending limit still denies the start. That is not a failure: the item stays at Spec ready with its approval, nothing is
  // stamped, and the parked-stage sweep (every 15 minutes) starts the build again, with no person, when the limit allows it. Any other refusal ends as it did.
  if (started.status !== "started" && started.reason !== null && RESERVATION_PAUSE_REASONS.includes(started.reason)) {
    await advanceLogStep("advance.paused", { work_item_id: workItemId, at: "build_start", reason: started.reason, attempt: spendAttempt });
    return { status: "paused", detail: `build_paused:${started.reason}` };
  }
  if (started.status !== "started" || started.runId === null) {
    // Nothing was spent and the item did not move: it stays at Spec ready, where it can be approved again. The refusal is
    // recorded as a fact of the item (by the worker).
    await advanceLogStep("advance.failed", { work_item_id: workItemId, at: "build_start", status: started.status, reason: started.reason });
    return { status: "failed", detail: `build_refused:${started.reason ?? "none"}` };
  }
  let runId = started.runId;
  await advanceLogStep("advance.build_started", { work_item_id: workItemId, run_id: runId });

  let waited = 0;
  let outcome = await advanceBuildOutcomeStep(accountId, runId);
  let pendingWaited = 0;
  for (let restarts = 0; ; restarts++) {
    while (!outcome.done && waited < BUILD_WAIT_MS && pendingWaited < RUNNER_PENDING_CEILING_MS) {
      const queued = outcome.queuedOnRunner;
      await sleep(BUILD_POLL_MS);
      if (queued) pendingWaited += BUILD_POLL_MS;
      else waited += BUILD_POLL_MS;
      outcome = await advanceBuildOutcomeStep(accountId, runId);
    }
    // D#599 PL-2: the run was queued on a side the item has left. The same step starts again on the new side; the wait goes on with that run.
    if (outcome.done && outcome.failureReason === PLACEMENT_CHANGED && restarts < PLACEMENT_RESTARTS_MAX && args.resumeRunId === undefined) {
      const again = await advanceBuildStep(accountId, userId, workItemId, args.haltEpoch, actionId, pinned, spendAttempt > 0 ? spendAttempt : undefined);
      if (again.status === "started" && again.runId !== null && again.runId !== runId) {
        await advanceLogStep("advance.build_restarted", { work_item_id: workItemId, from_run_id: runId, run_id: again.runId, reason: PLACEMENT_CHANGED });
        runId = again.runId;
        outcome = await advanceBuildOutcomeStep(accountId, runId);
        continue;
      }
    }
    break;
  }
  // D#2 H14c-3-3b-2: a build that ended at a limit is continued (or parked with its reason) before any failure is recorded.
  {
    const next = await continueLimitEnds(args, runId, outcome);
    if ("end" in next) return next.end;
    runId = next.runId;
    outcome = next.outcome;
  }
  // D#6 R-CHK-3 (C47): a run whose approved check failed has no pull request, and its work is on the run branch. Each fix round resumes it and is waited for like the build;
  // the worker refuses a round past the plan's `maxFixRounds()` (`escalated`), and the item then goes to Needs human. Bounded here as well, so the loop cannot run on.
  for (let round = 1; round <= CHECK_FIX_ROUNDS_CEILING && outcome.done && outcome.status === "failed" && outcome.failureReason === "check_failed"; round++) {
    const fix = await advanceCheckFixStep(accountId, userId, workItemId, args.haltEpoch, outcome.tailRunId);
    if (fix.status === "escalated") {
      const recorded = await advanceBuildFailedStep(accountId, workItemId, outcome.tailRunId, "check_rounds_used");
      await buildStopped(args, outcome.tailRunId, "build_check_rounds_used");
      await advanceLogStep("advance.failed", { work_item_id: workItemId, run_id: runId, at: "check_fix", reason: "check_rounds_used", recorded: recorded.status });
      return { status: "failed", detail: "build_check_rounds_used" };
    }
    // D#6 FU-CHECK-CROSS-SIDE-BRANCH: the round could not tell which branch to continue. Needs human under its own word (the card says why), not as a generic failed run.
    // FIXROUND-REFRESH-HEAD: the same for a paired public branch changed outside the cloud, or one GitHub could not read (nothing was started; the card gives
    // the fixed sentence of each). FIXROUND-BASE-SYNC: and for a branch that conflicts with its base, or could not be brought up to date with it.
    // And for a check that failed only in test files the change did not touch: a fix round cannot repair that, so the worker refuses to start one and no attempt is spent.
    if (fix.reason === "check_fix_branch_unknown" || fix.reason === "public_branch_moved" || fix.reason === "public_head_unavailable" || fix.reason === "base_sync_conflict" || fix.reason === "base_sync_unavailable" || fix.reason === "republish_base_missing" || fix.reason === "republish_stacked_unsupported" || fix.reason === "check_failed_outside_change") {
      const stop = fix.reason === "check_fix_branch_unknown" ? "build_check_fix_branch_unknown" : fix.reason;
      const recorded = await advanceBuildFailedStep(accountId, workItemId, outcome.tailRunId, fix.reason);
      await buildStopped(args, outcome.tailRunId, stop);
      await advanceLogStep("advance.failed", { work_item_id: workItemId, run_id: runId, at: "check_fix", reason: fix.reason, recorded: recorded.status });
      return { status: "failed", detail: stop };
    }
    if (fix.runId === null) break;
    runId = fix.runId;
    await advanceLogStep("advance.check_fix_started", { work_item_id: workItemId, run_id: runId, round });
    waited = 0;
    pendingWaited = 0;
    outcome = await advanceBuildOutcomeStep(accountId, runId);
    while (!outcome.done && waited < BUILD_WAIT_MS && pendingWaited < RUNNER_PENDING_CEILING_MS) {
      const queued = outcome.queuedOnRunner;
      await sleep(BUILD_POLL_MS);
      if (queued) pendingWaited += BUILD_POLL_MS;
      else waited += BUILD_POLL_MS;
      outcome = await advanceBuildOutcomeStep(accountId, runId);
    }
    // D#2 H14c-3-3b-2: the same for a check fix round that ended at a limit.
    const next = await continueLimitEnds(args, runId, outcome);
    if ("end" in next) return next.end;
    runId = next.runId;
    outcome = next.outcome;
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

  // D#7 DP4b-2: a succeeded run may have asked a question or reported decisions. A question parks the item (this workflow ends, the stage stays); the rest carries on.
  const decision = await advanceDecisionStep(accountId, userId, workItemId, args.haltEpoch, outcome.tailRunId);
  if (isHaltReason(decision)) return haltedEnd(args, "decision");
  if (decision === "parked") return waitingOnAnswer(args, outcome.tailRunId);

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
  // The review asks from its own first attempt: a restart attempt of the build's start is not the reviewers'.
  if (stage === "pr_opened" || stage === "changes_requested" || stage === "review_passed") {
    const forReview: AdvanceStartArgs = { ...args };
    delete forReview.startAttempt;
    delete forReview.startRereview;
    return reviewPhase(forReview, pinned);
  }
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
  const ctx: ReviewCtx = { repoId: loaded.repoId, owner: loaded.owner, name: loaded.name, issue: loaded.issue, tier: loaded.tier, specVersion: loaded.specVersion, debaterEnabled: loaded.debaterEnabled, executionMode: loaded.executionMode, recordedPr: loaded.recordedPr, prExecutionMode: loaded.prExecutionMode };
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
  const ctx: ReviewCtx = { repoId: loaded.repoId, owner: loaded.owner, name: loaded.name, issue: loaded.issue, tier: loaded.tier, specVersion: loaded.specVersion, debaterEnabled: loaded.debaterEnabled, executionMode: loaded.executionMode, recordedPr: loaded.recordedPr, prExecutionMode: loaded.prExecutionMode };
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
async function buildStopped(args: AdvanceStartArgs, runId: string | null, code: string, reasons: string[] = []): Promise<void> {
  await advanceEventStep(args.accountId, args.userId, args.workItemId, { kind: "stopped", dedupeKey: `build:${runId ?? args.actionId}`, code: code.replace(/[^a-z0-9_]/g, "_").slice(0, 64), ...(reasons.length === 0 ? {} : { reasons }), ...(runId === null ? {} : { runId }) });
}

/**
 * D#2 H14c-3-3b-2 (C88 R1, section 3): an executor run the workflow waits on (the build, a check fix round, a review fix round) that ended at a limit is
 * continued, or parked with a fixed reason, before any failure is recorded. `outcome` is the run's end as the caller read it. Answers the run to carry on
 * with and how it stands (the caller's own handling follows: a child that is still running when its wait runs out ends like any run whose wait ran
 * out), or the end of the workflow. A result `today` (and anything the step does not name) hands the outcome back unchanged, so the caller records the failure exactly as
 * it did before continuation existed.
 *
 * Bounded three ways: at most `MAX_CONTINUATIONS_PER_WORK_ITEM + 1` looks in one workflow, the step's own count of stored automatic continuations (the cap that
 * survives a restarted workflow), and the database's one live continuation per parent. A busy answer is slept on at most three times.
 * C88 R5 / the run-extension dial seam: the worker step is the one place that decides whether a limit end continues on its own; the dial of H14c-5c-3 joins there, not here.
 */
async function continueLimitEnds(args: AdvanceStartArgs, startRunId: string, startOutcome: BuildRunOutcome): Promise<{ runId: string; outcome: BuildRunOutcome } | { end: Result }> {
  const { accountId, userId, workItemId, haltEpoch } = args;
  let runId = startRunId;
  let outcome = startOutcome;
  for (let looks = 0; looks <= MAX_CONTINUATIONS_PER_WORK_ITEM && outcome.done && LIMIT_END_STATUSES.includes(outcome.status); looks++) {
    let step = await advanceContinueStep(accountId, userId, workItemId, haltEpoch, outcome.tailRunId);
    for (let busy = 0; step.code === "busy" && busy < CONTINUE_BUSY_RETRIES; busy++) {
      await sleep(CONTINUE_BUSY_SLEEP_MS);
      step = await advanceContinueStep(accountId, userId, workItemId, haltEpoch, outcome.tailRunId);
    }
    if ((step.code === "continued" || step.code === "duplicate") && step.runId !== null && step.runId !== outcome.tailRunId) {
      await advanceLogStep("advance.continued", { work_item_id: workItemId, from_run_id: outcome.tailRunId, run_id: step.runId, replay: step.code === "duplicate" });
      runId = step.runId;
      outcome = await waitForExecutorRun(accountId, runId);
      continue;
    }
    if (step.code === "parked" && step.parkedAs !== null) {
      const monthly = step.parkedAs === "monthly_budget_reached";
      // C7's park already wrote the move to Needs a person; only the card's fact and the end are ours.
      await buildStopped(args, outcome.tailRunId, monthly ? "monthly_budget_parked" : "run_limit_parked", monthly ? [] : [step.parkedAs]);
      await advanceLogStep("advance.failed", { work_item_id: workItemId, run_id: runId, at: "build", reason: "run_limit_parked", parked_as: step.parkedAs });
      return { end: { status: "failed", detail: `build_parked:${step.parkedAs}` } };
    }
    if (step.code === "work_item_closed") return { end: { status: "failed", detail: "build_item_closed" } };
    if (step.code === "waiting_on_answer") return { end: await waitingOnAnswer(args, outcome.tailRunId) };
    if (step.code === "halted") return { end: await haltedEnd(args, "continue") };
    break;
  }
  return { runId, outcome };
}

/** The wait for one executor run the workflow did not start itself (a continuation): the same poll and the same two budgets as the build's, counted afresh for this run. */
async function waitForExecutorRun(accountId: string, runId: string): Promise<BuildRunOutcome> {
  let waited = 0;
  let pendingWaited = 0;
  let outcome = await advanceBuildOutcomeStep(accountId, runId);
  while (!outcome.done && waited < BUILD_WAIT_MS && pendingWaited < RUNNER_PENDING_CEILING_MS) {
    const queued = outcome.queuedOnRunner;
    await sleep(BUILD_POLL_MS);
    if (queued) pendingWaited += BUILD_POLL_MS;
    else waited += BUILD_POLL_MS;
    outcome = await advanceBuildOutcomeStep(accountId, runId);
  }
  return outcome;
}

interface Verdict {
  role: string;
  runId: string;
  verdict: string;
  securityNeeded: boolean;
  environmentFailure: boolean;
  /** The reviewer could not verify some criteria in its environment: its `fail` is not a judgment of the code, and no fix round comes of it. */
  unverifiable: boolean;
  /** The run ended without a verdict (it failed, was cancelled, ran out of time, or left none): its `fail` is not a judgment. */
  noVerdict: boolean;
  endCode: string | null;
}

/** Waits for one reviewer run. A run still going when the wait ends is cancelled: it has no verdict (a review that could not finish is never a pass, and never a fail either). */
async function waitForReviewer(accountId: string, userId: string, workItemId: string, role: string, firstRunId: string, restart: () => Promise<string | null>): Promise<Verdict> {
  let runId = firstRunId;
  let waited = 0;
  let out = await advanceReviewerOutcomeStep(accountId, runId);
  let pendingWaited = 0;
  for (let restarts = 0; ; restarts++) {
    while (!out.done && waited < REVIEW_WAIT_MS && pendingWaited < RUNNER_PENDING_CEILING_MS) {
      const queued = out.queuedOnRunner;
      await sleep(REVIEW_POLL_MS);
      if (queued) pendingWaited += REVIEW_POLL_MS;
      else waited += REVIEW_POLL_MS;
      out = await advanceReviewerOutcomeStep(accountId, runId);
    }
    // D#599 PL-2: the run was queued on a side the item has left; the same review starts again on the new side (keyed by the worker) and is waited for here.
    if (out.done && out.failureReason === PLACEMENT_CHANGED && restarts < PLACEMENT_RESTARTS_MAX) {
      const again = await restart();
      if (again !== null && again !== runId) {
        await advanceLogStep("advance.review_restarted", { work_item_id: workItemId, from_run_id: runId, run_id: again, role, reason: PLACEMENT_CHANGED });
        runId = again;
        out = await advanceReviewerOutcomeStep(accountId, runId);
        continue;
      }
    }
    break;
  }
  if (!out.done) {
    await advanceCancelStep(accountId, userId, workItemId, out.tailRunId);
    await advanceLogStep("advance.review_wait_timeout", { work_item_id: workItemId, run_id: runId, role });
    return { role, runId, verdict: "fail", securityNeeded: false, environmentFailure: false, unverifiable: false, noVerdict: true, endCode: "wait_timeout" };
  }
  return { role, runId, verdict: out.verdict, securityNeeded: out.securityNeeded, environmentFailure: out.environmentFailure, unverifiable: out.unverifiable === true, noVerdict: out.noVerdict === true, endCode: out.endCode ?? null };
}

/**
 * One reviewer, waited for until it gives a verdict. A run that ends without one (killed at a memory limit, a lost runner, cancelled, out of time) is never
 * used as a verdict: the reviewer is started again on the same head under a new attempt key, until its runs have ended that way as many times as the
 * re-run step allows (the fix-round limit). Then the entry goes back marked `noVerdict` and the round hands the item to a person. A spending limit that
 * denies a re-run is a pause, like any reviewer start's.
 */
async function reviewUntilVerdict(args: AdvanceStartArgs, ctx: ReviewCtx, pr: { number: number; headSha: string; baseRef: string; branch: string }, role: string, firstRunId: string, prior: Array<{ role: string; runId: string }>, rereview: number, attemptOf: Map<string, number>): Promise<{ verdict: Verdict; pause: { pause: string; attempt: number } | null }> {
  const { accountId, userId, workItemId } = args;
  let runId = firstRunId;
  for (let ends = 1; ; ends++) {
    const v = await waitForReviewer(accountId, userId, workItemId, role, runId, async () => (await advanceStartReviewerStep(accountId, userId, workItemId, args.haltEpoch, ctx, pr, role, prior, rereview, (attemptOf.get(role) ?? 0) > 0 ? attemptOf.get(role) : undefined)).runId);
    if (!v.noVerdict) return { verdict: v, pause: null };
    const next = await advanceReviewRerunStep(accountId, userId, workItemId, args.haltEpoch, pr.headSha, rereview, role, ends);
    if (!next.rerun) {
      await advanceLogStep("advance.review_no_verdict", { work_item_id: workItemId, role, run_id: v.runId, reason: v.endCode, ends });
      return { verdict: v, pause: null };
    }
    const again = await advanceStartReviewerStep(accountId, userId, workItemId, args.haltEpoch, ctx, pr, role, prior, rereview, next.attempt);
    const pause = pauseOf(again.reason);
    if (pause !== null) {
      await waitOnHead(args, "review", pause, next.attempt, pr, rereview);
      return { verdict: v, pause: { pause, attempt: next.attempt } };
    }
    // A start that did not give a NEW run cannot be waited for again: the round goes to a person with this reviewer's missing verdict.
    if (again.runId === null || again.runId === runId) {
      await advanceLogStep("advance.review_no_verdict", { work_item_id: workItemId, role, run_id: v.runId, reason: again.reason ?? v.endCode, ends });
      return { verdict: v, pause: null };
    }
    await advanceLogStep("advance.review_rerun", { work_item_id: workItemId, role, from_run_id: runId, run_id: again.runId, reason: v.endCode, ends });
    attemptOf.set(role, next.attempt);
    runId = again.runId;
  }
}

/**
 * D#483 S5-k1d: a wait fact of a review or a fix round. Besides the pause and the attempt it carries the head, the pull request and the re-review round the ask was
 * for, so the sweep resumes only while that head is still the head, and restarts the review at the round it was in.
 */
async function waitOnHead(args: AdvanceStartArgs, stage: "review" | "fix_round", pause: string, attempt: number, pr: { number: number; headSha: string }, rereview: number): Promise<void> {
  await advanceEventStep(args.accountId, args.userId, args.workItemId, {
    kind: "stage_waiting",
    stage,
    code: pause,
    attempt,
    dedupeKey: `wait:${stage}:${pr.headSha}:${rereview}:${attempt}`,
    headSha: pr.headSha,
    prNumber: pr.number,
    round: rereview,
  });
}

/**
 * Starts the given roles in parallel (each keyed by head and role) and waits for each; a role that could not start has no verdict.
 *
 * D#483 S5-k1d: a reviewer a spending limit denied is a wait, not a refusal. The roles that started keep running; only the denied ones are asked again (five minutes
 * later, each ask a new attempt with its own key), for up to four hours. Reviewer runs of this head and round that already exist (an earlier ask of this review, or a
 * restart of it by the sweep) are used as they are and never asked for again. After the four hours a pause is still the answer: the caller ends `review_paused:<pause>`,
 * which is no failure, and the sweep starts the review again when the limit allows it.
 */
async function runReviewers(args: AdvanceStartArgs, ctx: ReviewCtx, pr: { number: number; headSha: string; baseRef: string; branch: string }, roles: string[], prior: Array<{ role: string; runId: string }>, round: number, rereview = 0): Promise<{ verdicts: Verdict[]; refused: string[]; refusedWhy: Record<string, string>; paused: { pause: string; attempt: number } | null }> {
  const { accountId, userId, workItemId } = args;
  const answers = new Map<string, StartedReviewer>();
  const attemptOf = new Map<string, number>();
  for (const k of await advanceReviewRunsStep(accountId, userId, workItemId, args.haltEpoch, pr.headSha, rereview)) if (roles.includes(k.role)) answers.set(k.role, { role: k.role, runId: k.runId, reason: null });
  let attempt = firstAttemptOf(args);
  let waited = 0;
  let pending = roles.filter((r) => !answers.has(r));
  for (;;) {
    const asked = await Promise.all(
      pending.map((role) => {
        attemptOf.set(role, attempt);
        return advanceStartReviewerStep(accountId, userId, workItemId, args.haltEpoch, ctx, pr, role, prior, rereview, attempt > 0 ? attempt : undefined);
      }),
    );
    for (const a of asked) answers.set(a.role, a);
    const denied = asked.filter((a) => a.runId === null && pauseOf(a.reason) !== null);
    if (denied.length === 0) break;
    const pause = pauseOf(denied[0]!.reason) as string;
    await waitOnHead(args, "review", pause, attempt, pr, rereview);
    if (waited >= BUILD_SPEND_WAIT_MS) return { verdicts: [], refused: [], refusedWhy: {}, paused: { pause, attempt } };
    if (waited === 0) await advanceLogStep("advance.stage_waiting", { work_item_id: workItemId, at: "review_start", reason: pause });
    await sleep(BUILD_SPEND_POLL_MS);
    waited += BUILD_SPEND_POLL_MS;
    attempt += 1;
    pending = denied.map((d) => d.role);
  }
  const started = roles.map((role) => answers.get(role) as StartedReviewer);
  await advanceLogStep("advance.review_started", {
    work_item_id: workItemId,
    round,
    rereview,
    pr: pr.number,
    head: pr.headSha.slice(0, 12),
    started: started.filter((s) => s.runId !== null).map((s) => s.role).join(","),
    refused: started.filter((s) => s.runId === null).map((s) => `${s.role}:${s.reason ?? "none"}`).join(","),
  });
  const verdicts: Verdict[] = [];
  for (const s of started) {
    if (s.runId !== null) {
      const got = await reviewUntilVerdict(args, ctx, pr, s.role, s.runId, prior, rereview, attemptOf);
      if (got.pause !== null) return { verdicts: [], refused: [], refusedWhy: {}, paused: got.pause };
      verdicts.push(got.verdict);
    }
  }
  // Who was refused, and the worker's closed reason for each (a role setting, the runner's daily limit, ...): the stop's code names the reason, so the card and Needs you can say it.
  const refusedWhy: Record<string, string> = {};
  for (const s of started) if (s.runId === null && s.reason !== null && s.reason !== undefined) refusedWhy[s.role] = s.reason;
  return { verdicts, refused: started.filter((s) => s.runId === null).map((s) => s.role), refusedWhy, paused: null };
}

/**
 * D#483 S5-k1d: the executor's fix round start, asked until a spending limit allows it. The first ask is attempt `firstAttempt`; while a limit denies it the pull request
 * stays where it is, each denied ask leaves the stage's wait fact on the head, and the next ask (five minutes later, up to four hours) is a new attempt with its own key.
 * Any answer that is not a limit pause (a start, a halt, any other refusal) ends the wait and is returned as it came.
 */
async function askFixUntilAllowed(args: AdvanceStartArgs, ctx: ReviewCtx, pr: { number: number; headSha: string; branch: string }, round: number, failing: Array<{ role: string; runId: string }>, rereview: number, person = false): Promise<{ fix: FixOut; attempt: number; pause: string | null }> {
  const { accountId, userId, workItemId, actionId } = args;
  let attempt = firstAttemptOf(args);
  let waited = 0;
  for (;;) {
    const fix = await advanceStartFixStep(accountId, userId, workItemId, args.haltEpoch, ctx, pr, actionId, round, failing, rereview, attempt > 0 ? attempt : undefined, person);
    const pause = fix.ok ? null : pauseOf(fix.reason);
    if (pause === null) return { fix, attempt, pause: null };
    await waitOnHead(args, "fix_round", pause, attempt, pr, rereview);
    if (waited >= BUILD_SPEND_WAIT_MS) return { fix, attempt, pause };
    if (waited === 0) await advanceLogStep("advance.stage_waiting", { work_item_id: workItemId, at: "fix_start", reason: pause });
    await sleep(BUILD_SPEND_POLL_MS);
    waited += BUILD_SPEND_POLL_MS;
    attempt += 1;
  }
}

/** The two answers a step gives when the item was halted: still halted, or halted and resumed since this workflow started. */
const isHaltReason = (reason: string | null | undefined): boolean => reason === "item_halted" || reason === "halted_since_approval";

/** A halt ends this workflow with one recorded stop. It never retries and never polls: only a person's later approval starts a new one. */
async function haltedEnd(args: AdvanceStartArgs, at: string): Promise<Result> {
  await stopped(args, at, "halted");
  return { status: "stopped", detail: "halted" };
}

/** D#7 DP4b-2: the run asked a question that waits for a person. One `stopped` fact, then this workflow ends: it does not poll and does not retry. The stage is unchanged. */
async function waitingOnAnswer(args: AdvanceStartArgs, runId: string): Promise<Result> {
  await advanceLogStep("advance.stopped", { work_item_id: args.workItemId, at: "decision", reason: "waiting_on_answer", run_id: runId });
  await advanceEventStep(args.accountId, args.userId, args.workItemId, { kind: "stopped", dedupeKey: `decision:${runId}`, code: "waiting_on_answer", runId });
  return { status: "stopped", detail: "waiting_on_answer" };
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
 * D#6 R5b-2a (body R5b.4): waits out a cloud-verified pull request's quiet period. Each pass reads the head from GitHub again and asks the worker
 * whether the reviewers may start on it; a push in between (seen by the webhook, or by the head having moved) restarts the ten minutes. Answers the
 * head and context to review, or the end of the workflow: no key (`review_key_missing`, the gate's recorded reason; a later press of Approve
 * or Check the build reviews the current head once a key is connected again), or a repository that left the mode (it is reviewed the way its new
 * mode is: the context is loaded again and the normal path goes on).
 */
async function awaitVerifiedQuiet(args: AdvanceStartArgs, ctx: ReviewCtx, first: PrFound, pinned: number | null): Promise<{ ctx: ReviewCtx; found: PrFound } | { end: Result }> {
  const { accountId, userId, workItemId } = args;
  let found = first;
  let seen: string | null = null;
  for (let i = 0; i < MAX_QUIET_CHECKS; i++) {
    const gate = await advanceVerifiedGateStep(accountId, userId, workItemId, args.haltEpoch, { number: found.number, headSha: found.headSha }, seen);
    seen = found.headSha;
    if (gate.state === "dispatch") return { ctx, found };
    if (gate.state === "wait") {
      await sleep(gate.waitMs);
      const again = await advanceFindPrStep(ctx);
      if (!again.ok) {
        await stopped(args, "review_pr", again.reason);
        return { end: { status: "no_pr", detail: again.reason } };
      }
      found = again;
      continue;
    }
    if (gate.state === "not_verified") {
      const loaded = await advanceReviewLoadStep(accountId, userId, workItemId, args.haltEpoch, pinned);
      if (!loaded.ok) {
        if (isHaltReason(loaded.reason)) return { end: await haltedEnd(args, "review_load") };
        await stopped(args, "review_load", loaded.reason);
        return { end: { status: "failed", detail: `review_${loaded.reason}` } };
      }
      const next: ReviewCtx = { repoId: loaded.repoId, owner: loaded.owner, name: loaded.name, issue: loaded.issue, tier: loaded.tier, specVersion: loaded.specVersion, fixRoundsStarted: loaded.fixRoundsStarted, debaterEnabled: loaded.debaterEnabled, executionMode: loaded.executionMode, recordedPr: loaded.recordedPr, prExecutionMode: loaded.prExecutionMode };
      const again = await advanceFindPrStep(next);
      if (!again.ok) {
        await stopped(args, "review_pr", again.reason);
        return { end: { status: "no_pr", detail: again.reason } };
      }
      return { ctx: next, found: again };
    }
    if (gate.state === "round_cap" || gate.state === "compute_cap") {
      // D#6 R5b-2b-i: no reviewer is started. The gate's outcome is "ready, a person merges" with the cap as its reason, and the stop is recorded so the gate line shows.
      const code = gate.state === "round_cap" ? "review_round_cap" : "review_compute_cap";
      await advanceEventStep(accountId, userId, workItemId, { kind: "merge_gate", dedupeKey: `${found.headSha}:ready_human_merges:${code}`, code: "ready_human_merges", reasons: [code], headSha: found.headSha, prNumber: found.number });
      await stopped(args, "review", code, { head: found.headSha, pr: found.number });
      return { end: { status: "ready_human_merges", detail: code } };
    }
    if (gate.state === "key_missing") {
      await stopped(args, "review", "review_key_missing", { head: found.headSha, pr: found.number });
      return { end: { status: "needs_human", detail: "review_key_missing" } };
    }
    if (isHaltReason(gate.reason)) return { end: await haltedEnd(args, "review_quiet") };
    await stopped(args, "review", gate.reason ?? "review_gate_refused", { head: found.headSha, pr: found.number });
    return { end: { status: "needs_human", detail: gate.reason ?? "review_gate_refused" } };
  }
  await stopped(args, "review", "review_quiet_period_unsettled", { head: found.headSha, pr: found.number });
  return { end: { status: "needs_human", detail: "review_quiet_period_unsettled" } };
}

/**
 * D#598 P7b: records a round's verdicts once the head's CI and repo-wide guards have finished. The recording step itself refuses (`ci_pending`, nothing
 * written) while they run; this only asks again every minute. After two hours the answer is `ci_wait_timeout`, which stops the item for a person.
 */
async function recordWhenCiSettled(args: AdvanceStartArgs, input: Parameters<typeof advanceRecordRoundStep>[4]): Promise<RoundOut> {
  let round = await advanceRecordRoundStep(args.accountId, args.userId, args.workItemId, args.haltEpoch, input);
  for (let waited = 0; round.decision === "ci_pending" && waited < CI_WAIT_MS; ) {
    const pause = waited < CI_POLL_FAST_FOR_MS ? CI_POLL_MS : CI_POLL_SLOW_MS;
    await sleep(pause);
    waited += pause;
    round = await advanceRecordRoundStep(args.accountId, args.userId, args.workItemId, args.haltEpoch, input);
  }
  if (round.decision === "ci_pending") {
    await advanceLogStep("advance.ci_wait_timeout", { work_item_id: args.workItemId, pr: input.prNumber, head: input.headSha.slice(0, 12) });
    return { ...round, decision: "ci_wait_timeout" };
  }
  return round;
}

/**
 * D#598 P7c: the delta re-check of a head that is only a merge of the base branch. Not being one answers `full_review` at once (no wait, nothing recorded).
 * Being one waits for the head's CI like a full review does (same cadence and limit as `recordWhenCiSettled`), then records it.
 */
async function recheckMergeOnly(args: AdvanceStartArgs, input: Parameters<typeof advanceRecordMergeOnlyStep>[4]): Promise<MergeOnlyOut> {
  let out = await advanceRecordMergeOnlyStep(args.accountId, args.userId, args.workItemId, args.haltEpoch, input);
  for (let waited = 0; out.decision === "ci_pending" && waited < CI_WAIT_MS; ) {
    const pause = waited < CI_POLL_FAST_FOR_MS ? CI_POLL_MS : CI_POLL_SLOW_MS;
    await sleep(pause);
    waited += pause;
    out = await advanceRecordMergeOnlyStep(args.accountId, args.userId, args.workItemId, args.haltEpoch, input);
  }
  if (out.decision === "ci_pending") {
    await advanceLogStep("advance.ci_wait_timeout", { work_item_id: args.workItemId, pr: input.prNumber, head: input.headSha.slice(0, 12) });
    return { decision: "ci_wait_timeout", reason: null };
  }
  return out;
}

/**
 * The review of an open pull request: reviewers on the head, all verdicts gathered, then recorded; the merge gate when
 * everyone passed; a fix round (a RESUME of the build's session) when someone asked for changes; then the review again on
 * the new head. See the file header for every way it stops.
 */
/**
 * Waits for a fix run to end, restarting it on the new side when its item moved there (D#599 PL-2, keyed by the worker). Answers the run followed last and
 * how it stands: `done` false when the wait ran out.
 */
async function followFix(args: AdvanceStartArgs, ctx: ReviewCtx, pr: { number: number; headSha: string; branch: string }, round: number, failing: Array<{ role: string; runId: string }>, rereview: number, runId: string, attempt: number, person = false): Promise<{ runId: string; fixed: BuildRunOutcome; end?: Result }> {
  const { accountId, userId, workItemId, actionId } = args;
  let waited = 0;
  let fixed = await advanceBuildOutcomeStep(accountId, runId);
  let pendingWaited = 0;
  for (let restarts = 0; ; restarts++) {
    while (!fixed.done && waited < BUILD_WAIT_MS && pendingWaited < RUNNER_PENDING_CEILING_MS) {
      const queued = fixed.queuedOnRunner;
      await sleep(BUILD_POLL_MS);
      if (queued) pendingWaited += BUILD_POLL_MS;
      else waited += BUILD_POLL_MS;
      fixed = await advanceBuildOutcomeStep(accountId, runId);
    }
    // D#599 PL-2: the fix run was queued on a side the item has left; the same fix round starts again on the new side (keyed by the worker).
    if (fixed.done && fixed.failureReason === PLACEMENT_CHANGED && restarts < PLACEMENT_RESTARTS_MAX) {
      const again = await advanceStartFixStep(accountId, userId, workItemId, args.haltEpoch, ctx, pr, actionId, round, failing, rereview, attempt > 0 ? attempt : undefined, person);
      if (again.ok && again.runId !== null && again.runId !== runId) {
        await advanceLogStep("advance.fix_restarted", { work_item_id: workItemId, from_run_id: runId, run_id: again.runId, reason: PLACEMENT_CHANGED });
        runId = again.runId;
        fixed = await advanceBuildOutcomeStep(accountId, again.runId);
        continue;
      }
    }
    // D#2 H14c-3-3b-2: a fix round that ended at a limit is continued (or parked with its reason) before the caller records a failed round.
    const next = await continueLimitEnds(args, runId, fixed);
    if ("end" in next) return { runId, fixed, end: next.end };
    return { runId: next.runId, fixed: next.outcome };
  }
}

/** The fixed code the driver stops with when a person's fix round pushed nothing: the person asked for a change and none was made, so nothing is reviewed or merged. */
const PERSON_FIX_NO_CHANGE = "person_fix_pushed_nothing";

/**
 * A person's Request changes: one fix round on the pull request's current head, before any review. The executor gets the person's note (a fenced run
 * note the worker adds and stamps applied) and the findings of any reviewer that asked for changes on this head. The round counts toward the item's fix
 * rounds and waits on spending limits as every fix round does. Answers the context to review the new head with, or the end of the workflow.
 */
async function personFixRound(args: AdvanceStartArgs, ctx: ReviewCtx): Promise<{ ctx: ReviewCtx } | { end: Result }> {
  const { accountId, userId, workItemId, actionId } = args;
  const found = await advanceFindPrStep(ctx);
  if (!found.ok) {
    await stopped(args, "person_fix_pr", found.reason);
    return { end: { status: "no_pr", detail: found.reason } };
  }
  const pr = { number: found.number, headSha: found.headSha, branch: found.branch };
  // Reviewers that asked for changes on this very head: their findings go to the executor with the note. A pass, or a run with no verdict, adds nothing.
  const failing: Array<{ role: string; runId: string }> = [];
  for (const r of await advanceReviewRunsStep(accountId, userId, workItemId, args.haltEpoch, pr.headSha, 0)) {
    const o = await advanceReviewerOutcomeStep(accountId, r.runId);
    if (o.done && !o.noVerdict && !o.environmentFailure && o.unverifiable !== true && o.verdict === "needs-fix") failing.push({ role: r.role, runId: r.runId });
  }
  const round = (ctx.fixRoundsStarted ?? 0) + 1;
  const ask = await askFixUntilAllowed(args, ctx, pr, round, failing, 0, true);
  if (ask.pause !== null) return { end: await pausedEnd(workItemId, "fix_round", ask.pause, ask.attempt) };
  if (isHaltReason(ask.fix.reason)) return { end: await haltedEnd(args, "person_fix") };
  if (!ask.fix.ok || ask.fix.runId === null) {
    await stopped(args, "person_fix", ask.fix.reason ?? "refused", { head: pr.headSha, pr: pr.number, round });
    return { end: { status: "fix_refused", detail: ask.fix.reason ?? undefined } };
  }
  const next: ReviewCtx = { ...ctx, fixRoundsStarted: round };
  const { runId, fixed, end } = await followFix(args, next, pr, round, failing, 0, ask.fix.runId, ask.attempt, true);
  if (end) return { end };
  const failed = async (code: string): Promise<{ end: Result }> => {
    await advanceEventStep(accountId, userId, workItemId, { kind: "fix_round_failed", dedupeKey: `fixfail:${pr.headSha}:${actionId}`, code, headSha: pr.headSha, runId });
    return { end: { status: "fix_failed", detail: code } };
  };
  if (!fixed.done) {
    await advanceCancelStep(accountId, userId, workItemId, fixed.tailRunId);
    return failed("wait_timeout");
  }
  await advanceLogStep("advance.fixed", { work_item_id: workItemId, round, run_id: runId, run_status: fixed.status, person: true });
  if (fixed.status === "succeeded") {
    const decision = await advanceDecisionStep(accountId, userId, workItemId, args.haltEpoch, fixed.tailRunId);
    if (isHaltReason(decision)) return { end: await haltedEnd(args, "decision") };
    if (decision === "parked") return { end: await waitingOnAnswer(args, fixed.tailRunId) };
  }
  const noCommit = fixed.status === "failed" && fixed.failureReason === "no_commit";
  if (fixed.status !== "succeeded" && !noCommit) return failed(`run_${fixed.status}`.replace(/[^a-z0-9_]/g, "_"));
  const after = await advanceFindPrStep(next);
  if (!after.ok) {
    await stopped(args, "review_pr", after.reason);
    return { end: { status: "no_pr", detail: after.reason } };
  }
  if (after.headSha === pr.headSha) {
    // Nothing was pushed for the person's request: stop and say so. The reviewers do not look again at a commit the person asked to change.
    await advanceEventStep(accountId, userId, workItemId, { kind: "fix_pushed_nothing", dedupeKey: `nothing:${pr.headSha}:${actionId}:person`, code: "person_request", headSha: pr.headSha, prNumber: pr.number, runId });
    await stopped(args, "person_fix", PERSON_FIX_NO_CHANGE, { head: pr.headSha, pr: pr.number, round });
    return { end: { status: "needs_human", detail: PERSON_FIX_NO_CHANGE } };
  }
  const descent = await advanceFixDescentStep(next, pr.headSha, after.headSha);
  if (descent.state !== "descends" && descent.state !== "not_needed") return failed(descent.state === "rewritten" ? "branch_rewritten" : "compare_unavailable");
  if (fixed.status !== "succeeded") return failed(`run_${fixed.status}`.replace(/[^a-z0-9_]/g, "_"));
  return { ctx: next };
}

/**
 * D#6 PUBLIC-MERGE PR2b: the gate placed a merge order and the customer's runner merges the public pull request. Waits (a durable sleep, then one read of the order)
 * until it is over: merged (GitHub says so, read by the cloud), a head moved (review again), or a stop for a person with the order's fixed reason. An order past its
 * 60-minute deadline is expired by the step itself (`runner_merge_timeout`).
 */
async function waitForMergeOrder(args: AdvanceStartArgs, pr: { number: number; headSha: string }): Promise<{ next: "continue" } | { next: "end"; result: Result }> {
  const { accountId, userId, workItemId } = args;
  const stop = async (code: string, record: boolean): Promise<{ next: "end"; result: Result }> => {
    if (record) await advanceEventStep(accountId, userId, workItemId, { kind: "merge_gate", dedupeKey: `${pr.headSha}:order:${code}`, code: "ready_human_merges", reasons: [code], headSha: pr.headSha, prNumber: pr.number });
    await advanceLogStep("advance.merge_order", { work_item_id: workItemId, pr: pr.number, state: "stopped", code });
    return { next: "end", result: { status: "ready_human_merges", detail: code } };
  };
  for (let polls = 0; polls < MERGE_ORDER_MAX_POLLS; polls++) {
    const order = await advanceMergeOrderStep(accountId, userId, workItemId, args.haltEpoch);
    if (order.state === "merged") {
      await advanceLogStep("advance.merge_order", { work_item_id: workItemId, pr: pr.number, state: "merged", code: order.code ?? "" });
      return { next: "end", result: { status: "merged" } };
    }
    if (order.state === "head_moved") {
      await advanceLogStep("advance.merge_order", { work_item_id: workItemId, pr: pr.number, state: "head_moved", code: order.code ?? "" });
      return { next: "continue" };
    }
    // The go phase already recorded the gate's own reasons for a block it found; a stop the gate never saw (a claim-time takeover or pairing change, a go phase
    // that was refused or found the pull request closed) is recorded here, so the card says why.
    if (order.state === "blocked") return stop(order.code ?? "runner_merge_failed", order.gateRecorded !== true);
    if (order.state === "failed") return stop(order.code ?? "runner_merge_failed", true);
    if (order.state === "refused") {
      await stopped(args, "merge_order", order.code ?? "refused", { head: pr.headSha, pr: pr.number });
      return { next: "end", result: { status: "needs_human", detail: order.code ?? "refused" } };
    }
    // `none` (an order that should exist does not) is a stop, not a wait.
    if (order.state === "none") return stop("runner_merge_failed", true);
    await sleep(MERGE_ORDER_POLL_MS);
  }
  return stop("runner_merge_timeout", true);
}

async function reviewPhase(args: AdvanceStartArgs, pinned: number | null): Promise<Result> {
  const { accountId, userId, workItemId, actionId } = args;

  const loaded = await advanceReviewLoadStep(accountId, userId, workItemId, args.haltEpoch, pinned);
  if (!loaded.ok && isHaltReason(loaded.reason)) return haltedEnd(args, "review_load");
  if (!loaded.ok) {
    await stopped(args, "review_load", loaded.reason);
    return { status: "failed", detail: `review_${loaded.reason}` };
  }
  let ctx: ReviewCtx = { repoId: loaded.repoId, owner: loaded.owner, name: loaded.name, issue: loaded.issue, tier: loaded.tier, specVersion: loaded.specVersion, fixRoundsStarted: loaded.fixRoundsStarted, debaterEnabled: loaded.debaterEnabled, executionMode: loaded.executionMode, recordedPr: loaded.recordedPr, prExecutionMode: loaded.prExecutionMode };
  // A person pressed Request changes: their fix round comes first, on the pull request's current head. The review below then checks the new head, as after any fix.
  if (loaded.personRequestPending) {
    const person = await personFixRound(args, ctx);
    if ("end" in person) return person.end;
    ctx = person.ctx;
  }

  // C44-7: a fix round that proved "no change needed" asks the reviewers that wanted the fix to look again at the SAME head, once per head.
  // `again` is that pending look; `lookedAgain` holds the heads already given theirs (workflow state, rebuilt by a replay from the same step results).
  let again: { head: string; roles: string[]; passes: Array<{ role: string; runId: string }>; n: number } | null = null;
  const lookedAgain = new Set<string>();
  for (let attempt = 0; attempt < MAX_REVIEW_ROUNDS; attempt++) {
    let found = await advanceFindPrStep(ctx);
    if (!found.ok) {
      await stopped(args, "review_pr", found.reason);
      return { status: "no_pr", detail: found.reason };
    }
    // D#6 R5b-2a: a cloud-verified pull request is reviewed only after its quiet period, and with a model key. Every other mode goes straight on.
    if (ctx.executionMode === "runner_verified") {
      const quiet = await awaitVerifiedQuiet(args, ctx, found, pinned);
      if ("end" in quiet) return quiet.end;
      ctx = quiet.ctx;
      found = quiet.found;
    }
    const pr = { number: found.number, headSha: found.headSha, baseRef: found.baseRef, branch: found.branch };
    // A push since the "no change" fix makes it a new head: it gets the full review, not the narrow one.
    if (again !== null && again.head !== pr.headSha) again = null;
    const carried: Array<{ role: string; runId: string }> = again?.passes ?? [];
    // A restart by the sweep begins in the re-review round the parked review was in (the waiting fact carries it); every later pass of the loop has its own.
    const rereview: number = again?.n ?? (attempt === 0 ? (Number.isSafeInteger(args.startRereview) && args.startRereview! > 0 ? args.startRereview! : 0) : 0);

    // Who must review this head: code and acceptance always; security when the item is critical, the diff touches a
    // security surface, or (below) the code reviewer asks for it; the debater when the repo's role setting allows it.
    let plan = await advanceReviewPlanStep(accountId, userId, workItemId, args.haltEpoch, ctx, found, false);
    // D#598 P7c: a head that is only a merge of the base branch into the reviewed one gets the delta re-check, not a full review: no reviewer runs,
    // the reviewed head's passes stand for it, and the merge gate follows. A head with any code change falls through to the full review below.
    if (again === null) {
      const delta = await recheckMergeOnly(args, { headSha: pr.headSha, prNumber: pr.number, baseRef: pr.baseRef, requiredRoles: plan.roles });
      if (delta.decision === "halted") return haltedEnd(args, "review");
      // The head moved while the re-check waited for CI: nothing was recorded; look at the new head.
      if (delta.decision === "head_moved") continue;
      if (delta.decision === "all_passed") {
        await advanceLogStep("advance.reviewed", { work_item_id: workItemId, round: attempt, rereview, pr: pr.number, head: pr.headSha.slice(0, 12), decision: "merge_only", recorded: "" });
        const gate = await advanceMergeGateStep(accountId, userId, workItemId, args.haltEpoch, pr.number);
        await advanceLogStep("advance.merge_gate", { work_item_id: workItemId, pr: pr.number, outcome: gate.outcome, reasons: gate.reasons.join(","), status: gate.status });
        if (gate.outcome === "head_moved") continue;
        if (gate.outcome === "merge_delegated") {
          const waited = await waitForMergeOrder(args, pr);
          if (waited.next === "continue") continue;
          return waited.result;
        }
        if (gate.outcome === "error" || gate.outcome === "refused") await stopped(args, "merge_gate", gate.reasons[0] ?? gate.outcome, { head: pr.headSha, pr: pr.number });
        return { status: gate.outcome, detail: gate.reasons.join(",") || undefined };
      }
      if (delta.decision !== "full_review") {
        // CI never finished, or the step was refused: nothing is decided, nothing is merged.
        await stopped(args, "review", delta.decision, { head: pr.headSha, pr: pr.number });
        return { status: "needs_human", detail: delta.decision };
      }
    }
    const roundOne = again !== null ? again.roles.filter((r) => r !== "debater") : plan.roles.filter((r) => r !== "debater");
    const first = await runReviewers(args, ctx, pr, roundOne, [], attempt, rereview);
    if (first.paused !== null) return pausedEnd(workItemId, "review", first.paused.pause, first.paused.attempt);
    const verdicts = [...first.verdicts];
    let refused = [...first.refused];
    let refusedWhy: Record<string, string> = { ...first.refusedWhy };

    // The code reviewer's "security review needed" flag adds the security reviewer for this head.
    if (verdicts.some((v) => v.role === "code-reviewer" && v.securityNeeded)) {
      plan = await advanceReviewPlanStep(accountId, userId, workItemId, args.haltEpoch, ctx, found, true);
      const extra = plan.roles.filter((r) => r !== "debater" && !roundOne.includes(r) && !carried.some((c) => c.role === r));
      if (extra.length > 0) {
        const more = await runReviewers(args, ctx, pr, extra, [], attempt, rereview);
        if (more.paused !== null) return pausedEnd(workItemId, "review", more.paused.pause, more.paused.attempt);
        verdicts.push(...more.verdicts);
        refused = [...refused, ...more.refused];
        refusedWhy = { ...refusedWhy, ...more.refusedWhy };
      }
    }

    // The debater tries to refute a pass: it runs only after everyone else has passed.
    const others = plan.roles.filter((r) => r !== "debater");
    let debaterRan = false;
    if (plan.roles.includes("debater") && refused.length === 0 && others.every((r) => carried.some((c) => c.role === r) || verdicts.some((v) => v.role === r && v.verdict === "pass"))) {
      const passes = [...carried, ...verdicts.filter((v) => v.verdict === "pass").map((v) => ({ role: v.role, runId: v.runId }))];
      debaterRan = true;
      const debate = await runReviewers(args, ctx, pr, ["debater"], passes, attempt, rereview);
      if (debate.paused !== null) return pausedEnd(workItemId, "review", debate.paused.pause, debate.paused.attempt);
      verdicts.push(...debate.verdicts);
      refused = [...refused, ...debate.refused];
      refusedWhy = { ...refusedWhy, ...debate.refusedWhy };
    }

    // Every verdict is in: record them, passes first and non-passes last, in ONE step.
    const round = await recordWhenCiSettled(args, {
      headSha: pr.headSha,
      prNumber: pr.number,
      // The debater is required only once it has been started: it runs after everyone else passed, so a needs-fix from
      // another reviewer must start a fix round, not stop as "incomplete" for want of a debater verdict. (The merge gate
      // still demands its pass: it reads the full plan.)
      requiredRoles: plan.roles.filter((r) => (r !== "debater" || debaterRan) && !carried.some((c) => c.role === r)),
      verdicts: verdicts.map((v) => ({ role: v.role, runId: v.runId, verdict: v.verdict, ...(v.environmentFailure ? { environmentFailure: true } : {}), ...(v.unverifiable ? { unverifiable: true } : {}), ...(v.noVerdict ? { noVerdict: true, endCode: v.endCode ?? "no_verdict" } : {}) })),
    });
    again = null;
    await advanceLogStep("advance.reviewed", { work_item_id: workItemId, round: attempt, rereview, pr: pr.number, head: pr.headSha.slice(0, 12), decision: round.decision, recorded: round.recorded.join(",") });

    if (round.decision === "halted") return haltedEnd(args, "review");
    // D#598 P7b: the head moved while the round waited for CI (a push to the pull request): nothing was recorded; review the new head.
    if (round.decision === "head_moved") continue;
    if (round.decision === "all_passed") {
      const gate = await advanceMergeGateStep(accountId, userId, workItemId, args.haltEpoch, pr.number);
      await advanceLogStep("advance.merge_gate", { work_item_id: workItemId, pr: pr.number, outcome: gate.outcome, reasons: gate.reasons.join(","), status: gate.status });
      // The head moved while the gate ran: review the new head.
      if (gate.outcome === "head_moved") continue;
      if (gate.outcome === "merge_delegated") {
        const waited = await waitForMergeOrder(args, pr);
        if (waited.next === "continue") continue;
        return waited.result;
      }
      if (gate.outcome === "error" || gate.outcome === "refused") await stopped(args, "merge_gate", gate.reasons[0] ?? gate.outcome, { head: pr.headSha, pr: pr.number });
      return { status: gate.outcome, detail: gate.reasons.join(",") || undefined };
    }
    if (round.decision === "escalated") {
      await advanceLogStep("advance.stopped", { work_item_id: workItemId, at: "review", reason: "max_fix_rounds" });
      return { status: "escalated", detail: "max_fix_rounds" };
    }
    if (round.decision === "environment_failure") {
      // D#598 P7d: a reviewer could not run the tests. The worker recorded the fact; no verdict was recorded and no fix round starts.
      await advanceLogStep("advance.stopped", { work_item_id: workItemId, at: "review", reason: "reviewer_environment" });
      return { status: "needs_human", detail: "reviewer_environment" };
    }
    if (round.decision === "unverifiable") {
      // A reviewer could not verify some criteria in its environment. The worker recorded the escalation (the item is at Needs a person, the criteria stay in the
      // reviewer's run) and no verdict; no fix round starts, because an executor cannot change the reviewer's environment.
      await advanceLogStep("advance.stopped", { work_item_id: workItemId, at: "review", reason: "reviewer_unverifiable", roles: verdicts.filter((v) => v.unverifiable).map((v) => v.role).join(",") });
      return { status: "needs_human", detail: "reviewer_unverifiable" };
    }
    if (round.decision === "reviewer_no_verdict") {
      // A reviewer kept ending without a verdict: the worker recorded the escalation (which reviewer, how it ended) and moved the item to Needs a person.
      const missing = verdicts.filter((v) => v.noVerdict);
      await advanceLogStep("advance.stopped", { work_item_id: workItemId, at: "review", reason: "reviewer_no_verdict", roles: missing.map((v) => v.role).join(","), ends: missing.map((v) => v.endCode ?? "none").join(",") });
      return { status: "needs_human", detail: "reviewer_no_verdict" };
    }
    if (round.decision === "reviewer_fail") {
      await advanceLogStep("advance.stopped", { work_item_id: workItemId, at: "review", reason: "reviewer_fail" });
      return { status: "needs_human", detail: "reviewer_fail" };
    }
    if (round.decision !== "fix") {
      // incomplete (a required reviewer could not start) or refused: nothing is decided, nothing is merged.
      // The code names the worker's reason when it gave one (`not_started_runner_daily_limit`), the role otherwise: the person reading the card needs the cause, not only the role.
      await stopped(args, "review", refused.length > 0 ? `not_started_${refusedWhy[refused[0]!] ?? refused[0]}` : round.decision, { head: pr.headSha, pr: pr.number });
      return { status: "needs_human", detail: refused.length > 0 ? `reviewer_not_started:${refused.join(",")}` : round.decision };
    }

    // A fix round: the executor RESUMES the build's sandbox and session with the findings, then the head is read again.
    const failing = verdicts.filter((v) => v.verdict !== "pass" && !v.unverifiable).map((v) => ({ role: v.role, runId: v.runId }));
    const fixAsk = await askFixUntilAllowed(args, ctx, pr, round.nextRound ?? round.round + 1, failing, rereview);
    if (fixAsk.pause !== null) return pausedEnd(workItemId, "fix_round", fixAsk.pause, fixAsk.attempt);
    let fix: FixOut = fixAsk.fix;
    if (isHaltReason(fix.reason)) return haltedEnd(args, "fix");
    // The fix round is now started: the next review of this item is the round after it (the security reviewer's step-back counts these).
    ctx = { ...ctx, fixRoundsStarted: round.nextRound ?? round.round + 1 };
    if (!fix.ok || fix.runId === null) {
      await advanceLogStep("advance.stopped", { work_item_id: workItemId, at: "fix", reason: fix.reason ?? "none" });
      return { status: "fix_refused", detail: fix.reason ?? undefined };
    }
    const followed = await followFix(args, ctx, pr, round.nextRound ?? round.round + 1, failing, rereview, fix.runId, fixAsk.attempt);
    if (followed.end) return followed.end;
    fix = { ...fix, runId: followed.runId };
    const fixed = followed.fixed;
    if (!fixed.done) {
      await advanceCancelStep(accountId, userId, workItemId, fixed.tailRunId);
      await advanceEventStep(accountId, userId, workItemId, { kind: "fix_round_failed", dedupeKey: `fixfail:${pr.headSha}:${actionId}`, code: "wait_timeout", headSha: pr.headSha, runId: fix.runId });
      return { status: "fix_failed", detail: "wait_timeout" };
    }
    await advanceLogStep("advance.fixed", { work_item_id: workItemId, round: round.nextRound ?? round.round + 1, run_id: fix.runId, run_status: fixed.status });
    if (fixed.status === "succeeded") {
      // D#7 DP4b-2: the same read after a succeeded fix round, before the next review.
      const decision = await advanceDecisionStep(accountId, userId, workItemId, args.haltEpoch, fixed.tailRunId);
      if (isHaltReason(decision)) return haltedEnd(args, "decision");
      if (decision === "parked") return waitingOnAnswer(args, fixed.tailRunId);
    }
    // A runner fix run whose agent finished and pushed nothing ends `failed no_commit`; a sandbox one ends `succeeded` with the head unmoved. Both are
    // "no change", and the head decides it (below), so only a fix that failed some other way, or is not the runner's no-commit, stops here.
    const noCommit = fixed.status === "failed" && fixed.failureReason === "no_commit";
    if (fixed.status !== "succeeded" && !noCommit) {
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
      // "No change needed": the fix proved the code right and pushed nothing. The reviewers that asked for the fix look once more at this same head; a second
      // "no change" on it is a disagreement the driver cannot settle, and goes to a person. The fix-round limit still bounds the whole.
      const repeat = lookedAgain.has(pr.headSha);
      await advanceEventStep(accountId, userId, workItemId, { kind: "fix_pushed_nothing", dedupeKey: `nothing:${pr.headSha}:${actionId}:${rereview}`, code: repeat ? NO_CHANGE_REPEATED : "rereview", headSha: pr.headSha, prNumber: pr.number, runId: fix.runId });
      if (repeat) {
        await advanceLogStep("advance.stopped", { work_item_id: workItemId, at: "fix", reason: NO_CHANGE_REPEATED, head: pr.headSha.slice(0, 12) });
        await advanceEventStep(accountId, userId, workItemId, { kind: "escalated", dedupeKey: `${NO_CHANGE_REPEATED}:${pr.headSha}`, code: NO_CHANGE_REPEATED, headSha: pr.headSha, prNumber: pr.number, runId: fix.runId });
        return { status: "needs_human", detail: NO_CHANGE_REPEATED };
      }
      lookedAgain.add(pr.headSha);
      await advanceLogStep("advance.fix_no_change", { work_item_id: workItemId, run_id: fix.runId, run_status: fixed.status, head: pr.headSha.slice(0, 12), roles: failing.map((f) => f.role).join(",") });
      again = { head: pr.headSha, roles: failing.map((f) => f.role), passes: verdicts.filter((v) => v.verdict === "pass").map((v) => ({ role: v.role, runId: v.runId })).concat(carried), n: rereview + 1 };
      continue;
    }
    // D#599 PL-2b-2 (security model 5): a cross-side sandbox round pushes without --force; GitHub must say its new head descends from the head it started on.
    // A rewritten branch ends the round `failed branch_rewritten` and nothing is reviewed. A runner round's push is fast-forward by construction.
    const descent = await advanceFixDescentStep(ctx, pr.headSha, after.headSha);
    if (descent.state !== "descends" && descent.state !== "not_needed") {
      const code = descent.state === "rewritten" ? "branch_rewritten" : "compare_unavailable";
      await advanceEventStep(accountId, userId, workItemId, { kind: "fix_round_failed", dedupeKey: `fixfail:${pr.headSha}:${actionId}`, code, headSha: pr.headSha, runId: fix.runId });
      return { status: "fix_failed", detail: code };
    }
    // The fix changed the head. A run that FAILED yet moved the head is not a "no change": it stays a failed fix, as before.
    if (fixed.status !== "succeeded") {
      await advanceEventStep(accountId, userId, workItemId, { kind: "fix_round_failed", dedupeKey: `fixfail:${pr.headSha}:${actionId}`, code: `run_${fixed.status}`.replace(/[^a-z0-9_]/g, "_"), headSha: pr.headSha, runId: fix.runId });
      return { status: "fix_failed", detail: fixed.status };
    }
  }
  await stopped(args, "review", "review_rounds_used");
  return { status: "needs_human", detail: "review_rounds_used" };
}
