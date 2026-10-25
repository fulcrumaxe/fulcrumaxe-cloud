import type { Pool } from "pg";
import type { PublicPullRequestLookup } from "./publicPullRequest.js";
import type { CiSnapshot } from "../build/mergeGate.js";
import { SHA_PATTERN } from "../build/mergeGate.js";
import type { GitHubHttp } from "../build/githubMergePort.js";
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
 *   - a check run whose status is not `completed` (queued, in progress, waiting, pending, requested);
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

export type CiWaitReason = "wrong_head" | "incomplete_snapshot" | "check_running" | "status_pending" | "required_missing";

export interface CiWaitReading {
  /** `head_moved`: the pull request's head is no longer the reviewed one (only when the snapshot follows the PR). Nothing is recorded. */
  state: "settled" | "pending" | "head_moved";
  /** Fixed words only, in a fixed order, each at most once. Empty when settled. */
  reasons: CiWaitReason[];
}

const REASON_ORDER: readonly CiWaitReason[] = ["wrong_head", "incomplete_snapshot", "check_running", "status_pending", "required_missing"];

/** Commit status states that are final. Any other state (pending, expected, one GitHub adds later) is still running. */
const FINISHED_STATUS_STATES: ReadonlySet<string> = new Set(["success", "failure", "error"]);

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
  const required = (snapshot.protectionUnreadable === true || !Array.isArray(snapshot.requiredContexts) ? [] : snapshot.requiredContexts).filter((c) => c !== REVIEW_STATUS_CONTEXT);
  if (required.some((ctx) => !checkRuns.some((c) => c.name === ctx) && !statuses.some((s) => s.context === ctx))) reasons.add("required_missing");
  const list = REASON_ORDER.filter((r) => reasons.has(r));
  return { state: list.length === 0 ? "settled" : "pending", reasons: list };
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
 * republish not recorded yet, or a branch changed by someone else) is `wrong_head`, a wait. A `runner_local` repo keeps its own path whole (its
 * reads go through the local-only fence, which cannot reach the code repository). Single-plane items, and paired items whose public pull request is
 * not open yet, are read exactly as before. A failed read throws and nothing is recorded, as for the private read.
 */
export function createCiGate(deps: {
  pool: Pool;
  openHttp: (ctx: { repoId: string; owner: string; name: string; executionMode: string }) => Promise<GitHubHttp>;
  /** Opens the same kind of transport for the PAIRED code repository (`owner`/`name` are the code repository's; `repoId` is the item's own repository, whose installation serves it). */
  openPublicHttp?: (ctx: { repoId: string; owner: string; name: string; executionMode: string }) => Promise<GitHubHttp>;
  /** Finds the item's public pull request (see publicPullRequest.ts). Both this and `openPublicHttp` must be given for the public read. */
  publicPullRequest?: PublicPullRequestLookup;
}): CiGate {
  return {
    async read(input) {
      if (!SHA_PATTERN.test(input.headSha)) throw new Error("ci wait: malformed head sha");
      const loaded = await loadReviewContext(deps.pool, input.accountId, input.workItemId);
      // Without a context there is no repository to read, and no verdict is recorded for it either: the caller's step fails and retries.
      if (!loaded.ok) throw new Error(`ci wait: ${loaded.reason}`);
      const ctx = loaded.ctx;
      const publicPr = deps.openPublicHttp !== undefined && deps.publicPullRequest !== undefined && ctx.executionMode !== "runner_local" ? await deps.publicPullRequest(input.accountId, input.workItemId) : null;
      if (publicPr !== null && deps.openPublicHttp !== undefined) {
        const http = await deps.openPublicHttp({ repoId: ctx.repoId, owner: publicPr.owner, name: publicPr.name, executionMode: ctx.executionMode });
        const port = createReviewGitHubPort({ pool: deps.pool, http }, { ...ctx, owner: publicPr.owner, name: publicPr.name }, { accountId: input.accountId, workItemId: input.workItemId, prNumber: publicPr.number });
        const ref = { repoId: ctx.repoId, prNumber: publicPr.number };
        const live = (await port.getPullRequest(ref)).headSha;
        if (!SHA_PATTERN.test(live)) throw new Error("ci wait: malformed public head sha");
        const reading = readCiWait(await port.getCiSnapshot(ref, live), live);
        if (reading.state === "settled" && !publicPr.managedByPerson && publicPr.stampedHead !== null && publicPr.stampedHead !== live) return { state: "pending", reasons: ["wrong_head"] };
        return reading;
      }
      const http = await deps.openHttp({ repoId: ctx.repoId, owner: ctx.owner, name: ctx.name, executionMode: ctx.executionMode });
      const port = createReviewGitHubPort({ pool: deps.pool, http }, ctx, { accountId: input.accountId, workItemId: input.workItemId, prNumber: input.prNumber });
      return readCiWait(await port.getCiSnapshot({ repoId: ctx.repoId, prNumber: input.prNumber }, input.headSha), input.headSha, { followsPullRequest: ctx.executionMode === "runner_local" });
    },
  };
}
