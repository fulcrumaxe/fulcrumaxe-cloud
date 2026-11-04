import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { BranchSyncOutcome } from "@fx/github";
import { withTenant } from "@fx/db/src/withTenant.js";
import { recordDriverEvent } from "@fx/core/src/work-items/driverEvents.js";
import { recordStage } from "@fx/core/src/work-items/recordStage.js";
import { IllegalStageTransitionError, WorkItemHaltedError } from "@fx/core/src/work-items/stages.js";
import { emitDomainEvent } from "@fx/core/src/domain-events/emit.js";
import { BASE_SYNCED, BASE_SYNC_CONFLICT, BASE_SYNC_UNAVAILABLE, REPLACE_ROUND_CODE_OF, REPUBLISH_BASE_MISSING, REPUBLISH_STACKED_UNSUPPORTED, REPUBLISH_STACK_PARENT_ENDED, REPUBLISH_STACK_PARENT_CLOSED } from "@fx/core/src/work-items/baseSync.js";
import { readStackParentPull } from "@fx/core/src/work-items/stackParentPull.js";
import { decideStackStart } from "@fx/pipeline";
import { readPlanePush } from "@fx/core/src/repos/planePushRecord.js";
import { RUNNER_REPLACE_ROUND_KIND } from "@fx/runner";
import { clearReplaceAuthorization } from "@fx/core/src/setup-requests/branchPushed.js";
import { checkPublicBranch, type FixRoundHeadPorts } from "./fixRoundHeads.js";

/**
 * FIXROUND-BASE-SYNC (R2-a): before either kind of fix round starts, the pull request's base branch is merged into the item's private branch, with one
 * synchronous GitHub call (`ports.syncBase`, packages/github `branchSync.ts`). A branch cut before its base moved would otherwise carry the old base into
 * the round, and the round's check would fail on what the base has since fixed.
 *
 *  - up to date (204): nothing was written; the round starts from the branch as it is.
 *  - merged (201): GitHub made a merge commit `M` whose parents must be exactly the head the round was checked against and the base tip the cloud read. It is
 *    recorded as the webhook would record a push (`pr_head_pushed`, code `base_synced`, one fact per change), and the round starts from `M`. If the first
 *    parent is not the head that was checked (a push in between) that push is recorded too, as `observed`. A reply with other parents refuses the round.
 *  - conflict (409): nothing was written. `escalated` / `base_sync_conflict` is recorded; a review round also moves the item to Needs a person here, a check
 *    round leaves that to the build's own failure record (the same word reaches it).
 *  - anything else: `stopped` / `base_sync_unavailable`, the round is refused. Nothing ever falls back to the stale base.
 *
 * The merge commit exists on the private branch only. The public branch is built from trees, never from this history.
 */
type Who = { accountId: string; workItemId: string };
type Repo = { id: string; owner: string; name: string };
const SHA = /^[0-9a-f]{40}$/;

/** The fix-round attempt as a short fixed-length word, so every fact and move of one attempt has its own key (a repeat at the same head is a new attempt). */
export const attemptWord = (attempt: string): string => createHash("sha256").update(attempt).digest("hex").slice(0, 32);

/** The run line (`run.stage`) a round that followed a base sync carries (@fx/core previewProgress `lineFor`). */
export const BASE_SYNCED_STAGE = "base_synced";

/** The run event a SANDBOX fix round carries when it must update the public pull request: `{ base_sha, branch }`, the base tip the cloud brought the branch up to date with. Written by the cloud in the run's create transaction; the settle reads it. */
export const FIX_BASE_EVENT = "plane.fix_base";

/** The one fixed line a round that followed a merge adds to its prompt (no item content): the checkout already holds the base's changes. */
export const BASE_SYNCED_PROMPT_LINE = "Note: this branch was just brought up to date with its base branch, so the checkout already holds the base's latest changes. Do not merge or rebase it yourself.";

/** `baseSha`: the base tip the branch now contains, read by the cloud in the same call; it becomes the signed diff base of the round (`continues.base_sha`). */
export type BaseSyncResult = { ok: true; synced: boolean; baseSha: string } | { ok: false; reason: string };

/** The fact of a round refused because its branch could not be brought up to date (one per attempt): `stopped`, or `escalated` with the move to Needs a person (an escalation shares the move's stamp, which the card's lookup counts). The card shows the fixed sentence. */
export async function recordBaseSyncUnavailable(pool: Pool, who: Who, attempt: string, liveHead: string | null, prNumber: number | null, toNeedsPerson = false): Promise<void> {
  await withTenant(pool, who.accountId, async (client) => {
    await recordDriverEvent(client, who.accountId, { workItemId: who.workItemId, kind: toNeedsPerson ? "escalated" : "stopped", dedupeKey: `${BASE_SYNC_UNAVAILABLE}:${attemptWord(attempt)}`, code: BASE_SYNC_UNAVAILABLE, ...(liveHead !== null ? { headSha: liveHead } : {}), ...(prNumber !== null ? { prNumber } : {}) });
    if (toNeedsPerson) await moveToNeedsPerson(client, who, attempt, BASE_SYNC_UNAVAILABLE);
  });
}

async function moveToNeedsPerson(client: PoolClient, who: Who, attempt: string, reason: string): Promise<void> {
  try {
    const moved = await recordStage(client, { workItemId: who.workItemId, toStage: "needs_human", at: new Date(), source: "control_plane", sourceRef: `base-sync-${reason}-${attemptWord(attempt)}` });
    if (moved.recorded) await emitDomainEvent(client, { type: "work_item.needs_human", accountId: who.accountId, subjectId: who.workItemId, payload: { workItemId: who.workItemId, reason } });
  } catch (err) {
    // A halted item, or one that already left the review stages, stays where it is; the fact is the record.
    if (!(err instanceof WorkItemHaltedError) && !(err instanceof IllegalStageTransitionError)) throw err;
  }
}

export async function syncRunBranch(
  pool: Pool,
  ports: FixRoundHeadPorts | null | undefined,
  who: Who,
  input: { repo: Repo; pr: { number: number; branch: string }; liveHead: string | null; moveToNeedsPerson: boolean; attempt: string; publicCopy?: boolean; readOnly?: boolean; stackedOk?: boolean },
): Promise<BaseSyncResult> {
  const unavailable = async (liveHead: string | null): Promise<BaseSyncResult> => {
    await recordBaseSyncUnavailable(pool, who, input.attempt, liveHead, input.pr.number);
    return { ok: false, reason: BASE_SYNC_UNAVAILABLE };
  };
  const { syncBase, privateHead } = ports ?? {};
  let live = input.liveHead;
  let outcome: BranchSyncOutcome;
  let closed = false;
  try {
    if (!syncBase) throw new Error("no sync port");
    // The check round has not read the branch yet; the merge's first parent is compared with this.
    live ??= privateHead ? await privateHead({ repo: input.repo, branch: input.pr.branch }) : null;
    if (live === null || !SHA.test(live)) throw new Error("no head");
    // A parent that ended unmerged is read from our rows before anything is merged; the sync then only reads (nothing is written until the parent is shown open).
    closed = input.publicCopy === true && (await stackParentEnd(pool, who)) === "closed";
    outcome = await syncBase({ repo: input.repo, branch: input.pr.branch, prNumber: input.pr.number, ...(input.publicCopy === true ? { publicCopy: true } : {}), ...(input.readOnly === true || closed ? { readOnly: true } : {}) });
  } catch {
    // fx-swallow-ok: the cause can carry a repository name or a token; only the fixed code survives
    console.warn(JSON.stringify({ event: "advance.base_sync_unavailable", work_item_id: who.workItemId }));
    return unavailable(live);
  }
  if (live === null) return unavailable(null);
  const head: string = live;
  const refuse = async (code: string): Promise<BaseSyncResult> => ({ ok: false, reason: await refuseRepublish(pool, who, { code, prNumber: input.pr.number, moveToNeedsPerson: input.moveToNeedsPerson, attempt: input.attempt }) });
  // The change's branch holds its parent's closed work: a base of main would publish it, so only a pull request still on the parent's branch (read live below) can go on.
  if (closed && outcome.kind !== "stacked") return refuse(REPUBLISH_STACK_PARENT_CLOSED);
  let o = outcome;
  if (o.kind === "stacked" && input.stackedOk === true) {
    const lifted = await syncStacked(pool, ports, who, input, o.baseRef);
    if ("code" in lifted) return lifted.code === BASE_SYNC_UNAVAILABLE ? unavailable(live) : refuse(lifted.code);
    o = lifted.outcome;
  }
  if (o.kind === "stacked") return refuse(REPUBLISH_STACKED_UNSUPPORTED);
  if (o.kind === "up_to_date") return SHA.test(o.baseSha) ? { ok: true, synced: false, baseSha: o.baseSha } : unavailable(live);
  if (o.kind === "conflict") {
    await withTenant(pool, who.accountId, async (client) => {
      await recordDriverEvent(client, who.accountId, { workItemId: who.workItemId, kind: "escalated", dedupeKey: `${BASE_SYNC_CONFLICT}:${attemptWord(input.attempt)}`, code: BASE_SYNC_CONFLICT, headSha: head, prNumber: input.pr.number });
      if (input.moveToNeedsPerson) await moveToNeedsPerson(client, who, input.attempt, BASE_SYNC_CONFLICT);
    });
    console.info(JSON.stringify({ event: "advance.base_sync_conflict", work_item_id: who.workItemId }));
    return { ok: false, reason: BASE_SYNC_CONFLICT };
  }
  // 201: the merge commit's parents must be the branch head the round was checked against and the base tip the cloud read, in that order.
  const [first, second, ...rest] = o.parents;
  if (!SHA.test(o.sha) || first === undefined || second !== o.baseSha || rest.length > 0 || !SHA.test(first)) return unavailable(live);
  await withTenant(pool, who.accountId, async (client) => {
    if (first !== head) {
      // Someone pushed between the head check and the merge: recorded as the verified-review gate records a push it saw itself.
      await recordDriverEvent(client, who.accountId, { workItemId: who.workItemId, kind: "pr_head_pushed", dedupeKey: `observed:${head}..${first}`, code: "observed", headSha: first, prNumber: input.pr.number });
    }
    await recordDriverEvent(client, who.accountId, { workItemId: who.workItemId, kind: "pr_head_pushed", dedupeKey: `${BASE_SYNCED}:${first}..${o.sha}`, code: BASE_SYNCED, headSha: o.sha, prNumber: input.pr.number });
  });
  console.info(JSON.stringify({ event: "advance.base_synced", work_item_id: who.workItemId }));
  return { ok: true, synced: true, baseSha: o.baseSha };
}

/**
 * D#6 FIXROUND-REPUBLISH-STACKED: how the item's stack parent ended, from our rows (one read, nothing stamped): the parent item's stage, or its push row. `merged` and `closed` (without merging) are the two ends; null: no parent, or it is still in play.
 * A parent closed with no merge on record counts as `closed` (fail closed).
 */
export async function stackParentEnd(pool: Pool, who: Who): Promise<"merged" | "closed" | null> {
  const { rows } = await withTenant(pool, who.accountId, (client) =>
    client.query<{ stage: string; push: string | null }>(
      `SELECT p.stage, pp.state AS push FROM work_items w JOIN work_items p ON p.account_id = w.account_id AND p.id = w.stack_parent_id
         LEFT JOIN plane_pushes pp ON pp.account_id = p.account_id AND pp.work_item_id = p.id WHERE w.id = $1 AND w.account_id = $2`,
      [who.workItemId, who.accountId],
    ),
  );
  const r = rows[0];
  if (!r) return null;
  if (r.stage === "merged" || r.push === "pr_merged") return "merged";
  return r.stage === "closed_unmerged" || r.stage === "closed" || r.push === "pr_closed" ? "closed" : null;
}

/**
 * D#6 FIXROUND-REPUBLISH-STACKED: a sandbox round on a stacked change with a public copy goes on only while the pull request it is stacked on is verifiably open (the build start's own rule, `decideStackStart`).
 * The parent is read from our rows for its number and from GitHub for its state, and only after the port answered `stacked`. Merged or closed: `republish_stack_parent_ended`. A parent that cannot be read, or whose
 * branch moved between the two reads: `base_sync_unavailable`. No recorded parent (the database keeps a parent in the child's repository), no port, or a base that is not the parent's branch: the refusal stands. Then the sync is asked again, naming the branch.
 */
async function syncStacked(pool: Pool, ports: FixRoundHeadPorts | null | undefined, who: Who, input: { repo: Repo; pr: { number: number; branch: string } }, baseRef: string): Promise<{ outcome: BranchSyncOutcome } | { code: string }> {
  const { stackBase, syncBase } = ports ?? {};
  const parent = await withTenant(pool, who.accountId, (client) => readStackParentPull(client, who.workItemId));
  if (!stackBase || !syncBase || parent === null) return { code: REPUBLISH_STACKED_UNSUPPORTED };
  if (parent.prNumber === null) return { code: BASE_SYNC_UNAVAILABLE };
  try {
    const read = await stackBase.readParent({ repoId: input.repo.id, owner: input.repo.owner, name: input.repo.name, prNumber: parent.prNumber });
    const decided = decideStackStart(read);
    if (!decided.ok && decided.reason !== "stack_parent_closed") return { code: BASE_SYNC_UNAVAILABLE };
    if (!decided.ok || decided.base === null) {
      // Ended. GitHub's merged bit is not trusted alone: the cleanup sweep closes a merged paired parent's private pull request unmerged, so our rows (the item's stage) say which it was.
      const end = await stackParentEnd(pool, who);
      return { code: end === "merged" || (end === null && read.merged) ? REPUBLISH_STACK_PARENT_ENDED : REPUBLISH_STACK_PARENT_CLOSED };
    }
    if (decided.base.branch !== baseRef) return { code: REPUBLISH_STACKED_UNSUPPORTED };
    return { outcome: await syncBase({ repo: input.repo, branch: input.pr.branch, prNumber: input.pr.number, publicCopy: true, stackBranch: decided.base.branch }) };
  } catch {
    // fx-swallow-ok: the cause can carry a repository name or a token; only the fixed code survives
    console.warn(JSON.stringify({ event: "advance.stack_parent_unavailable", work_item_id: who.workItemId }));
    return { code: BASE_SYNC_UNAVAILABLE };
  }
}

/**
 * FIXROUND-REPUBLISH (R2-c0): whether the round must end by republishing the item's public pull request: the platform pushed a public branch for the item and a person has not taken it over (the same test
 * `checkPublicBranch` makes). Read BEFORE the base sync, so that the sync can refuse a stacked change without merging.
 */
export async function hasPublicCopy(pool: Pool, who: Who): Promise<boolean> {
  const row = await withTenant(pool, who.accountId, (client) => readPlanePush(client, who.accountId, who.workItemId));
  return row !== null && row.headSha !== null && row.managedByPersonAt === null;
}

/**
 * A round that must republish and cannot is refused before anything starts: `republish_base_missing` when no base was signed (no pull request to sync, or none this round continues; the checkout is never asked), and
 * `republish_stacked_unsupported` for a change stacked on another pull request (its base is a branch, not public `main`). A refusal is recorded as `escalated`, and a review round also moves the item to Needs a
 * person (a check round leaves that to the build's own failure record, the same word reaches it).
 */
export async function refuseRepublish(pool: Pool, who: Who, input: { code: string; prNumber: number | null; moveToNeedsPerson: boolean; attempt: string }): Promise<string> {
  await withTenant(pool, who.accountId, (client) => recordRepublishRefusal(client, who, input));
  console.info(JSON.stringify({ event: "advance.republish_refused", work_item_id: who.workItemId, code: input.code }));
  return input.code;
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The record of a refusal, inside the caller's tenant transaction (the runner's report writes it in the same one as the run's own state). Returns the code recorded: a round a person's
 * Replace started (the cloud's marker on the run `attempt` names) that ends with no change, a moved tip or any other failed update is recorded under the Replace form of the code, whose
 * sentence does not say to build again; the caller raises the question again for it (`raiseAfterLeaseFailure`).
 */
export async function recordRepublishRefusal(client: PoolClient, who: Who, input: { code: string; prNumber: number | null; moveToNeedsPerson: boolean; attempt: string; keepCode?: true }): Promise<string> {
  const marked = input.keepCode !== true && Object.hasOwn(REPLACE_ROUND_CODE_OF, input.code) && RUN_ID.test(input.attempt) && (await client.query("SELECT 1 FROM run_events WHERE account_id = $1 AND run_id = $2 AND kind = $3 LIMIT 1", [who.accountId, input.attempt, RUNNER_REPLACE_ROUND_KIND])).rows.length > 0;
  const code = marked ? REPLACE_ROUND_CODE_OF[input.code]! : input.code;
  await clearReplaceAuthorization(client, who.workItemId);
  await recordDriverEvent(client, who.accountId, { workItemId: who.workItemId, kind: "escalated", dedupeKey: `${code}:${attemptWord(input.attempt)}`, code, ...(input.prNumber !== null ? { prNumber: input.prNumber } : {}) });
  if (!input.moveToNeedsPerson) return code;
  try {
    const moved = await recordStage(client, { workItemId: who.workItemId, toStage: "needs_human", at: new Date(), source: "control_plane", sourceRef: `${code}-${attemptWord(input.attempt)}` });
    if (moved.recorded) await emitDomainEvent(client, { type: "work_item.needs_human", accountId: who.accountId, subjectId: who.workItemId, payload: { workItemId: who.workItemId, reason: code } });
  } catch (err) {
    // A halted item, or one that already left the review stages, stays where it is; the fact above is the record.
    if (!(err instanceof WorkItemHaltedError) && !(err instanceof IllegalStageTransitionError)) throw err;
  }
  return code;
}

/** After the sync: a round that must republish with no signed base is refused `republish_base_missing`; null when it may go on. */
export async function republishGate(pool: Pool, who: Who, input: { publicCopy: boolean; baseSha: string | null; prNumber: number | null; moveToNeedsPerson: boolean; attempt: string }): Promise<string | null> {
  if (!input.publicCopy || input.baseSha !== null) return null;
  return refuseRepublish(pool, who, { code: REPUBLISH_BASE_MISSING, prNumber: input.prNumber, moveToNeedsPerson: input.moveToNeedsPerson, attempt: input.attempt });
}

/**
 * A check fix round's `beforeStart`: the public branch check (#439), then, for a round that continues a pull request's branch (the item's own branch, or the run branch the runner opened its pull request on), the base sync,
 * then the republish gate. A round with no pull request (the first build's run branch, cut moments ago) has no base to catch up with. The conflict is left for the build's own failure record
 * to move the item (`moveToNeedsPerson: false`): the same word reaches it.
 */
export function checkFixBeforeStart(pool: Pool, ports: FixRoundHeadPorts | null | undefined, who: Who) {
  const state: { synced: boolean; baseSha: string | null; needed: boolean } = { synced: false, baseSha: null, needed: false };
  const beforeStart = async (branch: { repo: Repo; pr: { number: number; branch: string } } | null, attempt: string, sandbox: boolean): Promise<string | null> => {
    const publicRefusal = await checkPublicBranch(pool, ports, who);
    if (publicRefusal !== null) return publicRefusal;
    // Asked before the sync, which refuses a stacked change without merging when a public copy has to be republished.
    const publicCopy = await hasPublicCopy(pool, who);
    state.needed = publicCopy;
    if (branch !== null) {
      const sync = await syncRunBranch(pool, ports, who, { ...branch, liveHead: null, moveToNeedsPerson: false, attempt, publicCopy, stackedOk: sandbox });
      if (!sync.ok) return sync.reason;
      Object.assign(state, { synced: sync.synced, baseSha: sync.baseSha });
    }
    return republishGate(pool, who, { publicCopy, baseSha: state.baseSha, prNumber: branch?.pr.number ?? null, moveToNeedsPerson: false, attempt });
  };
  /** `state.synced`: a merge was made by this call, so the run it leads to carries the sync's progress line. `state.baseSha`: the base tip the round is signed with. `state.needed`: the round republishes the public pull request. */
  return Object.assign(beforeStart, { state });
}

