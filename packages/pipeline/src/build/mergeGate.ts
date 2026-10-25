import type { Pool, PoolClient } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { MAX_REFRESHES } from "../mergeQueue/policy.js";
import { effectiveRunRows, type HeadRuns } from "../mergeQueue/carryForward.js";
import { requiredReviewers, shouldDispatchDebater } from "./requiredReviewers.js";
import type { PipelineRole, PullRequestRef, WorkItemTier } from "./types.js";

/**
 * D#2 H14b: the merge gate (H14 criterion 3 as REPLACED by correction C11).
 *
 * The gate runs as a workflow step outside any sandbox. It reads the PR's
 * current head SHA from GitHub, then requires every condition below FOR
 * THAT SHA, and otherwise marks the PR "ready, human merges":
 *
 *   - each required role's latest `agent_runs` row for this work item and
 *     this head SHA has `status = 'succeeded'`, `runtime = 'production'`
 *     (an allowlist: `'local'` and a future `'runner'` never count) and
 *     `envelope.verdict = 'pass'`;
 *   - CI is green for that SHA (check runs and statuses read by SHA);
 *   - `autoMergeAllowed` (H07) is exactly `true`;
 *   - the merge call carries GitHub's `sha` parameter set to that SHA, so
 *     a push after review makes GitHub refuse instead of letting stale
 *     verdicts carry the merge.
 *
 * WHAT THE GATE NEVER READS. Labels are display only (C11). The gate's
 * ports return structured state only -- a head SHA, `agent_runs` columns,
 * check-run and status enums -- so nothing a PR author, a commenter or a
 * model wrote (a PR body, a comment, a label, a summary in the envelope)
 * has a path into the decision. `envelope.verdict` is compared with `===`
 * against the literal `"pass"`; every other value, shape or spelling
 * blocks the merge. Every branch fails closed.
 *
 * Reading of C11 recorded here, not silently picked: C11 says
 * acceptance-tester's "latest row on that SHA must not be a fail". H14a
 * always dispatches acceptance-tester (`requiredReviewers`), so the gate
 * treats it like every other required role: a row must exist and pass. A
 * missing or unparsed acceptance result therefore blocks, which is the
 * stricter of the two readings and can never merge something the looser
 * one would refuse.
 *
 * A REJECTION ALWAYS VETOES. The required set comes from caller inputs
 * (`tier`, `securityDiffTriggerFired`, `debaterEnabled`) that are not tied
 * to the head SHA, so the gate loads rows for EVERY gated role. A role
 * outside the required set is not demanded, but if its latest TERMINAL row
 * on this exact SHA is not a succeeded pass, the merge is refused whatever
 * the caller's inputs say (CWE-636: a tier downgrade or a flipped trigger
 * must never turn a recorded needs-fix into a merge). A newer pending /
 * running / paused row does not displace that terminal row, and any status
 * outside that non-terminal list counts as terminal (fail closed).
 *
 * H14c-1 (hardening): CI snapshots must be complete (`CiSnapshot` doc), the
 * veto path shares the required path's definition of a pass (production
 * runtime), and overlapping live runs of one reviewer role on one head
 * cannot exist (migration 0643 + `dispatchReviewers`'s `already_dispatched`
 * outcome). The production port is `githubMergePort.ts`.
 *
 * D#6 R3b (correction C12 section 1, the owner ruling). For a `runner_local` repo ONLY, reviews run on the customer's machine
 * and may count, when ALL of the following hold; every other repo keeps the `production` rule above exactly:
 *   (a) the repo's admin-set opt-in is on (`reviewMode: "runner_local_on"`; until the opt-in exists the port says off, so
 *       `runner_local_off` is what the gate sees and it never merges);
 *   (b) the verdict row is a succeeded `runtime = 'runner'` run of a `runner_local` run on this exact head whose `runner_id`
 *       names a runner of this account that is not revoked and whose `registered_by` holds owner or admin NOW (computed in SQL
 *       at evaluation; a runner registered by anyone else is advisory and blocks);
 *   (c) GitHub still decides CI and protection: CI green on the head AS READ FROM GITHUB, at least one check or status that is
 *       NOT our own `fulcrumaxe/review` (a repo's own CI, so a faked pass cannot be its own CI signal), and the base branch
 *       protected (a classic protection rule or a ruleset). Each missing piece is its own block reason;
 *   (d) the `fulcrumaxe/review` status says "Local review" (githubReads.ts);
 *   (e) same reviewers and role cards (the job carries them).
 * A `runner_local` repo with the opt-in off never merges here, whatever the rows say (`local_review_not_enabled`).
 *
 * WIRING (H14c). This module is not wired to anything yet. H14c is where
 * `isAutoMergeAllowed` (H07's `autoMergeAllowed` from `@fx/trust`) and
 * `requestReviews` (H14a's `dispatchReviewers`) get their production
 * wiring, alongside the real GitHub port and the workflow step.
 *
 * NOT here (C25): `openMergeApproval()` when the gate passes but
 * auto-merge is off. `packages/merge-approvals` (D#29 BV10) is not on
 * main; C25 says BV10 adds that call if it lands after H14. The
 * `markReadyForHumanMerge` port is the single place it will attach.
 */

/** The PR as GitHub reports it through our App. Structured fields only. */
export interface PullRequestState {
  headSha: string;
  state: "open" | "closed";
  merged: boolean;
  draft: boolean;
  /** D#598 P3b: the branch the PR merges INTO, and the repository's default branch, both as GitHub reports them on the PR. The gate merges
   * only when they are equal; a port that cannot read either throws (it is never "the default"). */
  baseRef: string;
  defaultBranch: string;
}

export interface CheckRunState {
  name: string;
  status: string;
  conclusion: string | null;
  /** The GitHub App that reported the run. Absent or null never satisfies an
   * app-bound required check. */
  appId?: number | null;
}

/** A required check that protection or a ruleset binds to one GitHub App:
 * only a check run of that name reported by that app satisfies it. */
export interface RequiredAppCheck {
  context: string;
  appId: number;
}

export interface CommitStatusState {
  context: string;
  state: string;
}

/**
 * CI for ONE commit. `headSha` is the SHA GitHub attributed the data to;
 * the gate re-checks it against the head it is gating, so a port that
 * answered for the wrong commit (a branch lookup, a stale cache) cannot
 * turn a green older commit into a green head. `statuses` is the combined
 * status: the LATEST state per context.
 *
 * A SNAPSHOT MUST BE COMPLETE (H14c-CI-1..3). A port that reads only the
 * first page of check runs, or that reads before a slower CI system has
 * posted anything, would otherwise look green. So the snapshot carries:
 *   - the API's own `total_count` for check runs and for statuses; a
 *     snapshot whose collected list is not exactly that long is incomplete
 *     and is NOT green;
 *   - `requiredContexts`: the status-check contexts the base branch's
 *     protection or rulesets require (empty = none configured). Each must
 *     be present on the SHA and successful.
 * A port that cannot establish any of these must throw (the step retries),
 * never return a best-effort snapshot.
 */
export interface CiSnapshot {
  headSha: string;
  checkRuns: readonly CheckRunState[];
  checkRunsTotalCount: number;
  statuses: readonly CommitStatusState[];
  statusesTotalCount: number;
  requiredContexts: readonly string[];
  /** The subset of `requiredContexts` that is bound to an app (also present
   * by name in `requiredContexts`). Required: an omitted list is a malformed
   * snapshot, not "no bindings". */
  requiredAppChecks: readonly RequiredAppCheck[];
  /** D#6 R3b: the base branch is protected (a classic protection rule or a ruleset that applies to it), as GitHub says. Absent
   * reads as not protected: only a `runner_local` repo's gate asks for it, and it fails closed. */
  baseBranchProtected?: boolean;
  /** The branch-protection read was refused (403) or answered 404 without GitHub's own messages, so the required checks are UNKNOWN,
   * not empty. CI is never green from such a snapshot, in any mode. */
  protectionUnreadable?: boolean;
}

/**
 * What the one merge call answered. Two planes, `runner_local`: the port's merge call does not merge. It hands the merge to the customer's runner (an order
 * placed, or the single write credential authorized) and answers `delegated: true`; or, when it could not even do that, `delegated: false` with the reason a
 * person sees. Neither is a refusal by the host, so neither is classified from a re-read.
 */
export type MergeCallOutcome = { merged: true } | { merged: false; httpStatus: number } | { merged: false; delegated: true } | { merged: false; delegated: false; reason: MergeBlockReason };

/** GitHub's documented `mergeable_state` values. A value GitHub adds later reads as `unknown`, which never classifies anything. */
export type MergeableState = "clean" | "behind" | "dirty" | "blocked" | "unstable" | "has_hooks" | "draft" | "unknown";

/**
 * D#519 MQ1: the pull request as GitHub reports its mergeability. `mergeable` is `null` while GitHub is still computing it in the
 * background; a port polls that itself (bounded) and returns `null` only when the bound was spent, which no caller may read as
 * either answer. `behind` is reported only when the base branch requires up-to-date branches, so "is it behind" for any other repo
 * comes from `compareToBase`, never from this.
 */
export interface PullRequestMergeability {
  headSha: string;
  state: "open" | "closed";
  merged: boolean;
  mergeable: boolean | null;
  mergeableState: MergeableState;
}

/** GitHub's compare `status`: the head relative to the base branch. */
export type CompareStatus = "ahead" | "behind" | "diverged" | "identical";

/**
 * D#519 MQ1: `GET /compare/{base}...{head}`. `behindBy` is how many commits the base branch has that the head lacks. `files` is the
 * set of paths the head changed since the merge base (a rename lists both names), or `null` when the caller did not ask for them.
 * GitHub returns files on one response only and at most 300 for the whole comparison. When the cap is reached `filesTruncated` is
 * true and `files` is `null`: the set is unknown, so a caller MUST treat it as overlapping anything (never as disjoint).
 */
export interface BranchComparison {
  status: CompareStatus;
  aheadBy: number;
  behindBy: number;
  files: readonly string[] | null;
  filesTruncated: boolean;
}

/**
 * D#519 MQ1: what GitHub's update-branch endpoint amounted to. `accepted` is only the 202: GitHub merges the base into the branch
 * LATER, so the head has not changed yet and nothing has been refreshed. `conflict` is a 422 with an unmoved head and `mergeable:
 * false`; `head_moved` is a 422 whose re-read head differs from the `expected_head_sha` sent. Any other answer throws.
 */
export type UpdateBranchOutcome = { outcome: "accepted" } | { outcome: "conflict" } | { outcome: "head_moved"; newHeadSha: string };

export interface MergeGateGitHubPort {
  getPullRequest(pr: PullRequestRef): Promise<PullRequestState>;
  /** D#519 MQ1: the pull request's mergeability, with `mergeable: null` already polled (see `PullRequestMergeability`). With `gatedHeadSha`, polling stops as soon as the head differs from it (a moved head needs no mergeability). */
  getMergeability(pr: PullRequestRef, opts?: { gatedHeadSha?: string }): Promise<PullRequestMergeability>;
  /** D#519 MQ1: `PUT .../update-branch` with `expected_head_sha`. Asynchronous on GitHub's side (see `UpdateBranchOutcome`). */
  updateBranch(pr: PullRequestRef, args: { expectedHeadSha: string }): Promise<UpdateBranchOutcome>;
  /** D#519 MQ1: the base branch against `headSha`. `files` asks for the changed paths too (every page). */
  compareToBase(pr: PullRequestRef, headSha: string, opts?: { files?: boolean }): Promise<BranchComparison>;
  /** D#519 MQ1: whether protection or a ruleset on the base branch requires branches to be up to date. A read that cannot be made throws; it is never "not required". */
  requiresUpToDateBranch(pr: PullRequestRef): Promise<boolean>;
  getCiSnapshot(pr: PullRequestRef, headSha: string): Promise<CiSnapshot>;
  /** Must send GitHub's `sha` parameter. */
  mergePullRequest(pr: PullRequestRef, args: { sha: string }): Promise<MergeCallOutcome>;
  /** The "ready, human merges" marking. Display only; `reasons` are
   * closed-vocabulary codes, never free text. */
  markReadyForHumanMerge(pr: PullRequestRef, args: { headSha: string; reasons: readonly MergeBlockReason[] }): Promise<void>;
}

export interface MergeGateDeps {
  pool: Pool;
  github: MergeGateGitHubPort;
  /** H07's `autoMergeAllowed(workItem, repoSettings)`, resolved by the
   * caller from `work_items.provenance` and the repo's guard settings.
   * Only the exact boolean `true` counts. Injected because this package
   * does not depend on `@fx/trust`. */
  isAutoMergeAllowed(input: { accountId: string; workItemId: string }): Promise<unknown>;
  /** Called when the merge is refused because the head moved, and when the
   * head being gated has no reviewer rows at all: request the reviews on
   * that SHA (H14c wires this to `dispatchReviewers`). */
  requestReviews(pr: PullRequestRef, newHeadSha: string): Promise<void>;
  /** D#598 P3b: the number of the open pull request this one builds on (the stack parent's), for the sentence a person reads. Absent or
   * null: not known; the stop still holds. A throw is read as not known: it can only change the wording, never the stop. */
  stackParentPullNumber?(input: { accountId: string; workItemId: string }): Promise<number | null>;
}

export interface MergeGateInput {
  accountId: string;
  workItemId: string;
  pr: PullRequestRef;
  tier: WorkItemTier;
  securityDiffTriggerFired: boolean;
  debaterEnabled: boolean;
  /**
   * D#6 R3b: how the repo's reviews are judged. Absent or `"cloud"`: today's rule, `runtime = 'production'` only.
   * `"runner_local_off"`: a `runner_local` repo whose admin has not turned auto-merge on for runner reviews (the default):
   * the production rule, plus a block that always holds. `"runner_local_on"`: runner verdicts that meet (b) count, and (c) applies.
   */
  reviewMode?: ReviewMode;
  /**
   * D#6 M1G-a: the operator locked this repository to human merges (`humanMergeOnly(repoGhId)` in @fx/db, read by the caller
   * once per request). When `true` the gate adds `human_merge_only` and never calls merge, whatever the review mode, the opt-in
   * or `autoMerge` says. Absent or false: today's rule.
   */
  humanMergeOnly?: boolean;
  /**
   * Two planes: the head the reviewers judged, when the pull request merged is a different commit (a paired item's public pull request; the reviewers
   * ran on the private run branch's head). Reviewer records are read at this head. CI, the `sha` bound to the merge and the marking stay on the head
   * of `pr`. Absent: the head of `pr` is both, as for a single-plane repository.
   */
  reviewedHeadSha?: string;
  /**
   * Two planes: the head of `pr` the caller already checked (its stamp, its changed files). The gate reads the pull request itself and, when that head is
   * not this one, stops with `head_moved` BEFORE reading CI or merging, so every decision is made for one commit. Absent: no such check.
   */
  expectedHeadSha?: string;
  /** Stops the caller already knows (e.g. `public_head_unrecorded`); any entry means the gate does not merge and marks the pull request for a person. */
  extraBlockReasons?: readonly MergeBlockReason[];
  /**
   * Two planes, `runner_local`: the cloud never calls merge for such a repository's public pull request (its merge belongs to the customer's runner or to a
   * person). When every other condition is met, the gate stops here instead of merging and marks the pull request for a person with this reason. Absent:
   * today's rule. A condition that already blocks is reported as it is; this reason appears only on a pull request that would otherwise have merged.
   */
  mergeUnavailableReason?: MergeBlockReason;
}

export type ReviewMode = "cloud" | "runner_local_off" | "runner_local_on";

export type MergeBlockReason =
  | "pr_draft"
  | "head_sha_malformed"
  | "missing_run_code_reviewer"
  | "missing_run_security_reviewer"
  | "missing_run_acceptance_tester"
  | "missing_run_debater"
  | "run_not_succeeded_code_reviewer"
  | "run_not_succeeded_security_reviewer"
  | "run_not_succeeded_acceptance_tester"
  | "run_not_succeeded_debater"
  | "run_not_production_code_reviewer"
  | "run_not_production_security_reviewer"
  | "run_not_production_acceptance_tester"
  | "run_not_production_debater"
  | "runner_not_trusted_code_reviewer"
  | "runner_not_trusted_security_reviewer"
  | "runner_not_trusted_acceptance_tester"
  | "runner_not_trusted_debater"
  | "verdict_not_pass_code_reviewer"
  | "verdict_not_pass_security_reviewer"
  | "verdict_not_pass_acceptance_tester"
  | "verdict_not_pass_debater"
  | "run_timestamp_invalid"
  | "ci_not_green"
  | "repo_ci_missing"
  | "no_branch_protection"
  | "local_review_not_enabled"
  | "local_reviews_passed_advisory"
  | "auto_merge_not_allowed"
  | "human_merge_only"
  /** Two planes: the public pull request's head is not the one the platform last pushed (a push not recorded yet, or a branch changed by someone else). */
  | "public_head_unrecorded"
  /** Two planes: a person took the public branch over, so what it holds was not reviewed here; the merge is theirs. */
  | "public_branch_person_managed"
  /** Two planes: the public head was built from a private head other than the one the reviewers cleared. */
  | "public_head_not_reviewed"
  /** Two planes: the item's repository is paired and its public pull request is not open (not opened yet, closed or merged). The private copy never merges in its place. */
  | "public_pr_not_open"
  /** Two planes, `runner_local`: everything else is met, but the cloud does not merge such a repository's pull request and no runner step exists yet; a person merges. */
  | "runner_merge_unavailable"
  /** Two planes, `runner_local`: the runner did not finish a merge order in time (60 minutes); a person merges. */
  | "runner_merge_timeout"
  /** Two planes, `runner_local`: the runner's merge order failed (its attempts ran out, or the credential could not be issued); a person merges. */
  | "runner_merge_failed"
  /** Two planes, `runner_local`: the runner said it merged and GitHub does not say so (or names another head); nothing is recorded as merged and a person looks. */
  | "runner_report_mismatch"
  /** D#598 P3b (C3 R-598-P5b-6): the PR's base is not the repository's default branch, so it builds on a pull request that has not merged. */
  | "stacked_on_open_pr"
  /** Rides with `stacked_on_open_pr` when the parent's pull request number is known: the number the page puts in its sentence. */
  | `stacked_on_pr_${number}`
  /** The residual: GitHub refused the merge and nothing below explains it. */
  | "merge_call_refused"
  // D#519: the merge queue's distinct stops. `merge_conflict`, `branch_behind` and `branch_protection_refused` are what the gate
  // itself answers after a refused merge (MQ1); the rest are produced by the queue and the ordered-resource check (MQ2 to MQ5).
  | "merge_queue_waiting"
  | "branch_behind"
  | "merge_conflict"
  | "branch_protection_refused"
  | "ordered_resource_out_of_order"
  | "merge_dependency_closed"
  | "history_rewritten";

export type MergeGateResult =
  | { outcome: "merged"; headSha: string }
  /** Two planes, `runner_local`: every condition was met and the merge was handed to the customer's runner (see `MergeCallOutcome`). Nothing merged, nothing marked. */
  | { outcome: "merge_delegated"; headSha: string }
  | { outcome: "ready_human_merges"; headSha: string; reasons: MergeBlockReason[] }
  /** The PR is closed or already merged: nothing to gate, nothing marked
   * (a merged PR must never be labelled "ready, human merges"). */
  | { outcome: "pr_not_open"; headSha: string }
  /** GitHub refused the merge because the head moved (409/422 and the
   * head really is different now): nothing merged, reviews requested. */
  | { outcome: "head_moved"; staleHeadSha: string; newHeadSha: string };

export type GatedRole = Extract<PipelineRole, "code-reviewer" | "security-reviewer" | "acceptance-tester" | "debater">;

const ROLE_CODE: Record<GatedRole, string> = {
  "code-reviewer": "code_reviewer",
  "security-reviewer": "security_reviewer",
  "acceptance-tester": "acceptance_tester",
  debater: "debater",
};

const ALL_GATED_ROLES = Object.keys(ROLE_CODE) as GatedRole[];

/** `agent_runs.status` values that are still in flight. `status` has no
 * CHECK constraint, so the gate enumerates the NON-terminal set and treats
 * every other value, including one it has never heard of, as terminal: an
 * unknown status carrying a rejection must veto, not hide (fail closed). */
export const NON_TERMINAL_STATUSES: readonly string[] = ["pending", "running", "paused"];

/** The required roles: H14a's dispatch set, plus the debater where it is
 * enabled for a Feature or Critical item. One source of truth with what
 * `dispatchReviewers`/`dispatchDebaterIfNeeded` actually run. */
export function gatedRoles(input: Pick<MergeGateInput, "tier" | "securityDiffTriggerFired" | "debaterEnabled">): GatedRole[] {
  const roles: GatedRole[] = requiredReviewers({ tier: input.tier, securityDiffTriggerFired: input.securityDiffTriggerFired });
  if (shouldDispatchDebater(input.tier, input.debaterEnabled)) {
    roles.push("debater");
  }
  return roles;
}

/** The commit status context the platform posts when its reviewers pass (also in review/githubReads.ts, which imports this). */
export const REVIEW_STATUS_CONTEXT_NAME = "fulcrumaxe/review";

/**
 * The repository's own CI passed on this commit. Counts only a check run that has completed with `success` or `neutral`
 * (a `skipped`, failed, cancelled or still-running check proves nothing), and a commit status in state `success`, from
 * anything other than the platform's own review status. Names are compared case-insensitively, so a differently cased
 * `fulcrumaxe/review` is still ours and never counts as the repository's CI.
 */
export function hasRepoOwnCi(snapshot: CiSnapshot): boolean {
  const ours = REVIEW_STATUS_CONTEXT_NAME.toLowerCase();
  return (
    snapshot.checkRuns.some((c) => c.name.toLowerCase() !== ours && c.status === "completed" && (c.conclusion === "success" || c.conclusion === "neutral")) ||
    snapshot.statuses.some((s) => s.context.toLowerCase() !== ours && s.state === "success")
  );
}

export const SHA_PATTERN =/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** Check-run conclusions that count as green. `neutral` and `skipped` are
 * GitHub's non-blocking outcomes; everything else (failure, cancelled,
 * timed_out, action_required, stale, null) is not green. */
const GREEN_CONCLUSIONS: ReadonlySet<string> = new Set(["success", "neutral", "skipped"]);

function isGreenCheck(c: CheckRunState): boolean {
  return c.status === "completed" && c.conclusion !== null && GREEN_CONCLUSIONS.has(c.conclusion);
}

const isCount = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

/**
 * Green means: the snapshot is for this exact SHA and is COMPLETE (each
 * list is exactly as long as the API's `total_count`), there is at least one
 * check or status (a commit with no CI signal is not proven green), every
 * check run has completed with a green conclusion, every status context is
 * `success`, and every required context is present and green. Anything the
 * snapshot does not show is not assumed.
 */
export function isCiGreen(snapshot: CiSnapshot, headSha: string): boolean {
  if (snapshot.headSha !== headSha) return false;
  if (snapshot.protectionUnreadable === true) return false;
  if (!Array.isArray(snapshot.checkRuns) || !Array.isArray(snapshot.statuses)) return false;
  if (!isCount(snapshot.checkRunsTotalCount) || snapshot.checkRuns.length !== snapshot.checkRunsTotalCount) return false;
  if (!isCount(snapshot.statusesTotalCount) || snapshot.statuses.length !== snapshot.statusesTotalCount) return false;
  if (!Array.isArray(snapshot.requiredContexts) || !snapshot.requiredContexts.every((c) => typeof c === "string")) return false;
  if (
    !Array.isArray(snapshot.requiredAppChecks) ||
    !snapshot.requiredAppChecks.every((r) => typeof r?.context === "string" && typeof r.appId === "number")
  ) {
    return false;
  }
  if (snapshot.checkRuns.length + snapshot.statuses.length === 0) return false;
  if (!snapshot.checkRuns.every(isGreenCheck)) return false;
  if (!snapshot.statuses.every((s) => s.state === "success")) return false;
  // A same-named run from another app (and any commit status, which has no
  // app) does not satisfy an app-bound requirement.
  if (!snapshot.requiredAppChecks.every((r) => snapshot.checkRuns.some((c) => c.name === r.context && c.appId === r.appId))) return false;
  return snapshot.requiredContexts.every((ctx) => {
    const checks = snapshot.checkRuns.filter((c) => c.name === ctx);
    const statuses = snapshot.statuses.filter((s) => s.context === ctx);
    // Present under that name and, given the every-signal rule above, green.
    return checks.length + statuses.length > 0;
  });
}

export interface RunRow {
  role: string;
  status: string;
  runtime: string;
  verdict: string | null;
  /** Computed in SQL: the row is TERMINAL and its `created_at` equals the
   * greatest `created_at` among the role's terminal rows on this SHA. A
   * newer in-flight row does not displace it. */
  is_latest_terminal: boolean;
  /** Computed in SQL: this row's `created_at` equals the greatest
   * `created_at` among the rows for its role on this SHA. */
  is_latest: boolean;
  /** Computed in SQL: `created_at` is a finite timestamp. node-pg cannot
   * parse 'infinity' into a Date, so the timestamp is never read in JS. */
  ts_ok: boolean;
  /** Computed in SQL (D#6 R3b, safeguard (b)): the row is a `runner_local` runner run whose runner is of this account, not revoked,
   * and registered by someone who holds owner or admin on the account right now. False for every other row. */
  runner_admin_ok?: boolean;
}

/** SQL for `RunRow.runner_admin_ok`, for a query over `agent_runs` aliased `ar`. One definition, shared with the security-flag read. */
export const RUNNER_ADMIN_OK_SQL = `(ar.runtime = 'runner' AND ar.execution_mode = 'runner_local' AND ar.runner_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM runners rn
           JOIN account_members am ON am.account_id = rn.account_id AND am.user_id = rn.registered_by AND am.role IN ('owner', 'admin')
          WHERE rn.account_id = ar.account_id AND rn.id = ar.runner_id AND rn.revoked_at IS NULL))`;

/** Whether a run row's runtime counts toward the gate: `production`, or (local review on) a trusted runner's run. */
function runtimeCounts(r: RunRow, localOn: boolean): boolean {
  return r.runtime === "production" || (localOn && r.runtime === "runner" && r.runner_admin_ok === true);
}

function runtimeReason(role: GatedRole, r: RunRow, localOn: boolean): MergeBlockReason | null {
  if (runtimeCounts(r, localOn)) return null;
  // A runner run under local review that fails (b) is named as such; everything else is the old reason.
  if (localOn && r.runtime === "runner") return `runner_not_trusted_${ROLE_CODE[role]}` as MergeBlockReason;
  return `run_not_production_${ROLE_CODE[role]}` as MergeBlockReason;
}

/**
 * The reasons a REQUIRED role's runs on this SHA do not pass. The latest
 * row is the one with the greatest `created_at` (chosen in SQL); if
 * several share that exact timestamp they must ALL pass (an unresolvable
 * tie must not pick the passing one).
 */
export function roleReasons(role: GatedRole, rows: readonly RunRow[], localOn = false): MergeBlockReason[] {
  const mine = rows.filter((r) => r.role === role);
  const latest = mine.filter((r) => r.is_latest);
  // No rows, or rows but none marked latest (defence in depth): nothing can
  // be shown to have passed.
  if (latest.length === 0) return [`missing_run_${ROLE_CODE[role]}` as MergeBlockReason];
  const reasons: MergeBlockReason[] = [];
  if (latest.some((r) => r.status !== "succeeded")) reasons.push(`run_not_succeeded_${ROLE_CODE[role]}` as MergeBlockReason);
  for (const r of latest) {
    const why = runtimeReason(role, r, localOn);
    if (why !== null && !reasons.includes(why)) reasons.push(why);
  }
  if (latest.some((r) => r.verdict !== "pass")) reasons.push(`verdict_not_pass_${ROLE_CODE[role]}` as MergeBlockReason);
  return reasons;
}

/** A role that is NOT required is not demanded, but a completed rejection
 * on this SHA still vetoes. The verdict that counts is the role's latest
 * TERMINAL row: a newer pending/running/paused row does not mask it (a
 * paused re-run must not hide a needs-fix indefinitely). That row must have
 * succeeded, be a production run AND say `pass`; a failed / timed-out / unknown-status row
 * vetoes even when its envelope claims a pass. A role with no terminal row
 * is not a veto. */
export function vetoReasons(role: GatedRole, rows: readonly RunRow[], localOn = false): MergeBlockReason[] {
  const latest = rows.filter((r) => r.role === role && r.is_latest_terminal);
  const reasons: MergeBlockReason[] = [];
  if (latest.some((r) => r.status !== "succeeded")) reasons.push(`run_not_succeeded_${ROLE_CODE[role]}` as MergeBlockReason);
  // H14c-RT-1: the same definition of a pass as `roleReasons` -- succeeded,
  // production, verdict pass. A newer succeeded `local` pass must not turn
  // an older production needs-fix into a merge.
  for (const r of latest) {
    const why = runtimeReason(role, r, localOn);
    if (why !== null && !reasons.includes(why)) reasons.push(why);
  }
  if (latest.some((r) => r.verdict !== "pass")) reasons.push(`verdict_not_pass_${ROLE_CODE[role]}` as MergeBlockReason);
  return reasons;
}

/**
 * D#6 R3c (C35 section 3.3): `reviewerReasons`, with one honest change for a `runner_local` repo whose opt-in is off. There the
 * per-role runtime reasons would tell the person that reviews are missing, when every required role has a trusted runner pass on
 * this head. When that is so (the same rows clear the head under the opt-in-on rules), they are replaced by the single
 * `local_reviews_passed_advisory`. The block itself is not touched: `local_review_not_enabled` is added by the gate as before. A role
 * without a trusted pass keeps today's reasons.
 */
export function gateReviewerReasons(roles: readonly GatedRole[], rows: readonly RunRow[], mode: ReviewMode): MergeBlockReason[] {
  const reasons = reviewerReasons(roles, rows, mode);
  if (mode === "runner_local_off" && reasons.length > 0 && reviewerReasons(roles, rows, "runner_local_on").length === 0) return ["local_reviews_passed_advisory"];
  return reasons;
}

/**
 * D#598 P7c: the head whose reviewer runs stand for `headSha`, when the platform recorded a merge-only re-check of it (a merge of the
 * default branch into the branch, with the pull request's own diff unchanged). The fact is a `review_verdicts` driver event with the code
 * `merge_only_recheck`; the head that holds the runs is its `rows_<sha>` reason. Null when there is none. Only the platform writes this
 * event, after reading GitHub: a person's push cannot make one.
 */
export async function carriedRunsHead(client: PoolClient, accountId: string, workItemId: string, headSha: string): Promise<string | null> {
  const { rows } = await client.query<{ reasons: string[] }>(
    `SELECT reasons FROM work_item_driver_events
      WHERE account_id = $1 AND work_item_id = $2 AND kind = 'review_verdicts' AND code = 'merge_only_recheck' AND head_sha = $3
      ORDER BY seq DESC LIMIT 1`,
    [accountId, workItemId, headSha],
  );
  const m = /^rows_([0-9a-f]{40})$/.exec((rows[0]?.reasons ?? []).find((r) => r.startsWith("rows_")) ?? "");
  return m ? m[1]! : null;
}

export async function loadRunsOnSha(
  pool: Pool,
  accountId: string,
  workItemId: string,
  headSha: string,
): Promise<RunRow[]> {
  return withTenant(pool, accountId, async (client) => {
    // D#598 P7c: the runs of the head a merge-only re-check carried forward count for this head too (never more than one extra head).
    const carried = await carriedRunsHead(client, accountId, workItemId, headSha);
    const heads = carried === null ? [headSha] : [headSha, carried];
    // `envelope->>'verdict'` is NULL unless the top-level key exists, so a
    // nested or renamed verdict never reads as a pass. Rows are matched on
    // the work item AND the exact head SHA: a run on another item or on an
    // older commit is invisible here.
    // Ordering is decided here, not in JS: `created_at` can hold values
    // (infinity) that node-pg returns as strings, and a throw on one row
    // must not wedge the step's retry loop.
    const { rows } = await client.query<RunRow>(
      `SELECT role, status, runtime, envelope ->> 'verdict' AS verdict,
              COALESCE(created_at = max(created_at) OVER (PARTITION BY role), false) AS is_latest,
              COALESCE(
                (status IS NULL OR status <> ALL($5::text[]))
                AND created_at = max(created_at) FILTER (WHERE status IS NULL OR status <> ALL($5::text[])) OVER (PARTITION BY role),
                false
              ) AS is_latest_terminal,
              isfinite(created_at) AS ts_ok,
              COALESCE(${RUNNER_ADMIN_OK_SQL}, false) AS runner_admin_ok
         FROM agent_runs ar
        WHERE account_id = $1 AND work_item_id = $2 AND head_sha = ANY($3::text[]) AND role = ANY($4::text[])
        ORDER BY created_at DESC, id`,
      [accountId, workItemId, heads, [...ALL_GATED_ROLES], [...NON_TERMINAL_STATUSES]],
    );
    return rows;
  });
}

/**
 * D#519 MQ3-a: the rows that speak for `headSha`. Its own rows, and, for a role with none, the rows of the head it was refreshed from,
 * but ONLY through a `head_refreshes` row, which the queue writes after it has verified a platform update-branch merge. A head with no
 * such row has its own rows and nothing else (a person's merge of the default branch carries nothing). Where the refresh's files
 * overlapped, the code reviewer's pass does not carry (see `effectiveRunRows`).
 */
export async function loadEffectiveRunsOnSha(pool: Pool, accountId: string, workItemId: string, headSha: string): Promise<RunRow[]> {
  const own = await loadRunsOnSha(pool, accountId, workItemId, headSha);
  const hops = await withTenant(pool, accountId, async (client) =>
    (await client.query<{ from_sha: string; to_sha: string; files_overlap: boolean }>(
      `SELECT from_sha, to_sha, files_overlap FROM head_refreshes WHERE account_id = $1 AND work_item_id = $2`,
      [accountId, workItemId],
    )).rows,
  );
  const chain: HeadRuns[] = [{ rows: own, refreshOverlap: false }];
  const seen = new Set([headSha]);
  let cur = headSha;
  while (chain.length <= MAX_REFRESHES) {
    const into = hops.filter((h) => h.to_sha === cur);
    const hop = into[0];
    if (!hop || seen.has(hop.from_sha)) break;
    // Two rows into one head would be a recording error: the stricter answer stands.
    chain[chain.length - 1]!.refreshOverlap = into.some((h) => h.files_overlap);
    chain.push({ rows: await loadRunsOnSha(pool, accountId, workItemId, hop.from_sha), refreshOverlap: false });
    seen.add(hop.from_sha);
    cur = hop.from_sha;
  }
  return chain.length === 1 ? own : effectiveRunRows(chain);
}

/**
 * The reviewer half of the gate: why the recorded runs on one head do not clear the required roles. Empty means every
 * required role has a latest succeeded production pass AND no other gated role has a terminal rejection on this head.
 * `runMergeGate` uses it, and so does anything that has to ask "would the reviewers clear this head" without the CI and
 * auto-merge halves (the platform's `fulcrumaxe/review` status), so there is one definition of it.
 */
export function reviewerReasons(roles: readonly GatedRole[], rows: readonly RunRow[], mode: ReviewMode = "cloud"): MergeBlockReason[] {
  const reasons: MergeBlockReason[] = [];
  const localOn = mode === "runner_local_on";
  if (rows.some((r) => !r.ts_ok)) reasons.push("run_timestamp_invalid");
  for (const role of roles) reasons.push(...roleReasons(role, rows, localOn));
  for (const role of ALL_GATED_ROLES) {
    if (!roles.includes(role)) reasons.push(...vetoReasons(role, rows, localOn));
  }
  return reasons;
}

/**
 * Evaluates every gate condition for the PR's current head and either
 * merges (exactly one merge call, `sha` = that head) or marks the PR
 * "ready, human merges". Nothing here throws on a failed condition; a
 * port error propagates to the workflow step's own retry policy and is
 * never read as permission to merge.
 */
export async function runMergeGate(deps: MergeGateDeps, input: MergeGateInput): Promise<MergeGateResult> {
  const pr = await deps.github.getPullRequest(input.pr);
  const headSha = pr.headSha;
  const reasons: MergeBlockReason[] = [];

  // A closed or merged PR is not ours to mark or merge.
  if (pr.state !== "open" || pr.merged) return { outcome: "pr_not_open", headSha: String(headSha) };
  if (pr.draft !== false) reasons.push("pr_draft");
  // D#598 P3b: a PR whose base is not the default branch is never merged here. Merging it would put the child into its parent's branch,
  // not into main. Strict equality on two strings GitHub reported: a missing, empty or different value is a stop (fail closed). After
  // D#519 MQ3 the queue keeps a stacked child waiting and retargets it, so on the normal path this does not fire; it is the backstop.
  if (typeof pr.baseRef !== "string" || pr.baseRef === "" || pr.baseRef !== pr.defaultBranch) {
    reasons.push("stacked_on_open_pr");
    let parentPr: number | null = null;
    try {
      parentPr = (await deps.stackParentPullNumber?.({ accountId: input.accountId, workItemId: input.workItemId })) ?? null;
    } catch {
      // fx-swallow-ok: the number only words the sentence; the stop above already holds and nothing merges
    }
    if (typeof parentPr === "number" && Number.isSafeInteger(parentPr) && parentPr > 0) reasons.push(`stacked_on_pr_${parentPr}`);
  }
  if (typeof headSha !== "string" || !SHA_PATTERN.test(headSha)) {
    // Without a well-formed SHA there is nothing to bind verdicts or CI to.
    reasons.push("head_sha_malformed");
    return markHuman(deps, input.pr, String(headSha), reasons);
  }

  // Two planes: the caller checked one head of this pull request; if it is not the head now, nothing below (CI, reviewer rows, the merge) is for it.
  if (input.expectedHeadSha !== undefined && input.expectedHeadSha !== headSha) {
    return { outcome: "head_moved", staleHeadSha: input.expectedHeadSha, newHeadSha: headSha };
  }
  // A reviewed head that is given must be well formed; it is never replaced by the pull request's own head.
  if (input.reviewedHeadSha !== undefined && !SHA_PATTERN.test(input.reviewedHeadSha)) {
    reasons.push("head_sha_malformed");
    return markHuman(deps, input.pr, headSha, reasons);
  }
  const roles = gatedRoles(input);
  const evidenceHead = input.reviewedHeadSha ?? headSha;
  const rows = await loadEffectiveRunsOnSha(deps.pool, input.accountId, input.workItemId, evidenceHead);
  // A head with no reviewer rows at all has never had its reviews
  // dispatched (or a dispatch after a moved head threw before writing any):
  // request them, so a retry cannot strand a new head with no reviews.
  // A throw propagates to the step's retry, which lands here again.
  if (rows.length === 0) await deps.requestReviews(input.pr, headSha);
  const mode: ReviewMode = input.reviewMode ?? "cloud";
  reasons.push(...gateReviewerReasons(roles, rows, mode));
  // A runner_local repo whose admin has not opted in never merges on this gate, whatever the rows say.
  if (mode === "runner_local_off") reasons.push("local_review_not_enabled");

  const ci = await deps.github.getCiSnapshot(input.pr, headSha);
  if (!isCiGreen(ci, headSha)) reasons.push("ci_not_green");
  if (mode === "runner_local_on") {
    // (c): GitHub, not a runner, decides CI and protection. Our own status must not be the only CI signal.
    if (!hasRepoOwnCi(ci)) reasons.push("repo_ci_missing");
    if (ci.baseBranchProtected !== true) reasons.push("no_branch_protection");
  }

  const allowed = await deps.isAutoMergeAllowed({ accountId: input.accountId, workItemId: input.workItemId });
  if (allowed !== true) reasons.push("auto_merge_not_allowed");
  // D#6 M1G-a: the operator's lock. A reason is always added, so the merge call below is unreachable for a locked repo.
  if (input.humanMergeOnly === true) reasons.push("human_merge_only");
  for (const r of input.extraBlockReasons ?? []) if (!reasons.includes(r)) reasons.push(r);

  if (reasons.length > 0) {
    return markHuman(deps, input.pr, headSha, reasons);
  }
  // The caller says this pull request is never merged by the cloud: stop before the one merge call below.
  if (input.mergeUnavailableReason !== undefined) return markHuman(deps, input.pr, headSha, [input.mergeUnavailableReason]);

  const outcome = await deps.github.mergePullRequest(input.pr, { sha: headSha });
  if (outcome.merged === true) {
    return { outcome: "merged", headSha };
  }
  if ("delegated" in outcome) return outcome.delegated ? { outcome: "merge_delegated", headSha } : markHuman(deps, input.pr, headSha, [outcome.reason]);
  // A refused merge is classified from structured re-reads (D#519 MQ1), never from GitHub's message text and never by assuming a
  // status means one thing: 405 covers a conflict, an out-of-date branch and a protection refusal alike, and a 422 may or may not
  // be a moved head.
  const status = outcome.httpStatus;
  if (status !== 405 && status !== 403 && status !== 409 && status !== 422) return markHuman(deps, input.pr, headSha, ["merge_call_refused"]);
  // Re-read the PR from GitHub (never from the refusal). `getMergeability` has already polled a null `mergeable`.
  const after = await deps.github.getMergeability(input.pr, { gatedHeadSha: headSha });
  if (after.headSha !== headSha && (status === 409 || status === 422)) {
    // A moved head is not an error: review the new commit. The re-read head goes to requestReviews (and into a dispatch), so it
    // must pass the same pattern as the first read. Junk: a human decides.
    if (typeof after.headSha !== "string" || !SHA_PATTERN.test(after.headSha)) {
      return markHuman(deps, input.pr, headSha, ["head_sha_malformed"]);
    }
    await deps.requestReviews(input.pr, after.headSha);
    return { outcome: "head_moved", staleHeadSha: headSha, newHeadSha: after.headSha };
  }
  // A 409 with an unmoved head, or any refusal on a head other than the one gated, is not explained by what was read.
  if (status === 409 || after.headSha !== headSha) return markHuman(deps, input.pr, headSha, ["merge_call_refused"]);
  return markHuman(deps, input.pr, headSha, [await classifyRefusal(deps.github, input.pr, headSha, after)]);
}

/**
 * D#519 MQ1: the reason for a refused merge, from the re-read `mergeable` and `mergeable_state` (and the compare, to tell an
 * out-of-date branch from a protection rule). Fails closed: `mergeable: null` after the poll bound, an unknown state and a state that
 * contradicts `mergeable` all stay `merge_call_refused`, and nothing here ever calls the merge endpoint again.
 */
async function classifyRefusal(github: MergeGateGitHubPort, pr: PullRequestRef, headSha: string, m: PullRequestMergeability): Promise<MergeBlockReason> {
  if (m.mergeable === null) return "merge_call_refused";
  if (m.mergeableState === "dirty") return m.mergeable === false ? "merge_conflict" : "merge_call_refused";
  if (m.mergeableState === "behind") return "branch_behind";
  if (m.mergeableState !== "blocked") return "merge_call_refused";
  // Blocked. When the repo requires up-to-date branches and the head lacks base commits, the branch is what is out of date.
  try {
    if (await github.requiresUpToDateBranch(pr)) {
      const cmp = await github.compareToBase(pr, headSha);
      if (cmp.behindBy > 0) return "branch_behind";
    }
  } catch {
    // fx-swallow-ok: the extra read only refines which stop this is; when it cannot be made the generic protection stop stands and nothing merges
  }
  return "branch_protection_refused";
}

async function markHuman(
  deps: MergeGateDeps,
  pr: PullRequestRef,
  headSha: string,
  reasons: MergeBlockReason[],
): Promise<MergeGateResult> {
  await deps.github.markReadyForHumanMerge(pr, { headSha, reasons });
  return { outcome: "ready_human_merges", headSha, reasons };
}
