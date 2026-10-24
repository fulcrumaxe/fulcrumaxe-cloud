import type { Pool, PoolClient } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { listDuePrSlotReconciles, PR_SLOT_RECONCILE_LIST_LIMIT } from "@fx/db/src/prSlotReconcileLister.js";
import { recordStage } from "@fx/core/src/work-items/recordStage.js";
import { IllegalStageTransitionError } from "@fx/core/src/work-items/stages.js";
import { ITEM_PR_BRANCH, RUNNER_RUN_BRANCH } from "@fulcrumaxe/runner-protocol";
import { effectiveModeSql, isRunnerMode, readRecordedRunnerPullRequest, readSandboxBoundPullRequest } from "@fx/runner";

/**
 * D#598: an item in a pull-request stage whose pull request is already closed or merged on GitHub.
 *
 * The pull_request webhook is what moves an item out of `pr_opened`, `changes_requested` or `review_passed` (packages/github eventMapper, `transition_pr`).
 * When that delivery never arrives (the pull request was closed before the App was installed, a delivery GitHub gave up on), the item stays in a
 * pull-request stage, and a pull-request stage holds a build slot (packages/pipeline buildSlots.ts), so the repository's only build slot is held for good.
 * This module reads the pull request's real state back from GitHub and, when it is closed or merged, records the move the webhook would have made:
 * `recordStage` to `merged` or `closed_unmerged`, source `webhook` (it is a fact about GitHub, recorded for a halted item as the webhook's is), at the
 * merge or close time GitHub reports. That is the same transition row, the same `work_item.stage_changed` event and the same branch-cleanup wake. A later
 * webhook for the same close finds the item already at that stage and is a no-op (eventMapper treats it as a duplicate).
 *
 * Which pull request. The one the review and the merge look up: a runner run's is the number and branch its `done` recorded; a sandbox round bound to a
 * pull request another side opened is that pair; a sandbox build is the item's own branch `fx/issue-<n>`. It is read with the list call
 * (`GET /repos/{o}/{r}/pulls?state=all&head=<o>:<branch>`), which is the read a `runner_local` repository's fenced client allows (A3), through the
 * read-only installation client (`metadata: read`, `pull_requests: read`, GET only) the caller opens. Any open pull request on that branch means the item
 * is still in review and nothing changes; otherwise the newest one decides: `merged_at` set is merged, else closed unmerged.
 *
 * Two-plane repositories. When the item's repository is paired with a public code repository and the platform recorded the public pull request it opened
 * (`plane_pushes`: the paired repository, the public branch `fx/p-<id>`, the pull request number), THAT is the pull request in force and it is read where it lives:
 * the paired repository, by the recorded number AND branch. The runner's own record names a private pull request (the run branch's), which can stay open for ever
 * after the public one was closed or merged; reading it kept the slot held (the first live case). A paired item whose public pull request is not recorded yet
 * reads nothing (`no_pull_request`), and a pull request of the same number on the private repository is never looked at: the list call is made on the paired
 * repository only, the head repository must be that repository, and the number must be the recorded one. The pairing is read as it is now (a cleared pairing
 * returns the item to the single-repository path). The read-only client is opened for the item's own repository (its installation), scoped to the paired one.
 *
 * Only the pull request in force. The deciding pull request must have closed or merged AFTER the item entered its current pull-request stage (the latest
 * move into a pull-request stage from a stage outside them), so an older closed pull request on the item's branch cannot close an item whose current
 * pull request (one linked another way, on another branch) is still open. The locked re-read checks the same branch, number and entry time still hold.
 *
 * Fail safe. A GitHub answer that is not 200, a body of the wrong shape, no pull request found, or a throw changes nothing about the item. The stage is
 * read again under the row lock right before the move, so a webhook that got in first wins and this records nothing.
 *
 * Bounded. Each item is asked about at most once per PR_RECONCILE_EVERY_SECONDS, whoever asks (a waiting build, the sweep): the caller whose upsert of the
 * item's `pr_slot_reconciles` row moves its time makes the read, every other caller in the window does not (migration 0894). Everything is read and
 * written under the item's own tenant; the sweep's cross-tenant list (0894's definer) names ids only. Nothing is ever written to GitHub.
 */

/** One read per item per this long (migration 0894's lister uses the same 600 seconds; a test holds the two equal). */
export const PR_RECONCILE_EVERY_SECONDS = 600;
/** The stages in which an item has a pull request and holds a build slot. */
export const PR_STAGES: readonly string[] = Object.freeze(["pr_opened", "changes_requested", "review_passed"]);
/** The most holders one refused build start checks. */
export const MAX_HOLDERS_PER_WAIT = 10;
/** A sweep pass stops starting items after this long (it shares the branch-cleanup route's minute). */
export const PR_SWEEP_BUDGET_MS = 15_000;

/** The read-only GitHub client for one repository: the `read` installation client, fenced for a `runner_local` repository. */
export interface PrStateHttp {
  request(req: { method: "GET"; path: string; query?: Readonly<Record<string, string | number>> }): Promise<{ status: number; body: unknown }>;
}
/** Opens that client. `executionMode` is the side that built the pull request (it decides the fence). */
export type PrStateOpen = (executionMode: string, target: { repoId: string; owner: string; name: string }) => Promise<PrStateHttp>;

export type PrState = { ok: true; state: "open" } | { ok: true; state: "merged" | "closed_unmerged"; number: number; at: Date } | { ok: false; reason: "github_unavailable" | "malformed" | "no_pull_request" };

/** The public branch the platform pushes for a paired item: `fx/p-<plane_pushes.id>` (the column is generated from the row id). */
const PLANE_PUSH_BRANCH = /^fx\/p-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);
const isTime = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

/**
 * The state of the pull request(s) whose head is `branch` in this repository (and, when `number` is given, that one only). Structured fields only: a
 * number, a state word and two times. A title or body is never read.
 */
export async function readPullRequestState(http: PrStateHttp, repo: { owner: string; name: string }, target: { branch: string; number: number | null }): Promise<PrState> {
  if (!OWNER_RE.test(repo.owner) || !NAME_RE.test(repo.name) || !(ITEM_PR_BRANCH.test(target.branch) || RUNNER_RUN_BRANCH.test(target.branch) || PLANE_PUSH_BRANCH.test(target.branch))) return { ok: false, reason: "malformed" };
  const res = await http.request({ method: "GET", path: `/repos/${repo.owner}/${repo.name}/pulls`, query: { state: "all", head: `${repo.owner}:${target.branch}`, per_page: 30 } });
  if (res.status !== 200) return { ok: false, reason: "github_unavailable" };
  if (!Array.isArray(res.body)) return { ok: false, reason: "malformed" };
  const here = `${repo.owner}/${repo.name}`.toLowerCase();
  const mine: { number: number; state: string; mergedAt: string | null; closedAt: string | null }[] = [];
  for (const p of res.body) {
    if (!isObj(p) || !isObj(p.head)) return { ok: false, reason: "malformed" };
    const headRepo = p.head.repo;
    // Only a branch of this repository with exactly this name: the head repository must be the base repository.
    if (!isObj(headRepo) || typeof headRepo.full_name !== "string" || headRepo.full_name.toLowerCase() !== here || p.head.ref !== target.branch) continue;
    if (typeof p.number !== "number" || !Number.isSafeInteger(p.number) || p.number <= 0) return { ok: false, reason: "malformed" };
    if (p.state !== "open" && p.state !== "closed") return { ok: false, reason: "malformed" };
    if (!(p.merged_at === null || isTime(p.merged_at)) || !(p.closed_at === null || isTime(p.closed_at))) return { ok: false, reason: "malformed" };
    if (p.state === "closed" && p.closed_at === null) return { ok: false, reason: "malformed" };
    if (target.number !== null && p.number !== target.number) continue;
    mine.push({ number: p.number, state: p.state, mergedAt: p.merged_at as string | null, closedAt: p.closed_at as string | null });
  }
  if (mine.length === 0) return { ok: false, reason: res.body.length === 0 || target.number !== null ? "no_pull_request" : "malformed" };
  if (mine.some((p) => p.state === "open")) return { ok: true, state: "open" };
  const newest = mine.reduce((a, b) => (b.number > a.number ? b : a));
  return newest.mergedAt !== null
    ? { ok: true, state: "merged", number: newest.number, at: new Date(newest.mergedAt) }
    : { ok: true, state: "closed_unmerged", number: newest.number, at: new Date(newest.closedAt!) };
}

export type ReconcileOutcome = "merged" | "closed_unmerged" | "open" | "not_held" | "older_pull_request" | "no_pull_request" | "recently_checked" | "github_unavailable" | "malformed";

interface Holder {
  /** The item's own repository (its installation opens the client). */
  repoId: string;
  /** The repository the pull request lives in: the item's own, or the paired public one. */
  owner: string;
  name: string;
  /** The side that built the pull request (the newest executor run's mode, else the item's effective mode). */
  prMode: string;
  target: { branch: string; number: number | null };
  /** When the item entered its current pull-request stage: a pull request that closed before this is not the one in force. */
  enteredAt: Date;
}

/** The item's pull request target and stage entry time, read under its tenant (`lock`: the row is locked, as recordStage will). Not a claim on the window. */
async function resolveHolder(client: PoolClient, accountId: string, workItemId: string, lock: boolean): Promise<Holder | "not_held" | "no_pull_request"> {
  const r = await client.query<{ stage: string; repo_id: string | null; gh_number: string | null; gh_owner: string | null; gh_name: string | null; execution_mode: string | null; newest_mode: string | null }>(
    `SELECT w.stage, w.repo_id, w.gh_number, r.gh_owner, r.gh_name, ${effectiveModeSql("w", "r")} AS execution_mode,
            (SELECT ar.execution_mode FROM agent_runs ar WHERE ar.account_id = w.account_id AND ar.work_item_id = w.id AND ar.role = 'executor' ORDER BY ar.created_at DESC, ar.id DESC LIMIT 1) AS newest_mode
       FROM work_items w JOIN repos r ON r.account_id = w.account_id AND r.id = w.repo_id
      WHERE w.id = $1 AND w.account_id = $2${lock ? " FOR UPDATE OF w" : ""}`,
    [workItemId, accountId],
  );
  const row = r.rows[0];
  if (!row || !PR_STAGES.includes(row.stage) || row.repo_id === null) return "not_held";
  if (!row.gh_owner || !row.gh_name) return "no_pull_request";
  const prMode = row.newest_mode ?? row.execution_mode ?? "sandbox";
  // A paired repository's pull request is the public one the platform recorded, read on the paired repository (see the header).
  const plane = await client.query<{ code_repo: string; branch: string; pr_number: number | null }>(
    `SELECT p.code_repo, p.branch, p.pr_number
       FROM plane_pushes p JOIN repo_pairing rp ON rp.account_id = p.account_id AND rp.repo_id = p.repo_id AND lower(rp.code_repo) = lower(p.code_repo)
      WHERE p.account_id = $1 AND p.work_item_id = $2 AND p.repo_id = $3 ORDER BY p.created_at DESC, p.id DESC LIMIT 1`,
    [accountId, workItemId, row.repo_id],
  );
  const paired = plane.rows[0];
  let owner = row.gh_owner;
  let name = row.gh_name;
  let target: { branch: string; number: number | null } | null;
  if (paired) {
    const [o, n, extra] = paired.code_repo.split("/");
    if (paired.pr_number === null || !o || !n || extra !== undefined) return "no_pull_request";
    owner = o;
    name = n;
    target = { branch: paired.branch, number: paired.pr_number };
  } else {
    const recorded = isRunnerMode(prMode) ? await readRecordedRunnerPullRequest(client, { accountId, workItemId }) : await readSandboxBoundPullRequest(client, { accountId, workItemId });
    const issue = row.gh_number === null ? null : Number(row.gh_number);
    target = recorded !== null ? { branch: recorded.branch, number: recorded.number } : !isRunnerMode(prMode) && issue !== null && Number.isSafeInteger(issue) && issue > 0 ? { branch: `fx/issue-${issue}`, number: null } : null;
  }
  if (target === null) return "no_pull_request";
  // The latest move into a pull-request stage from outside them. No such move: the entry time is unknown, so no closed pull request can be shown to be the one in force.
  const entry = await client.query<{ at: Date | null }>(
    `SELECT max(at) AS at FROM work_item_transitions
      WHERE account_id = $1 AND work_item_id = $2 AND to_stage = ANY($3::text[]) AND from_stage <> ALL($3::text[])`,
    [accountId, workItemId, [...PR_STAGES]],
  );
  const enteredAt = entry.rows[0]?.at ?? null;
  if (enteredAt === null) return "no_pull_request";
  return { repoId: row.repo_id, owner, name, prMode, target, enteredAt };
}

/** The item's pull request target, read under its tenant, and the claim on this window's read. */
async function loadAndClaim(client: PoolClient, accountId: string, workItemId: string): Promise<Holder | "not_held" | "no_pull_request" | "recently_checked"> {
  const holder = await resolveHolder(client, accountId, workItemId, false);
  if (typeof holder === "string") return holder;
  const claim = await client.query(
    `INSERT INTO pr_slot_reconciles (account_id, work_item_id, checked_at) VALUES ($1, $2, now())
     ON CONFLICT (account_id, work_item_id) DO UPDATE SET checked_at = now()
      WHERE pr_slot_reconciles.checked_at <= now() - make_interval(secs => $3::int)`,
    [accountId, workItemId, PR_RECONCILE_EVERY_SECONDS],
  );
  if (claim.rowCount !== 1) return "recently_checked";
  return holder;
}

/** Reads one item's pull request from GitHub and, when it is closed or merged, moves the item as the webhook would. Never throws for GitHub. */
export async function reconcileHolder(pool: Pool, open: PrStateOpen, accountId: string, workItemId: string): Promise<ReconcileOutcome> {
  const holder = await withTenant(pool, accountId, (client) => loadAndClaim(client, accountId, workItemId));
  if (typeof holder === "string") return holder;
  let state: PrState;
  try {
    state = await readPullRequestState(await open(holder.prMode, { repoId: holder.repoId, owner: holder.owner, name: holder.name }), holder, holder.target);
  } catch {
    // fx-swallow-ok: a client that cannot be opened or a request that throws is "GitHub could not be read": the item is left as it is, and the next window asks again
    state = { ok: false, reason: "github_unavailable" };
  }
  if (!state.ok) return state.reason;
  if (state.state === "open") return "open";
  const toStage = state.state;
  const at = state.at;
  const decidingNumber = state.number;
  if (at.getTime() <= holder.enteredAt.getTime()) return "older_pull_request";
  const sourceRef = `pr_reconcile:${state.number}`;
  return withTenant(pool, accountId, async (client) => {
    // Read again under the row lock (recordStage takes the same one): a webhook that moved the item first wins, and nothing is recorded. The pull request
    // in force must still be the one that was read: the same branch, the same recorded number (and the deciding number when none is recorded), and the
    // same entry into the pull-request stage, which the deciding pull request closed after.
    const now = await resolveHolder(client, accountId, workItemId, true);
    if (typeof now === "string") return now;
    const same = now.owner.toLowerCase() === holder.owner.toLowerCase() && now.name.toLowerCase() === holder.name.toLowerCase() && now.target.branch === holder.target.branch && now.target.number === holder.target.number && (now.target.number === null || now.target.number === decidingNumber) && now.enteredAt.getTime() === holder.enteredAt.getTime();
    if (!same) return "not_held";
    try {
      await recordStage(client, { workItemId, toStage, at, source: "webhook", sourceRef });
    } catch (err) {
      if (err instanceof IllegalStageTransitionError) return "not_held";
      throw err;
    }
    return toStage;
  });
}

/**
 * A build start was refused because the slots are held. Checks the holders that have a pull request (the same repository for a repository reason, the
 * account's hosted items for the account reason), each at most once per window, and answers how many it moved out of a pull-request stage.
 */
export async function reconcileSlotHolders(pool: Pool, open: PrStateOpen, accountId: string, waiterId: string, reason: string, log: (line: string) => void = (l) => console.info(l)): Promise<number> {
  const scope = reason === "waiting_for_build_slot_account" ? "account" : "repo";
  const holders = await withTenant(pool, accountId, async (client) =>
    (
      await client.query<{ id: string }>(
        `SELECT h.id FROM work_items h
           JOIN repos r ON r.account_id = h.account_id AND r.id = h.repo_id
           JOIN work_items me ON me.account_id = h.account_id AND me.id = $2
          WHERE h.account_id = $1 AND h.id <> $2 AND h.stage = ANY($3::text[])
            AND (($4::text = 'repo' AND h.repo_id = me.repo_id) OR ($4::text = 'account' AND ${effectiveModeSql("h", "r")} NOT IN ('runner_local', 'runner_verified')))
          ORDER BY h.updated_at, h.id LIMIT $5::int`,
        [accountId, waiterId, [...PR_STAGES], scope, MAX_HOLDERS_PER_WAIT],
      )
    ).rows.map((x) => x.id),
  );
  let moved = 0;
  for (const id of holders) {
    const outcome = await reconcileHolder(pool, open, accountId, id);
    if (outcome !== "recently_checked") log(JSON.stringify({ event: "advance.pr_slot_reconcile", work_item_id: id, waiting_item_id: waiterId, outcome }));
    if (outcome === "merged" || outcome === "closed_unmerged") moved += 1;
  }
  return moved;
}

export interface PrSlotSweepCounts {
  listed: number;
  /** Items moved to merged or closed_unmerged. */
  moved: number;
  /** Items whose pull request is still open, or that were not moved for a reason that is no failure. */
  unchanged: number;
  /** Items GitHub or the database could not answer for; listed again in the next window. */
  failed: number;
}

/** One pass of the periodic sweep: every item in a pull-request stage not checked in the window, across accounts, each under its own tenant. */
export async function sweepPrSlotHolders(deps: { pool: Pool; openClient: PrStateOpen; now?: () => number; log?: (line: string) => void }): Promise<PrSlotSweepCounts> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.info(line));
  const counts: PrSlotSweepCounts = { listed: 0, moved: 0, unchanged: 0, failed: 0 };
  const startedAt = now();
  let due;
  try {
    due = await listDuePrSlotReconciles(deps.pool, { limit: PR_SLOT_RECONCILE_LIST_LIMIT });
  } catch (error) {
    // fx-swallow-ok: counted and logged with a fixed code (never the driver's message); the next tick looks again
    counts.failed += 1;
    log(JSON.stringify({ event: "pr_slot_sweep.list_failed", code: (error as { code?: string } | null)?.code ?? "error" }));
    return counts;
  }
  counts.listed = due.length;
  for (const item of due) {
    if (now() - startedAt > PR_SWEEP_BUDGET_MS) break;
    try {
      const outcome = await reconcileHolder(deps.pool, deps.openClient, item.accountId, item.workItemId);
      if (outcome === "merged" || outcome === "closed_unmerged") counts.moved += 1;
      else if (outcome === "github_unavailable" || outcome === "malformed") counts.failed += 1;
      else counts.unchanged += 1;
      if (outcome !== "open" && outcome !== "recently_checked") log(JSON.stringify({ event: "pr_slot_sweep.item", work_item_id: item.workItemId, outcome }));
    } catch (error) {
      // fx-swallow-ok: one item's failure is counted and logged by id and a fixed code; the pass goes on and the item is listed again
      counts.failed += 1;
      log(JSON.stringify({ event: "pr_slot_sweep.failed", work_item_id: item.workItemId, code: (error as { code?: string } | null)?.code ?? "error" }));
    }
  }
  return counts;
}
