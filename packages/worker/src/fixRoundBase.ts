import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { BranchSyncOutcome } from "@fx/github";
import { withTenant } from "@fx/db/src/withTenant.js";
import { recordDriverEvent } from "@fx/core/src/work-items/driverEvents.js";
import { recordStage } from "@fx/core/src/work-items/recordStage.js";
import { IllegalStageTransitionError, WorkItemHaltedError } from "@fx/core/src/work-items/stages.js";
import { emitDomainEvent } from "@fx/core/src/domain-events/emit.js";
import { BASE_SYNCED, BASE_SYNC_CONFLICT, BASE_SYNC_UNAVAILABLE } from "@fx/core/src/work-items/baseSync.js";
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
const attemptWord = (attempt: string): string => createHash("sha256").update(attempt).digest("hex").slice(0, 32);

/** The run line (`run.stage`) a round that followed a base sync carries (@fx/core previewProgress `lineFor`). */
export const BASE_SYNCED_STAGE = "base_synced";

export type BaseSyncResult = { ok: true; synced: boolean } | { ok: false; reason: string };

export async function syncRunBranch(
  pool: Pool,
  ports: FixRoundHeadPorts | null | undefined,
  who: Who,
  input: { repo: Repo; pr: { number: number; branch: string }; liveHead: string | null; moveToNeedsPerson: boolean; attempt: string },
): Promise<BaseSyncResult> {
  const unavailable = async (liveHead: string | null): Promise<BaseSyncResult> => {
    await withTenant(pool, who.accountId, (client) =>
      recordDriverEvent(client, who.accountId, { workItemId: who.workItemId, kind: "stopped", dedupeKey: `${BASE_SYNC_UNAVAILABLE}:${attemptWord(input.attempt)}`, code: BASE_SYNC_UNAVAILABLE, ...(liveHead !== null ? { headSha: liveHead } : {}), prNumber: input.pr.number }),
    );
    return { ok: false, reason: BASE_SYNC_UNAVAILABLE };
  };
  const { syncBase, privateHead } = ports ?? {};
  let live = input.liveHead;
  let outcome: BranchSyncOutcome;
  try {
    if (!syncBase) throw new Error("no sync port");
    // The check round has not read the branch yet; the merge's first parent is compared with this.
    live ??= privateHead ? await privateHead({ repo: input.repo, branch: input.pr.branch }) : null;
    if (live === null || !SHA.test(live)) throw new Error("no head");
    outcome = await syncBase({ repo: input.repo, branch: input.pr.branch, prNumber: input.pr.number });
  } catch {
    // fx-swallow-ok: the cause can carry a repository name or a token; only the fixed code survives
    console.warn(JSON.stringify({ event: "advance.base_sync_unavailable", work_item_id: who.workItemId }));
    return unavailable(live);
  }
  if (live === null) return unavailable(null);
  const head: string = live;
  const o = outcome;
  if (o.kind === "up_to_date") return { ok: true, synced: false };
  if (o.kind === "conflict") {
    await withTenant(pool, who.accountId, async (client) => {
      await recordDriverEvent(client, who.accountId, { workItemId: who.workItemId, kind: "escalated", dedupeKey: `${BASE_SYNC_CONFLICT}:${attemptWord(input.attempt)}`, code: BASE_SYNC_CONFLICT, headSha: head, prNumber: input.pr.number });
      if (!input.moveToNeedsPerson) return;
      try {
        const moved = await recordStage(client, { workItemId: who.workItemId, toStage: "needs_human", at: new Date(), source: "control_plane", sourceRef: `base-sync-conflict-${attemptWord(input.attempt)}` });
        if (moved.recorded) await emitDomainEvent(client, { type: "work_item.needs_human", accountId: who.accountId, subjectId: who.workItemId, payload: { workItemId: who.workItemId, reason: BASE_SYNC_CONFLICT } });
      } catch (err) {
        // A halted item, or one that already left the review stages, stays where it is; the fact above is the record.
        if (!(err instanceof WorkItemHaltedError) && !(err instanceof IllegalStageTransitionError)) throw err;
      }
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
  return { ok: true, synced: true };
}

/**
 * A check fix round's `beforeStart`: the public branch check (#439), then, for a round that continues the item's own pull request branch, the base sync. A round
 * with no pull request (the first build's run branch, cut moments ago) has no base to catch up with. The conflict is left for the build's own failure record
 * to move the item (`moveToNeedsPerson: false`): the same word reaches it.
 */
export function checkFixBeforeStart(pool: Pool, ports: FixRoundHeadPorts | null | undefined, who: Who) {
  const state = { synced: false };
  const beforeStart = async (branch: { repo: Repo; pr: { number: number; branch: string }; attempt: string } | null): Promise<string | null> => {
    const publicRefusal = await checkPublicBranch(pool, ports, who);
    if (publicRefusal !== null || branch === null) return publicRefusal;
    const sync = await syncRunBranch(pool, ports, who, { ...branch, liveHead: null, moveToNeedsPerson: false });
    if (sync.ok) state.synced = sync.synced;
    return sync.ok ? null : sync.reason;
  };
  /** `state.synced`: a merge was made by this call, so the run it leads to carries the sync's progress line. */
  return Object.assign(beforeStart, { state });
}
