import type { PoolClient } from 'pg';
import { readReviewHold } from './reviewHold.js';

/**
 * The one place that decides whether a parked stage may be started again with no person: the worker's sweep (packages/worker stageResume.ts `planFor`) calls it to
 * decide, and the build card's "starts by itself" sentence calls it to say what the sweep will do, so the two cannot drift. Read under the item's own tenant.
 * Stops at the first no and answers its reason; on a yes it answers what the restart needs.
 */

/** Run statuses a run cannot leave (the worker's STAGE_RESUME_TERMINAL_STATUSES re-exports this one). */
export const STAGE_TERMINAL_STATUSES: readonly string[] = Object.freeze(['succeeded', 'failed', 'timed_out', 'killed_spend', 'refused_spend', 'cancelled']);
const SESSION_RE = /^session:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** What a stage that has no `progressKinds` of its own treats as "it ended in a refusal that is not a limit". */
const DEFAULT_PROGRESS_KINDS: readonly string[] = Object.freeze(['build_refused', 'stopped']);
const SPEC_OF_ITEM = '(CASE WHEN w.planned_pr_key IS NULL THEN s.work_item_id = w.id ELSE s.id = w.planned_pr_spec_version_id AND s.work_item_id = w.parent_id END)';
const likeEscape = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The parts of a registry entry the decision reads. */
export interface StageGateEntry {
  stage: string;
  itemStages: readonly string[];
  /**
   * Item stages at which a planned PR child (an item with a planned key under a parent) may be parked, besides `itemStages`. A child waits at Triaged, and its Spec is the
   * one its parent planned for it, not one of its own. Also lets the child's waiting launch request count as its approval (see the approval query). Absent: no child.
   */
  childItemStages?: readonly string[];
  approval: { kind: 'advance_work_item' | 'respec_work_item'; from: 'self' | 'origin' };
  needsSpec: boolean;
  runKeyLikes(workItemId: string, actionId: string, headSha?: string | null): string[];
  startedRunsOk?: boolean;
  progressKinds?: readonly string[];
}

/** The build stage's part of its registry entry; the pipeline's entry spreads this, so the registry and the build card's sentence read one definition. */
export const BUILD_STAGE_GATE = Object.freeze({
  itemStages: Object.freeze(['spec_ready']) as readonly string[],
  // A planned PR child waits for the slot at Triaged (the launch gate starts it there); the slot wake covers it under the launch it already has.
  childItemStages: Object.freeze(['triaged']) as readonly string[],
  approval: Object.freeze({ kind: 'advance_work_item', from: 'self' }) as { kind: 'advance_work_item'; from: 'self' },
  needsSpec: true,
  // `advance:<item>:build:v<spec version>:<approval>[:s<n>][:n<pin>]` (startBuildForItem; the worker prefixes the item).
  runKeyLikes: (workItemId: string, actionId: string): string[] => [`advance:${likeEscape(workItemId)}:build:v%:${likeEscape(actionId)}%`],
});

export type StageGateResult<H> =
  | { skip: string }
  | { approval: { id: string; userId: string }; haltEpoch: number; specVersion: number | null; keys: string[]; head: H | null };

/** `head`: for a stage bound to a head, reads it between the progress check and the key check (the keys name it). Answers a skip or the head. */
export async function stageApprovalGate<H extends { sha: string }>(
  client: PoolClient,
  accountId: string,
  workItemId: string,
  entry: StageGateEntry,
  head?: () => Promise<{ skip: string } | { head: H }>,
): Promise<StageGateResult<H>> {
  const item = (
    await client.query<{ stage: string; provenance: string; halted: boolean; halt_epoch: number; version: number | null; spec_at: Date | null; is_child: boolean }>(
      // A planned PR child's Spec is the version its parent planned for it (the worker's SPEC_OF_ITEM_SQL); any other item's is its own.
      `SELECT w.stage, w.provenance, w.halted_at IS NOT NULL AS halted, w.halt_epoch, (w.planned_pr_key IS NOT NULL AND w.parent_id IS NOT NULL) AS is_child,
              (SELECT max(s.version) FROM spec_versions s WHERE s.account_id = w.account_id AND s.erased_at IS NULL AND ${SPEC_OF_ITEM}) AS version,
              (SELECT max(s.created_at) FROM spec_versions s WHERE s.account_id = w.account_id AND ${SPEC_OF_ITEM}) AS spec_at
         FROM work_items w WHERE w.id = $1 AND w.account_id = $2`,
      [workItemId, accountId],
    )
  ).rows[0];
  if (!item) return { skip: 'item_gone' };
  if (item.halted) return { skip: 'halted' };
  const childHere = item.is_child && (entry.childItemStages ?? []).includes(item.stage);
  if (item.provenance !== 'internal' || !(entry.itemStages.includes(item.stage) || childHere)) return { skip: 'not_parked_here' };
  // A review re-entered from Needs a person parks there. Only an item still held for a missing verdict is that review: any other cause of Needs a person is a build to
  // run again, and the workflow would start that instead of the review the old waiting fact was for.
  if (entry.stage === 'review' && item.stage === 'needs_human' && !(await readReviewHold(client, workItemId))) return { skip: 'not_parked_here' };
  if (entry.needsSpec && (item.version === null || item.spec_at === null)) return { skip: 'no_spec' };

  // The cards an approval of this stage may sit on: the item itself and, where the entry says so, the card this one replaced (retired with `superseded:<this item>`).
  const targets = [workItemId];
  if (entry.approval.from === 'origin') {
    const origin = await client.query<{ work_item_id: string }>("SELECT DISTINCT work_item_id FROM work_item_transitions WHERE account_id = $1 AND to_stage = 'closed' AND source_ref = $2", [accountId, `superseded:${workItemId}`]);
    targets.push(...origin.rows.map((r) => r.work_item_id));
  }
  // Any request of this kind that is still waiting to be performed means a person is acting right now: leave it to them.
  const open = await client.query("SELECT 1 FROM run_action_requests WHERE account_id = $1 AND target_id = ANY($2::uuid[]) AND kind IN ('advance_work_item', 'respec_work_item') AND state IN ('accepted', 'claimed') LIMIT 1", [accountId, targets]);
  if (open.rows.length > 0) return { skip: 'approval_in_flight' };
  const approval = (
    await client.query<{ id: string; requested_by: string; principal_kind: string; finished_at: Date }>(
      // A child that is parked at its stage accepts a launch that settled `waiting` for the slot as its approval: the launch gate's dial request (key `dial:<receipt>`) or a
      // person's own launch, both filed by a session. Nothing else is an approval of a child, and no item but a child gets this.
      `SELECT id, requested_by, principal_kind, finished_at FROM run_action_requests
        WHERE account_id = $1 AND target_id = ANY($2::uuid[]) AND kind = $3 AND state = 'done'
          AND (outcome ->> 'advance' = 'started' OR ($4::boolean AND outcome ->> 'advance' = 'waiting' AND principal_kind = 'session'))
        ORDER BY finished_at DESC, id DESC LIMIT 1`,
      [accountId, targets, entry.approval.kind, childHere],
    )
  ).rows[0];
  if (!approval) return { skip: 'no_approval' };
  const who = SESSION_RE.exec(approval.requested_by);
  if (!who || approval.principal_kind !== 'session') return { skip: 'no_approval' };
  // The Spec the person approved is the newest one: one written after the approval was performed is a different Spec, and the person decides about it.
  if (entry.needsSpec && item.spec_at !== null && item.spec_at.getTime() > approval.finished_at.getTime()) return { skip: 'spec_changed' };
  const member = await client.query<{ role: string }>('SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2', [accountId, who[1]]);
  const role = member.rows[0]?.role;
  if (role !== 'owner' && role !== 'admin') return { skip: 'approver_gone' };
  // A live workflow or run is working on the item: nothing to resume.
  const live = await client.query<{ n: string }>('SELECT count(*) AS n FROM agent_runs WHERE account_id = $1 AND work_item_id = $2 AND NOT (status = ANY($3::text[]))', [accountId, workItemId, [...STAGE_TERMINAL_STATUSES]]);
  if (Number(live.rows[0]?.n ?? 0) > 0) return { skip: 'run_live' };

  // A restart that ended in a refusal that is not a limit (or a stop) left a newer fact than the waiting one: that is not this sweep's to retry every pass.
  // Only a new waiting fact (a later limit pause) or a person's new approval makes the item this sweep's again. A review or a fix round also leaves its own
  // progress facts (the reviewers started, a verdict, a fix round), and any of them after the wait means the stage has moved on.
  const refusedAfterWait = await client.query(
    `SELECT 1 FROM work_item_driver_events e
      WHERE e.account_id = $1 AND e.work_item_id = $2 AND e.kind = ANY($3::text[])
        AND e.seq > COALESCE((SELECT max(w.seq) FROM work_item_driver_events w WHERE w.account_id = $1 AND w.work_item_id = $2 AND w.kind IN ('stage_waiting', 'build_waiting')), 0)
      LIMIT 1`,
    [accountId, workItemId, [...(entry.progressKinds ?? DEFAULT_PROGRESS_KINDS)]],
  );
  if (refusedAfterWait.rows.length > 0) return { skip: entry.progressKinds === undefined ? 'refused_after_wait' : 'moved_on_after_wait' };

  let onHead: H | null = null;
  if (head) {
    const h = await head();
    if ('skip' in h) return h;
    onHead = h.head;
  }
  const keys = await client.query<{ idempotency_key: string; status: string | null }>(
    `SELECT k.idempotency_key, r.status FROM agent_run_idempotency_keys k LEFT JOIN agent_runs r ON r.account_id = k.account_id AND r.id = k.run_id
      WHERE k.account_id = $1 AND k.idempotency_key LIKE ANY($2::text[])`,
    [accountId, entry.runKeyLikes(workItemId, approval.id, onHead?.sha ?? null)],
  );
  // A run of this stage that really started (it did not end `refused_spend`) means the stage was allowed once: what came of it is the workflow's own outcome.
  // (A review starts several reviewers; a started one beside a denied one is the normal partial start, and the restart finds it by its key.)
  if (entry.startedRunsOk !== true && keys.rows.some((r) => r.status !== 'refused_spend')) return { skip: 'stage_already_ran' };
  return { approval: { id: approval.id, userId: who[1]! }, haltEpoch: item.halt_epoch, specVersion: item.version === null ? null : Number(item.version), keys: keys.rows.map((r) => r.idempotency_key), head: onHead };
}

/** Whether the worker's slot wake will start this item's build when its slot frees: the build stage's gate, no more and no less. */
export async function buildStartsByItself(client: PoolClient, workItemId: string): Promise<boolean> {
  const row = (await client.query<{ account_id: string }>('SELECT account_id FROM work_items WHERE id = $1::uuid', [workItemId])).rows[0];
  if (!row) return false;
  return !('skip' in (await stageApprovalGate(client, row.account_id, workItemId, { stage: 'build', ...BUILD_STAGE_GATE })));
}
