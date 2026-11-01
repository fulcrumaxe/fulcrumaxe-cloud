import type { PoolClient } from "pg";
import type { CommitInfo, CommitReaderPort } from "../build/githubMergePort.js";
import type { MergeGateGitHubPort } from "../build/mergeGate.js";
import type { PullRequestRef } from "../build/types.js";
import { decideCarryForward } from "./carryForward.js";
import { MAX_REFRESHES } from "./policy.js";
import { attachWorkRun, finishWork, listHeadRefreshes, markRefreshRequested, readRefreshRequested, recordHeadRefresh, releaseForWork, renewSlot, returnToReview, stopEntry, type HeadRefreshRow } from "./store.js";
import type { MergeQueueEntry } from "./types.js";

/**
 * D#519 MQ3-a: the refresh half of the slot step. An entry holding the merge slot is checked for being behind the default branch;
 * if it is, GitHub's update-branch is called through MQ1's port (no agent, no push of ours), the new head is VERIFIED to be our own
 * platform refresh, a `head_refreshes` row is written, and the entry either carries its reviews forward (files disjoint) or releases
 * the slot for a delta review of the merge commit (files overlap). The step makes no merge call, waits for no CI and starts no
 * workflow: those are MQ3-b's, which also binds `startDeltaReview` and `gate` to the real reviewer start and the real gate.
 *
 * What counts as a refresh. Only a commit that (1) has exactly two parents, the previous head first and a commit already on the
 * default branch second, (2) has the identity `isPlatformRefreshIdentity` names (our App as author, GitHub's own `web-flow` as
 * committer, a valid signature), and (3) whose TREE is exactly the clean three-way merge of the previous head and that second parent
 * (`checkCleanMerge`). Anything else is a foreign push: no row, no carried verdict, the entry goes back to review. A person's or a
 * bot's merge of the default branch into the branch is such a push whatever its shape (D#598 P7c handles that case with its own
 * record and never reads `head_refreshes`).
 *
 * The author alone proves nothing: it comes from an email anyone can type. The signature is checked against the committer, so a
 * contributor can sign their own commit and name the bot as author. Only GitHub itself commits as `web-flow`, and only GitHub can sign
 * as it. And even a perfect identity is not enough without the tree check, which is what stops a hand-built merge.
 *
 * ASSUMPTION, to be confirmed from one real update-branch commit on cloud-staging before this merges: GitHub's update-branch commit
 * has `author.login` = our App's bot account, `committer.login` = `web-flow`, and `verification` = verified with reason `valid`. The
 * tests pin those fields in `fakeGitHubMergeTls.ts`; the choice of fields lives in `isPlatformRefreshIdentity` and the fake only, so
 * if the real commit differs, change those two together.
 */

export type RefreshGitHubPort = Pick<MergeGateGitHubPort, "getMergeability" | "updateBranch" | "compareToBase" | "requiresUpToDateBranch"> & CommitReaderPort;

export type StartDeltaReview = (
  client: PoolClient,
  args: { entry: MergeQueueEntry; fromSha: string; toSha: string; baseSha: string },
/**
 * `started: false` says why nothing ran. `refused_spend`: the entry needs a person. `main_side_only`: the merge touched none of the PR's
 * files (C4 2.4), so no review is needed and the entry goes straight back to `queued`. Anything else (`head_changed`, `spec_changed`,
 * `invalid_input`, `worker_unavailable`): the entry returns to review, at its original place, and nothing was started.
 */
) => Promise<{ started: true; runId: string | null } | { started: false; reason: "refused_spend" | "waiting_for_capacity" | "main_side_only" | "head_changed" | "spec_changed" | "invalid_input" | "worker_unavailable" }>;

export interface RefreshStepDeps<G> {
  github: RefreshGitHubPort;
  /** Runs `fn` in a tenant transaction for the account (`withTenant`). Nothing is held across a GitHub call. */
  inTenant<T>(accountId: string, fn: (client: PoolClient) => Promise<T>): Promise<T>;
  /** The GitHub login our App's installation acts as (for example `fulcrumaxe-app[bot]`). */
  ourLogin: string;
  /** The merge gate, run on the reviewed head when the branch is not behind. MQ3-b binds it to `runMergeGate`. */
  gate(args: { headSha: string }): Promise<G>;
  /**
   * Starts the delta review of the merge commit. Called inside the SAME transaction that released the slot, so the run exists only
   * after the slot is gone. MQ3-b binds it to the real reviewer start (metered and enveloped); a refused start is `refused_spend`.
   */
  startDeltaReview: StartDeltaReview;
  sleep(ms: number): Promise<void>;
  /** D#694 B6-3: the base branch is behind GitHub's merge queue, which builds its own group tip: the branch is never compared or updated here. */
  skipBehindRefresh?: boolean;
  pollIntervalMs?: number;
  pollLimit?: number;
}

export interface RefreshStepInput {
  accountId: string;
  /** The entry that holds the slot, as `takeSlot` returned it. */
  entry: MergeQueueEntry;
  holder: string;
  pr: PullRequestRef;
}

export type RefreshOutcome<G> =
  /** Not behind: no update-branch call, and the gate ran on the reviewed head. */
  | { outcome: "not_behind"; headSha: string; gate: G }
  /** Behind and refreshed; files disjoint, so the reviews carry. The caller waits for fresh CI on `toSha`, then gates. */
  | { outcome: "refreshed"; fromSha: string; toSha: string; baseSha: string; why: RefreshWhy }
  /** Behind and refreshed; files overlap. The slot is released, `awaiting_work` / `delta_review`, and the delta review was started. */
  | { outcome: "needs_delta_review"; fromSha: string; toSha: string; baseSha: string; reason: "files_overlap" | "files_unknown"; runId: string | null }
  /** The delta review's start was refused for spend. The entry is stopped (`refused_spend`) and holds no slot. */
  | { outcome: "refused_spend"; fromSha: string; toSha: string }
  /** The merge touched only files from the default branch (C4 2.4): no review, the entry is `queued` again and holds no slot. */
  | { outcome: "delta_skipped"; fromSha: string; toSha: string }
  /** The delta review could not start (head moved, Spec changed, bad input, no worker): the entry is back in review and holds no slot. */
  | { outcome: "delta_not_started"; fromSha: string; toSha: string; reason: string }
  /** The head is not a verified platform refresh. No row, nothing carried, the entry is back in review. */
  | { outcome: "foreign_head"; headSha: string; reason: VerifyFailure }
  /** The refresh bound was spent. The entry is stopped with `branch_behind`. */
  | { outcome: "branch_behind" }
  /** Update-branch could not merge: a real conflict. MQ4 owns what happens next; the slot is still held. */
  | { outcome: "conflict" }
  /** GitHub has not applied the update yet (or the head moved under us). Run the step again; nothing was recorded. */
  | { outcome: "refresh_pending" }
  | { outcome: "pr_not_open" }
  /** The lease lapsed or the entry was reclaimed: the caller stops and touches nothing. */
  | { outcome: "slot_lost" };

/** `stale_green`: the repo does not require up-to-date branches, but the head is behind, so CI that ran on an old base is not trusted. */
export type RefreshWhy = "required" | "stale_green" | "recovered";

export type VerifyFailure = "not_two_parents" | "first_parent_not_previous_head" | "second_parent_not_on_default" | "author_not_our_app" | "committer_not_github" | "not_signed_by_github" | "tree_not_verified" | "no_refresh_requested";

export type RefreshVerdict = { ok: true; baseSha: string; commit: CommitInfo } | { ok: false; reason: VerifyFailure };

/** The committer GitHub records on the merge commit its own update-branch call makes (assumption above). */
export const PLATFORM_COMMITTER_LOGIN = "web-flow";

const sameLogin = (a: string | null, b: string): boolean => a !== null && a.toLowerCase() === b.toLowerCase();

/**
 * THE one place that says what a platform refresh commit looks like. Author = our App; committer = GitHub's `web-flow`; signed, with
 * verification reason `valid`. A commit missing any of the three is not ours, and which one is missing is the reason returned.
 */
export function platformRefreshIdentity(c: CommitInfo, ourLogin: string): { ok: true } | { ok: false; reason: "author_not_our_app" | "committer_not_github" | "not_signed_by_github" } {
  if (!sameLogin(c.authorLogin, ourLogin)) return { ok: false, reason: "author_not_our_app" };
  if (!sameLogin(c.committerLogin, PLATFORM_COMMITTER_LOGIN)) return { ok: false, reason: "committer_not_github" };
  if (!c.verified || c.verificationReason !== "valid") return { ok: false, reason: "not_signed_by_github" };
  return { ok: true };
}

/**
 * Is `toSha` the platform's own refresh of `fromSha`? Pure reads; writes nothing. The cheap structural checks run before the one
 * GitHub compare that places the second parent on the default branch.
 */
export async function verifyRefresh(
  github: RefreshGitHubPort,
  pr: PullRequestRef,
  args: { fromSha: string; toSha: string; ourLogin: string },
): Promise<RefreshVerdict> {
  if (args.ourLogin.trim() === "") throw new Error("verifyRefresh: no App login to compare against");
  const commit = await github.getCommit(pr, args.toSha);
  if (commit.parents.length !== 2) return { ok: false, reason: "not_two_parents" };
  const [first, second] = commit.parents as [string, string];
  if (first !== args.fromSha || second === first) return { ok: false, reason: "first_parent_not_previous_head" };
  const identity = platformRefreshIdentity(commit, args.ourLogin);
  if (!identity.ok) return identity;
  // `base...second`: the second parent is on the default branch when it is behind the base tip or is the tip.
  const cmp = await github.compareToBase(pr, second);
  if (cmp.status !== "behind" && cmp.status !== "identical") return { ok: false, reason: "second_parent_not_on_default" };
  // The tree: exactly the clean three-way merge of the previous head and the second parent. A truncated tree, a merge base that is not
  // the unique best one, a failed read and a different tree are all "not verified".
  const merge = await github.checkCleanMerge(pr, { from: args.fromSha, other: second, head: args.toSha });
  if (!merge.clean) return { ok: false, reason: "tree_not_verified" };
  return { ok: true, baseSha: second, commit };
}

/** The head the entry has reached through verified refreshes: from the reviewed head, follow `from -> to` rows. */
export function refreshTip(reviewedHead: string, refreshes: readonly HeadRefreshRow[]): string {
  let cur = reviewedHead;
  const seen = new Set([cur]);
  for (;;) {
    const next = refreshes.find((r) => r.fromSha === cur);
    if (!next || seen.has(next.toSha)) return cur;
    seen.add(next.toSha);
    cur = next.toSha;
  }
}

export async function runRefreshStep<G>(deps: RefreshStepDeps<G>, input: RefreshStepInput): Promise<RefreshOutcome<G>> {
  const { accountId, holder, pr } = input;
  const entryId = input.entry.id;
  const renew = () => deps.inTenant(accountId, (c) => renewSlot(c, { accountId, entryId, holder, phase: "refresh" }));

  const held = await renew();
  if (!held) return { outcome: "slot_lost" };
  const refreshes = await deps.inTenant(accountId, (c) => listHeadRefreshes(c, accountId, entryId));
  const tip = refreshTip(input.entry.headSha, refreshes);

  const now = await deps.github.getMergeability(pr);
  if (now.state !== "open" || now.merged) return { outcome: "pr_not_open" };
  // A head we did not leave it at: our own refresh that finished after a crashed step, or somebody else's push. It can be ours only if
  // this entry recorded that it asked for a refresh from `tip`; without that record nothing is verified and nothing can carry.
  if (now.headSha !== tip) {
    const asked = await deps.inTenant(accountId, (c) => readRefreshRequested(c, accountId, entryId));
    if (asked !== tip) {
      await deps.inTenant(accountId, (c) => returnToReview(c, { accountId, entryId }));
      return { outcome: "foreign_head", headSha: now.headSha, reason: "no_refresh_requested" };
    }
    return afterHeadChange(deps, input, tip, now.headSha, "recovered");
  }

  // D#694 B6-3: in the host's merge queue GitHub builds its own group tip, so the branch is never updated here.
  if (deps.skipBehindRefresh) return { outcome: "not_behind", headSha: tip, gate: await deps.gate({ headSha: tip }) };
  const cmp = await deps.github.compareToBase(pr, tip);
  if (cmp.behindBy === 0) return { outcome: "not_behind", headSha: tip, gate: await deps.gate({ headSha: tip }) };

  // Behind. A strict repo cannot merge until it is refreshed; a non-strict one is refreshed anyway, because CI that ran against an
  // older default branch is not trusted for a merge onto a newer one. The strictness read is made either way, so an unreadable rule
  // throws (the step retries) and the outcome says which it was.
  const why: RefreshWhy = (await deps.github.requiresUpToDateBranch(pr)) ? "required" : "stale_green";
  if (held.refreshCount >= MAX_REFRESHES) {
    await deps.inTenant(accountId, (c) => stopEntry(c, { accountId, entryId, reason: "branch_behind", holder }));
    return { outcome: "branch_behind" };
  }

  // The intent is recorded BEFORE the call, so a crash between the call and the read still leaves the record that we asked.
  if (!(await deps.inTenant(accountId, (c) => markRefreshRequested(c, { accountId, entryId, holder, fromSha: tip })))) return { outcome: "slot_lost" };
  const update = await deps.github.updateBranch(pr, { expectedHeadSha: tip });
  if (update.outcome === "conflict" || update.outcome === "head_moved") {
    // GitHub did not apply it: the request is withdrawn, so a later foreign push at this head cannot ride on it.
    await deps.inTenant(accountId, (c) => markRefreshRequested(c, { accountId, entryId, holder, fromSha: null }));
    return update.outcome === "conflict" ? { outcome: "conflict" } : { outcome: "refresh_pending" };
  }

  // 202: GitHub applies the merge later. Read until the head changes, renewing the lease on every wait.
  for (let reads = 0; reads < (deps.pollLimit ?? 6); reads++) {
    await deps.sleep(deps.pollIntervalMs ?? 2000);
    if (!(await renew())) return { outcome: "slot_lost" };
    const after = await deps.github.getMergeability(pr);
    if (after.headSha !== tip) return afterHeadChange(deps, input, tip, after.headSha, why);
  }
  return { outcome: "refresh_pending" };
}

async function afterHeadChange<G>(deps: RefreshStepDeps<G>, input: RefreshStepInput, fromSha: string, toSha: string, why: RefreshWhy): Promise<RefreshOutcome<G>> {
  const { accountId, holder, pr } = input;
  const entryId = input.entry.id;
  const verdict = await verifyRefresh(deps.github, pr, { fromSha, toSha, ourLogin: deps.ourLogin });
  if (!verdict.ok) {
    // A foreign push: it is not a refresh, so no row is written and no verdict carries. Back to review at the original place.
    await deps.inTenant(accountId, (c) => returnToReview(c, { accountId, entryId }));
    return { outcome: "foreign_head", headSha: toSha, reason: verdict.reason };
  }
  // The PR's own files, read against the default branch at the new head (a rename lists both names), and the files the merge brought in.
  const prSide = await deps.github.compareToBase(pr, toSha, { files: true });
  const decision = decideCarryForward(prSide.files, verdict.commit.files);
  const refresh = { accountId, entryId, holder, fromSha, toSha, baseSha: verdict.baseSha, filesOverlap: !decision.carry };

  if (decision.carry) {
    const rec = await deps.inTenant(accountId, (c) => recordHeadRefresh(c, refresh));
    if (!rec.recorded && rec.reason === "not_holder") return { outcome: "slot_lost" };
    return { outcome: "refreshed", fromSha, toSha, baseSha: verdict.baseSha, why };
  }

  // Overlap: the row, the release of the slot and the start of the delta review are ONE transaction. A crash between them would
  // leave a recorded overlap with no review; here it leaves nothing, and the retry starts again from the same head.
  const baseSha = verdict.baseSha;
  const reason = decision.reason;
  return deps.inTenant(accountId, async (c): Promise<RefreshOutcome<G>> => {
    const rec = await recordHeadRefresh(c, refresh);
    if (!rec.recorded && rec.reason === "not_holder") return { outcome: "slot_lost" };
    const released = await releaseForWork(c, { accountId, entryId, holder, kind: "delta_review" });
    if (!released.ok) return { outcome: "slot_lost" };
    const started = await deps.startDeltaReview(c, { entry: released.entry, fromSha, toSha, baseSha });
    if (!started.started) {
      if (started.reason === "refused_spend") {
        await stopEntry(c, { accountId, entryId, reason: started.reason });
        return { outcome: "refused_spend", fromSha, toSha };
      }
      if (started.reason === "main_side_only") {
        await finishWork(c, { accountId, entryId });
        return { outcome: "delta_skipped", fromSha, toSha };
      }
      await returnToReview(c, { accountId, entryId });
      return { outcome: "delta_not_started", fromSha, toSha, reason: started.reason };
    }
    if (started.runId !== null) await attachWorkRun(c, { accountId, entryId, runId: started.runId });
    return { outcome: "needs_delta_review", fromSha, toSha, baseSha, reason, runId: started.runId };
  });
}
