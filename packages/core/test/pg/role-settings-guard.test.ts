import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { NotFoundError, ForbiddenError } from '../../src/tenancy/errors.js';
import { getRepoGuardSettings, setRepoGuardSettings } from '../../src/role-settings/guardSettings.js';
import { InvalidRoleSettingsInputError } from '../../src/role-settings/errors.js';
import type { RoleSettingsCtx } from '../../src/role-settings/types.js';

/**
 * D#2 H12 criterion 5: the two per-repo auto-merge guard toggles. The
 * exact wire shape (`autoMerge`/`blockExternalAutoMerge` on
 * `repos.settings`) is what `packages/trust/src/work-gate.ts`'s
 * `autoMergeAllowed` already expects to be fed.
 */
describe('role-settings: repo guard toggles (criterion 5)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let refs: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    refs = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  function ownerCtx(): RoleSettingsCtx {
    return { pool: appUserPool, principal: { accountId: refs.accountId, userId: refs.userId } };
  }

  it('defaults: autoMerge off, blockExternalAutoMerge on', async () => {
    const settings = await getRepoGuardSettings(ownerCtx(), refs.repoId);
    expect(settings).toEqual({ autoMerge: false, blockExternalAutoMerge: true });
  });

  it('a nonexistent repo gets NotFoundError', async () => {
    await expect(getRepoGuardSettings(ownerCtx(), randomUUID())).rejects.toThrow(NotFoundError);
  });

  it('an owner can turn autoMerge on; the change persists and writes an audit_log row', async () => {
    const before = await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1', [
      refs.accountId,
    ]);
    const result = await setRepoGuardSettings(ownerCtx(), refs.repoId, { autoMerge: true });
    expect(result).toEqual({ autoMerge: true, blockExternalAutoMerge: true });

    const readBack = await getRepoGuardSettings(ownerCtx(), refs.repoId);
    expect(readBack).toEqual({ autoMerge: true, blockExternalAutoMerge: true });

    const after = await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1', [
      refs.accountId,
    ]);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n + 1);
  });

  it('turning blockExternalAutoMerge off WITHOUT confirmed is rejected, and nothing is written', async () => {
    await expect(
      setRepoGuardSettings(ownerCtx(), refs.repoId, { blockExternalAutoMerge: false }),
    ).rejects.toThrow(InvalidRoleSettingsInputError);

    const settings = await getRepoGuardSettings(ownerCtx(), refs.repoId);
    expect(settings.blockExternalAutoMerge).toBe(true);
  });

  // Security review (PR #89, must-fix, CWE-1287/20): a non-boolean `confirmed`
  // must NOT satisfy the guard-off confirmation. `!input.confirmed` used to
  // accept any of these as truthy; only `confirmed: true` may pass.
  it.each<{ label: string; confirmed: unknown }>([
    { label: 'the string "false"', confirmed: 'false' },
    { label: 'the string "true"', confirmed: 'true' },
    { label: 'the number 1', confirmed: 1 },
    { label: 'an empty object', confirmed: {} },
  ])('confirmed: $label is REFUSED for turning blockExternalAutoMerge off, and nothing is written', async ({ confirmed }) => {
    const beforeAudit = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1',
      [refs.accountId],
    );

    await expect(
      setRepoGuardSettings(ownerCtx(), refs.repoId, {
        blockExternalAutoMerge: false,
        confirmed: confirmed as never,
      }),
    ).rejects.toThrow(InvalidRoleSettingsInputError);

    const settings = await getRepoGuardSettings(ownerCtx(), refs.repoId);
    expect(settings.blockExternalAutoMerge).toBe(true);

    const afterAudit = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1',
      [refs.accountId],
    );
    expect(afterAudit.rows[0]!.n).toBe(beforeAudit.rows[0]!.n);
  });

  it('turning blockExternalAutoMerge off WITH confirmed: true succeeds and writes an audit_log row', async () => {
    const before = await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1', [
      refs.accountId,
    ]);
    const result = await setRepoGuardSettings(ownerCtx(), refs.repoId, {
      blockExternalAutoMerge: false,
      confirmed: true,
    });
    expect(result.blockExternalAutoMerge).toBe(false);

    const after = await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1', [
      refs.accountId,
    ]);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n + 1);

    const { rows } = await admin.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [refs.accountId],
    );
    expect(rows[0]!.action).toBe('role_settings.guard_changed');
  });

  it('a non-admin (member) gets ForbiddenError', async () => {
    const memberUserId = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
      memberUserId,
      `guard-member-${memberUserId}@example.test`,
    ]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [
      refs.accountId,
      memberUserId,
    ]);
    const memberCtx: RoleSettingsCtx = {
      pool: appUserPool,
      principal: { accountId: refs.accountId, userId: memberUserId },
    };
    await expect(setRepoGuardSettings(memberCtx, refs.repoId, { autoMerge: false })).rejects.toThrow(
      ForbiddenError,
    );
  });

  it('an empty input (neither field set) is rejected', async () => {
    await expect(setRepoGuardSettings(ownerCtx(), refs.repoId, {})).rejects.toThrow(InvalidRoleSettingsInputError);
  });

  // Security review (PR #89, should-fix, CWE-20): a non-boolean autoMerge or
  // blockExternalAutoMerge value must be rejected with a typed input error
  // before the transaction opens, rather than stored as-is.
  it.each<{ toggle: 'autoMerge' | 'blockExternalAutoMerge'; value: unknown }>([
    { toggle: 'autoMerge', value: 'true' },
    { toggle: 'autoMerge', value: 1 },
    { toggle: 'autoMerge', value: 0 },
    { toggle: 'autoMerge', value: 'false' },
    { toggle: 'blockExternalAutoMerge', value: 'true' },
    { toggle: 'blockExternalAutoMerge', value: 1 },
    { toggle: 'blockExternalAutoMerge', value: 0 },
    { toggle: 'blockExternalAutoMerge', value: 'false' },
  ])('a non-boolean $toggle value ($value) is refused, and nothing is written', async ({ toggle, value }) => {
    const before = await getRepoGuardSettings(ownerCtx(), refs.repoId);
    const beforeAudit = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1',
      [refs.accountId],
    );

    await expect(
      setRepoGuardSettings(ownerCtx(), refs.repoId, { [toggle]: value } as never),
    ).rejects.toThrow(InvalidRoleSettingsInputError);

    const after = await getRepoGuardSettings(ownerCtx(), refs.repoId);
    expect(after).toEqual(before);

    const afterAudit = await admin.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit_log WHERE account_id = $1',
      [refs.accountId],
    );
    expect(afterAudit.rows[0]!.n).toBe(beforeAudit.rows[0]!.n);
  });
});
