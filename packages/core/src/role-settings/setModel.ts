import { getRoleEntry } from '@fx/roles';
import { withTenant } from '../tenancy/withTenant.js';
import { assertActiveMembership } from '../tenancy/scopedAccess.js';
import { requireOwnerOrAdmin, type MembershipRole } from '../tenancy/authorize.js';
import { assertRepoExists } from './internal.js';
import { writeRoleSettingsAuditLog } from './auditLog.js';
import { InvalidRoleSettingsInputError } from './errors.js';
import { ROLE_MODEL_IDS, type RoleModelId, type RoleSettingsCtx } from './types.js';

export interface SetRoleModelInput {
  repoId: string;
  role: string;
  /** A model id, or null to clear the override. */
  model: RoleModelId | null;
}

/**
 * D#31 API-8b: sets or clears one role's model override on a repo and
 * writes one `role_settings.model_changed` audit row, in one transaction.
 *
 * The H22 floor is NOT checked here (core cannot import @fx/model-router);
 * the API route applies it before calling. Two backstops sit behind it:
 * this function refuses an id outside `ROLE_MODEL_IDS`, and migration 0645's
 * CHECK constraints refuse a below-floor or unknown model at the database.
 *
 * A missing row is created as `off` (never the manifest default -- presence
 * carries the meaning since H08-followup), so setting only a model cannot
 * switch a role on.
 *
 * Race safety: the row is created first if missing (DO NOTHING), then read
 * FOR UPDATE, so two concurrent writers serialise and each audit row's
 * `before` is the value the other one left.
 */
export async function setRoleModel(ctx: RoleSettingsCtx, input: SetRoleModelInput): Promise<void> {
  const manifestEntry = getRoleEntry(input.role);
  if (manifestEntry === undefined) {
    throw new InvalidRoleSettingsInputError(`unknown role: ${input.role}`, 'role');
  }
  if (input.model !== null && !(ROLE_MODEL_IDS as readonly unknown[]).includes(input.model)) {
    throw new InvalidRoleSettingsInputError(
      `model must be one of ${ROLE_MODEL_IDS.join(', ')} or null`,
      'model',
    );
  }

  const { accountId, userId } = ctx.principal;
  await withTenant(ctx.pool, accountId, userId, async (client) => {
    await assertActiveMembership(client, accountId, userId);

    // Same order as setRoleMode: membership, role check, repo existence.
    const { rows: memberRows } = await client.query<{ role: MembershipRole }>(
      'SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2',
      [accountId, userId],
    );
    requireOwnerOrAdmin(memberRows[0]?.role ?? null);

    await assertRepoExists(client, input.repoId);

    await client.query(
      `INSERT INTO role_settings (account_id, repo_id, role, mode)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (repo_id, role) DO NOTHING`,
      [accountId, input.repoId, input.role, 'off'],
    );
    const { rows } = await client.query<{ model: string | null }>(
      'SELECT model FROM role_settings WHERE repo_id = $1 AND role = $2 FOR UPDATE',
      [input.repoId, input.role],
    );
    const before = rows[0]?.model ?? null;

    await client.query(
      'UPDATE role_settings SET model = $3, updated_at = now() WHERE repo_id = $1 AND role = $2',
      [input.repoId, input.role, input.model],
    );

    await writeRoleSettingsAuditLog(client, accountId, userId, 'role_settings.model_changed', {
      repoId: input.repoId,
      role: input.role,
      before,
      after: input.model,
    });
  });
}
