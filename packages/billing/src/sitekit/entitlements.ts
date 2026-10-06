import type { PoolClient } from 'pg';

/**
 * D#3 K09a: the only two reads publish (K08), the full-site gate (K10) and
 * sync (K11) make about payment. `client` is a tenant-bound client
 * (`withTenant`): the account id is also in the predicate, so a site of
 * another account reads as false whichever way the client is bound.
 */
type Reader = Pick<PoolClient, 'query'>;

/** True once the site's setup payment has been recorded by the webhook. */
export async function isSetupPaid(client: Reader, accountId: string, siteId: string): Promise<boolean> {
  const { rows } = await client.query(
    'SELECT 1 FROM sitekit_entitlements WHERE account_id = $1 AND site_id = $2 AND setup_paid_at IS NOT NULL',
    [accountId, siteId],
  );
  return rows.length > 0;
}

/** True while the site's sync subscription is active or trialing and has not ended. */
export async function isSyncEntitled(client: Reader, accountId: string, siteId: string): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT 1 FROM sitekit_entitlements
      WHERE account_id = $1 AND site_id = $2 AND sync_status IN ('active', 'trialing') AND sync_ended_at IS NULL`,
    [accountId, siteId],
  );
  return rows.length > 0;
}
