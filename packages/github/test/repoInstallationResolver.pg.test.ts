import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '@fx/db/src/pool.js';
import { createRepoInstallationResolver } from '../src/repoInstallationResolver.js';
import { seedAccountWithRepo } from './helpers/seed.js';

/** D#31 AUTHOR-CHECK-WIRE A9: the repo -> installation resolver against real Postgres. */
describe('createRepoInstallationResolver', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let platformOpsPool: Pool;
  let nextGh = 900_000 + Math.floor(Math.random() * 50_000);

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

  /** A repo on an installation, with the installer record unless `installer` is false. */
  async function fixture(opts: { installer?: boolean | 'deleted' | 'suspended'; kind?: 'team' | 'team_readonly' | 'sitekit' } = {}) {
    const gh = nextGh++;
    const kind = opts.kind ?? 'team';
    const refs = await seedAccountWithRepo(admin, gh, kind);
    const installer = opts.installer ?? true;
    if (installer) {
      await admin.query(
        `INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id, deleted_at, suspended_at)
         VALUES ($1, $2, 1, $3, $4)`,
        [gh, kind, installer === 'deleted' ? new Date() : null, installer === 'suspended' ? new Date() : null],
      );
    }
    return { ...refs, gh, kind };
  }
  const resolve = (repoId: string) => createRepoInstallationResolver(platformOpsPool)(repoId);

  it('a repo on a live installation resolves to its installation id and app kind', async () => {
    const f = await fixture();
    expect(await resolve(f.repoId)).toEqual({ installationId: f.gh, appKind: 'team' });
    const g = await fixture({ kind: 'team_readonly' });
    expect(await resolve(g.repoId)).toEqual({ installationId: g.gh, appKind: 'team_readonly' });
  });

  it('a repo with no installation is null', async () => {
    const f = await fixture();
    await admin.query(`UPDATE repos SET installation_id = NULL WHERE id = $1`, [f.repoId]);
    expect(await resolve(f.repoId)).toBeNull();
  });

  it.each([[false], ['deleted'], ['suspended']] as const)('installer record %s is null', async (installer) => {
    const f = await fixture({ installer });
    expect(await resolve(f.repoId)).toBeNull();
  });

  it('a second installations row (another account) with the same gh_installation_id is null', async () => {
    const f = await fixture();
    const other = randomUUID();
    await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [other, `cus_test_${other}`]);
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team_readonly')`, [randomUUID(), other, f.gh]);
    expect(await resolve(f.repoId)).toBeNull();
  });

  it('an unknown repo id is null', async () => {
    expect(await resolve(randomUUID())).toBeNull();
  });

  it('a database error throws (it is not turned into null)', async () => {
    const dead = createPool(process.env.GITHUB_DATABASE_URL_PLATFORM_OPS!);
    await dead.end();
    await expect(createRepoInstallationResolver(dead)(randomUUID())).rejects.toThrow();
  });
});
