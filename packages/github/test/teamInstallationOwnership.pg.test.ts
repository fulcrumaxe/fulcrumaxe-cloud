import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '@fx/db/src/pool.js';
import { createTeamInstallationOwnership } from '../src/teamInstallationOwnership.js';
import { seedAccountWithRepo } from './helpers/seed.js';

/** D#598 PAIR-INSTALL-CHECK: an installation id counts only when it is the caller's own live write-App installation, against real Postgres. */
describe('createTeamInstallationOwnership', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let platformOpsPool: Pool;
  let nextGh = 700_000 + Math.floor(Math.random() * 50_000);

  beforeAll(async () => {
    adminPool = createPool(process.env.GITHUB_DATABASE_URL!);
    platformOpsPool = createPool(process.env.GITHUB_DATABASE_URL_PLATFORM_OPS!);
    admin = await adminPool.connect();
  });
  afterAll(async () => {
    admin.release();
    await platformOpsPool.end();
    await adminPool.end();
  });

  async function fixture(opts: { installer?: boolean | 'deleted' | 'suspended'; kind?: 'team' | 'team_readonly' } = {}) {
    const gh = nextGh++;
    const kind = opts.kind ?? 'team';
    const refs = await seedAccountWithRepo(admin, gh, kind);
    const installer = opts.installer ?? true;
    if (installer) {
      await admin.query(
        `INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id, deleted_at, suspended_at) VALUES ($1, $2, 1, $3, $4)`,
        [gh, kind, installer === 'deleted' ? new Date() : null, installer === 'suspended' ? new Date() : null],
      );
    }
    return { ...refs, gh };
  }
  const owns = (accountId: string, gh: number) => createTeamInstallationOwnership(platformOpsPool)(accountId, gh);

  it("is true for the account's own live team installation", async () => {
    const f = await fixture();
    expect(await owns(f.accountId, f.gh)).toBe(true);
  });

  it("is false for another account's installation id, even though it exists", async () => {
    const f = await fixture();
    const other = await fixture();
    expect(await owns(other.accountId, f.gh)).toBe(false);
    expect(await owns(randomUUID(), f.gh)).toBe(false);
  });

  it.each([[false], ['deleted'], ['suspended']] as const)('is false when the installer record is %s', async (installer) => {
    const f = await fixture({ installer });
    expect(await owns(f.accountId, f.gh)).toBe(false);
  });

  it('is false for a read-only installation, an unknown id and a malformed account id', async () => {
    const ro = await fixture({ kind: 'team_readonly' });
    expect(await owns(ro.accountId, ro.gh)).toBe(false);
    expect(await owns(ro.accountId, 1)).toBe(false);
    expect(await owns(ro.accountId, 0)).toBe(false);
    expect(await owns("x'; --", ro.gh)).toBe(false);
  });
});
