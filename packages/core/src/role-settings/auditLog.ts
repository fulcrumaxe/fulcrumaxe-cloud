import type { PoolClient } from 'pg';

/**
 * The ONE call site in this module that writes an `audit_log` row (H12
 * criteria 3 and 5). D#76 (migration 0008) converted every `audit_log`
 * write in the codebase to go through `audit_write`, the SECURITY
 * DEFINER function that stamps `account_id`/`actor`/`created_at` itself
 * rather than trusting the caller -- app_user's raw INSERT grant on
 * `audit_log` is revoked. `setMode.ts` and `guardSettings.ts` both call
 * this and never write `audit_log` directly.
 *
 * `accountId` is intentionally unused here (renamed `_accountId`):
 * `audit_write` derives the account from the session's `app.account_id`
 * GUC, already set by the `withTenant(...)` transaction both callers run
 * inside, not from a caller-supplied argument. The parameter stays in
 * the signature so neither call site needs to change.
 *
 * `actor` is passed for the same reason -- `audit_write` stamps the
 * actor from `current_member_user_id()`, the verified session member,
 * regardless of what's passed here -- but is kept in the signature for
 * the same reason.
 */
export async function writeRoleSettingsAuditLog(
  client: PoolClient,
  _accountId: string,
  _actor: string,
  action: string,
  payload: unknown,
): Promise<void> {
  await client.query('SELECT audit_write($1, $2::jsonb)', [action, JSON.stringify(payload)]);
}
