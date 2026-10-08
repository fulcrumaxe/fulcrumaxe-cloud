import type { PoolClient } from 'pg';
import { emitDomainEvent } from '../domain-events/emit.js';
import {
  assertLegalStageTransition,
  StageInputError,
  WorkItemHaltedError,
  WorkItemNotFoundError,
  WORK_ITEM_STAGES_REQUIRING_REVIEWER,
  WORK_ITEM_TRANSITION_REVIEWERS,
  type WorkItemStage,
  type WorkItemTransitionReviewer,
} from './stages.js';

const REVIEWER_STAGES = new Set<string>(WORK_ITEM_STAGES_REQUIRING_REVIEWER);
const VALID_REVIEWERS = new Set<string>(WORK_ITEM_TRANSITION_REVIEWERS);
const VALID_SOURCES = new Set(['webhook', 'control_plane']);

const AT_WINDOW_MS = 5 * 60 * 1000;

export interface RecordStageInput {
  workItemId: string;
  toStage: WorkItemStage;
  at: Date;
  source: 'webhook' | 'control_plane';
  sourceRef: string;
  runId?: string | null;
  reviewer?: WorkItemTransitionReviewer | null;
  /**
   * Who is moving the item. `'automatic'` (the default, so a writer added later is covered) may not take a halted item
   * out of its halt; `'person'` is passed only by an explicit person action (Close, Reopen, Back to discussion, and a
   * Spec published by a signed-in person).
   */
  actor?: 'automatic' | 'person';
}

export type RecordStageResult =
  | { recorded: true; transitionId: string }
  | { recorded: false; reason: 'duplicate' };

/**
 * D#45 S1 criterion 9. The single sanctioned writer of `work_item_transitions`
 * (criterion 10: a static test fails if `INSERT INTO work_item_transitions`
 * appears anywhere else under packages/** or apps/**, other than migration
 * files and test files) and of `work_items.stage`.
 *
 * `client` is expected to already be scoped to one tenant -- normally the
 * `PoolClient` `withTenant` hands its callback, so RLS confines every query
 * below to that tenant's own rows. This function never begins, commits or
 * rolls back a transaction itself (criterion 9g): it only issues statements
 * against the client it's given, so a caller can run it inside its own
 * `BEGIN ... ROLLBACK` or inside `withTenant`'s transaction.
 *
 * Order of checks (criterion 9's own scenarios pin this order):
 *   1. `reviewer` <-> `toStage` requiredness (StageInputError), pure, before any query.
 *   2. `SELECT ... FOR UPDATE` the work item row (also gives the DB's
 *      `now()` and serializes concurrent callers, criterion 9h). Zero rows
 *      -> WorkItemNotFoundError (an unknown id and a cross-tenant id both
 *      land here, since RLS already scopes the SELECT).
 *   3. `at` more than 5 minutes after the DB's `now()` -> StageInputError.
 *   4. Duplicate check on `(account_id, work_item_id, to_stage,
 *      source_ref)`, BEFORE legality and not derived from the item's
 *      current stage, so a duplicate is still recognised after the item has
 *      since moved on (criterion 9b) rather than throwing
 *      IllegalStageTransitionError for what is really a duplicate.
 *   5. DP-C6: a halted item refuses an automatic control-plane move out of the halt (WorkItemHaltedError).
 *   5b. `assertLegalStageTransition(fromStage, toStage)`.
 *   6. INSERT the transition row, then UPDATE `work_items.stage`.
 */
export async function recordStage(
  client: PoolClient,
  input: RecordStageInput,
): Promise<RecordStageResult> {
  const { workItemId, toStage, at, source, sourceRef, runId = null, reviewer = null, actor = 'automatic' } = input;

  const reviewerRequired = REVIEWER_STAGES.has(toStage);
  if (reviewerRequired && reviewer == null) {
    throw new StageInputError(`recordStage: reviewer is required for to_stage "${toStage}"`);
  }
  if (!reviewerRequired && reviewer != null) {
    throw new StageInputError(`recordStage: reviewer must be omitted for to_stage "${toStage}"`);
  }
  if (reviewer != null && !VALID_REVIEWERS.has(reviewer)) {
    throw new StageInputError(`recordStage: unknown reviewer "${reviewer}"`);
  }
  if (!VALID_SOURCES.has(source)) {
    throw new StageInputError(`recordStage: unknown source "${source}"`);
  }

  const { rows } = await client.query<{ stage: string; account_id: string; db_now: Date; halted: boolean }>(
    `SELECT stage, account_id, now() AS db_now, halted_at IS NOT NULL AS halted FROM work_items WHERE id = $1 FOR UPDATE`,
    [workItemId],
  );
  if (rows.length === 0) {
    throw new WorkItemNotFoundError(workItemId);
  }
  const { stage: fromStage, account_id: accountId, db_now: dbNow, halted } = rows[0]!;

  if (at.getTime() > dbNow.getTime() + AT_WINDOW_MS) {
    throw new StageInputError(
      `recordStage: "at" (${at.toISOString()}) is more than 5 minutes after the database's now() (${dbNow.toISOString()})`,
    );
  }

  const dup = await client.query(
    `SELECT id FROM work_item_transitions
       WHERE account_id = $1 AND work_item_id = $2 AND to_stage = $3 AND source_ref = $4`,
    [accountId, workItemId, toStage, sourceRef],
  );
  if (dup.rows.length > 0) {
    return { recorded: false, reason: 'duplicate' };
  }

  // A customer halt is left only by a person. A webhook is a fact about GitHub and is recorded; a move INTO needs_human
  // is the park itself (the halt, an escalation, a failed build). Checked after the duplicate test (a replay is still
  // a duplicate) and before legality.
  if (halted && source === 'control_plane' && actor === 'automatic' && toStage !== 'needs_human') {
    throw new WorkItemHaltedError(workItemId);
  }

  assertLegalStageTransition(fromStage, toStage);

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO work_item_transitions
       (account_id, work_item_id, from_stage, to_stage, reviewer, at, source, source_ref, run_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [accountId, workItemId, fromStage, toStage, reviewer, at, source, sourceRef, runId],
  );
  const transitionId = inserted.rows[0]!.id;

  await client.query(`UPDATE work_items SET stage = $1, updated_at = now() WHERE id = $2`, [
    toStage,
    workItemId,
  ]);

  // D#483 P3: every recorded move tells the live channel, in the same transaction as the move, so a board open in a
  // browser applies it without a reload. Ids and stage words only (resolved disagreement 8). The board never trusts the
  // stages in it: it reads the item again. The event is for the stream; it is not a webhook event type.
  await emitDomainEvent(client, {
    type: 'work_item.stage_changed',
    accountId,
    subjectId: workItemId,
    payload: { workItemId, fromStage, toStage },
  });

  return { recorded: true, transitionId };
}
