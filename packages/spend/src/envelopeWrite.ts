import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { currentEnvelope, type EnvelopeScope } from './envelope.js';
import { foregroundBudgetUsd } from './plans.js';
import { monthToDateUsd } from './reserve.js';
import type { PlanId } from './types.js';

/**
 * What the account can still spend this month: the model budget left plus the foreground compute allowance left, each floored at zero, counting open
 * reservations as spent (the same totals reserve() reads). Envelopes draw on the foreground budget, so that is the compute side.
 */
export async function remainingAccountBudgetUsd(client: PoolClient, accountId: string, now: Date = new Date()): Promise<number> {
  const { rows } = await client.query<{ plan: PlanId; budget: string | null }>('SELECT plan, model_budget_usd_month::text AS budget FROM accounts WHERE id = $1', [accountId]);
  const account = rows[0];
  if (!account) return 0;
  const model = Math.max(0, Number(account.budget ?? 0) - (await monthToDateUsd(client, accountId, 'model', now)));
  const compute = Math.max(0, foregroundBudgetUsd(account.plan) - (await monthToDateUsd(client, accountId, 'foreground_compute', now)));
  return model + compute;
}

export class EnvelopeWriteError extends Error {
  constructor(readonly code: 'over_account_budget' | 'envelope_not_found' | 'invalid_amount' | 'version_conflict') {
    super(code);
    this.name = 'EnvelopeWriteError';
  }
}

export interface EnvelopeWrite {
  accountId: string;
  /** Omit to open a new envelope (version 1); give an existing id to write its next version. */
  envelopeId?: string;
  scope: EnvelopeScope;
  repoId?: string | null;
  amountUsd: number;
  estimateUsd?: number | null;
  marginPct?: number | null;
  now?: Date;
}

/**
 * Writes one envelope version on a `withTenant` client whose session names the person (app.user_id): the insert policy makes `created_by` that user and
 * requires an owner or admin. An amount above what the account can still spend this month is refused `over_account_budget` and nothing is written.
 * Returns the envelope's id and the version written. Two writers racing to the same next version: the loser gets `version_conflict`.
 */
export async function writeEnvelopeVersion(client: PoolClient, w: EnvelopeWrite): Promise<{ envelopeId: string; version: number }> {
  if (!Number.isFinite(w.amountUsd) || w.amountUsd < 0) throw new EnvelopeWriteError('invalid_amount');
  if (w.amountUsd > (await remainingAccountBudgetUsd(client, w.accountId, w.now))) throw new EnvelopeWriteError('over_account_budget');
  const envelopeId = w.envelopeId ?? randomUUID();
  let version = 1;
  if (w.envelopeId !== undefined) {
    const current = await currentEnvelope(client, w.accountId, w.envelopeId);
    if (current === null) throw new EnvelopeWriteError('envelope_not_found');
    version = current.version + 1;
  }
  try {
    await client.query('SAVEPOINT envelope_write');
    await client.query(
      `INSERT INTO approval_envelopes (id, account_id, repo_id, scope, amount_usd, estimate_usd, margin_pct, version, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULLIF(current_setting('app.user_id', true), '')::uuid)`,
      [envelopeId, w.accountId, w.repoId ?? null, w.scope, w.amountUsd, w.estimateUsd ?? null, w.marginPct ?? null, version],
    );
    await client.query('RELEASE SAVEPOINT envelope_write');
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT envelope_write');
    if ((err as { code?: string }).code === '23505') throw new EnvelopeWriteError('version_conflict');
    throw err;
  }
  return { envelopeId, version };
}
