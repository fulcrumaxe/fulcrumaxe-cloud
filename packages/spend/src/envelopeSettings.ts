import type { PoolClient } from 'pg';
import { envelopeDefaultMarginPct } from '@fx/plan-data';
import { currentEnvelope, envelopeSpentUsd, weekStartUtc, type EnvelopeScope } from './envelope.js';
import { EnvelopeWriteError, writeEnvelopeVersion } from './envelopeWrite.js';

/**
 * D#483 S5-e2: the three things a person changes about envelopes after an approval, each an append-only version plus ONE audit row in the same transaction.
 *
 *   changeEnvelope          an item or batch envelope gets a new version (never an UPDATE: app_user holds SELECT and INSERT on approval_envelopes only).
 *   changeAutostart         the weekly auto-start envelope: the one envelope id per account of scope `weekly_autostart`, written by a person who confirms it.
 *                           Setting 0 (or removing it) writes a version of 0, which turns auto-start off. It renews every Monday 00:00 UTC and nothing rolls over.
 *   changeMargin            the default margin the pre-fill adds to a priced estimate, in `envelope_margin_settings`.
 *
 * Every function takes a client inside a `withTenant` transaction whose session names the person (`app.user_id`): the tables' own policies require an owner
 * or admin, and a refusal rolls the whole transaction back, audit row included. The routes add the session-only rule.
 *
 * Undo: there is no delete. A change is undone by writing the earlier value, which is a new version and an audit row of its own.
 */

/** The sentence shown while auto-start is off (setting 0 or removing it). Customer wording approved with the Spec. */
export const AUTOSTART_OFF_SENTENCE = 'Set a weekly auto-start limit to let small, doc and bug items start on their own';

export class EnvelopeSettingError extends Error {
  constructor(readonly code: 'setting_changed' | 'envelope_scope' | 'envelope_not_found') {
    super(code);
    this.name = 'EnvelopeSettingError';
  }
}

const PG_UNIQUE_VIOLATION = '23505';
const isUniqueViolation = (err: unknown): boolean => (err as { code?: string } | null)?.code === PG_UNIQUE_VIOLATION;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

async function audit(client: PoolClient, action: 'envelope.changed' | 'autostart_envelope.changed' | 'envelope_margin.changed', payload: Record<string, unknown>): Promise<void> {
  await client.query('SELECT audit_write($1::text, $2::jsonb)', [action, JSON.stringify(payload)]);
}

// ---- the default margin ---------------------------------------------------------------------------------------------------------------

export type MarginSource = 'setting' | 'plan_data' | 'none';
export interface EffectiveMargin {
  /** Percent, or null when the account has no setting and the plan data carries none (the pre-fill is then the bare estimate: fail closed, never a made-up margin). */
  marginPct: number | null;
  source: MarginSource;
  /** The plan data's `envelope.defaultMarginPct`, or null when it carries none. */
  planDefaultPct: number | null;
  /** The setting's current version, or null while the account has never set one. */
  version: number | null;
  historyCount: number;
}

/** The account's current margin setting (its highest version), or null when it has never set one. */
export async function currentMarginSetting(client: PoolClient, accountId: string): Promise<{ marginPct: number; version: number } | null> {
  const { rows } = await client.query<{ margin_pct: string; version: number }>(
    'SELECT margin_pct::text AS margin_pct, version FROM envelope_margin_settings WHERE account_id = $1 ORDER BY version DESC LIMIT 1',
    [accountId],
  );
  return rows[0] ? { marginPct: Number(rows[0].margin_pct), version: rows[0].version } : null;
}

/**
 * The margin an approval's pre-fill uses: the account's own setting, else the plan data's default, else none. The plan-data reader (`envelopeDefaultMarginPct`,
 * from S5-e1) answers null when plan data is missing or carries no figure, and throws on a figure that fails its schema, so a bad figure never turns into a
 * margin. The caller must run inside a `withTenant` transaction for `accountId`.
 */
export async function effectiveMargin(client: PoolClient, accountId: string): Promise<EffectiveMargin> {
  const setting = await currentMarginSetting(client, accountId);
  const planDefaultPct = envelopeDefaultMarginPct();
  const { rows } = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM envelope_margin_settings WHERE account_id = $1', [accountId]);
  const historyCount = Number(rows[0]!.n);
  if (setting !== null) return { marginPct: setting.marginPct, source: 'setting', planDefaultPct, version: setting.version, historyCount };
  if (planDefaultPct !== null) return { marginPct: planDefaultPct, source: 'plan_data', planDefaultPct, version: null, historyCount };
  return { marginPct: null, source: 'none', planDefaultPct: null, version: null, historyCount };
}

/**
 * Writes the next margin version and one `envelope_margin.changed` audit row naming both values. The same value as the current setting writes nothing.
 * `setting_changed` when another change took the same version first.
 */
export async function changeMargin(client: PoolClient, input: { accountId: string; userId: string; marginPct: number }): Promise<{ written: boolean; version: number | null }> {
  const { accountId, userId, marginPct } = input;
  const before = await effectiveMargin(client, accountId);
  if (before.source === 'setting' && before.marginPct === marginPct) return { written: false, version: before.version };
  const version = (before.version ?? 0) + 1;
  try {
    await client.query('SAVEPOINT margin_write');
    await client.query('INSERT INTO envelope_margin_settings (account_id, margin_pct, version, changed_by) VALUES ($1, $2, $3, $4)', [accountId, marginPct, version, userId]);
    await client.query('RELEASE SAVEPOINT margin_write');
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT margin_write');
    if (isUniqueViolation(err)) throw new EnvelopeSettingError('setting_changed');
    throw err;
  }
  await audit(client, 'envelope_margin.changed', { from: before.marginPct, from_source: before.source, to: marginPct, version });
  return { written: true, version };
}

// ---- an item or batch envelope ----------------------------------------------------------------------------------------------------------

export interface EnvelopeChange {
  envelopeId: string;
  scope: EnvelopeScope;
  repoId: string | null;
  version: number;
  amountUsd: number;
  fromAmountUsd: number;
  fromVersion: number;
}

/**
 * Appends a new version to an item or batch envelope and writes one `envelope.changed` audit row with both amounts. The writer's own refusals pass through
 * (`over_account_budget`, `envelope_below_first_run`, `invalid_amount`, `version_conflict`). The weekly auto-start envelope is not edited here: it is
 * confirmed through `changeAutostart`, so this refuses it `envelope_scope`. `firstRunUsd` answers the first run's reservation for the envelope's repository, the floor of any new amount.
 */
export async function changeEnvelope(
  client: PoolClient,
  input: { accountId: string; envelopeId: string; amountUsd: number; firstRunUsd: (repoId: string) => Promise<number> },
): Promise<EnvelopeChange> {
  const { accountId, envelopeId, amountUsd } = input;
  const { rows } = await client.query<{ scope: EnvelopeScope; repo_id: string | null; version: number; amount_usd: string }>(
    'SELECT scope, repo_id, version, amount_usd::text AS amount_usd FROM approval_envelopes WHERE account_id = $1 AND id = $2 ORDER BY version DESC LIMIT 1',
    [accountId, envelopeId],
  );
  const current = rows[0];
  if (current === undefined) throw new EnvelopeSettingError('envelope_not_found');
  if (current.scope === 'weekly_autostart') throw new EnvelopeSettingError('envelope_scope');
  const minAmountUsd = current.repo_id === null ? undefined : await input.firstRunUsd(current.repo_id);
  const written = await writeEnvelopeVersion(client, {
    accountId,
    envelopeId,
    scope: current.scope,
    repoId: current.repo_id,
    amountUsd,
    ...(minAmountUsd === undefined ? {} : { minAmountUsd }),
  });
  await audit(client, 'envelope.changed', {
    envelope_id: envelopeId,
    scope: current.scope,
    repo_id: current.repo_id,
    from_version: current.version,
    to_version: written.version,
    from: Number(current.amount_usd),
    to: amountUsd,
  });
  return { envelopeId, scope: current.scope, repoId: current.repo_id, version: written.version, amountUsd, fromAmountUsd: Number(current.amount_usd), fromVersion: current.version };
}

// ---- the weekly auto-start envelope ------------------------------------------------------------------------------------------------------

export interface AutostartState {
  envelopeId: string | null;
  version: number | null;
  /** The weekly amount in force, or 0 while auto-start is off. */
  amountUsd: number;
  enabled: boolean;
  /** The Monday 00:00 UTC this week started, and the one it renews at. */
  weekStartsAt: Date;
  renewsAt: Date;
  /** Spend counted against this week's amount; last week's does not count and nothing rolls over. */
  spentThisWeekUsd: number;
  remainingThisWeekUsd: number;
}

/** The account's weekly auto-start envelope as it stands at `now`, derived from the envelope's versions and this week's spend. */
export async function readAutostart(client: PoolClient, accountId: string, now: Date = new Date()): Promise<AutostartState> {
  const weekStartsAt = weekStartUtc(now);
  const renewsAt = new Date(weekStartsAt.getTime() + 7 * 24 * 60 * 60 * 1000);
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM approval_envelopes WHERE account_id = $1 AND scope = 'weekly_autostart' AND version = 1 LIMIT 1`,
    [accountId],
  );
  const envelopeId = rows[0]?.id ?? null;
  const current = envelopeId === null ? null : await currentEnvelope(client, accountId, envelopeId);
  if (envelopeId === null || current === null) {
    return { envelopeId: null, version: null, amountUsd: 0, enabled: false, weekStartsAt, renewsAt, spentThisWeekUsd: 0, remainingThisWeekUsd: 0 };
  }
  const spent = round4(await envelopeSpentUsd(client, accountId, envelopeId, now));
  return {
    envelopeId,
    version: current.version,
    amountUsd: current.amountUsd,
    enabled: current.amountUsd > 0,
    weekStartsAt,
    renewsAt,
    spentThisWeekUsd: spent,
    remainingThisWeekUsd: round4(Math.max(0, current.amountUsd - spent)),
  };
}

/**
 * Sets, changes or turns off the weekly auto-start envelope, and writes one `autostart_envelope.changed` audit row naming both amounts. `amountUsd` of 0
 * (or null: removing it) turns auto-start off by writing a version of 0; with no envelope yet that writes nothing. The route has already required the
 * person's explicit confirmation for a positive amount. An amount above what the account can still spend this month is refused `over_account_budget`.
 */
export async function changeAutostart(client: PoolClient, input: { accountId: string; amountUsd: number | null; now?: Date }): Promise<{ written: boolean; state: AutostartState }> {
  const { accountId } = input;
  const amountUsd = input.amountUsd ?? 0;
  const before = await readAutostart(client, accountId, input.now);
  // Off when it is already off (or never set), and the same amount again, change nothing.
  if (amountUsd === before.amountUsd) return { written: false, state: before };
  try {
    await writeEnvelopeVersion(client, {
      accountId,
      ...(before.envelopeId === null ? {} : { envelopeId: before.envelopeId }),
      scope: 'weekly_autostart',
      repoId: null,
      amountUsd,
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  } catch (err) {
    if (err instanceof EnvelopeWriteError && err.code === 'version_conflict') throw new EnvelopeSettingError('setting_changed');
    throw err;
  }
  const state = await readAutostart(client, accountId, input.now);
  await audit(client, 'autostart_envelope.changed', { envelope_id: state.envelopeId, from_version: before.version, to_version: state.version, from: before.amountUsd, to: amountUsd });
  return { written: true, state };
}
