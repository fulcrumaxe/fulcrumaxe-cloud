import { withTenant } from '@fx/db/src/withTenant.js';
import { getMemberRole, requireOwnerOrAdmin } from '@fx/core/src/tenancy/authorize.js';
import { emitDomainEvent } from '@fx/core/src/domain-events/emit.js';
import { NotFoundError } from './errors.js';
import type { ModelConnectionCtx } from './types.js';

/**
 * D#31 comment 18494573 (C6-1). Criterion 6: "Delete removes the
 * ciphertext and the wrapped data key." A real `DELETE` is the only way
 * to guarantee that -- `key_ciphertext`/`wrapped_dek` are NOT NULL, so
 * "remove" can't mean nulling in place without a schema change. Throws
 * NotFoundError (never a silent no-op) when there is no connection,
 * matching membership.ts's own convention for a missing target row.
 */
export async function remove(ctx: ModelConnectionCtx): Promise<void> {
  const { accountId, userId } = ctx.principal;

  // Checked before opening remove()'s own withTenant transaction --
  // getMemberRole opens (and closes) its own, so nesting it inside would
  // hold two connections from `ctx.pool` open for no reason.
  const role = await getMemberRole(ctx.pool, accountId, userId);
  requireOwnerOrAdmin(role);

  await withTenant(ctx.pool, accountId, userId, async (client) => {
    const { rowCount } = await client.query(`DELETE FROM model_connections WHERE account_id = $1`, [accountId]);
    if (!rowCount) {
      throw new NotFoundError(`model_connections: no connection for account ${accountId}`);
    }

    // D#76: app_user's INSERT grant on audit_log was revoked -- this goes
    // through audit_write(), which stamps account_id/actor/created_at
    // itself. 'model_connection.remove' is on its allowlist
    // (migrations/0008_audit_log_append_only.sql).
    await client.query(`SELECT audit_write('model_connection.remove', $1::jsonb)`, [
      JSON.stringify({}),
    ]);
    // Onboarding step 1 goes back to open with the key: tell the open windows, in the same transaction.
    await emitDomainEvent(client, { type: 'model_connection.changed', accountId, payload: { state: 'removed' } });
  });
}
