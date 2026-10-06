/**
 * The writes behind the stuck-item actions that do not need an agent to answer: Close, and the change each of Back to
 * discussion and Treat as a feature makes before the stage driver is asked to run. (Build again writes nothing here: it is
 * the stage driver's own `rebuild`.)
 *
 * Why these live in @fx/core and not in the API route: the API package never writes a stage (a test pins that no file under
 * packages/api/src mentions `recordStage`), so every stage move goes through here, through `recordStage`, with source
 * `control_plane`. Every function does ONE thing in ONE tenant transaction: reads the item with its row locked, asks the
 * one table (operatorActions.ts) whether the caller may, makes the move or the change, and writes its audit row. A refusal
 * throws `OperatorRefusedError` before anything is written.
 *
 * Only legal edges of the stage graph are used (needs_human -> discussing for Back to discussion; closed from the five stages
 * the table allows): `recordStage` checks each against stages.ts, and no edge was added for these actions.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { NotFoundError } from '../tenancy/errors.js';
import { withTenant } from '../tenancy/withTenant.js';
import { recordStage } from './recordStage.js';
import { IllegalStageTransitionError } from './stages.js';
import { BACK_TO_DISCUSSION_REF_PREFIX, operatorVerdict, readOperatorFacts, type OperatorAction, type OperatorVerdict } from './operatorActions.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The table said no. Nothing was written. */
export class OperatorRefusedError extends Error {
  constructor(public readonly verdict: Extract<OperatorVerdict, { ok: false }>) {
    super(verdict.message);
    this.name = 'OperatorRefusedError';
  }
}

/** The stage moved between the read and the write (the row is locked, so only a webhook could). */
export class OperatorMovedOnError extends Error {
  constructor() {
    super('work item moved on');
    this.name = 'OperatorMovedOnError';
  }
}

export interface OperatorMoveCtx {
  pool: Pool;
  /** `role` is the caller's role in the account (the route has already required owner or admin; the table asks again). */
  principal: { accountId: string; userId: string; tokenId?: string; role: string };
  /** The request's `Idempotency-Key`, if any: part of the transition's source, so a keyed repeat is the same transition. */
  idempotencyKey?: string | null;
}

/** The audit rows go through the 0713 definer, which stamps the actor and refuses anyone but an owner or admin. */
async function audit(client: PoolClient, action: 'work_item.kind_changed' | 'work_item.closed' | 'work_item.sent_back', payload: Record<string, unknown>): Promise<void> {
  await client.query('SELECT audit_write_work_item_action($1::text, $2::jsonb)', [action, JSON.stringify(payload)]);
}

const refOf = (key: string | null | undefined): string => (key ? createHash('sha256').update(key).digest('hex').slice(0, 32) : randomUUID());

async function move(client: PoolClient, workItemId: string, toStage: 'discussing' | 'closed' | 'triaged', sourceRef: string): Promise<void> {
  try {
    await recordStage(client, { workItemId, toStage, at: new Date(), source: 'control_plane', sourceRef });
  } catch (err) {
    if (err instanceof IllegalStageTransitionError) throw new OperatorMovedOnError();
    throw err;
  }
}

/** Reads the item locked and refuses, or hands back its facts. Not found (an unknown id, another account's) is `NotFoundError`. */
async function allowed(client: PoolClient, ctx: OperatorMoveCtx, workItemId: string, action: OperatorAction) {
  const facts = await readOperatorFacts(client, workItemId, ctx.principal.role, true);
  if (!facts) throw new NotFoundError('not found');
  const verdict = operatorVerdict(action, facts);
  if (!verdict.ok) throw new OperatorRefusedError(verdict);
  return facts;
}

/** Close: the item moves to `closed` and the audit row names who closed it and from which stage. */
export async function closeWorkItem(ctx: OperatorMoveCtx, workItemId: string): Promise<{ workItemId: string; stage: 'closed' }> {
  if (!UUID_RE.test(workItemId)) throw new NotFoundError('not found');
  const { accountId, userId } = ctx.principal;
  await withTenant(ctx.pool, accountId, userId, async (client) => {
    const facts = await allowed(client, ctx, workItemId, 'close');
    await move(client, workItemId, 'closed', `close:${refOf(ctx.idempotencyKey)}`);
    await audit(client, 'work_item.closed', { work_item_id: workItemId, from_stage: facts.stage });
  });
  return { workItemId, stage: 'closed' };
}

/**
 * Back to discussion: `needs_human -> discussing`. The transition's source starts with BACK_TO_DISCUSSION_REF_PREFIX, which is
 * how the panel and the Spec step know a new panel (and a new Spec version that supersedes the old one) is wanted.
 */
export async function sendBackToDiscussion(ctx: OperatorMoveCtx, workItemId: string): Promise<void> {
  if (!UUID_RE.test(workItemId)) throw new NotFoundError('not found');
  const { accountId, userId } = ctx.principal;
  await withTenant(ctx.pool, accountId, userId, async (client) => {
    await allowed(client, ctx, workItemId, 'back_to_discussion');
    await move(client, workItemId, 'discussing', `${BACK_TO_DISCUSSION_REF_PREFIX}${refOf(ctx.idempotencyKey)}`);
    await audit(client, 'work_item.sent_back', { work_item_id: workItemId, from_stage: 'needs_human', to_stage: 'discussing' });
  });
}

/** Treat as a feature: the card and its discussion both become `feature`, and the audit row records old kind -> new kind (and, stamped by the definer, who). */
export async function treatAsFeature(ctx: OperatorMoveCtx, workItemId: string): Promise<void> {
  if (!UUID_RE.test(workItemId)) throw new NotFoundError('not found');
  const { accountId, userId } = ctx.principal;
  await withTenant(ctx.pool, accountId, userId, async (client) => {
    const facts = await allowed(client, ctx, workItemId, 'treat_as_feature');
    await client.query("UPDATE discussions SET kind = 'feature' WHERE id = $1::uuid AND kind = 'project'", [facts.discussion_id]);
    await client.query("UPDATE work_items SET kind = 'feature', updated_at = now() WHERE id = $1::uuid", [workItemId]);
    await audit(client, 'work_item.kind_changed', { work_item_id: workItemId, discussion_id: facts.discussion_id, from_kind: 'project', to_kind: 'feature' });
  });
}

/**
 * Reopen: `closed -> triaged`, a legal edge of the stage graph. The item can then be approved again as any triaged item.
 *
 * TODO: the audit row is written as `work_item.sent_back` with `action: 'reopen'` in its payload because the 0713 definer's
 * allowlist has no reopen event and a migration cannot be added on the live branch without breaking migration order. When this
 * becomes permanent, add a `work_item.reopened` event type in a migration numbered correctly at merge time and write it here.
 */
export async function reopenWorkItem(ctx: OperatorMoveCtx, workItemId: string): Promise<{ workItemId: string; stage: 'triaged' }> {
  if (!UUID_RE.test(workItemId)) throw new NotFoundError('not found');
  const { accountId, userId } = ctx.principal;
  await withTenant(ctx.pool, accountId, userId, async (client) => {
    await allowed(client, ctx, workItemId, 'reopen');
    await move(client, workItemId, 'triaged', `reopen:${refOf(ctx.idempotencyKey)}`);
    await audit(client, 'work_item.sent_back', { work_item_id: workItemId, from_stage: 'closed', to_stage: 'triaged', action: 'reopen' });
  });
  return { workItemId, stage: 'triaged' };
}
