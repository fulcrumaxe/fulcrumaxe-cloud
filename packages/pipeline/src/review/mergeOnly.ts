import type { Pool } from "pg";
import { withTenant } from "@fx/core/src/tenancy/withTenant.js";
import { recordDriverEvent } from "@fx/core/src/work-items/driverEvents.js";
import type { GitHubHttp } from "../build/githubMergePort.js";
import { gateReviewerReasons, loadRunsOnSha, SHA_PATTERN, type GatedRole } from "../build/mergeGate.js";
import type { CiGate, CiWaitReason } from "./ciWait.js";
import { loadReviewContext } from "./context.js";
import { reviewerFlaggedSecurity } from "./mergeGateRun.js";
import { isSafeRef } from "./reviewPrompts.js";
import type { VerdictRole } from "./verdicts.js";

/**
 * D#598 P7c: a new head that is only a merge of the default branch into the pull request's branch gets a delta re-check, not a
 * second full review.
 *
 * What the re-check is. Not an agent run: a fixed set of facts read from GitHub and from our own records, then one driver event.
 * The head is carried forward only when ALL of these hold:
 *   1. the newest head that was reviewed has a pass from every required reviewer by our records (the merge gate's own test);
 *   2. the new head is a merge commit: exactly two parents, the first being that reviewed head;
 *   3. the second parent is already part of the base branch's history (the merge brought in the default branch and nothing else);
 *   4. the new head's tree is exactly the clean three-way merge of the reviewed head and that second parent, over the merge base of the two:
 *      for every path, the entry (file mode and blob id, so an exec-bit flip or a symlink conversion shows) is the reviewed head's when the
 *      base side did not change it, the second parent's when the pull request did not change it, and, when both changed it, only when both
 *      made the same change. Both sides changing a path differently is never carried: a lazy "keep mine" resolution would silently revert
 *      the base's change once the pull request is squash-merged. That rule is only sound over THE merge base, so the merge base must be
 *      the unique best one (`isUniqueBase`).
 * Anything else, or any read that fails or is cut short (a truncated tree, GitHub's 100,000-entry cap), is a full review. Conservative on
 * purpose: a merge that touched a file both sides changed, a hand-edited merge commit, or several commits since the reviewed head all differ
 * from the clean merge, so they get a full review.
 *
 * The record. A `review_verdicts` driver event with the code `merge_only_recheck` on the new head. Its `from_<sha>` reason is the
 * reviewed head the merge was made from, and `rows_<sha>` the head whose reviewer runs stand for the new one (the same head, or, when
 * the reviewed head was itself carried, the one it was carried from). The merge gate (build/mergeGate.ts `loadRunsOnSha`) reads that
 * event, so the carried passes count for the new head and no other. No second row of reviewer runs is ever created.
 *
 * The boundary with D#519: a verified platform refresh of a queued entry's head (`head_refreshes`, MQ3's update-branch) is MQ3's
 * carry-forward, decided inside the queue; this module never writes that table. This is for a head that a person or
 * a bot made by merging the default branch, which the queue did not do. For a head the platform refreshed, this module reads the `head_refreshes` row
 * (read only) and declines, so only one of the two ever carries a given head.
 *
 * A `runner_local` repo is always a full review: its GitHub reads go through an allowlisted client that has no compare or git-commit call.
 */

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

export const MERGE_ONLY_CODE = "merge_only_recheck";
const SHA1 = /^[0-9a-f]{40}$/;

/** A tree entry as `mode type sha`: a change of mode, of kind (file, symlink, submodule) or of content shows up as a different string. */
type Entries = ReadonlyMap<string, string>;
export type TreeReading = { ok: true; entries: Entries } | { ok: false };

const repoPath = (owner: string, name: string): string => `/repos/${owner}/${name}`;

/** The commit's tree id, or null when the commit cannot be read. */
async function readTreeId(http: GitHubHttp, repo: { owner: string; name: string }, commit: string): Promise<string | null> {
  const res = await http.request({ method: "GET", path: `${repoPath(repo.owner, repo.name)}/git/commits/${commit}` });
  const tree = res.status === 200 && isObj(res.body) ? res.body.tree : undefined;
  return isObj(tree) && typeof tree.sha === "string" && SHA1.test(tree.sha) ? tree.sha : null;
}

/** Every file, symlink and submodule entry (directories are implied by their contents) of one commit's tree. A truncated list is unreadable. */
export async function readTreeEntries(http: GitHubHttp, repo: { owner: string; name: string }, commit: string): Promise<TreeReading> {
  if (!SHA1.test(commit)) return { ok: false };
  const treeId = await readTreeId(http, repo, commit);
  if (treeId === null) return { ok: false };
  const res = await http.request({ method: "GET", path: `${repoPath(repo.owner, repo.name)}/git/trees/${treeId}`, query: { recursive: 1 } });
  if (res.status !== 200 || !isObj(res.body) || res.body.truncated !== false || !Array.isArray(res.body.tree)) return { ok: false };
  const entries = new Map<string, string>();
  for (const e of res.body.tree) {
    if (!isObj(e) || typeof e.path !== "string" || typeof e.mode !== "string" || typeof e.type !== "string" || typeof e.sha !== "string") return { ok: false };
    if (e.type !== "tree") entries.set(e.path, `${e.mode} ${e.type} ${e.sha}`);
  }
  return { ok: true, entries };
}

/**
 * Whether `head` is the clean three-way merge of `from` (the reviewed head) and `other` (the second parent) over `base`, path by path.
 * Where the base side did not change a path the reviewed head's entry stands; where the pull request did not change it the second
 * parent's does; where both changed it the result must equal what they both made. Anything else is not the clean merge.
 */
export function isCleanMerge(base: Entries, from: Entries, other: Entries, head: Entries): boolean {
  const paths = new Set([...base.keys(), ...from.keys(), ...other.keys(), ...head.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const f = from.get(path);
    const o = other.get(path);
    const h = head.get(path);
    if (f === o) {
      if (h !== f) return false;
    } else if (f === b) {
      if (h !== o) return false;
    } else if (o === b) {
      if (h !== f) return false;
    } else {
      return false;
    }
  }
  return true;
}

/**
 * Whether the merge base GitHub named for `from...other` is the one best merge base of the two. With a criss-cross history (the two sides
 * merged into each other) there are two, GitHub returns just one, and the three-way test over the wrong one is NOT stricter: measured from
 * it the base side can look unchanged on a path where, measured from the other, both sides changed it. A merge that real git reports as a
 * conflict, resolved "keep mine", would then pass and the squash merge would override the base's resolution with no review.
 *
 * The test: `aheadFromBase` is `ahead_by` of `compare/{baseCommit}...{other}` (the commits `other` reaches that the merge base does not),
 * `aheadFromReviewed` is `ahead_by` of `compare/{from}...{other}` (those `from` does not reach). The merge base is an ancestor of `from`, so
 * the second set lies inside the first, and they are equal exactly when every common ancestor of `from` and `other` is an ancestor of the
 * merge base, that is, when it is the unique best base. A missing or malformed count is not unique.
 */
export function isUniqueBase(aheadFromBase: unknown, aheadFromReviewed: unknown): boolean {
  return typeof aheadFromBase === "number" && Number.isInteger(aheadFromBase) && aheadFromBase >= 0 && aheadFromBase === aheadFromReviewed;
}

/** A compare answer whose `ahead_by` and `total_commits` are the same integer (a missing or different `total_commits` is not agreement). */
function countsAgree(body: Json): boolean {
  return typeof body.ahead_by === "number" && Number.isInteger(body.ahead_by) && body.total_commits === body.ahead_by;
}

export type MergeOnlyReading = { mergeOnly: true } | { mergeOnly: false; reason: string };

/** Whether `head` is only a merge of the base branch into the branch that was at `from` (conditions 2 to 4 above). Fail closed: any doubt is `mergeOnly: false`. */
export async function readMergeOnly(http: GitHubHttp, repo: { owner: string; name: string; baseRef: string; from: string; head: string }): Promise<MergeOnlyReading> {
  if (!SHA1.test(repo.from) || !SHA1.test(repo.head) || !isSafeRef(repo.baseRef)) return { mergeOnly: false, reason: "malformed" };
  const commit = await http.request({ method: "GET", path: `${repoPath(repo.owner, repo.name)}/git/commits/${repo.head}` });
  if (commit.status !== 200) return { mergeOnly: false, reason: "github_unavailable" };
  const parents = isObj(commit.body) && Array.isArray(commit.body.parents) ? commit.body.parents.map((p) => (isObj(p) && typeof p.sha === "string" ? p.sha : "")) : [];
  if (parents.length !== 2 || parents[0] !== repo.from || !SHA1.test(parents[1]!)) return { mergeOnly: false, reason: "not_a_merge_of_the_reviewed_head" };
  // The second parent must already be in the base branch's history: compare parent...base answers `ahead` (or `identical`) exactly then.
  const anc = await http.request({ method: "GET", path: `${repoPath(repo.owner, repo.name)}/compare/${parents[1]}...${repo.baseRef}`, query: { per_page: 1 } });
  if (anc.status !== 200) return { mergeOnly: false, reason: "github_unavailable" };
  const status = isObj(anc.body) ? anc.body.status : undefined;
  if (status !== "ahead" && status !== "identical") return { mergeOnly: false, reason: "merged_something_other_than_base" };
  // The merge base of the reviewed head and the second parent: the commit a three-way merge of the two starts from.
  const mb = await http.request({ method: "GET", path: `${repoPath(repo.owner, repo.name)}/compare/${repo.from}...${parents[1]}`, query: { per_page: 1 } });
  const baseCommit = mb.status === 200 && isObj(mb.body) && isObj(mb.body.merge_base_commit) ? mb.body.merge_base_commit.sha : undefined;
  if (typeof baseCommit !== "string" || !SHA1.test(baseCommit)) return { mergeOnly: false, reason: "diff_unreadable" };
  // Carry only over the unique best merge base (a criss-cross history has two, and GitHub names one of them).
  const fromBase = await http.request({ method: "GET", path: `${repoPath(repo.owner, repo.name)}/compare/${baseCommit}...${parents[1]}`, query: { per_page: 1 } });
  if (fromBase.status !== 200 || !isObj(fromBase.body) || !isObj(mb.body)) return { mergeOnly: false, reason: "diff_unreadable" };
  // `total_commits` is documented as the `git log BASE..HEAD` count, which is what `ahead_by` should also be. A read where they differ is not
  // one the test below can rely on, so it is a full review.
  if (!isUniqueBase(fromBase.body.ahead_by, mb.body.ahead_by)) return { mergeOnly: false, reason: "ambiguous_merge_base" };
  if (!countsAgree(fromBase.body) || !countsAgree(mb.body)) return { mergeOnly: false, reason: "diff_unreadable" };
  const ids = { owner: repo.owner, name: repo.name };
  const [base, from, other, head] = await Promise.all([baseCommit, repo.from, parents[1]!, repo.head].map((c) => readTreeEntries(http, ids, c)));
  if (!base!.ok || !from!.ok || !other!.ok || !head!.ok) return { mergeOnly: false, reason: "diff_unreadable" };
  return isCleanMerge(base!.entries, from!.entries, other!.entries, head!.entries) ? { mergeOnly: true } : { mergeOnly: false, reason: "code_changed" };
}

export interface MergeOnlyInput {
  accountId: string;
  workItemId: string;
  headSha: string;
  prNumber: number;
  baseRef: string;
  /** The roles the review plan requires on the new head. */
  requiredRoles: readonly VerdictRole[];
}

export type MergeOnlyDecision =
  | { decision: "all_passed"; from: string }
  /** Not a merge-only head (or no way to be sure): the caller runs the full review. Nothing was recorded. */
  | { decision: "full_review"; reason: string }
  | { decision: "ci_pending"; ciReasons: CiWaitReason[] }
  /** The pull request's head is no longer the one asked about (only where the CI read follows the pull request). Nothing was recorded. */
  | { decision: "head_moved" };

interface PriorHead {
  head: string;
  /** The head whose runs stand for it. */
  rows: string;
}

/** The newest head (other than `headSha`) a review round was recorded for. */
async function priorReviewedHead(pool: Pool, accountId: string, workItemId: string, headSha: string): Promise<PriorHead | null> {
  return withTenant(pool, accountId, async (client) => {
    const { rows } = await client.query<{ head_sha: string; code: string | null; reasons: string[] }>(
      `SELECT head_sha, code, reasons FROM work_item_driver_events
        WHERE account_id = $1 AND work_item_id = $2 AND kind = 'review_verdicts' AND head_sha IS NOT NULL AND head_sha <> $3
        ORDER BY seq DESC LIMIT 1`,
      [accountId, workItemId, headSha],
    );
    const r = rows[0];
    if (!r || !SHA1.test(r.head_sha)) return null;
    if (r.code === null) return { head: r.head_sha, rows: r.head_sha };
    if (r.code !== MERGE_ONLY_CODE) return null;
    const carried = /^rows_([0-9a-f]{40})$/.exec(r.reasons.find((x) => x.startsWith("rows_")) ?? "");
    return carried ? { head: r.head_sha, rows: carried[1]! } : null;
  });
}

/**
 * Decides and, when the head is merge-only and its CI has finished, records the re-check. Reads before any write; a throw records nothing and
 * the caller's step retries. `ci` is required for the same reason as in `recordRound`: the wait cannot be skipped by omission.
 */
export async function recordMergeOnlyRecheck(pool: Pool, input: MergeOnlyInput, deps: { http: GitHubHttp; ci: CiGate }): Promise<MergeOnlyDecision> {
  const { accountId, workItemId, headSha, prNumber } = input;
  const full = (reason: string): MergeOnlyDecision => ({ decision: "full_review", reason });
  if (!SHA1.test(headSha) || !SHA_PATTERN.test(headSha)) return full("head_not_sha1");
  const loaded = await loadReviewContext(pool, accountId, workItemId);
  if (!loaded.ok) return full(loaded.reason);
  const ctx = loaded.ctx;
  if (ctx.executionMode === "runner_local") return full("runner_local");

  // The boundary with D#519: a head the platform's own verified refresh made (a `head_refreshes` row) is the merge queue's carry-forward, not this one.
  // Nothing is carried here for it; the reviewers run as they did before this module existed, and the queue's own record stands on its own.
  const refreshed = await withTenant(pool, accountId, (client) =>
    client.query("SELECT 1 FROM head_refreshes WHERE account_id = $1 AND work_item_id = $2 AND to_sha = $3 LIMIT 1", [accountId, workItemId, headSha]),
  );
  if (refreshed.rowCount === 1) return full("platform_refresh_left_to_queue");

  const prior = await priorReviewedHead(pool, accountId, workItemId, headSha);
  if (prior === null) return full("no_prior_review");
  // 1. Every required reviewer passed on the reviewed head, by the gate's own test. A security flag its code reviewer set keeps the security reviewer required.
  const roles = new Set<GatedRole>(input.requiredRoles);
  if (await reviewerFlaggedSecurity(pool, accountId, workItemId, prior.rows, false)) roles.add("security-reviewer");
  if (gateReviewerReasons([...roles], await loadRunsOnSha(pool, accountId, workItemId, prior.rows), "cloud").length > 0) return full("prior_not_passed");

  // 2 to 4. The commit and the diff, from GitHub.
  const reading = await readMergeOnly(deps.http, { owner: ctx.owner, name: ctx.name, baseRef: input.baseRef, from: prior.head, head: headSha });
  if (!reading.mergeOnly) return full(reading.reason);

  // The head's CI and repo-wide guards finish before anything is recorded (D#598 P7b), as for a full review.
  const wait = await deps.ci.read({ accountId, workItemId, prNumber, headSha });
  if (wait.state === "head_moved") return { decision: "head_moved" };
  if (wait.state === "pending") return { decision: "ci_pending", ciReasons: wait.reasons };

  await withTenant(pool, accountId, (client) =>
    recordDriverEvent(client, accountId, {
      workItemId,
      kind: "review_verdicts",
      dedupeKey: `merge_only:${headSha}`,
      code: MERGE_ONLY_CODE,
      reasons: [`from_${prior.head}`, `rows_${prior.rows}`],
      headSha,
      prNumber,
    }),
  );
  return { decision: "all_passed", from: prior.head };
}
