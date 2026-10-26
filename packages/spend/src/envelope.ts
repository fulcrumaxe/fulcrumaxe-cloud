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

/**
 * The advisory lock one envelope's money is decided under. `reserve()` takes it before admitting a run, and the auto-start gate (`autostartRoom`) takes it
 * before starting an item on the weekly envelope, so an admission and a start never both read the same headroom. Held to the end of the transaction.
 */
export const envelopeLockKey = (accountId: string, envelopeId: string): string => `${accountId}:envelope:${envelopeId}`;

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

/** The envelope's spend, as one SQL expression over $1 = account, $2 = envelope, $3 = the instant spend is counted from (see the file header and `spendSince`). Counts a charge only while its run started or may still start. */
const SPENT_SQL = `SELECT COALESCE(SUM(x.usd), 0) AS sum FROM (
       SELECT l.usd FROM ledger l
         JOIN agent_runs r ON r.account_id = l.account_id AND r.id = l.run_id
         JOIN work_items w ON w.account_id = r.account_id AND w.id = r.work_item_id
        WHERE l.account_id = $1 AND w.envelope_id = $2 AND l.created_at >= $3::timestamptz
       UNION ALL
       SELECT s.usd_reserved FROM spend_reservations s
         JOIN agent_runs r ON r.account_id = s.account_id AND r.id = s.run_id
         JOIN work_items w ON w.account_id = r.account_id AND w.id = r.work_item_id
        WHERE s.account_id = $1 AND s.state = 'open' AND w.envelope_id = $2 AND s.created_at >= $3::timestamptz
       UNION ALL
       SELECT c.usd FROM envelope_run_charges c
         JOIN agent_runs r ON r.account_id = c.account_id AND r.id = c.run_id
        WHERE c.account_id = $1 AND c.envelope_id = $2 AND c.created_at >= $3::timestamptz AND NOT (r.status = 'refused_spend' OR (r.status = 'cancelled' AND r.started_at IS NULL))
     ) x`;

/**
 * D#483 S5-e2: the Monday 00:00 UTC at or before `now`, the start of the week the weekly auto-start envelope is counted over. Pure; uses no local time zone.
 * The next one is `weekStartUtc(now) + 7 days`.
 */
export function weekStartUtc(now: Date): Date {
  const day = (now.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day));
}

/**
 * The instant an envelope's spend is counted from. A weekly auto-start envelope renews every Monday 00:00 UTC and nothing rolls over, so only spend from
 * this week counts against its amount; an item or batch envelope counts all of its spend (`-infinity`). An envelope with no row counts all (and then
 * fails closed on its missing amount).
 */
export async function spendSince(client: PoolClient, accountId: string, envelopeId: string, now: Date): Promise<string> {
  const { rows } = await client.query<{ scope: EnvelopeScope }>('SELECT scope FROM approval_envelopes WHERE account_id = $1 AND id = $2 LIMIT 1', [accountId, envelopeId]);
  return rows[0]?.scope === 'weekly_autostart' ? weekStartUtc(now).toISOString() : '-infinity';
}

/** What the envelope has spent or holds right now, for display. The admission check below never uses this number: it compares inside the database. */
export async function envelopeSpentUsd(client: PoolClient, accountId: string, envelopeId: string, now: Date = new Date()): Promise<number> {
  const since = await spendSince(client, accountId, envelopeId, now);
  const { rows } = await client.query<{ sum: string }>(`SELECT sum::text FROM (${SPENT_SQL}) t`, [accountId, envelopeId, since]);
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
export async function envelopeAdmits(client: PoolClient, accountId: string, envelopeId: string, runUsd: number | null, now: Date = new Date()): Promise<boolean> {
  if (runUsd === null || !Number.isFinite(runUsd)) return false;
  const since = await spendSince(client, accountId, envelopeId, now);
  const { rows } = await client.query<{ ok: boolean }>(
    `SELECT (spent.sum * 10000 + $4::bigint <= cur.amount_usd * 10000) AS ok
       FROM (SELECT amount_usd FROM approval_envelopes WHERE account_id = $1 AND id = $2 ORDER BY version DESC LIMIT 1) cur,
            (${SPENT_SQL}) spent`,
    [accountId, envelopeId, since, tenThousandths(runUsd)],
  );
  return rows[0]?.ok === true;
}

/**
 * Records a no-model run's estimated price against its envelope, through envelope_charge_record (0865), the only writer: the run's own item must draw on
 * that envelope, and a charge only ever goes up, so a smaller figure written earlier cannot hide this one. A second call with the same figure changes nothing.
 */
export async function recordEnvelopeCharge(client: PoolClient, _accountId: string, runId: string, envelopeId: string, usd: number): Promise<void> {
  // The tenant is the session's own (withTenant); the definer reads it from there, so the account id is not sent.
  await client.query('SELECT envelope_charge_record($1::uuid, $2::uuid, $3::numeric)', [runId, envelopeId, usd]);
}

/** The refusals work_item_set_envelope raises (SQLSTATE 55000, the code as the message). */
export type SetEnvelopeRefusal = 'work_started' | 'envelope_already_set' | 'envelope_scope' | 'envelope_repo_mismatch' | 'envelope_taken';

export class SetEnvelopeError extends Error {
  constructor(readonly code: SetEnvelopeRefusal) {
    super(code);
    this.name = 'SetEnvelopeError';
  }
}

const SET_ENVELOPE_REFUSALS: ReadonlySet<string> = new Set<SetEnvelopeRefusal>(['work_started', 'envelope_already_set', 'envelope_scope', 'envelope_repo_mismatch', 'envelope_taken']);

/**
 * Attaches an envelope to a work item at approval, through work_item_set_envelope (0865), the only way work_items.envelope_id is ever set. The session must
 * be an owner or admin of the account; the item must still be at Triaged with no run. True when this call set it, false when the item already had this envelope.
 */
export async function setWorkItemEnvelope(client: PoolClient, workItemId: string, envelopeId: string): Promise<boolean> {
  await client.query('SAVEPOINT set_item_envelope');
  try {
    const { rows } = await client.query<{ set: boolean }>('SELECT work_item_set_envelope($1::uuid, $2::uuid) AS set', [workItemId, envelopeId]);
    await client.query('RELEASE SAVEPOINT set_item_envelope');
    return rows[0]!.set;
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT set_item_envelope');
    const e = err as { code?: string; message?: string };
    if (e.code === '55000' && e.message && SET_ENVELOPE_REFUSALS.has(e.message)) throw new SetEnvelopeError(e.message as SetEnvelopeRefusal);
    throw err;
  }
}

/** Remembers that the ask for (item, envelope version) was raised, through envelope_pause_ask_record (0865): the ask must exist. True when this call wrote it. */
export async function recordEnvelopePauseAsk(client: PoolClient, input: { workItemId: string; envelopeId: string; version: number; askId: string }): Promise<boolean> {
  const { rows } = await client.query<{ recorded: boolean }>('SELECT envelope_pause_ask_record($1::uuid, $2::uuid, $3::integer, $4::uuid) AS recorded', [input.workItemId, input.envelopeId, input.version, input.askId]);
  return rows[0]!.recorded;
}

/** Remembers that a rule denied the spend past (item, envelope version), through envelope_pause_receipt_record (0866): the deny receipt must exist. True when this call wrote it. */
export async function recordEnvelopePauseReceipt(client: PoolClient, input: { workItemId: string; envelopeId: string; version: number; receiptId: string }): Promise<boolean> {
  const { rows } = await client.query<{ recorded: boolean }>('SELECT envelope_pause_receipt_record($1::uuid, $2::uuid, $3::integer, $4::uuid) AS recorded', [input.workItemId, input.envelopeId, input.version, input.receiptId]);
  return rows[0]!.recorded;
}
