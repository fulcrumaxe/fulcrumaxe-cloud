import type { Pool } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { recordDriverEvent } from "@fx/core/src/work-items/driverEvents.js";
import { stageApprovalGate, type StageGateEntry } from "@fx/core/src/work-items/stageApprovalGate.js";
import { reportError } from "@fx/telemetry";
import type { GateReaskDeps } from "./gateReask.js";

/**
 * A pull request that merged can leave another open pull request of the same repository conflicting with its base. Nothing asked the merge gate again when that
 * happened, so an item that had already passed review sat at "Review passed" with a conflicting pull request until a person noticed (a planned PR whose sibling
 * merged into the same file stayed that way for half an hour on staging).
 *
 * This is the event that notices it: a merge in the repository wakes the other open-pull-request items of that repository that are not being worked on. Each one's
 * pull request is read (the caller supplies the read, so this package holds no GitHub client), and only a pull request GitHub now calls conflicting starts the item's
 * review workflow, under the approval the item already has. The workflow's gate answers `merge_conflict` and starts the existing conflict fix round. A pull request
 * that still merges cleanly, one GitHub has not finished computing, and one that cannot be read are left exactly as they were.
 *
 * Idempotent per merge: the claim is one waiting fact per (item, merged pull request) whose dedupe key names the repository and the merged number, so a replayed delivery,
 * or two deliveries at once, start nothing the second time. The fact also carries the merged number (`after_pr_<n>` among its reasons), which is what lets a card say
 * what the conflict came after. Push, not poll: nothing here is timed.
 */

export const SIBLING_WAKE_CODE = "sibling_merged";
/** The reason code a claim carries for the merged pull request's number. */
export const afterPrReason = (prNumber: number): string => `after_pr_${prNumber}`;
export const SIBLING_WAKE_MAX_ITEMS = 10;

/** Stages with an open pull request. `needs_human` only counts when the stage gate says it is held for a missing verdict (a review re-entered there); any other cause is a build. */
const SIBLING_ENTRY: StageGateEntry = Object.freeze({
  stage: "review",
  itemStages: Object.freeze(["pr_opened", "review_passed", "changes_requested", "needs_human"]) as readonly string[],
  approval: Object.freeze({ kind: "advance_work_item", from: "self" }) as { kind: "advance_work_item"; from: "self" },
  needsSpec: false,
  runKeyLikes: (): string[] => [],
  startedRunsOk: true,
  progressKinds: Object.freeze([]) as readonly string[],
});

/** Facts that say a workflow handed the item to a person. */
const HANDED_OVER_KINDS: readonly string[] = Object.freeze(["stopped", "escalated"]);

export interface MergedSibling {
  /** The full name of the repository the merge happened in. */
  repoFullName: string;
  prNumber: number;
}

export interface SiblingCandidate {
  workItemId: string;
  prNumber: number;
}

export type SiblingWakeOutcome = { started: true } | { started: false; reason: string };

/**
 * The items whose open pull request is in the merged one's repository, with that number: an item with a public copy there (the platform's own record of it), or, for an
 * item with no public copy, the pull request its newest gate answer was for. Only items at a pull-request stage, not halted, not the merged pull request itself.
 */
export async function findSiblingCandidates(pool: Pool, target: { accountId: string; repoId: string }, merged: MergedSibling): Promise<SiblingCandidate[]> {
  return withTenant(pool, target.accountId, async (client) => {
    const { rows } = await client.query<{ id: string; pr: number }>(
      `SELECT id, pr FROM (
         SELECT w.id, p.pr_number AS pr, w.created_at
           FROM work_items w
           JOIN LATERAL (SELECT x.pr_number FROM plane_pushes x
                          WHERE x.account_id = w.account_id AND x.work_item_id = w.id AND x.pr_number IS NOT NULL
                          ORDER BY x.created_at DESC, x.id DESC LIMIT 1) p ON true
          WHERE w.account_id = $1 AND w.stage = ANY($2::text[]) AND w.halted_at IS NULL AND w.provenance = 'internal'
            AND EXISTS (SELECT 1 FROM plane_pushes y WHERE y.account_id = w.account_id AND y.work_item_id = w.id AND lower(y.code_repo) = lower($3) AND y.pr_number = p.pr_number AND y.state NOT IN ('pr_closed', 'pr_merged', 'refused'))
         UNION ALL
         SELECT w.id, g.pr_number AS pr, w.created_at
           FROM work_items w
           JOIN LATERAL (SELECT e.pr_number FROM work_item_driver_events e
                          WHERE e.account_id = w.account_id AND e.work_item_id = w.id AND e.kind = 'merge_gate' AND e.pr_number IS NOT NULL
                          ORDER BY e.seq DESC LIMIT 1) g ON true
          WHERE w.account_id = $1 AND w.repo_id = $4 AND w.stage = ANY($2::text[]) AND w.halted_at IS NULL AND w.provenance = 'internal'
            AND NOT EXISTS (SELECT 1 FROM plane_pushes z WHERE z.account_id = w.account_id AND z.work_item_id = w.id AND z.pr_number IS NOT NULL)
       ) c
       WHERE pr <> $5
       ORDER BY created_at, id
       LIMIT ${SIBLING_WAKE_MAX_ITEMS}`,
      [target.accountId, SIBLING_ENTRY.itemStages, merged.repoFullName, target.repoId, merged.prNumber],
    );
    return rows.map((r) => ({ workItemId: r.id, prNumber: r.pr }));
  });
}

/** Asks one item's review workflow to run again because `merged` merged. Skips unless the item has its approval, no live run and no request in flight; claims once per merge. */
export async function requestSiblingAdvance(runnerPool: Pool, deps: GateReaskDeps, input: { accountId: string; workItemId: string; prNumber: number; merged: MergedSibling }): Promise<SiblingWakeOutcome> {
  const log = deps.log ?? ((line: string) => console.info(line));
  const { accountId, workItemId } = input;
  const skip = (reason: string): SiblingWakeOutcome => {
    log(JSON.stringify({ event: "sibling_conflict_wake.skipped", work_item_id: workItemId, reason }));
    return { started: false, reason };
  };
  if (deps.startAdvance === null) return skip("advance_unavailable");
  const planned = await withTenant(runnerPool, accountId, async (client): Promise<{ skip: string } | { approval: { id: string; userId: string }; haltEpoch: number }> => {
    const approved = await stageApprovalGate(client, accountId, workItemId, SIBLING_ENTRY);
    if ("skip" in approved) return approved;
    const item = (
      await client.query<{ stage: string; escalated_at: Date | null; approved_at: Date | null; gate_seq: string | null; gate_head: string | null; push_head: string | null }>(
        `SELECT w.stage,
                (SELECT max(t.created_at) FROM work_item_transitions t WHERE t.account_id = w.account_id AND t.work_item_id = w.id AND t.to_stage = 'needs_human') AS escalated_at,
                (SELECT r.finished_at FROM run_action_requests r WHERE r.account_id = w.account_id AND r.id = $3::uuid) AS approved_at,
                (SELECT e.seq::text FROM work_item_driver_events e WHERE e.account_id = w.account_id AND e.work_item_id = w.id AND e.kind = 'merge_gate' ORDER BY e.seq DESC LIMIT 1) AS gate_seq,
                (SELECT e.head_sha FROM work_item_driver_events e WHERE e.account_id = w.account_id AND e.work_item_id = w.id AND e.kind = 'merge_gate' ORDER BY e.seq DESC LIMIT 1) AS gate_head,
                (SELECT x.head_sha FROM plane_pushes x WHERE x.account_id = w.account_id AND x.work_item_id = w.id AND x.head_sha IS NOT NULL ORDER BY x.created_at DESC, x.id DESC LIMIT 1) AS push_head
           FROM work_items w WHERE w.account_id = $1 AND w.id = $2`,
        [accountId, workItemId, approved.approval.id],
      )
    ).rows[0];
    if (!item) return { skip: "item_gone" };
    // An item at Needs a person is held there by an escalation (a reviewer with no verdict, the merge queue's used-up retry or silence). Only a person's approval given AFTER it
    // got there re-enters the review; an older one was given for an earlier build and must not bypass the escalation with nobody acting (the same rule the parked-stage sweep relies on).
    if (item.stage === "needs_human" && (item.approved_at === null || (item.escalated_at !== null && item.approved_at.getTime() <= item.escalated_at.getTime()))) return { skip: "approval_predates_escalation" };
    // A workflow that ended in a stop or an escalation for a person after the last gate answer (and after the approval) has handed the item over: not this wake's to restart.
    const handedOver = await client.query(
      "SELECT 1 FROM work_item_driver_events WHERE account_id = $1 AND work_item_id = $2 AND kind = ANY($3::text[]) AND seq > COALESCE($4::bigint, 0) AND created_at > $5::timestamptz LIMIT 1",
      [accountId, workItemId, [...HANDED_OVER_KINDS], item.gate_seq, item.approved_at ?? new Date(0)],
    );
    if (handedOver.rows.length > 0) return { skip: "moved_on" };
    // The claim names the head the last gate answer was for, so a head-bound parked review that finds this fact as the newest wait still has its head.
    const head = item.gate_head ?? item.push_head;
    const claimed = await recordDriverEvent(client, accountId, {
      workItemId,
      kind: "stage_waiting",
      stage: "review",
      code: SIBLING_WAKE_CODE,
      attempt: 0,
      reasons: [afterPrReason(input.merged.prNumber)],
      dedupeKey: `sibling:${input.merged.repoFullName.toLowerCase()}#${input.merged.prNumber}`,
      prNumber: input.prNumber,
      ...(head !== null ? { headSha: head } : {}),
    });
    if (!claimed.recorded) return { skip: "already_asked" };
    return { approval: approved.approval, haltEpoch: approved.haltEpoch };
  });
  if ("skip" in planned) return skip(planned.skip);
  try {
    await deps.startAdvance({ accountId, userId: planned.approval.userId, workItemId, actionId: planned.approval.id, haltEpoch: planned.haltEpoch });
  } catch (err) {
    // fx-swallow-ok: the claim stands and shows as a wait; a person's "Check the merge" asks again, and the delivery is already committed
    reportError(err, { stage: "advance.sibling_conflict_wake" });
    return skip("start_failed");
  }
  log(JSON.stringify({ event: "sibling_conflict_wake.started", work_item_id: workItemId }));
  return { started: true };
}

export interface SiblingWakeInput {
  accountId: string;
  repoId: string;
  merged: MergedSibling;
  /** Whether GitHub now calls this pull request conflicting: true, false, or null when it cannot say yet (still computing, unreadable, not open). Only true starts anything. */
  isConflicting(prNumber: number): Promise<boolean | null>;
}

/** The worker's facade for the webhook. Answers how many workflows it started. */
export function createSiblingConflictWake(runnerPool: Pool, deps: GateReaskDeps) {
  async function wakeConflictingSiblings(input: SiblingWakeInput): Promise<number> {
    const candidates = await findSiblingCandidates(runnerPool, input, input.merged);
    const results = await Promise.all(
      candidates.map(async (c): Promise<number> => {
        let conflicting: boolean | null;
        try {
          conflicting = await input.isConflicting(c.prNumber);
        } catch (err) {
          // fx-swallow-ok: a read that failed leaves the item as it was; one unreadable pull request must not stop the others, and the next merge wakes it again
          reportError(err, { stage: "advance.sibling_conflict_read" });
          return 0;
        }
        if (conflicting !== true) return 0;
        return (await requestSiblingAdvance(runnerPool, deps, { accountId: input.accountId, workItemId: c.workItemId, prNumber: c.prNumber, merged: input.merged })).started ? 1 : 0;
      }),
    );
    return results.reduce((a, b) => a + b, 0);
  }
  return { wakeConflictingSiblings };
}

export type SiblingConflictWake = ReturnType<typeof createSiblingConflictWake>;
