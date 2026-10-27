import type { PoolClient } from 'pg';
import { currentEnvelope, envelopeLockKey, envelopeSpentUsd } from './envelope.js';

/**
 * D#483 S5-b2c-1: what is left of a parent's envelope for a planned PR child's first run, DECIDED UNDER THE ENVELOPE'S LOCK (`reserve()`'s own lock, so a launch and
 * a run's admission never read the same headroom). The sum is the envelope's current amount, minus what its items have spent or hold (ledger plus open
 * reservations: `envelopeSpentUsd`, the same sum `reserve()` uses), minus one first-run price for every OTHER item on the envelope that was launched but has not
 * started a run yet (it will reserve, so it is spoken for; `autostartRoom` counts its pending items the same way). That last term is what makes two children
 * launched at once unable to pass an envelope with room for one: the first sees the envelope whole, the second sees it with the first's run already counted.
 *
 * The check is a pre-check. `reserve()` still admits the run itself and is the binding one. Fails closed: no envelope, or a price that is not a positive number,
 * is `fits: false`. Must run inside a `withTenant` transaction.
 */
export interface ChildEnvelopeRoom {
  fits: boolean;
  /** What is left after the spend and the launched-but-unstarted items, never below 0. */
  remainingUsd: number;
  /** Other items on the envelope that were launched and have not started a run. */
  pendingItems: number;
}

const tt = (usd: number): number => Math.round(usd * 10_000);

export async function childEnvelopeRoom(
  client: PoolClient,
  input: { accountId: string; envelopeId: string; childId: string; firstRunUsd: number; now?: Date },
): Promise<ChildEnvelopeRoom> {
  const { accountId, envelopeId, childId } = input;
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [envelopeLockKey(accountId, envelopeId)]);
  const cur = await currentEnvelope(client, accountId, envelopeId);
  if (cur === null) return { fits: false, remainingUsd: 0, pendingItems: 0 };
  const spent = await envelopeSpentUsd(client, accountId, envelopeId, input.now ?? new Date());
  const pending = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM work_items w
      WHERE w.account_id = $1 AND w.envelope_id = $2 AND w.id <> $3 AND w.stage = 'triaged'
        AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.account_id = w.account_id AND r.work_item_id = w.id AND r.status <> 'cancelled')`,
    [accountId, envelopeId, childId],
  );
  const pendingItems = pending.rows[0]?.n ?? Number.POSITIVE_INFINITY;
  const price = tt(input.firstRunUsd);
  if (!Number.isFinite(input.firstRunUsd) || price <= 0 || !Number.isFinite(pendingItems)) return { fits: false, remainingUsd: 0, pendingItems: Number.isFinite(pendingItems) ? pendingItems : 0 };
  const left = tt(cur.amountUsd) - tt(spent) - pendingItems * price;
  return { fits: price <= left, remainingUsd: Math.max(0, left) / 10_000, pendingItems };
}
