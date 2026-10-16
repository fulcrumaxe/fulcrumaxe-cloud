import type { PoolClient } from 'pg';

/**
 * D#483 S5-d: the spend envelope of an approval. The ONE implementation of "may this run start, given the item's envelope": reserve() calls it under the
 * envelope's lock and headroom.ts calls it without one, so the two cannot disagree (packages/spend/test/headroom.test.ts holds them to it).
 *
 * Spend of an envelope = the ledger rows (model and compute) of the runs of every item that draws on it, plus its open reservations, plus the estimated
 * charge of each run that reserved no model money (envelope_run_charges, written by reserve()). A run is admitted only while that sum plus the run's own
 * reservation stays within the envelope's current amount (its highest version), so spend never passes the amount by more than a run already in flight.
 * Nothing here stops a run that is in flight.
 */

export type EnvelopeScope = 'item' | 'batch' | 'weekly_autostart';

/** The item's envelope, or null when it draws on none (it keeps the plan's Feature/Small cap). */
export async function itemEnvelopeId(client: PoolClient, accountId: string, workItemId: string): Promise<string | null> {
  const { rows } = await client.query<{ envelope_id: string | null }>('SELECT envelope_id FROM work_items WHERE id = $1 AND account_id = $2', [workItemId, accountId]);
  return rows[0]?.envelope_id ?? null;
}

/** The envelope's current amount and version (its highest version), or null when no such envelope exists. */
export async function currentEnvelope(client: PoolClient, accountId: string, envelopeId: string): Promise<{ amountUsd: number; version: number } | null> {
  const { rows } = await client.query<{ amount_usd: string; version: number }>(
    'SELECT amount_usd::text, version FROM approval_envelopes WHERE account_id = $1 AND id = $2 ORDER BY version DESC LIMIT 1',
    [accountId, envelopeId],
  );
  return rows[0] ? { amountUsd: Number(rows[0].amount_usd), version: rows[0].version } : null;
}

/** The envelope's spend, as one SQL expression over $1 = account, $2 = envelope (see the file header). Counts a charge only while its run started or may still start. */
const SPENT_SQL = `SELECT COALESCE(SUM(x.usd), 0) AS sum FROM (
       SELECT l.usd FROM ledger l
         JOIN agent_runs r ON r.account_id = l.account_id AND r.id = l.run_id
         JOIN work_items w ON w.account_id = r.account_id AND w.id = r.work_item_id
        WHERE l.account_id = $1 AND w.envelope_id = $2
       UNION ALL
       SELECT s.usd_reserved FROM spend_reservations s
         JOIN agent_runs r ON r.account_id = s.account_id AND r.id = s.run_id
         JOIN work_items w ON w.account_id = r.account_id AND w.id = r.work_item_id
        WHERE s.account_id = $1 AND s.state = 'open' AND w.envelope_id = $2
       UNION ALL
       SELECT c.usd FROM envelope_run_charges c
         JOIN agent_runs r ON r.account_id = c.account_id AND r.id = c.run_id
        WHERE c.account_id = $1 AND c.envelope_id = $2 AND NOT (r.status = 'refused_spend' OR (r.status = 'cancelled' AND r.started_at IS NULL))
     ) x`;

/** What the envelope has spent or holds right now, for display. The admission check below never uses this number: it compares inside the database. */
export async function envelopeSpentUsd(client: PoolClient, accountId: string, envelopeId: string): Promise<number> {
  const { rows } = await client.query<{ sum: string }>(`SELECT sum::text FROM (${SPENT_SQL}) t`, [accountId, envelopeId]);
  return Number(rows[0]!.sum);
}

/** Whole ten-thousandths of a dollar: the unit the money columns hold, so sums and compares never meet a binary fraction. */
const tenThousandths = (usd: number): number => Math.round(usd * 10_000);

/**
 * The amount a run counts against its envelope: its model and compute reservations, plus `floorUsd` (the run's estimated model price) when it reserves no
 * model money. Summed in whole ten-thousandths, so 0.1 + 0.2 is 0.3. Null when the run reserves no model money and was given no estimate: the check then fails closed.
 */
export function envelopeRunUsd(p: { estimateModelUsd?: number; estimateComputeUsd?: number; envelopeFloorUsd?: number }): number | null {
  const model = p.estimateModelUsd ?? 0;
  const compute = tenThousandths(p.estimateComputeUsd ?? 0);
  if (model > 0) return (tenThousandths(model) + compute) / 10_000;
  return p.envelopeFloorUsd !== undefined && p.envelopeFloorUsd > 0 ? (tenThousandths(p.envelopeFloorUsd) + compute) / 10_000 : null;
}

/**
 * True when the run fits the envelope. The sum and the compare are done by the database in numeric, with the run's amount passed as a whole number of
 * ten-thousandths, so a settled $0.10 plus a $0.20 run fits a $0.30 envelope exactly. An envelope with no row, or a run with no price, is a no (fail closed).
 */
export async function envelopeAdmits(client: PoolClient, accountId: string, envelopeId: string, runUsd: number | null): Promise<boolean> {
  if (runUsd === null || !Number.isFinite(runUsd)) return false;
  const { rows } = await client.query<{ ok: boolean }>(
    `SELECT (spent.sum * 10000 + $3::bigint <= cur.amount_usd * 10000) AS ok
       FROM (SELECT amount_usd FROM approval_envelopes WHERE account_id = $1 AND id = $2 ORDER BY version DESC LIMIT 1) cur,
            (${SPENT_SQL}) spent`,
    [accountId, envelopeId, tenThousandths(runUsd)],
  );
  return rows[0]?.ok === true;
}

/** Records a no-model run's estimated price against its envelope. The run must exist; a second call for the same run changes nothing. */
export async function recordEnvelopeCharge(client: PoolClient, accountId: string, runId: string, envelopeId: string, usd: number): Promise<void> {
  await client.query('INSERT INTO envelope_run_charges (account_id, run_id, envelope_id, usd) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [accountId, runId, envelopeId, usd]);
}
