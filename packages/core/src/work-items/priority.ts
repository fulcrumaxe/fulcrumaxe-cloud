import type { Pool, PoolClient } from 'pg';
import { emitDomainEvent } from '../domain-events/emit.js';
import { requireOwnerOrAdmin, type MembershipRole } from '../tenancy/authorize.js';
import { NotFoundError } from '../tenancy/errors.js';
import { assertActiveMembership } from '../tenancy/scopedAccess.js';
import { withTenant } from '../tenancy/withTenant.js';
import { compareQueueOrder, type QueueOrderKey } from './queueOrder.js';
import { TERMINAL_WORK_ITEM_STAGES, type WorkItemStage } from './stages.js';

/** D#2 H26b: renumbering leaves gaps this wide, so most moves touch one row. */
export const QUEUE_RANK_GAP = 1024;

/** Stages a priority change is refused for (409 `not_reorderable`). `needs_human` and the in-flight stages stay reorderable. */
const TERMINAL_STAGES: ReadonlySet<WorkItemStage> = new Set(TERMINAL_WORK_ITEM_STAGES);

export type PriorityMove = 'top' | 'up' | 'down' | { before: string };

export interface SetWorkItemPriorityInput {
  workItemId: string;
  /** 0 urgent, 1 high, 2 normal, 3 low. */
  priority?: number;
  move?: PriorityMove;
  /** Set when a decided correction caused the change (D#597): the audit row then names it and says how it was decided. */
  attribution?: { correctionId: string; via: 'assistant' | 'workspace' | 'terminal' };
}

export interface SetWorkItemPriorityCtx {
  pool: Pool;
  principal: { accountId: string; userId: string };
}

export interface SetWorkItemPriorityResult {
  workItemId: string;
  priority: number;
  queueRank: number | null;
  /** False when nothing needed to change: no audit row and no event were written. */
  changed: boolean;
}

/** Maps to 422. */
export class PriorityInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriorityInputError';
  }
}

/** Maps to 409 `not_reorderable`. */
export class NotReorderableError extends Error {
  constructor(public readonly stage: string) {
    super(`a work item in stage ${stage} cannot be reordered`);
    this.name = 'NotReorderableError';
  }
}

/** A stored rank this process cannot hold exactly. Never coerced or clamped. */
export class QueueRankRangeError extends Error {
  constructor(value: string) {
    super(`queue_rank ${value} is not a safe integer`);
    this.name = 'QueueRankRangeError';
  }
}

/** node-postgres returns bigint as a string. Convert at the read boundary, and fail loudly beyond 2^53 - 1. */
export function toQueueRank(raw: string | number | null): number | null {
  if (raw === null) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isSafeInteger(n)) throw new QueueRankRangeError(String(raw));
  return n;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ItemRow {
  id: string;
  stage: WorkItemStage;
  priority: number;
  queue_rank: string | null;
  created_at: Date;
}

interface Item extends QueueOrderKey {
  queueRank: number | null;
  stage: WorkItemStage;
}

function toItem(row: ItemRow): Item {
  return {
    id: row.id,
    stage: row.stage,
    priority: row.priority,
    queueRank: toQueueRank(row.queue_rank),
    createdAt: row.created_at,
  };
}

function validate(input: SetWorkItemPriorityInput): void {
  const { priority, move } = input;
  if (priority === undefined && move === undefined) {
    throw new PriorityInputError('give a priority, a move, or both');
  }
  if (priority !== undefined && (!Number.isInteger(priority) || priority < 0 || priority > 3)) {
    throw new PriorityInputError('priority must be an integer from 0 to 3');
  }
  if (move === undefined || move === 'top' || move === 'up' || move === 'down') return;
  if (typeof move !== 'object' || move === null || typeof move.before !== 'string' || !UUID_RE.test(move.before)) {
    throw new PriorityInputError("move must be 'top', 'up', 'down' or { before: <work item id> }");
  }
}

/** `queue` is the bucket in queue order with the target in it; returns the order after the move. */
function place(queue: Item[], targetId: string, move: PriorityMove): Item[] {
  const from = queue.findIndex((i) => i.id === targetId);
  const target = queue[from]!;
  const rest = queue.filter((i) => i.id !== targetId);
  let to: number;
  if (move === 'top') {
    to = 0;
  } else if (move === 'up') {
    to = Math.max(0, from - 1);
  } else if (move === 'down') {
    to = Math.min(rest.length, from + 1);
  } else {
    to = rest.findIndex((i) => i.id === move.before);
    if (to === -1) throw new PriorityInputError('before must name another open item of the same priority');
  }
  return [...rest.slice(0, to), target, ...rest.slice(to)];
}

/** A rank strictly between the target's neighbours, or null when there is no room (renumber the bucket). */
function rankBetween(prev: Item | undefined, next: Item | undefined): number | null {
  if (prev !== undefined && prev.queueRank === null) return null; // a ranked item can't sort after an unranked one
  const lo = prev?.queueRank ?? null;
  const hi = next?.queueRank ?? null;
  let candidate: number;
  if (lo === null && hi === null) candidate = QUEUE_RANK_GAP;
  else if (hi === null) candidate = lo! + QUEUE_RANK_GAP;
  else if (lo === null) candidate = hi > QUEUE_RANK_GAP ? hi - QUEUE_RANK_GAP : Math.floor(hi / 2);
  else candidate = Math.floor((lo + hi) / 2);
  if (!Number.isSafeInteger(candidate) || candidate < 1) return null;
  if (lo !== null && candidate <= lo) return null;
  if (hi !== null && candidate >= hi) return null;
  return candidate;
}

/**
 * D#2 H26b: changes one work item's priority and/or its place in the queue.
 * Owner or admin only (the gate lives HERE; the 0676 definer re-checks it as
 * a floor). The change, its `work_item.priority_changed` audit row and its
 * domain event commit in one withTenant transaction.
 *
 * A priority change without a `move` clears the rank (the item joins the new
 * priority's unranked tail); ranks only mean something inside one priority.
 * Ranks are renumbered in gaps of 1,024 when a gap runs out. No token scope
 * is checked here: scopes live in the route registry.
 */
export async function setWorkItemPriority(
  ctx: SetWorkItemPriorityCtx,
  input: SetWorkItemPriorityInput,
): Promise<SetWorkItemPriorityResult> {
  const { accountId, userId } = ctx.principal;
  validate(input);
  if (!UUID_RE.test(input.workItemId)) throw new NotFoundError(`work item ${input.workItemId} not found`);

  return withTenant(ctx.pool, accountId, userId, (client: PoolClient) => setWorkItemPriorityIn(client, ctx.principal, input));
}

/**
 * The body of setWorkItemPriority on a transaction the caller already holds (withTenant for this account AND this user: the
 * floor checks read both). A decided correction uses it so the decision, the change and the applied stamp commit together.
 */
export async function setWorkItemPriorityIn(
  client: PoolClient,
  principal: { accountId: string; userId: string },
  input: SetWorkItemPriorityInput,
): Promise<SetWorkItemPriorityResult> {
  const { accountId, userId } = principal;
  validate(input);
  if (!UUID_RE.test(input.workItemId)) throw new NotFoundError(`work item ${input.workItemId} not found`);
  {
    await assertActiveMembership(client, accountId, userId);
    const { rows: memberRows } = await client.query<{ role: MembershipRole }>(
      'SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2',
      [accountId, userId],
    );
    requireOwnerOrAdmin(memberRows[0]?.role ?? null);

    // One reorder at a time per account: the rank arithmetic reads its neighbours.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', ['work_item_priority', accountId]);

    const { rows: targetRows } = await client.query<ItemRow>(
      'SELECT id, stage, priority, queue_rank, created_at FROM work_items WHERE id = $1::uuid',
      [input.workItemId],
    );
    if (targetRows[0] === undefined) throw new NotFoundError(`work item ${input.workItemId} not found`);
    const target = toItem(targetRows[0]);
    if (TERMINAL_STAGES.has(target.stage)) throw new NotReorderableError(target.stage);

    const newPriority = input.priority ?? target.priority;
    const sameBucket = newPriority === target.priority;
    const { rows: peerRows } = await client.query<ItemRow>(
      `SELECT id, stage, priority, queue_rank, created_at FROM work_items
        WHERE priority = $1 AND stage NOT IN ('merged', 'closed_unmerged', 'closed')`,
      [newPriority],
    );
    const bucket = peerRows.map(toItem).filter((i) => i.id !== target.id);

    let after: { priority: number; queueRank: number | null };
    let renumbered: Item[] = [];
    if (input.move === undefined) {
      after = { priority: newPriority, queueRank: sameBucket ? target.queueRank : null };
    } else {
      // The target starts where the order puts it now, or at the tail of a new bucket.
      const sorted = bucket.sort(compareQueueOrder);
      const start = sameBucket ? [...sorted, target].sort(compareQueueOrder) : [...sorted, target];
      const order = place(start, target.id, input.move);
      const at = order.findIndex((i) => i.id === target.id);
      const rank = rankBetween(order[at - 1], order[at + 1]);
      if (rank !== null) {
        after = { priority: newPriority, queueRank: rank };
      } else {
        const ranked = order.map((item, i) => ({ ...item, queueRank: (i + 1) * QUEUE_RANK_GAP }));
        const before = new Map(bucket.map((b) => [b.id, b.queueRank]));
        renumbered = ranked.filter((item) => item.id !== target.id && item.queueRank !== before.get(item.id));
        after = { priority: newPriority, queueRank: ranked[at]!.queueRank };
      }
    }

    if (after.priority === target.priority && after.queueRank === target.queueRank && renumbered.length === 0) {
      return { workItemId: target.id, priority: target.priority, queueRank: target.queueRank, changed: false };
    }

    await client.query('UPDATE work_items SET priority = $2, queue_rank = $3 WHERE id = $1::uuid', [
      target.id,
      after.priority,
      after.queueRank,
    ]);
    if (renumbered.length > 0) {
      await client.query(
        `UPDATE work_items w SET queue_rank = v.rank
           FROM unnest($1::uuid[], $2::bigint[]) AS v(id, rank) WHERE w.id = v.id`,
        [renumbered.map((i) => i.id), renumbered.map((i) => i.queueRank)],
      );
    }

    await client.query('SELECT audit_write_work_item_priority($1::uuid, $2::jsonb)', [
      target.id,
      JSON.stringify({
        work_item_id: target.id,
        before: { priority: target.priority, queue_rank: target.queueRank },
        after: { priority: after.priority, queue_rank: after.queueRank },
        renumbered: renumbered.length,
        ...(input.attribution ? { correction_id: input.attribution.correctionId, via: input.attribution.via } : {}),
      }),
    ]);
    await emitDomainEvent(client, {
      type: 'work_item.priority_changed',
      accountId,
      subjectId: target.id,
      payload: { work_item_id: target.id },
    });

    return { workItemId: target.id, priority: after.priority, queueRank: after.queueRank, changed: true };
  }
}
