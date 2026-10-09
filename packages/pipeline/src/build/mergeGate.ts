import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
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

export type MergeCallOutcome = { merged: true } | { merged: false; httpStatus: number };

export interface MergeGateGitHubPort {
  getPullRequest(pr: PullRequestRef): Promise<PullRequestState>;
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
  | "merge_call_refused";

export type MergeGateResult =
  | { outcome: "merged"; headSha: string }
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

export async function loadRunsOnSha(
  pool: Pool,
  accountId: string,
  workItemId: string,
  headSha: string,
): Promise<RunRow[]> {
  return withTenant(pool, accountId, async (client) => {
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
        WHERE account_id = $1 AND work_item_id = $2 AND head_sha = $3 AND role = ANY($4::text[])
        ORDER BY created_at DESC, id`,
      [accountId, workItemId, headSha, [...ALL_GATED_ROLES], [...NON_TERMINAL_STATUSES]],
    );
    return rows;
  });
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
  if (typeof headSha !== "string" || !SHA_PATTERN.test(headSha)) {
    // Without a well-formed SHA there is nothing to bind verdicts or CI to.
    reasons.push("head_sha_malformed");
    return markHuman(deps, input.pr, String(headSha), reasons);
  }

  const roles = gatedRoles(input);
  const rows = await loadRunsOnSha(deps.pool, input.accountId, input.workItemId, headSha);
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

  if (reasons.length > 0) {
    return markHuman(deps, input.pr, headSha, reasons);
  }

  const outcome = await deps.github.mergePullRequest(input.pr, { sha: headSha });
  if (outcome.merged === true) {
    return { outcome: "merged", headSha };
  }
  if (outcome.httpStatus === 409 || outcome.httpStatus === 422) {
    // A moved head is not an error. Re-read the head from GitHub (never
    // from the refusal); if it really moved, review the new commit.
    const after = await deps.github.getPullRequest(input.pr);
    if (after.headSha !== headSha) {
      // The re-read head goes to requestReviews (and into a dispatch), so it
      // must pass the same pattern as the first read. Junk: a human decides.
      if (typeof after.headSha !== "string" || !SHA_PATTERN.test(after.headSha)) {
        return markHuman(deps, input.pr, headSha, ["head_sha_malformed"]);
      }
      await deps.requestReviews(input.pr, after.headSha);
      return { outcome: "head_moved", staleHeadSha: headSha, newHeadSha: after.headSha };
    }
  }
  return markHuman(deps, input.pr, headSha, ["merge_call_refused"]);
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
