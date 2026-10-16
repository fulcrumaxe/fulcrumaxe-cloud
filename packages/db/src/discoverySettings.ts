import type { Pool, PoolClient } from 'pg';
import { withTenant } from './withTenant.js';

/**
 * How often a repository is re-discovered (D#483 S5-g1), over migrations/0849_discovery_settings.sql.
 *
 * Append-only: every change is a new version row for the repo, and the audit row naming the previous and the new value is written in the
 * same transaction. Nothing here issues an UPDATE or a DELETE, and app_user holds neither. No row means `daily`. Undo is a new version
 * with the earlier value.
 *
 * The `app.user_id` of the transaction is the actor and `changed_by`, never an input (the policy requires them to be equal, and to be an
 * owner or admin of the account).
 */

export const DISCOVERY_FREQUENCIES = ['daily', 'weekly', 'off'] as const;
export type DiscoveryFrequency = (typeof DISCOVERY_FREQUENCIES)[number];
/** What a repo does when no version has been written. */
export const DISCOVERY_DEFAULT_FREQUENCY: DiscoveryFrequency = 'daily';

export type DiscoverySettingErrorCode = 'discovery_frequency_invalid' | 'discovery_repo_invalid' | 'discovery_version_conflict';

/** Thrown before any write, or on a lost version race. `code` is the named error; branch on it, not on the message. */
export class DiscoverySettingError extends Error {
  constructor(readonly code: DiscoverySettingErrorCode) {
    super(code);
    this.name = 'DiscoverySettingError';
  }
}

export interface DiscoverySettingVersion {
  id: string;
  accountId: string;
  repoId: string;
  frequency: DiscoveryFrequency;
  version: number;
  changedBy: string;
  createdAt: Date;
}

interface Row {
  id: string;
  account_id: string;
  repo_id: string;
  frequency: DiscoveryFrequency;
  version: number;
  changed_by: string;
  created_at: Date;
}

const map = (r: Row): DiscoverySettingVersion => ({
  id: r.id,
  accountId: r.account_id,
  repoId: r.repo_id,
  frequency: r.frequency,
  version: r.version,
  changedBy: r.changed_by,
  createdAt: r.created_at,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The CURRENT (highest-version) row for the repo, or null when none was ever written (the repo is on the default). RLS scopes it to the account. */
export async function getCurrentDiscoverySetting(client: PoolClient, repoId: string): Promise<DiscoverySettingVersion | null> {
  const { rows } = await client.query<Row>(`SELECT * FROM discovery_settings WHERE repo_id = $1::uuid ORDER BY version DESC LIMIT 1`, [repoId]);
  return rows[0] ? map(rows[0]) : null;
}

/** The frequency in force: the current version, else the default. A stored value this code does not know fails closed to `off`. */
export function effectiveDiscoveryFrequency(row: DiscoverySettingVersion | null): DiscoveryFrequency {
  if (row === null) return DISCOVERY_DEFAULT_FREQUENCY;
  return (DISCOVERY_FREQUENCIES as readonly string[]).includes(row.frequency) ? row.frequency : 'off';
}

/** The repo's most recent versions, newest first. The full history stays in the table; the page asks for a bounded number. */
export async function listDiscoverySettingHistory(client: PoolClient, repoId: string, limit = 50): Promise<DiscoverySettingVersion[]> {
  const { rows } = await client.query<Row>(`SELECT * FROM discovery_settings WHERE repo_id = $1::uuid ORDER BY version DESC LIMIT $2`, [repoId, limit]);
  return rows.map(map);
}

export interface AppendDiscoveryVersionInput {
  accountId: string;
  repoId: string;
  frequency: DiscoveryFrequency;
  /** The authenticated caller; see `WriteDiscoverySettingContext`. */
  changedBy: string;
}

/**
 * Appends the next version and writes the audit row naming the previous and the new value, on a client that already holds a `withTenant`
 * transaction opened as `changedBy`. Setting the value already in force writes nothing and returns null: no version, no audit row.
 */
export async function appendDiscoveryVersion(client: PoolClient, input: AppendDiscoveryVersionInput): Promise<DiscoverySettingVersion | null> {
  const { accountId, repoId, frequency, changedBy } = input;
  if (!UUID_RE.test(repoId)) throw new DiscoverySettingError('discovery_repo_invalid');
  if (!(DISCOVERY_FREQUENCIES as readonly string[]).includes(frequency)) throw new DiscoverySettingError('discovery_frequency_invalid');
  // No FOR UPDATE: that needs UPDATE, which app_user deliberately lacks. A lost race fails on the UNIQUE key instead (mapped below).
  const previous = await getCurrentDiscoverySetting(client, repoId);
  const before = effectiveDiscoveryFrequency(previous);
  if (before === frequency) return null;
  let inserted: DiscoverySettingVersion;
  try {
    const { rows } = await client.query<Row>(
      `INSERT INTO discovery_settings (account_id, repo_id, frequency, version, changed_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [accountId, repoId, frequency, previous ? previous.version + 1 : 1, changedBy],
    );
    inserted = map(rows[0]!);
  } catch (err) {
    // Two writers racing for one version: the loser fails on the UNIQUE key (23505) or, if the winner had already committed, on the
    // next-version trigger (23514 with its own message). Any other check violation is not a race and passes through.
    const e = err as { code?: string; message?: string } | null;
    if (e?.code === '23505' || (e?.code === '23514' && /^discovery_settings\.version must be/.test(e.message ?? ''))) {
      throw new DiscoverySettingError('discovery_version_conflict');
    }
    throw err;
  }
  await client.query(`SELECT audit_write('discovery_setting.changed', $1::jsonb)`, [
    JSON.stringify({ actor: changedBy, repo_id: repoId, version: inserted.version, previous: before, new: frequency }),
  ]);
  return inserted;
}

export interface WriteDiscoverySettingContext {
  pool: Pool;
  /** The AUTHENTICATED caller's user id; never a request field. */
  principal: string;
}

/** One change as one transaction: the version row and its audit row commit together, or neither does. */
export async function writeDiscoverySetting(
  ctx: WriteDiscoverySettingContext,
  input: Omit<AppendDiscoveryVersionInput, 'changedBy'>,
): Promise<DiscoverySettingVersion | null> {
  return withTenant(ctx.pool, input.accountId, ctx.principal, (client) => appendDiscoveryVersion(client, { ...input, changedBy: ctx.principal }));
}
