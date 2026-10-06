import type { Pool, PoolClient } from 'pg';

/**
 * Typed reads and the flip write over `account_features`
 * (migrations/0611_exposure_audit.sql, D#8 R1). Absence of a row is
 * meaningful -- D#8 R2's resolver treats a `silent`/`gated` feature with
 * no row as "still at its class default" -- so this module never seeds or
 * backfills a row, only reads and writes ones that represent an actual
 * decision.
 *
 * Reads go through `app_user` (SELECT-only grant, RLS-scoped by
 * `withTenant`'s session settings) via a plain `PoolClient`, the same
 * shape `decisions.ts`'s read helpers use. The write goes through a
 * SEPARATE pool connected as `exposure_writer` -- `app_user` holds no
 * INSERT/UPDATE on this table at all (R1 criteria 2-3). Which pool a
 * caller passes is the caller's responsibility; this module has no
 * opinion about how that pool's connection string is provisioned, the
 * same division decisions.ts draws between its own tenant-scoped reads
 * and (not built here) DP3's receipt_writer-backed write.
 */

export type FeatureState = 'on' | 'off';
export type FeatureSource = 'customer' | 'platform' | 'product_default';

export interface AccountFeature {
  id: string;
  accountId: string;
  featureKey: string;
  state: FeatureState;
  source: FeatureSource;
  decidedByUserId: string;
  decidedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface AccountFeatureRow {
  id: string;
  account_id: string;
  feature_key: string;
  state: string;
  source: string;
  decided_by_user_id: string;
  decided_at: Date;
  created_at: Date;
  updated_at: Date;
}

function mapAccountFeatureRow(row: AccountFeatureRow): AccountFeature {
  return {
    id: row.id,
    accountId: row.account_id,
    featureKey: row.feature_key,
    state: row.state as FeatureState,
    source: row.source as FeatureSource,
    decidedByUserId: row.decided_by_user_id,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The account_features row for `featureKey` in the CURRENT account, or
 * `null` if that feature has never been explicitly decided for this
 * account -- meaning the D#8 R2 catalogue's class default applies.
 * `client` must come from `withTenant` (or any connection with
 * `app.account_id` already set): RLS scopes the result to whichever
 * account that transaction set, the same as every other tenant read in
 * this package.
 */
export async function getAccountFeature(
  client: PoolClient,
  featureKey: string,
): Promise<AccountFeature | null> {
  const { rows } = await client.query<AccountFeatureRow>(
    `SELECT * FROM account_features WHERE feature_key = $1`,
    [featureKey],
  );
  return rows[0] ? mapAccountFeatureRow(rows[0]) : null;
}

/** Every feature ever explicitly decided for the current account, keyed order. */
export async function listAccountFeatures(client: PoolClient): Promise<AccountFeature[]> {
  const { rows } = await client.query<AccountFeatureRow>(
    `SELECT * FROM account_features ORDER BY feature_key`,
  );
  return rows.map(mapAccountFeatureRow);
}

/**
 * `(ctx, input)` shape (same discipline as decisions.ts's
 * writeDialSetting): the caller's identity is `ctx.principal`, the
 * AUTHENTICATED caller's own user id, never a value taken from request
 * input -- R1 criterion 4. `WriteFeatureFlipInput` deliberately has no
 * `decidedByUserId` field at all, so a forged one in a raw request
 * payload has nowhere typed to land; see exposure.test.ts for the
 * non-vacuity proof (a payload carrying an extra, forged
 * `decidedByUserId` key still stores `ctx.principal`).
 *
 * `pool` MUST be connected (or, for a `PoolClient`, have had `SET ROLE`
 * issued) as `exposure_writer` -- `app_user` holds no INSERT/UPDATE on
 * `account_features` (R1 criteria 2-3), so this deliberately does not go
 * through `withTenant`/app_user at all. The customer-owner/admin vs.
 * platform_ops vs. partner-refused authority check (D#8 R3's
 * resolveExposure() flip-authority table) is the caller's job, before
 * this function is ever invoked -- exposure_writer itself has no
 * per-account RLS scoping (see migrations/0611_exposure_audit.sql for
 * why). Accepts a `PoolClient` as well as a `Pool` so a caller that has
 * already checked out a single connection (for example to issue `SET
 * ROLE` on it directly, the way exposure.test.ts does -- there is no
 * dedicated `exposure_writer` connection string in this package's own
 * test harness, see the migration's file header) does not have that
 * connection's role state discarded by a plain `Pool.query()` picking a
 * different connection out of the pool.
 */
export interface WriteFeatureFlipContext {
  pool: Pool | PoolClient;
  principal: string;
}

export interface WriteFeatureFlipInput {
  accountId: string;
  featureKey: string;
  state: FeatureState;
  source: FeatureSource;
}

/**
 * Upserts the account_features row for `(accountId, featureKey)`:
 * INSERTs a fresh decision, or UPDATEs the existing one in place if the
 * account has flipped this feature before (UNIQUE (account_id,
 * feature_key) in migrations/0611_exposure_audit.sql -- this table
 * records the CURRENT decision, not history the way decision_settings
 * does). `decided_at`/`updated_at` are always stamped `now()` by this
 * function, never taken from the caller.
 */
export async function writeFeatureFlip(
  ctx: WriteFeatureFlipContext,
  input: WriteFeatureFlipInput,
): Promise<AccountFeature> {
  const { pool, principal } = ctx;
  const { accountId, featureKey, state, source } = input;

  const { rows } = await pool.query<AccountFeatureRow>(
    `INSERT INTO account_features
       (account_id, feature_key, state, source, decided_by_user_id, decided_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())
     ON CONFLICT (account_id, feature_key) DO UPDATE
       SET state = EXCLUDED.state,
           source = EXCLUDED.source,
           decided_by_user_id = EXCLUDED.decided_by_user_id,
           decided_at = now(),
           updated_at = now()
     RETURNING *`,
    [accountId, featureKey, state, source, principal],
  );
  return mapAccountFeatureRow(rows[0]!);
}
