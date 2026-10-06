import { getRoleEntry, type RoleMode } from '@fx/roles';
import { withTenant } from '../tenancy/withTenant.js';
import { assertActiveMembership } from '../tenancy/scopedAccess.js';
import { requireOwnerOrAdmin, type MembershipRole } from '../tenancy/authorize.js';
import { assertRepoExists } from './internal.js';
import { writeRoleSettingsAuditLog } from './auditLog.js';
import { InvalidRoleSettingsInputError } from './errors.js';
import type { RoleSettingsCtx } from './types.js';

export interface SetRoleModeInput {
  repoId: string;
  role: string;
  mode: RoleMode;
}

/**
 * H12 criterion 3: "Changing a mode writes `role_settings` and an
 * `audit_log` row. Non-admins get 403 (test)." sec-criteria A7: role
 * authorization is the application's job -- enforced here by
 * `requireOwnerOrAdmin`, the same gate H05/H10/H12 all call
 * (authorize.ts's own doc comment).
 *
 * Validation against the role's own `allowedModes` (an unknown role
 * name, or a mode that role doesn't support) happens before the
 * transaction opens -- it needs no database round trip and should never
 * touch a row.
 */
export async function setRoleMode(ctx: RoleSettingsCtx, input: SetRoleModeInput): Promise<void> {
  const manifestEntry = getRoleEntry(input.role);
  if (manifestEntry === undefined) {
    throw new InvalidRoleSettingsInputError(`unknown role: ${input.role}`, 'role');
  }
  if (!manifestEntry.allowedModes.includes(input.mode)) {
    throw new InvalidRoleSettingsInputError(
      `role ${input.role} does not allow mode ${input.mode} (allowed: ${manifestEntry.allowedModes.join(', ')})`,
      'mode',
    );
  }

  const { accountId, userId } = ctx.principal;
  await withTenant(ctx.pool, accountId, userId, async (client) => {
    await assertActiveMembership(client, accountId, userId);

    // Security review (PR #89, informational, consistency): run the role
    // check before the repo-existence check, matching guardSettings' order.
    // Otherwise a member sees NotFoundError for a missing repo but
    // ForbiddenError for an existing one -- both within their own account,
    // so this crosses no tenant line, but the inconsistency is needless.
    const { rows } = await client.query<{ role: MembershipRole }>(
      'SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2',
      [accountId, userId],
    );
    requireOwnerOrAdmin(rows[0]?.role ?? null);

    await assertRepoExists(client, input.repoId);

    await client.query(
      `INSERT INTO role_settings (account_id, repo_id, role, mode)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (repo_id, role) DO UPDATE SET mode = EXCLUDED.mode, updated_at = now()`,
      [accountId, input.repoId, input.role, input.mode],
    );

    await writeRoleSettingsAuditLog(client, accountId, userId, 'role_settings.mode_changed', {
      repoId: input.repoId,
      role: input.role,
      mode: input.mode,
    });
  });
}
