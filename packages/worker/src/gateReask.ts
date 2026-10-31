import type { Pool } from "pg";
import { withTenant } from "@fx/db/src/withTenant.js";
import { recordDriverEvent } from "@fx/core/src/work-items/driverEvents.js";
import { blockingReasons } from "@fx/core/src/work-items/mergeReadiness.js";
import { stageApprovalGate, type StageGateEntry } from "@fx/core/src/work-items/stageApprovalGate.js";
import { TRANSIENT_GATE_REASONS } from "@fx/core/src/work-items/stalled.js";
import { reportError } from "@fx/telemetry";
import type { AdvanceStartArgs } from "./advance.js";

/**
 * The merge gate asks itself again. A pull request that is not open yet, or whose checks have not finished, makes the gate answer `ready_human_merges` with a
 * reason that time clears (`TRANSIENT_GATE_REASONS`). Nothing then asked again, so the item sat there until a person pressed "Check the merge". This is that
 * press, made by the event that clears the reason: the public pull request opened, or a check of it finished green. The webhook calls it; there is no timer.
 *
 * It is the gate and nothing else. It starts the same review-stage workflow the person's press starts, under the approval the item already has, and the reviewers'
 * rows of the head are found by their keys, so no reviewer runs again. A head that moved since the gate answered is a new review, not this: it is left alone.
 *
 * Idempotent. The claim is one waiting fact (`stage_waiting`, stage `review`, code `gate_reask`) keyed by the gate answer it is for; a replayed delivery, a second
 * check finishing, or two deliveries at once find it and start nothing. The workflow then writes a new gate answer, which is what the next event is judged against.
 * The fact is also what keeps the item visible if the workflow dies: a wait nothing refreshes shows up in the stalled list.
 */

export const GATE_REASK_CODE = "gate_reask";

/** The review stage's entry, as far as the approval decision reads it: an item at "Review passed", approved by the person who pressed Build or Check the merge. */
const GATE_ENTRY: StageGateEntry = Object.freeze({
  stage: "review",
  itemStages: Object.freeze(["review_passed"]) as readonly string[],
  approval: Object.freeze({ kind: "advance_work_item", from: "self" }) as { kind: "advance_work_item"; from: "self" },
  needsSpec: false,
  runKeyLikes: (): string[] => [],
  startedRunsOk: true,
  progressKinds: Object.freeze([]) as readonly string[],
});

/** Facts that say the review or a fix moved on after the gate answered: the gate's answer is then not the newest word on the item. */
const MOVED_ON_KINDS: readonly string[] = Object.freeze(["pr_head_pushed", "review_started", "review_verdicts", "fix_round_started", "escalated", "stopped", "merged_by_gate"]);

export type GateReaskOutcome = { started: true } | { started: false; reason: string };

export interface GateReaskDeps {
  startAdvance: ((args: AdvanceStartArgs) => Promise<void>) | null;
  log?: (line: string) => void;
}

export async function reaskMergeGate(runnerPool: Pool, deps: GateReaskDeps, input: { accountId: string; workItemId: string }): Promise<GateReaskOutcome> {
  const log = deps.log ?? ((line: string) => console.info(line));
  const { accountId, workItemId } = input;
  const skip = (reason: string): GateReaskOutcome => {
    log(JSON.stringify({ event: "gate_reask.skipped", work_item_id: workItemId, reason }));
    return { started: false, reason };
  };
  if (deps.startAdvance === null) return skip("advance_unavailable");

  const planned = await withTenant(runnerPool, accountId, async (client): Promise<{ skip: string } | { approval: { id: string; userId: string }; haltEpoch: number }> => {
    const gate = (
      await client.query<{ seq: string; code: string | null; reasons: string[] | null; head_sha: string | null; pr_number: number | null }>(
        "SELECT seq, code, reasons, head_sha, pr_number FROM work_item_driver_events WHERE account_id = $1 AND work_item_id = $2 AND kind = 'merge_gate' ORDER BY seq DESC LIMIT 1",
        [accountId, workItemId],
      )
    ).rows[0];
    if (!gate || gate.code !== "ready_human_merges") return { skip: "not_at_gate" };
    // Only a stop that time clears. A gate answer with any other reason still blocks (fail closed: a code this list has never heard of is not transient).
    const blocking = blockingReasons(gate.reasons ?? []);
    if (blocking.length === 0 || !blocking.every((r) => TRANSIENT_GATE_REASONS.includes(r))) return { skip: "not_transient" };
    const moved = await client.query("SELECT 1 FROM work_item_driver_events WHERE account_id = $1 AND work_item_id = $2 AND kind = ANY($3::text[]) AND seq > $4 LIMIT 1", [accountId, workItemId, [...MOVED_ON_KINDS], gate.seq]);
    if (moved.rows.length > 0) return { skip: "moved_on" };
    const approved = await stageApprovalGate(client, accountId, workItemId, GATE_ENTRY);
    if ("skip" in approved) return approved;
    // The claim: one per gate answer.
    const claimed = await recordDriverEvent(client, accountId, {
      workItemId,
      kind: "stage_waiting",
      stage: "review",
      code: GATE_REASK_CODE,
      attempt: 0,
      dedupeKey: `reask:${gate.seq}`,
      ...(gate.head_sha !== null ? { headSha: gate.head_sha } : {}),
      ...(gate.pr_number !== null ? { prNumber: gate.pr_number } : {}),
    });
    if (!claimed.recorded) return { skip: "already_asked" };
    return { approval: approved.approval, haltEpoch: approved.haltEpoch };
  });
  if ("skip" in planned) return skip(planned.skip);

  try {
    await deps.startAdvance({ accountId, userId: planned.approval.userId, workItemId, actionId: planned.approval.id, haltEpoch: planned.haltEpoch });
  } catch (err) {
    // fx-swallow-ok: the claim stands, so the item shows as a wait nothing refreshes and a person's press asks again; the webhook delivery itself is already committed
    reportError(err, { stage: "advance.gate_reask" });
    return skip("start_failed");
  }
  log(JSON.stringify({ event: "gate_reask.started", work_item_id: workItemId }));
  return { started: true };
}

export const GATE_REASK_MAX_ITEMS = 20;

/** What a delivery says may now be ready: the repository it is about (full name), the pull requests it names and the head it is for. */
export interface GateWake {
  repoFullName: string;
  prNumbers: number[];
  headSha: string | null;
}

/**
 * The items this delivery may have made ready: the item whose PUBLIC pull request it is (the platform's own record of the pull request it opened, or the head it
 * last pushed), and, for a repository that is not paired, the item whose gate answer was for this pull request of this repository. Only items at "Review passed".
 */
export async function findGateReaskCandidates(pool: Pool, target: { accountId: string; repoId: string }, wake: GateWake): Promise<string[]> {
  if (wake.prNumbers.length === 0 && wake.headSha === null) return [];
  return withTenant(pool, target.accountId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT w.id
         FROM work_items w
        WHERE w.account_id = $1 AND w.stage = 'review_passed' AND w.halted_at IS NULL
          AND (
            EXISTS (SELECT 1 FROM plane_pushes p
                     WHERE p.account_id = w.account_id AND p.work_item_id = w.id AND lower(p.code_repo) = lower($2)
                       AND (p.pr_number = ANY($3::int[]) OR (p.head_sha IS NOT NULL AND p.head_sha = $4::text)))
            OR (w.repo_id = $5 AND EXISTS (SELECT 1 FROM work_item_driver_events e
                     WHERE e.account_id = w.account_id AND e.work_item_id = w.id AND e.kind = 'merge_gate' AND e.pr_number = ANY($3::int[])))
          )
        ORDER BY w.created_at, w.id
        LIMIT ${GATE_REASK_MAX_ITEMS}`,
      [target.accountId, wake.repoFullName, wake.prNumbers, wake.headSha, target.repoId],
    );
    return rows.map((r) => r.id);
  });
}

/**
 * The worker's facade for the webhook: the items this delivery may have made ready, each asked through `reaskMergeGate`. The pool never leaves this package.
 * Answers how many workflows it started.
 */
export function createGateReask(runnerPool: Pool, deps: GateReaskDeps) {
  async function wakeMergeGate(input: { accountId: string; repoId: string; wake: GateWake }): Promise<number> {
    let started = 0;
    for (const workItemId of await findGateReaskCandidates(runnerPool, input, input.wake)) {
      if ((await reaskMergeGate(runnerPool, deps, { accountId: input.accountId, workItemId })).started) started += 1;
    }
    return started;
  }
  return { wakeMergeGate };
}

export type GateReask = ReturnType<typeof createGateReask>;
