import type { AdvanceFacade, AdvancePrSource, AdvanceRunStart } from "@fx/worker";
import type { InstallationHttp, InstallationHttpKind, InstallationHttpTarget } from "@fx/github";
import { toCode } from "@fx/core/src/work-items/driverEvents.js";
import {
  ReviewPromptInputError,
  assembleFixPrompt,
  assembleReviewPrompt,
  compareHeads,
  findPullRequestForItem,
  assemblyMsSince,
  findRecordedPullRequest,
  isLocalGitHubHttp,
  listChangedFiles,
  listChangedFilesLocal,
  pauseForDenial,
  pauseOnDenial,
  promptRuntimeOf,
  readVerdict,
  reviewPlanFor,
  reviewStep,
  roundIsCrossSide,
  securityTriggers,
  type AssembledPrompt,
  type FixFinding,
  type ReviewPromptRole,
} from "@fx/pipeline";
import { openForRepo } from "./github/localOnlyHttp";
import type { StepWho } from "./advanceStageSteps";
import { isQueuedOnRunner } from "./advanceSteps";

/**
 * D#483 P3: the bodies of the stage driver's review steps (apps/web/workflows/workItemAdvance.ts holds the directives and
 * calls these). Plain async functions over the injected worker and GitHub client, so a test runs them without the Workflow
 * service, exactly as ./advanceSteps.ts and ./advanceStageSteps.ts do.
 *
 * What the workflow keeps is small and plain: ids, a commit id, fixed words, counts. The Spec's text, the reviewers'
 * findings and summaries (model text) are read INSIDE the step that builds a prompt from them and never returned, so none
 * of it lands in the workflow's event history or a log line. Every refusal is data with a fixed reason code, never a throw
 * (a step that throws is retried by the Workflow service and none of these refusals gets better by retrying).
 */

export type ReviewWorker = Pick<
  AdvanceFacade,
  | "advanceLoadReview"
  | "advanceLoadSpecText"
  | "advanceStartRun"
  | "advanceRunOutcome"
  | "advanceRecordRound"
  | "advanceRecordMergeOnly"
  | "advanceStartFix"
  | "advanceMergeGate"
  | "advanceVerifiedReviewGate"
  | "advanceRecordEvent"
  | "advanceCancel"
  | "advancePrFound"
> &
  /** D#483 S5-k1d: optional so a worker built before it (and a test's fake) still works; absent reads as "no reviewer run is known". */
  Partial<Pick<AdvanceFacade, "advanceReviewRuns">>;

/** Opens the GitHub client for one repository (apps/web/lib/github/installationHttp.ts in production). */
export type OpenHttp = (kind: InstallationHttpKind, target: InstallationHttpTarget) => Promise<InstallationHttp>;

export interface ReviewCtx extends AdvancePrSource {
  repoId: string;
  owner: string;
  name: string;
  /** The issue's number. */
  issue: number;
  tier: string;
  /** The Spec version the person approved. */
  specVersion: number;
  /** Fix rounds already started, kept up to date by the workflow as it starts them. Absent: none. */
  fixRoundsStarted?: number;
  debaterEnabled: boolean;
}

export type ReviewLoaded = ({ ok: true } & ReviewCtx) | { ok: false; reason: string };

/** The review context, and the Spec version the review is pinned to: the one the person approved (`pinned`). A newer version since refuses `spec_changed`. */
export async function reviewLoadBody(worker: ReviewWorker | null, who: StepWho, pinned: number | null): Promise<ReviewLoaded> {
  if (!worker) return { ok: false, reason: "worker_unavailable" };
  const out = await worker.advanceLoadReview(who);
  if (!out.ok) return { ok: false, reason: out.reason };
  const c = out.ctx;
  if (pinned !== null && c.specVersion !== pinned) return { ok: false, reason: "spec_changed" };
  return { ok: true, repoId: c.repoId, owner: c.owner, name: c.name, issue: c.issue, tier: c.tier, specVersion: c.specVersion, fixRoundsStarted: c.fixRoundsStarted ?? 0, debaterEnabled: c.debaterEnabled, executionMode: c.executionMode, recordedPr: c.recordedPr, prExecutionMode: c.prExecutionMode };
}

export interface PrFound {
  ok: true;
  number: number;
  headSha: string;
  baseRef: string;
  /** The pull request's head branch: the run's recorded branch for a runner run, `fx/issue-<n>` for a sandbox build. */
  branch: string;
  /** The diff check's codes for this pull request (empty: it touches none of the security surfaces). */
  securityCodes: string[];
}
export type PrLookup = PrFound | { ok: false; reason: string };

/**
 * The executor's open pull request, its head commit, and the security surfaces its diff touches. A sandbox build's is found by
 * `fx/issue-<n>`; a runner run's by the number and branch its `done` recorded, and none recorded is `no_open_pr` (D#6 C25 section 1.2).
 */
export async function findPrBody(open: OpenHttp | null, ctx: Pick<ReviewCtx, "repoId" | "owner" | "name" | "issue" | "executionMode" | "prExecutionMode" | "recordedPr">): Promise<PrLookup> {
  if (!open) return { ok: false, reason: "github_unavailable" };
  try {
    // D#599 PL-2: the pull request is looked up on the side that BUILT it (the newest executor run's), which is not the item's effective side
    // right after a placement change. That side picks the client and the lookup; gating and auto-merge read the effective mode elsewhere.
    const lookupMode = ctx.prExecutionMode ?? ctx.executionMode;
    // D#6 R3c: a runner_local repo is read through the local-only fence (paths only, never a patch).
    const http = await openForRepo(open, lookupMode, "read", { repoId: ctx.repoId, owner: ctx.owner, name: ctx.name });
    // D#599 PL-2b-2: on the sandbox side a recorded pair is the pull request a cross-side sandbox round was bound to (it carried on from a pull request the runner
    // opened). The lookup follows that pair, by number and branch, not the side of the newest executor run and not `fx/issue-<n>`. A sandbox build records none.
    const found =
      promptRuntimeOf(lookupMode) === "sandbox" && ctx.recordedPr !== null && ctx.recordedPr.bound === true
        ? await findRecordedPullRequest(http, { owner: ctx.owner, name: ctx.name }, ctx.recordedPr, { local: false })
        : await findPullRequestForItem(http, { owner: ctx.owner, name: ctx.name, issue: ctx.issue, executionMode: lookupMode, recordedPr: ctx.recordedPr });
    if (!found.ok) return { ok: false, reason: found.reason };
    const files =
      lookupMode === "runner_local"
        ? isLocalGitHubHttp(http)
          ? await listChangedFilesLocal(http, { owner: ctx.owner, name: ctx.name, pr: found.pr.number })
          : ({ ok: false, reason: "github_unavailable" } as const)
        : await listChangedFiles(http, { owner: ctx.owner, name: ctx.name, pr: found.pr.number });
    if (!files.ok) return { ok: false, reason: files.reason };
    const codes = securityTriggers({ files: files.files, truncated: files.truncated });
    return { ok: true, number: found.pr.number, headSha: found.pr.headSha, baseRef: found.pr.baseRef, branch: found.pr.branch, securityCodes: codes };
  } catch {
    // fx-swallow-ok: a fixed code is returned and the driver stops with it; the error text can name a repository
    console.warn(JSON.stringify({ event: "advance.pr_lookup_failed", repo_id: ctx.repoId }));
    return { ok: false, reason: "github_unavailable" };
  }
}

export interface VerifiedGateOut {
  /** `dispatch`: start the reviewers. `wait`: the quiet period has not ended. `key_missing`: no usable model key. `not_verified`: the repository left the mode. `refused`: a fixed `reason`. */
  state: "dispatch" | "wait" | "key_missing" | "round_cap" | "compute_cap" | "not_verified" | "refused";
  waitMs: number;
  /** The repository's mode right now (`not_verified` only). */
  executionMode: string | null;
  reason: string | null;
}

/**
 * D#6 R5b-2a: may the reviewers of this cloud-verified pull request start? Read fresh on every call from the item's rows (the executor's end, the
 * newest push, the model connection, the repository's mode), so a push, a removed key or a mode change between two checks is seen at once.
 */
export async function verifiedGateBody(worker: ReviewWorker | null, who: StepWho, pr: Pick<PrFound, "number" | "headSha">, seenHead: string | null): Promise<VerifiedGateOut> {
  if (!worker) return { state: "refused", waitMs: 0, executionMode: null, reason: "worker_unavailable" };
  const out = await worker.advanceVerifiedReviewGate(who, { prNumber: pr.number, headSha: pr.headSha, seenHead });
  return {
    state: out.state,
    waitMs: out.state === "wait" ? out.waitMs : 0,
    executionMode: out.state === "not_verified" ? out.executionMode : null,
    reason: out.state === "refused" ? out.reason : null,
  };
}

export interface ReviewPlanOut {
  /** Every role whose pass the merge gate will require on this head, debater last. */
  roles: string[];
  /** Why the security reviewer is required (empty when it is not). */
  securityReasons: string[];
}

/** Who must review this head, by the one rule the merge gate also uses. Records why a security review is required. */
export async function reviewPlanBody(worker: ReviewWorker | null, who: StepWho, ctx: Pick<ReviewCtx, "tier" | "debaterEnabled">, pr: Pick<PrFound, "number" | "headSha" | "securityCodes">, flagged: boolean): Promise<ReviewPlanOut> {
  const plan = reviewPlanFor({
    tier: ctx.tier as Parameters<typeof reviewPlanFor>[0]["tier"],
    securityDiffTriggerFired: pr.securityCodes.length > 0,
    reviewerFlaggedSecurity: flagged,
    debaterEnabled: ctx.debaterEnabled,
  });
  if (worker && plan.securityReasons.length > 0) {
    const reasons = [...plan.securityReasons, ...pr.securityCodes].slice(0, 20);
    await worker.advanceRecordEvent(who, { kind: "security_review_required", dedupeKey: `security:${pr.headSha}:${flagged ? "flagged" : "initial"}`, reasons, headSha: pr.headSha, prNumber: pr.number });
  }
  return { roles: plan.roles, securityReasons: plan.securityReasons };
}

export interface StartedReviewer {
  role: string;
  runId: string | null;
  reason: string | null;
}

const REVIEW_ROLES: readonly string[] = ["code-reviewer", "acceptance-tester", "security-reviewer", "debater"];

/**
 * D#483 S5-k1d: the reviewer runs of one head and re-review round that really started (every run but a refused one), one per role. A restarted review uses them and
 * asks only for the roles that have none: the key of an ask a spending limit denied finds that refused run again, so it is never asked a second time.
 */
export async function reviewRunsBody(worker: ReviewWorker | null, who: StepWho, headSha: string, rereview: number): Promise<Array<{ role: string; runId: string }>> {
  if (!worker || typeof worker.advanceReviewRuns !== "function") return [];
  return worker.advanceReviewRuns(who, { headSha, rereview });
}

/**
 * Starts one reviewer on the pull request's EXACT head. The run is keyed by (head, role), so a replayed step, a second
 * press of Approve, or a re-review of an unchanged head finds the run that exists and starts nothing. The prompt carries
 * the approved Spec and ends with the AGENT_OUTPUT envelope. The debater also gets the summaries of the reviewers who passed.
 *
 * D#483 S5-k1d: a start a spending limit denied answers the named pause as its reason (and no run id). Each later ask of the same reviewer is a new attempt (`attempt`,
 * the key's `:s<n>` after the re-review round), because the denied key finds its own refused run again.
 */
export async function startReviewerBody(
  worker: ReviewWorker | null,
  who: StepWho,
  ctx: ReviewCtx,
  pr: Pick<PrFound, "number" | "headSha" | "baseRef" | "branch">,
  role: string,
  prior: ReadonlyArray<{ role: string; runId: string }>,
  rereview = 0,
  attempt = 0,
): Promise<StartedReviewer> {
  if (!worker) return { role, runId: null, reason: "worker_unavailable" };
  if (!REVIEW_ROLES.includes(role)) return { role, runId: null, reason: "invalid_input" };
  const spec = await worker.advanceLoadSpecText(who, ctx.specVersion);
  if (spec === null) return { role, runId: null, reason: "spec_changed" };
  const priorSummaries: Array<{ role: string; summary: string }> = [];
  if (role === "debater") {
    for (const p of prior.slice(0, 4)) {
      const o = await worker.advanceRunOutcome(who.accountId, p.runId);
      priorSummaries.push({ role: p.role, summary: readVerdict(o.status, o.envelope).summary });
    }
  }
  let assembled: AssembledPrompt;
  // D#600 CX-10a: a review prompt has no map, so the span is the assembler call alone and `cold` stays unset.
  const assemblyStarted = performance.now();
  try {
    assembled = assembleReviewPrompt({
      role: role as ReviewPromptRole,
      owner: ctx.owner,
      name: ctx.name,
      issue: ctx.issue,
      pr: pr.number,
      headSha: pr.headSha,
      baseRef: pr.baseRef,
      branch: pr.branch,
      version: spec.version,
      spec: spec.body,
      runtime: promptRuntimeOf(ctx.executionMode, role),
      round: (ctx.fixRoundsStarted ?? 0) + 1,
      ...(role === "debater" ? { prior: priorSummaries } : {}),
    });
  } catch (err) {
    if (err instanceof ReviewPromptInputError) return { role, runId: null, reason: `bad_${err.field.toLowerCase()}` };
    throw err;
  }
  const assemblyMs = assemblyMsSince(assemblyStarted);
  const started: AdvanceRunStart = pauseOnDenial(await worker.advanceStartRun({
    accountId: who.accountId,
    workItemId: who.workItemId,
    haltEpoch: who.haltEpoch,
    step: reviewStep(pr.headSha, role, rereview, attempt),
    role,
    prompt: assembled.prompt,
    contextSections: assembled.sections,
    contextAssembly: { ms: assemblyMs },
    clone: true,
    headSha: pr.headSha,
    expectedExecutionMode: ctx.executionMode,
  }));
  if (!started.ok) return { role, runId: null, reason: started.reason };
  await worker.advanceRecordEvent(who, { kind: "review_started", dedupeKey: `review:${pr.headSha}:${role}${rereview > 0 ? `:rr${rereview}` : ""}`, reasons: [toCode(role)], headSha: pr.headSha, prNumber: pr.number, runId: started.runId });
  return { role, runId: started.runId, reason: null };
}

export interface ReviewerOutcome {
  status: string;
  done: boolean;
  /** pass | needs-fix | fail: the exact word, or fail. Meaningful once `done`. */
  verdict: string;
  /** The code reviewer asked for a security review (the JSON boolean true). */
  securityNeeded: boolean;
  /** D#598 P7d: the reviewer says it could not run the tests (the JSON boolean true). */
  environmentFailure: boolean;
  /** The run is `pending` on a runner (a queued runner run): the workflow credits that wait to the pending ceiling, not to the work budget. */
  queuedOnRunner: boolean;
  /** The end of the follow-up chain that starts at the run asked about (D#6 R2b-3, C22 section 7): the id to cancel when the wait runs out. */
  tailRunId: string;
  /** D#599 PL-2: `placement_changed` when the run was cancelled because its item moved to the other side; the driver then starts the step again. Absent otherwise. */
  failureReason?: string | null;
}

/** How a reviewer run stands. The findings and the summary stay in the run: only the verdict word and the flag leave. */
export async function reviewerOutcomeBody(worker: ReviewWorker | null, accountId: string, runId: string): Promise<ReviewerOutcome> {
  if (!worker) return { status: "missing", done: true, verdict: "fail", securityNeeded: false, environmentFailure: false, queuedOnRunner: false, tailRunId: runId };
  const out = await worker.advanceRunOutcome(accountId, runId);
  const v = readVerdict(out.status, out.envelope);
  return { status: out.status, done: out.done, verdict: v.verdict, securityNeeded: v.securityNeeded, environmentFailure: v.environmentFailure, queuedOnRunner: isQueuedOnRunner(out), tailRunId: out.tailRunId ?? runId, ...(out.failureReason === "placement_changed" ? { failureReason: out.failureReason } : {}) };
}

export interface RoundOut {
  decision: string;
  /** Fix rounds already started. */
  round: number;
  nextRound: number | null;
  /** `<role>:<verdict>:<outcome>` per recorded verdict, in the order recorded (passes first). */
  recorded: string[];
}

export interface GatheredInput {
  role: string;
  runId: string;
  verdict: string;
  environmentFailure?: boolean;
}

/** Every verdict of the head recorded in one step: passes first, non-passes last, then the decision. */
export async function recordRoundBody(worker: ReviewWorker | null, who: StepWho, input: { headSha: string; prNumber: number; requiredRoles: string[]; verdicts: GatheredInput[] }): Promise<RoundOut> {
  if (!worker) return { decision: "refused", round: 0, nextRound: null, recorded: [] };
  const out = await worker.advanceRecordRound(who, input);
  // A halt is its own answer, so the workflow can record one stop and end instead of treating it as a failed round.
  if (out.decision === "refused") return { decision: "reason" in out && (out.reason === "item_halted" || out.reason === "halted_since_approval") ? "halted" : "refused", round: 0, nextRound: null, recorded: [] };
  const done = out as Exclude<typeof out, { decision: "refused"; reason: string }>;
  return { decision: done.decision, round: done.round, nextRound: done.nextRound ?? null, recorded: done.recorded.map((r) => `${r.role}:${r.verdict}:${r.outcome}`) };
}

/** D#598 P7c: `all_passed` (a merge-only head, carried forward and recorded), `full_review` (run the reviewers), `ci_pending`, `halted` or `refused`. */
export interface MergeOnlyOut {
  decision: string;
  reason: string | null;
}

/** Asks whether a new head is only a merge of the base branch. Any refusal or missing worker is `full_review`: the reviewers run as they always did. */
export async function recordMergeOnlyBody(worker: ReviewWorker | null, who: StepWho, input: { headSha: string; prNumber: number; baseRef: string; requiredRoles: string[] }): Promise<MergeOnlyOut> {
  if (!worker) return { decision: "full_review", reason: "worker_unavailable" };
  const out = await worker.advanceRecordMergeOnly(who, input);
  if (out.decision === "refused") {
    const reason = "reason" in out ? out.reason : null;
    return reason === "item_halted" || reason === "halted_since_approval" ? { decision: "halted", reason } : { decision: "full_review", reason: reason ?? "refused" };
  }
  return { decision: out.decision, reason: "reason" in out && typeof out.reason === "string" ? out.reason : null };
}

export interface FixOut {
  ok: boolean;
  runId: string | null;
  reason: string | null;
}

const REVIEWER_OF_ROLE: Readonly<Record<string, "code" | "security" | "acceptance">> = { "code-reviewer": "code", "security-reviewer": "security", "acceptance-tester": "acceptance", debater: "code" };

/**
 * The executor's fix round: its prompt is built HERE from the reviewers' findings (read from their runs) and the approved
 * Spec, and the run is a RESUME of the build's sandbox and session through the worker, never a fresh start.
 */
export async function startFixBody(
  worker: ReviewWorker | null,
  who: StepWho,
  ctx: ReviewCtx,
  pr: Pick<PrFound, "number" | "headSha" | "branch">,
  actionId: string,
  round: number,
  failing: ReadonlyArray<{ role: string; runId: string }>,
  retry = 0,
  spendAttempt = 0,
): Promise<FixOut> {
  if (!worker) return { ok: false, runId: null, reason: "worker_unavailable" };
  const first = failing[0];
  if (!first) return { ok: false, runId: null, reason: "invalid_input" };
  const spec = await worker.advanceLoadSpecText(who, ctx.specVersion);
  if (spec === null) return { ok: false, runId: null, reason: "spec_changed" };
  const findings: FixFinding[] = [];
  for (const f of failing.slice(0, 4)) {
    const o = await worker.advanceRunOutcome(who.accountId, f.runId);
    const v = readVerdict(o.status, o.envelope);
    findings.push({ role: f.role, verdict: v.verdict, findings: v.findings, fullFindings: v.fullFindings, summary: v.summary });
  }
  // D#599 PL-2b-2: the round is on the other side of the one that opened the pull request (the pull request lookup follows the newest executor run's side).
  const crossSide = roundIsCrossSide(ctx.prExecutionMode, ctx.executionMode);
  let assembled: AssembledPrompt;
  // The same round with the Spec body: what a fresh session needs (a lost snapshot starts one), and what the worker sends instead when the session's pinned Spec is not the one held.
  let withBody: AssembledPrompt | null = null;
  let heldSpec: { version: number; sha256: string } | null = null;
  // D#600 CX-10a: a fix prompt has no map: the span is the assembler calls alone and `cold` stays unset.
  const assemblyStarted = performance.now();
  try {
    const runtime = promptRuntimeOf(ctx.executionMode);
    // D#600 CX-4a: the findings the caps cut are spilled and marked: a sandbox round reads /fx/context, a runner round the files its runner writes (CX-4b, from the signed job).
    const spillOptions = { spill: true };
    const base = { owner: ctx.owner, name: ctx.name, issue: ctx.issue, pr: pr.number, headSha: pr.headSha, branch: pr.branch, version: spec.version, spec: spec.body, findings, runtime, ...(crossSide ? { crossSide } : {}) };
    // A sandbox fix round resumes the build's own session, so it sends only the unchanged line, and the worker checks that line against the Spec version pinned on
    // the run being continued before it goes out. A runner round may be a follow-up in a fresh session after a lost one, so it keeps the body.
    if (runtime === "sandbox" && spec.sha256 !== undefined) {
      heldSpec = { version: spec.version, sha256: spec.sha256 };
      assembled = assembleFixPrompt({ ...base, heldSpec }, spillOptions);
      withBody = assembleFixPrompt(base, spillOptions);
    } else {
      assembled = assembleFixPrompt(base, spillOptions);
    }
  } catch (err) {
    if (err instanceof ReviewPromptInputError) return { ok: false, runId: null, reason: `bad_${err.field.toLowerCase()}` };
    throw err;
  }
  const assemblyMs = assemblyMsSince(assemblyStarted);
  const started = await worker.advanceStartFix(who, {
    issue: ctx.issue,
    headSha: pr.headSha,
    prompt: assembled.prompt,
    contextSections: assembled.sections,
    contextAssembly: { ms: assemblyMs },
    ...(assembled.spill ? { contextSpill: assembled.spill } : {}),
    ...(heldSpec && withBody ? { held: heldSpec, fallbackPrompt: withBody.prompt, fallbackContextSections: withBody.sections, ...(withBody.spill ? { fallbackContextSpill: withBody.spill } : {}) } : {}),
    round,
    actionId,
    ...(retry > 0 ? { retry } : {}),
    // D#483 S5-k1d: the number of the ask when an earlier ask of this round was denied by a spending limit (the first ask carries none).
    ...(spendAttempt > 0 ? { spendAttempt } : {}),
    reviewer: REVIEWER_OF_ROLE[first.role] ?? "code",
    failingRunId: first.runId,
    expectedExecutionMode: ctx.executionMode,
    // The pull request the pipeline just found on GitHub: a cross-side round works on its branch. The worker checks it against the item's own record.
    ...(crossSide ? { pr: { number: pr.number, branch: pr.branch } } : {}),
  });
  // A spending-limit denial comes back as its named pause (the driver waits and asks again); every other refusal keeps the code it came with.
  return started.ok ? { ok: true, runId: started.runId, reason: null } : { ok: false, runId: null, reason: pauseForDenial(started.reason) ?? started.reason };
}

export interface DescentOut {
  /** `not_needed`: not a cross-side sandbox round. `descends`: the new head is ahead of (or is) the head the round was dispatched on. `rewritten`: it is not. `unavailable`: GitHub could not say. */
  state: "not_needed" | "descends" | "rewritten" | "unavailable";
}

/**
 * D#599 PL-2b-2 (security model 5): after a cross-side SANDBOX round moved the pull request's head, GitHub must say the new head descends from the head the round
 * started on (compare status `ahead`). Anything else (`behind`, `diverged`) means the branch was rewritten under the round: it ends `failed branch_rewritten` and
 * nothing is reviewed. Not asked for a runner round (its push is fast-forward by construction and a runner_local repository's fence has no compare call).
 */
export async function fixDescentBody(open: OpenHttp | null, ctx: Pick<ReviewCtx, "repoId" | "owner" | "name" | "executionMode" | "prExecutionMode">, base: string, head: string): Promise<DescentOut> {
  // Only a sandbox round on the other side of the one that opened the pull request is checked here.
  if (!roundIsCrossSide(ctx.prExecutionMode, ctx.executionMode) || promptRuntimeOf(ctx.executionMode) !== "sandbox") return { state: "not_needed" };
  if (!open) return { state: "unavailable" };
  try {
    const http = await openForRepo(open, ctx.executionMode, "read", { repoId: ctx.repoId, owner: ctx.owner, name: ctx.name });
    const out = await compareHeads(http, { owner: ctx.owner, name: ctx.name, base, head });
    if (!out.ok) return { state: "unavailable" };
    return { state: out.status === "ahead" || out.status === "identical" ? "descends" : "rewritten" };
  } catch {
    // fx-swallow-ok: a fixed state is returned and the driver stops with it; the error text can name a repository
    console.warn(JSON.stringify({ event: "advance.fix_compare_failed", repo_id: ctx.repoId }));
    return { state: "unavailable" };
  }
}

export interface GateOut {
  outcome: string;
  reasons: string[];
  status: string | null;
  headSha: string | null;
}

export async function mergeGateBody(worker: ReviewWorker | null, who: StepWho, prNumber: number): Promise<GateOut> {
  if (!worker) return { outcome: "refused", reasons: ["worker_unavailable"], status: null, headSha: null };
  const out = await worker.advanceMergeGate(who, prNumber);
  return { outcome: out.outcome, reasons: out.reasons ?? (out.reason ? [out.reason] : []), status: out.status ?? null, headSha: out.headSha ?? null };
}

/** A fact of the item, in the fixed vocabulary. */
export async function eventBody(worker: ReviewWorker | null, who: StepWho, event: Parameters<ReviewWorker["advanceRecordEvent"]>[1]): Promise<void> {
  if (!worker) return;
  await worker.advanceRecordEvent(who, event);
}

/** Stops a live run of the item (the existing cancel path). */
export async function cancelBody(worker: ReviewWorker | null, who: StepWho, runId: string): Promise<void> {
  if (!worker) return;
  await worker.advanceCancel(who, runId);
}

/**
 * "Check the build" found the item's pull request while the item still sits at In progress: records In progress -> PR opened
 * (the webhook never did), so the review that follows can record its verdicts. Any other stage is left alone.
 */
export async function prFoundBody(worker: ReviewWorker | null, who: StepWho, prNumber: number): Promise<string | null> {
  if (!worker) return null;
  const out = await worker.advancePrFound(who, prNumber);
  return out.stage ?? null;
}
