import { withTenant } from '@fx/db/src/withTenant.js';
import { assertActiveMembership } from '@fx/core/src/tenancy/scopedAccess.js';
import type { ConnectionStatusView, ModelConnectionCtx, Provider } from './types.js';

interface Row {
  provider: Provider;
  key_fingerprint: string;
  status: ConnectionStatusView['status'];
  last_validated_at: Date | null;
  last_error_code: string | null;
}

/**
 * D#31 comment 18494573 (C6-1). Criteria 4 and 7. Reads exactly the
 * display columns the Spec allows (`last_error_code` too, so the UI has
 * a reason to show -- not key material, just a short provider error
 * code). A plain `SELECT` through `withTenant`, so a cross-tenant
 * accountId/userId returns `null` here, the same "wrong tenant" ==
 * "doesn't exist" RLS gives everywhere else.
 *
 * Security review finding 3 (CWE-639/CWE-862): unlike the other three
 * exported functions (connect/remove throw ForbiddenError, test() throws
 * NotFoundError), this one had NO membership check at all -- it relied
 * on RLS alone, and model_connections' RLS policy checks only
 * `app.account_id`, never `app.user_id`, so a non-member, a made-up user
 * id, or a member removed from the account could all read another
 * account's connection. `assertActiveMembership` (the same check
 * `getTenantRowOrNotFound` uses) now runs inside this same `withTenant`
 * transaction, before the SELECT -- a non-member gets NotFoundError,
 * never `null`, so a route can't turn "not a member" into "no
 * connection".
 */
export async function getStatus(ctx: ModelConnectionCtx): Promise<ConnectionStatusView | null> {
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    await assertActiveMembership(client, accountId, userId);
    const { rows } = await client.query<Row>(
      `SELECT provider, key_fingerprint, status, last_validated_at, last_error_code
         FROM model_connections WHERE account_id = $1`,
      [accountId],
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      provider: row.provider,
      fingerprint: row.key_fingerprint,
      status: row.status,
      last_validated_at: row.last_validated_at,
      last_error_code: row.last_error_code,
    };
  });
}
