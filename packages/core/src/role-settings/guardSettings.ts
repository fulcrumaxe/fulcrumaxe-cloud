import { withTenant } from '../tenancy/withTenant.js';
import { assertActiveMembership } from '../tenancy/scopedAccess.js';
import { requireOwnerOrAdmin, type MembershipRole } from '../tenancy/authorize.js';
import { getRepoSettingsOrNotFound } from './internal.js';
import { writeRoleSettingsAuditLog } from './auditLog.js';
import { HumanMergeOnlyError, InvalidRoleSettingsInputError, NotFoundError } from './errors.js';
import { humanMergeOnly } from '@fx/db/src/humanMergeOnly.js';
import type { PoolClient } from 'pg';
import type { RepoGuardSettings, RoleSettingsCtx } from './types.js';

/**
 * H12 criterion 5's defaults (autoMerge off, blockExternalAutoMerge on),
 * read exactly the way `packages/trust/src/work-gate.ts`'s
 * `autoMergeAllowed` expects to be fed (its `RepoAutoMergeSettings`):
 * `autoMerge` is only ever `true` when the stored value is exactly
 * `true`; `blockExternalAutoMerge` is only ever `false` (guard off) when
 * the stored value is exactly `false`. Any other stored shape -- absent,
 * `null`, a stray string -- reads back as these fail-closed defaults,
 * matching that module's own fail-closed comparisons.
 */
function readGuardSettings(raw: Record<string, unknown>): RepoGuardSettings {
  return {
    autoMerge: raw.autoMerge === true,
    blockExternalAutoMerge: raw.blockExternalAutoMerge !== false,
  };
}

/** H12 criterion 5's read side (no page: WS-F4 and D#31 API-8 call this). */
export async function getRepoGuardSettings(ctx: RoleSettingsCtx, repoId: string): Promise<RepoGuardSettings> {
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    await assertActiveMembership(client, accountId, userId);
    const raw = await getRepoSettingsOrNotFound(client, repoId);
    return readGuardSettings(raw);
  });
}

/**
 * D#6 M1G-a: whether the operator locked this repository to human merges. Read from the environment on this call (see
 * `humanMergeOnly`); a missing or other-tenant repo is a NotFoundError like every other read here.
 */
export async function isRepoHumanMergeOnly(ctx: RoleSettingsCtx, repoId: string): Promise<boolean> {
  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    await assertActiveMembership(client, accountId, userId);
    return humanMergeOnly(await getRepoGhId(client, repoId));
  });
}

async function getRepoGhId(client: PoolClient, repoId: string): Promise<string> {
  const { rows } = await client.query<{ gh_repo_id: string }>('SELECT gh_repo_id FROM repos WHERE id = $1', [repoId]);
  if (rows[0] === undefined) throw new NotFoundError(`repos ${repoId} not found`);
  return rows[0].gh_repo_id;
}

export interface SetRepoGuardSettingsInput {
  autoMerge?: boolean;
  blockExternalAutoMerge?: boolean;
  /**
   * H12 criterion 5: "Switching the guard off shows a plain warning ...
   * and requires confirmation." The warning/dialog is WS-F4's (no page
   * here); this is the service-level half of "requires confirmation" --
   * a call that would turn `blockExternalAutoMerge` off without this set
   * is rejected before anything is written.
   */
  confirmed?: boolean;
}

/**
 * H12 criterion 5: "Two per-repo toggles ... Both changes write
 * `audit_log` rows (test)." `requireOwnerOrAdmin` gates the mutation
 * (sec-criteria A7), same as `setRoleMode`. Returns the merged,
 * defaults-applied view after the write.
 */
export async function setRepoGuardSettings(
  ctx: RoleSettingsCtx,
  repoId: string,
  input: SetRepoGuardSettingsInput,
): Promise<RepoGuardSettings> {
  if (input.autoMerge === undefined && input.blockExternalAutoMerge === undefined) {
    throw new InvalidRoleSettingsInputError('setRepoGuardSettings: at least one of autoMerge/blockExternalAutoMerge is required', 'auto_merge');
  }
  // Security review (PR #89, needs-fix #2, CWE-20): reject a non-boolean
  // toggle value before the transaction opens, rather than storing it
  // as-is. Both `readGuardSettings` and `autoMergeAllowed` already fail
  // closed on a stray string/number, but a stored non-boolean leaves the
  // audit row's `after` disagreeing with the effective setting, and
  // `repos.settings` holding junk a looser future reader could misread.
  if (input.autoMerge !== undefined && typeof input.autoMerge !== 'boolean') {
    throw new InvalidRoleSettingsInputError('setRepoGuardSettings: autoMerge must be a boolean', 'auto_merge');
  }
  if (input.blockExternalAutoMerge !== undefined && typeof input.blockExternalAutoMerge !== 'boolean') {
    throw new InvalidRoleSettingsInputError('setRepoGuardSettings: blockExternalAutoMerge must be a boolean', 'block_external_auto_merge');
  }
  // Security review (PR #89, must-fix #1, CWE-1287/20): `confirmed` must be
  // exactly `true`. The prior `!input.confirmed` check let any merely
  // truthy value ("false", "true", 1, {}) stand in for confirmation,
  // fail-opening the one guard that stops a stranger's PR from
  // auto-merging unattended.
  if (input.blockExternalAutoMerge === false && input.confirmed !== true) {
    throw new InvalidRoleSettingsInputError(
      'turning off blockExternalAutoMerge requires confirmed: true (the caller must show the warning first)',
      'acknowledge_external_risk',
    );
  }

  const { accountId, userId } = ctx.principal;
  return withTenant(ctx.pool, accountId, userId, async (client) => {
    await assertActiveMembership(client, accountId, userId);

    const { rows } = await client.query<{ role: MembershipRole }>(
      'SELECT role FROM account_members WHERE account_id = $1 AND user_id = $2',
      [accountId, userId],
    );
    requireOwnerOrAdmin(rows[0]?.role ?? null);

    const rawBefore = await getRepoSettingsOrNotFound(client, repoId);
    // D#6 M1G-a: the operator's lock. Turning auto-merge on is refused before anything is written (no row change, no audit
    // row); turning it off is always allowed.
    if (input.autoMerge === true && humanMergeOnly(await getRepoGhId(client, repoId))) throw new HumanMergeOnlyError();
    const before = readGuardSettings(rawBefore);
    const after: RepoGuardSettings = {
      autoMerge: input.autoMerge ?? before.autoMerge,
      blockExternalAutoMerge: input.blockExternalAutoMerge ?? before.blockExternalAutoMerge,
    };

    await client.query(
      `UPDATE repos
          SET settings = settings || $2::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [repoId, JSON.stringify(after)],
    );

    await writeRoleSettingsAuditLog(client, accountId, userId, 'role_settings.guard_changed', {
      repoId,
      before,
      after,
    });

    return after;
  });
}
