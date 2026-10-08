import type { AdvanceFacade, AdvanceRunStart } from "@fx/worker";
import type { InstallationHttp, InstallationHttpKind, InstallationHttpTarget } from "@fx/github";
import { toCode } from "@fx/core/src/work-items/driverEvents.js";
import {
  ReviewPromptInputError,
  buildFixPrompt,
  buildReviewPrompt,
  findOpenPullRequest,
  listChangedFiles,
  readVerdict,
  reviewPlanFor,
  securityTriggers,
  type FixFinding,
  type ReviewPromptRole,
} from "@fx/pipeline";
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
  | "advanceStartFix"
  | "advanceMergeGate"
  | "advanceRecordEvent"
  | "advanceCancel"
  | "advancePrFound"
>;

/** Opens the GitHub client for one repository (apps/web/lib/github/installationHttp.ts in production). */
export type OpenHttp = (kind: InstallationHttpKind, target: InstallationHttpTarget) => Promise<InstallationHttp>;

export interface ReviewCtx {
  repoId: string;
  owner: string;
  name: string;
  /** The issue's number. */
  issue: number;
  tier: string;
  /** The Spec version the person approved. */
  specVersion: number;
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
  return { ok: true, repoId: c.repoId, owner: c.owner, name: c.name, issue: c.issue, tier: c.tier, specVersion: c.specVersion, debaterEnabled: c.debaterEnabled };
}

export interface PrFound {
  ok: true;
  number: number;
  headSha: string;
  baseRef: string;
  /** The diff check's codes for this pull request (empty: it touches none of the security surfaces). */
  securityCodes: string[];
}
export type PrLookup = PrFound | { ok: false; reason: string };

/** The executor's open pull request (`fx/issue-<n>`), its head commit, and the security surfaces its diff touches. */
export async function findPrBody(open: OpenHttp | null, ctx: Pick<ReviewCtx, "repoId" | "owner" | "name" | "issue">): Promise<PrLookup> {
  if (!open) return { ok: false, reason: "github_unavailable" };
  try {
    const http = await open("read", { repoId: ctx.repoId, owner: ctx.owner, name: ctx.name });
    const found = await findOpenPullRequest(http, { owner: ctx.owner, name: ctx.name, issue: ctx.issue });
    if (!found.ok) return { ok: false, reason: found.reason };
    const files = await listChangedFiles(http, { owner: ctx.owner, name: ctx.name, pr: found.pr.number });
    if (!files.ok) return { ok: false, reason: files.reason };
    const codes = securityTriggers({ files: files.files, truncated: files.truncated });
    return { ok: true, number: found.pr.number, headSha: found.pr.headSha, baseRef: found.pr.baseRef, securityCodes: codes };
  } catch {
    // fx-swallow-ok: a fixed code is returned and the driver stops with it; the error text can name a repository
    console.warn(JSON.stringify({ event: "advance.pr_lookup_failed", repo_id: ctx.repoId }));
    return { ok: false, reason: "github_unavailable" };
  }
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
 * Starts one reviewer on the pull request's EXACT head. The run is keyed by (head, role), so a replayed step, a second
 * press of Approve, or a re-review of an unchanged head finds the run that exists and starts nothing. The prompt carries
 * the approved Spec and ends with the AGENT_OUTPUT envelope. The debater also gets the summaries of the reviewers who passed.
 */
export async function startReviewerBody(
  worker: ReviewWorker | null,
  who: StepWho,
  ctx: ReviewCtx,
  pr: Pick<PrFound, "number" | "headSha" | "baseRef">,
  role: string,
  prior: ReadonlyArray<{ role: string; runId: string }>,
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
  let prompt: string;
  try {
    prompt = buildReviewPrompt({
      role: role as ReviewPromptRole,
      owner: ctx.owner,
      name: ctx.name,
      issue: ctx.issue,
      pr: pr.number,
      headSha: pr.headSha,
      baseRef: pr.baseRef,
      version: spec.version,
      spec: spec.body,
      ...(role === "debater" ? { prior: priorSummaries } : {}),
    });
  } catch (err) {
    if (err instanceof ReviewPromptInputError) return { role, runId: null, reason: `bad_${err.field.toLowerCase()}` };
    throw err;
  }
  const started: AdvanceRunStart = await worker.advanceStartRun({
    accountId: who.accountId,
    workItemId: who.workItemId,
    haltEpoch: who.haltEpoch,
    step: `review:${pr.headSha}:${role}`,
    role,
    prompt,
    clone: true,
    headSha: pr.headSha,
  });
  if (!started.ok) return { role, runId: null, reason: started.reason };
  await worker.advanceRecordEvent(who, { kind: "review_started", dedupeKey: `review:${pr.headSha}:${role}`, reasons: [toCode(role)], headSha: pr.headSha, prNumber: pr.number, runId: started.runId });
  return { role, runId: started.runId, reason: null };
}

export interface ReviewerOutcome {
  status: string;
  done: boolean;
  /** pass | needs-fix | fail: the exact word, or fail. Meaningful once `done`. */
  verdict: string;
  /** The code reviewer asked for a security review (the JSON boolean true). */
  securityNeeded: boolean;
  /** The run is `pending` on a runner (a queued runner run): the workflow credits that wait to the pending ceiling, not to the work budget. */
  queuedOnRunner: boolean;
  /** The end of the follow-up chain that starts at the run asked about (D#6 R2b-3, C22 section 7): the id to cancel when the wait runs out. */
  tailRunId: string;
}

/** How a reviewer run stands. The findings and the summary stay in the run: only the verdict word and the flag leave. */
export async function reviewerOutcomeBody(worker: ReviewWorker | null, accountId: string, runId: string): Promise<ReviewerOutcome> {
  if (!worker) return { status: "missing", done: true, verdict: "fail", securityNeeded: false, queuedOnRunner: false, tailRunId: runId };
  const out = await worker.advanceRunOutcome(accountId, runId);
  const v = readVerdict(out.status, out.envelope);
  return { status: out.status, done: out.done, verdict: v.verdict, securityNeeded: v.securityNeeded, queuedOnRunner: isQueuedOnRunner(out), tailRunId: out.tailRunId ?? runId };
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
  pr: Pick<PrFound, "number" | "headSha">,
  actionId: string,
  round: number,
  failing: ReadonlyArray<{ role: string; runId: string }>,
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
    findings.push({ role: f.role, verdict: v.verdict, findings: v.findings, summary: v.summary });
  }
  let prompt: string;
  try {
    prompt = buildFixPrompt({ owner: ctx.owner, name: ctx.name, issue: ctx.issue, pr: pr.number, headSha: pr.headSha, version: spec.version, spec: spec.body, findings });
  } catch (err) {
    if (err instanceof ReviewPromptInputError) return { ok: false, runId: null, reason: `bad_${err.field.toLowerCase()}` };
    throw err;
  }
  const started = await worker.advanceStartFix(who, {
    issue: ctx.issue,
    headSha: pr.headSha,
    prompt,
    round,
    actionId,
    reviewer: REVIEWER_OF_ROLE[first.role] ?? "code",
    failingRunId: first.runId,
  });
  return started.ok ? { ok: true, runId: started.runId, reason: null } : { ok: false, runId: null, reason: started.reason };
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
