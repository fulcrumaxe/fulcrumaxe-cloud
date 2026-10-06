import type { PoolClient } from 'pg';

export type AccountAction =
  | 'account.paused'
  | 'account.resumed'
  | 'account.budgets_changed'
  | 'account.share_public_figures_changed';

/**
 * The one way billing records an account action. Internal: deliberately not
 * exported from the package barrel.
 *
 * Calls the platform_ops-only `audit_write_account_action` function (migration
 * 0654) on the CALLER'S client, so it must run inside the same
 * `withPlatformOps` transaction as the write it records, after that write. If
 * the function raises (not an owner/admin of the account, bad action, oversize
 * payload), the error propagates out of the transaction and the write rolls
 * back with it -- there is no swallow-and-continue path.
 *
 * The function stamps the actor from `userId`, so the recorded actor is
 * always the acting member, never a value from `payload`.
 */
export async function recordAccountAction(
  client: PoolClient,
  params: { accountId: string; userId: string; action: AccountAction; payload: Record<string, unknown> },
): Promise<void> {
  await client.query('SELECT audit_write_account_action($1, $2, $3, $4::jsonb)', [
    params.accountId,
    params.userId,
    params.action,
    JSON.stringify(params.payload),
  ]);
}
