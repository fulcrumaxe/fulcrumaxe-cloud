import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '@fx/db/src/pool.js';
import { nextGhInstallationId, seedAccount } from '@fx/db/test/helpers/seed.js';
import { createTeamInstallationOwnership } from '../src/tenancy/installationOwnership.js';

/**
 * The ownership check in front of every public-repo token mint and every "App installed" answer, against real Postgres: an installation id counts only when
 * it is the asking account's own `team` installation with a live installer record. (Its use in front of the hosted push is tested in the github package.)
 */
describe('team installation ownership', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let opsPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    admin = await adminPool.connect();
  });
  afterAll(async () => {
    admin.release();
    await opsPool.end();
    await adminPool.end();
  });

  async function account(opts: { installer?: 'live' | 'deleted' | 'suspended' | 'none'; kind?: 'team' | 'team_readonly' } = {}) {
    const refs = await seedAccount(admin, randomUUID());
    const gh = Number(nextGhInstallationId());
    const kind = opts.kind ?? 'team';
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, $4)`, [randomUUID(), refs.accountId, gh, kind]);
    const installer = opts.installer ?? 'live';
    if (installer !== 'none') {
      await admin.query(`INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id, deleted_at, suspended_at) VALUES ($1, $2, 1, $3, $4)`, [
        gh, kind, installer === 'deleted' ? new Date() : null, installer === 'suspended' ? new Date() : null,
      ]);
    }
    return { accountId: refs.accountId, gh };
  }
  const owns = (accountId: string, gh: number) => createTeamInstallationOwnership(opsPool)(accountId, gh);

  it("is true for the account's own live team installation, and for no other account", async () => {
    const a = await account();
    const b = await account();
    expect(await owns(a.accountId, a.gh)).toBe(true);
    expect(await owns(b.accountId, a.gh)).toBe(false);
    expect(await owns(a.accountId, b.gh)).toBe(false);
    expect(await owns(randomUUID(), a.gh)).toBe(false);
  });

  it.each(['deleted', 'suspended', 'none'] as const)('is false when the installer record is %s', async (installer) => {
    const a = await account({ installer });
    expect(await owns(a.accountId, a.gh)).toBe(false);
  });

  it('is false for an installation of another App kind, for ids that are not installations, and for a malformed account id', async () => {
    const ro = await account({ kind: 'team_readonly' });
    expect(await owns(ro.accountId, ro.gh)).toBe(false);
    const a = await account();
    for (const id of [0, -1, 1.5, Number.NaN, 2 ** 53, 1]) expect(await owns(a.accountId, id)).toBe(false);
    for (const bad of ["x'; --", '', 'not-a-uuid']) expect(await owns(bad, a.gh)).toBe(false);
    expect(await owns(undefined as unknown as string, a.gh)).toBe(false);
  });
});
