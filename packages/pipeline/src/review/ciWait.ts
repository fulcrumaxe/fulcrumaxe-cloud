import type { Pool } from "pg";
import type { PublicPullRequestLookup } from "./publicPullRequest.js";
import type { CiSnapshot } from "../build/mergeGate.js";
import { SHA_PATTERN } from "../build/mergeGate.js";
import type { GitHubHttp } from "../build/githubMergePort.js";
import { attestGate1Head, GATE1_CONTEXT } from "./gate1Attest.js";
import { loadReviewContext } from "./context.js";
import { REVIEW_STATUS_CONTEXT } from "./githubReads.js";
import { createReviewGitHubPort } from "./mergeGateRun.js";

/**
 * D#598 P7b: a review verdict is not recorded while the pull request's CI, or a repo-wide guard, is still running.
 *
 * The rule lives in the verdict path itself (`recordRound` asks a `CiGate` before it writes anything), not in a reviewer's
 * prompt: a reviewer cannot be talked into recording early, and a pass cannot be written by some other caller that forgot to
 * look. It holds for every repository the same way: there is no setting that turns it off and no check of whose repository it is.
 *
 * "Still running" is read from the head commit's own signals, the same ones the merge gate reads (`getCiSnapshot`):
 *   - a check run whose status is not `completed` (queued, in progress, waiting, pending, requested). A run that already has a conclusion and a
 *     completion time counts as completed whatever its status says: the readers settle that once, in `settleCheckRun`;
 *   - a commit status that has not finished (anything but `success`, `failure` or `error`: `pending`, and `expected`, which a
 *     GraphQL read answers for a required status that was never reported);
 *   - a context the base branch requires (branch protection or a ruleset) that has not appeared on the commit yet. A repo-wide
 *     guard is exactly that: a required check that GitHub has not started or reported;
 *   - a snapshot that is not complete (a list shorter than GitHub's own total).
 * A snapshot that answers for ANOTHER commit than the reviewed one is not "still running" when the read follows the pull request's
 * last commit (a `runner_local` repo): the head moved after the review, so the answer is `head_moved`, nothing is waited for or recorded, and
 * the driver reviews the new head. Where the read is of the reviewed sha itself, a snapshot for another commit stays a wait (`wrong_head`).
 * A check that FINISHED red does not make the wait longer: it is a finished signal, the reviewers' verdicts are recorded as they
 * are, and the merge gate (which requires every check green) is the one that refuses a red head.
 *
 * Our own commit status (`fulcrumaxe/review`) is posted AFTER the reviewers pass, so it is never waited for: counting it would
 * make the wait depend on its own result.
 *
 * A commit with no check and no status at all, and no required context, has no CI to wait for.
 */

/**
 * `gate1_waiting` and `gate1_attest_off` (D#6 CLOUD-POSTS-FX-GATE1) only ever follow `required_missing` when `fx-gate1` is the one context missing on a
 * paired item's public head: the cloud's attester is waiting for a full CI run, or the attester is off (`FX_GATE1_ATTEST_REPOS` unset).
 */
export type CiWaitReason = "wrong_head" | "incomplete_snapshot" | "check_running" | "status_pending" | "required_missing" | "gate1_waiting" | "gate1_attest_off";

export interface CiWaitReading {
  /** `head_moved`: the pull request's head is no longer the reviewed one (only when the snapshot follows the PR). Nothing is recorded. */
  state: "settled" | "pending" | "head_moved";
  /** Fixed words only, in a fixed order, each at most once. Empty when settled. */
  reasons: CiWaitReason[];
  /** Only from `readCiWaitNamed`, and only when `required_missing` is a reason: the names of the required checks that have not reported (public check names), sorted, at most MAX_MISSING_NAMES. */
  missing?: string[];
  /** Only from `readCiWaitNamed`, and only when `check_running` or `status_pending` is a reason: the names of the checks that have not finished, sorted, at most MAX_MISSING_NAMES. */
  running?: string[];
}

const MAX_MISSING_NAMES = 5;
const MAX_NAME_LENGTH = 100;

const REASON_ORDER: readonly CiWaitReason[] = ["wrong_head", "incomplete_snapshot", "check_running", "status_pending", "required_missing", "gate1_waiting", "gate1_attest_off"];

/** Commit status states that are final. Any other state (pending, expected, one GitHub adds later) is still running. */
const FINISHED_STATUS_STATES: ReadonlySet<string> = new Set(["success", "failure", "error"]);

/** The required contexts (other than our own review status) that have not appeared on the commit, in the snapshot's order. Pure. */
function missingRequiredContexts(snapshot: CiSnapshot): string[] {
  const checkRuns = Array.isArray(snapshot.checkRuns) ? snapshot.checkRuns : [];
  const statuses = (Array.isArray(snapshot.statuses) ? snapshot.statuses : []).filter((s) => s.context !== REVIEW_STATUS_CONTEXT);
  const required = (snapshot.protectionUnreadable === true || !Array.isArray(snapshot.requiredContexts) ? [] : snapshot.requiredContexts).filter((c) => c !== REVIEW_STATUS_CONTEXT);
  return required.filter((ctx) => !checkRuns.some((c) => c.name === ctx) && !statuses.some((s) => s.context === ctx));
}

/**
 * `readCiWait`, plus the NAMES of the required checks that never reported when that is a reason, so a log line and a stop can say which one.
 * The decision is `readCiWait`'s, untouched; the names are a public check's name only, never a result or a log.
 */
export function readCiWaitNamed(snapshot: CiSnapshot, headSha: string, opts: { followsPullRequest?: boolean } = {}): CiWaitReading {
  const reading = readCiWait(snapshot, headSha, opts);
  const names = (list: string[]): string[] => [...new Set(list.map((n) => n.slice(0, MAX_NAME_LENGTH)))].sort().slice(0, MAX_MISSING_NAMES);
  const out: CiWaitReading = { ...reading };
  if (reading.reasons.includes("required_missing")) out.missing = names(missingRequiredContexts(snapshot));
  if (reading.reasons.includes("check_running") || reading.reasons.includes("status_pending")) {
    const checks = (Array.isArray(snapshot.checkRuns) ? snapshot.checkRuns : []).filter((c) => c.status !== "completed").map((c) => c.name);
    const states = (Array.isArray(snapshot.statuses) ? snapshot.statuses : []).filter((s) => s.context !== REVIEW_STATUS_CONTEXT && !FINISHED_STATUS_STATES.has(s.state)).map((s) => s.context);
    out.running = names([...checks, ...states]);
  }
  return out;
}

/**
 * Whether the head's CI and guards have finished, from one snapshot. Pure.
 * `followsPullRequest`: the snapshot is of the pull request's LAST commit whatever sha was asked for (the `runner_local` read), so a
 * different head in the answer means the head moved.
 */
export function readCiWait(snapshot: CiSnapshot, headSha: string, opts: { followsPullRequest?: boolean } = {}): CiWaitReading {
  if (snapshot.headSha !== headSha && opts.followsPullRequest === true) return { state: "head_moved", reasons: [] };
  const reasons = new Set<CiWaitReason>();
  if (snapshot.headSha !== headSha) reasons.add("wrong_head");
  const checkRuns = Array.isArray(snapshot.checkRuns) ? snapshot.checkRuns : [];
  const allStatuses = Array.isArray(snapshot.statuses) ? snapshot.statuses : [];
  if (!Array.isArray(snapshot.checkRuns) || !Array.isArray(snapshot.statuses) || checkRuns.length !== snapshot.checkRunsTotalCount || allStatuses.length !== snapshot.statusesTotalCount) {
    reasons.add("incomplete_snapshot");
  }
  const statuses = allStatuses.filter((s) => s.context !== REVIEW_STATUS_CONTEXT);
  if (checkRuns.some((c) => c.status !== "completed")) reasons.add("check_running");
  if (statuses.some((s) => !FINISHED_STATUS_STATES.has(s.state))) reasons.add("status_pending");
  // Required contexts are UNKNOWN (not empty) when the protection read was refused; the observed signals above are then all there is.
  if (missingRequiredContexts(snapshot).length > 0) reasons.add("required_missing");
  const list = REASON_ORDER.filter((r) => reasons.has(r));
  return { state: list.length === 0 ? "settled" : "pending", reasons: list };
}

/** The required contexts (our own review status left out) that have not appeared on the commit, in the snapshot's order. Unknown requirements: none. Pure. */
export function missingRequired(snapshot: CiSnapshot): string[] {
  if (snapshot.protectionUnreadable === true || !Array.isArray(snapshot.requiredContexts)) return [];
  const checkRuns = Array.isArray(snapshot.checkRuns) ? snapshot.checkRuns : [];
  const statuses = Array.isArray(snapshot.statuses) ? snapshot.statuses : [];
  return snapshot.requiredContexts.filter((ctx) => ctx !== REVIEW_STATUS_CONTEXT && !checkRuns.some((c) => c.name === ctx) && !statuses.some((s) => s.context === ctx));
}

/** Whether the only thing the wait is for is `fx-gate1`: the one reason `required_missing`, and `fx-gate1` the one missing context. Pure. */
export function onlyGate1Missing(reading: CiWaitReading, snapshot: CiSnapshot): boolean {
  const missing = missingRequired(snapshot);
  return reading.state === "pending" && reading.reasons.length === 1 && reading.reasons[0] === "required_missing" && missing.length === 1 && missing[0] === GATE1_CONTEXT;
}

/** What `recordRound` asks before it records anything. A throw is not an answer: the caller's step retries, and nothing is recorded. */
export interface CiGate {
  read(input: { accountId: string; workItemId: string; prNumber: number; headSha: string }): Promise<CiWaitReading>;
}


/**
 * The real gate: the head's CI read from GitHub through the review stage's own port (the local-only fence for a `runner_local`
 * repo). `openHttp` hands the transport for the item's repository, with a token whose purpose may read checks.
 *
 * Two planes. A paired item has two pull requests for one change: the private run branch's, which is reviewed, and the public one the platform opened
 * on the code repository, which is the one that merges and the one whose CI runs. Waiting on the private copy's CI held a round for hours while the
 * public one was green. When `openPublicHttp` is given and the item has a public pull request (found by the injected `publicPullRequest` lookup), the wait reads THAT
 * pull request's live head and checks instead. The reviewed private head is not compared with it: the two are different commits by construction.
 * What stands in for that comparison is the platform's stamp: a public head that is not the one the platform pushed (a push or a fix-round
 * republish not recorded yet, or a branch changed by someone else) is `wrong_head`, a wait; so is a missing stamp, or a push record still `updating` / `waiting_person_pushed`, answered before any checks are read. A `runner_local` repo does the same through the local-only fence: the code repository's
 * pull request is listed by the branch our own push record names, and its checks come from the fixed CommitChecks document. Single-plane items, and paired items whose public pull request is
 * not open yet, are read exactly as before. A failed read throws and nothing is recorded, as for the private read.
 */
export function createCiGate(deps: {
  pool: Pool;
  openHttp: (ctx: { repoId: string; owner: string; name: string; executionMode: string }) => Promise<GitHubHttp>;
  /** Opens the same kind of transport for the PAIRED code repository (`owner`/`name` are the code repository's; `repoId` is the item's own repository, whose installation serves it). */
  openPublicHttp?: (ctx: { repoId: string; owner: string; name: string; executionMode: string }) => Promise<GitHubHttp>;
  /** Finds the item's public pull request (see publicPullRequest.ts). Both this and `openPublicHttp` must be given for the public read. */
  publicPullRequest?: PublicPullRequestLookup;
  /**
   * D#6 CLOUD-POSTS-FX-GATE1: the cloud's own `fx-gate1` for a paired item's public head. `repos` is `FX_GATE1_ATTEST_REPOS` (empty: off); `ourLogin` is the
   * login of the App that serves the item's repository. The code-repository client attests on both paths (fenced for runner_local, the hosted merge_gate client otherwise).
   */
  gate1?: { repos: ReadonlySet<string>; ourLogin: (repoId: string) => Promise<string> };
}): CiGate {
  return {
    async read(input) {
      if (!SHA_PATTERN.test(input.headSha)) throw new Error("ci wait: malformed head sha");
      const loaded = await loadReviewContext(deps.pool, input.accountId, input.workItemId);
      // Without a context there is no repository to read, and no verdict is recorded for it either: the caller's step fails and retries.
      if (!loaded.ok) throw new Error(`ci wait: ${loaded.reason}`);
      const ctx = loaded.ctx;
      // `pr` is null for a paired item whose public pull request is not open: the wait reads the private copy then, and the merge gate stops with `public_pr_not_open`.
      const publicPr = deps.openPublicHttp !== undefined && deps.publicPullRequest !== undefined ? ((await deps.publicPullRequest(input.accountId, input.workItemId))?.pr ?? null) : null;
      if (publicPr !== null && deps.openPublicHttp !== undefined) {
        const http = await deps.openPublicHttp({ repoId: ctx.repoId, owner: publicPr.owner, name: publicPr.name, executionMode: ctx.executionMode });
        const port = createReviewGitHubPort({ pool: deps.pool, http }, { ...ctx, owner: publicPr.owner, name: publicPr.name }, { accountId: input.accountId, workItemId: input.workItemId, prNumber: publicPr.number, recordedBranch: publicPr.branch });
        const ref = { repoId: ctx.repoId, prNumber: publicPr.number };
        const live = (await port.getPullRequest(ref)).headSha;
        if (!SHA_PATTERN.test(live)) throw new Error("ci wait: malformed public head sha");
        // No stamp, or a republish in flight (the stamp may still equal the live head): wait before any checks read.
        if (!publicPr.managedByPerson && (publicPr.stampedHead === null || publicPr.pushState === "updating" || publicPr.pushState === "waiting_person_pushed")) return { state: "pending", reasons: ["wrong_head"] };
        const snapshot = await port.getCiSnapshot(ref, live);
        let reading = readCiWaitNamed(snapshot, live);
        // D#6 CLOUD-POSTS-FX-GATE1: only a head the platform pushed, with `fx-gate1` the one thing missing, is attested; after a post GitHub is read again.
        if (onlyGate1Missing(reading, snapshot) && !publicPr.managedByPerson && publicPr.stampedHead === live) {
          const gate1 = deps.gate1;
          if (gate1 === undefined || gate1.repos.size === 0) {
            reading = { ...reading, state: "pending", reasons: [...reading.reasons, "gate1_attest_off"] };
          } else {
            // Both paths (TL ruling 11-07 01:25): a runner_local pair's fenced client reads through its documents, a hosted pair's merge_gate client through REST.
            const out = await attestGate1Head(http, { repos: gate1.repos, owner: publicPr.owner, name: publicPr.name, number: publicPr.number, sha: live, ourLogin: () => gate1.ourLogin(ctx.repoId), readHead: async () => (await port.getPullRequest(ref)).headSha });
            if (out.kind === "posted" || out.kind === "already") reading = readCiWaitNamed(await port.getCiSnapshot(ref, live), live);
            else if (out.kind !== "off") reading = { ...reading, state: "pending", reasons: [...reading.reasons, "gate1_waiting"] };
          }
        }
        if (reading.state === "settled" && !publicPr.managedByPerson && publicPr.stampedHead !== live) return { state: "pending", reasons: ["wrong_head"] };
        return reading;
      }
      const http = await deps.openHttp({ repoId: ctx.repoId, owner: ctx.owner, name: ctx.name, executionMode: ctx.executionMode });
      const port = createReviewGitHubPort({ pool: deps.pool, http }, ctx, { accountId: input.accountId, workItemId: input.workItemId, prNumber: input.prNumber });
      return readCiWaitNamed(await port.getCiSnapshot({ repoId: ctx.repoId, prNumber: input.prNumber }, input.headSha), input.headSha, { followsPullRequest: ctx.executionMode === "runner_local" });
    },
  };
}
