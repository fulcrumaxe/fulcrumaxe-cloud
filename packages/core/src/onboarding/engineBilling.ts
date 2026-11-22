import type { PoolClient } from 'pg';
import { countLiveEnginesInTx } from './liveEngines.js';

/**
 * D#845 ON-22c: what the Budget & billing Engine row shows, read from the account's synced rows and the engines live now. No provider call: only the signed webhook writes these columns, so a
 * change shows here once the provider confirms it. Everything is derived on every read; the grace period is judged by the database clock, as in engineCoverage.ts.
 *
 *   none        no engines paid for, and nothing wrong with the subscription (never bought, or a hosted plan without engines): "Choose plan" buys them.
 *   active      engines paid for and the subscription is paying.
 *   past_due    payment failed and the seven day grace has not run out.
 *   not_paying  unpaid, incomplete or paused, or the stored ids are missing: nothing can change until it is paid.
 *   ended       cancelled, or the grace ran out. The paid quantity survives a cancellation and is not shown as paid.
 */
export type EngineBillingState = 'none' | 'active' | 'past_due' | 'not_paying' | 'ended';
export interface EngineBilling {
  paid_quantity: number;
  live_count: number;
  state: EngineBillingState;
  ended_at: string | null;
  as_of: string | null;
}

/** The most engines one account may hold (the billing service's own limit). */
export const ENGINE_BILLING_MAX = 100;

interface Row {
  engine_quantity: number | null;
  status: string | null;
  has_ids: boolean;
  ended_at: Date | null;
  grace_over: boolean;
  has_past_due_since: boolean;
  synced_at: Date | null;
}

export function engineBillingState(r: { quantity: number; status: string | null; hasIds: boolean; endedAt: boolean; graceOver: boolean; hasPastDueSince: boolean }): EngineBillingState {
  if (r.endedAt || r.graceOver || r.status === 'canceled' || r.status === 'incomplete_expired') return 'ended';
  if (r.status === 'unpaid' || r.status === 'incomplete' || r.status === 'paused') return 'not_paying';
  if ((r.status === 'active' || r.status === 'trialing') && !r.hasIds) return 'not_paying';
  if (r.status === 'past_due') return r.hasPastDueSince ? 'past_due' : 'not_paying';
  return r.quantity > 0 && (r.status === 'active' || r.status === 'trialing') ? 'active' : 'none';
}

/** Inside the caller's tenant transaction, the account named on the query on top of row security. Null when the account is gone. */
export async function readEngineBilling(client: PoolClient, accountId: string): Promise<EngineBilling | null> {
  const { rows } = await client.query<Row>(
    `SELECT engine_quantity, stripe_subscription_status AS status,
            (stripe_customer_id IS NOT NULL AND stripe_subscription_id IS NOT NULL) AS has_ids,
            subscription_ended_at AS ended_at,
            (past_due_since IS NOT NULL AND NOT (past_due_since > now() - interval '7 days')) AS grace_over,
            (past_due_since IS NOT NULL) AS has_past_due_since,
            stripe_synced_at AS synced_at
       FROM accounts WHERE id = $1 AND deleted_at IS NULL`,
    [accountId],
  );
  const a = rows[0];
  if (!a) return null;
  const quantity = Number.isInteger(a.engine_quantity) && (a.engine_quantity ?? 0) > 0 ? (a.engine_quantity as number) : 0;
  const state = engineBillingState({ quantity, status: a.status, hasIds: a.has_ids, endedAt: a.ended_at !== null, graceOver: a.grace_over, hasPastDueSince: a.has_past_due_since });
  return {
    // An ended plan's quantity survives cancellation and is not shown as paid.
    paid_quantity: state === 'ended' ? 0 : quantity,
    live_count: await countLiveEnginesInTx(client, accountId),
    state,
    ended_at: a.ended_at ? a.ended_at.toISOString() : null,
    as_of: a.synced_at ? a.synced_at.toISOString() : null,
  };
}
