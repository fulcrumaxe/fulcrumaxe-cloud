import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/** ONBOARDING-STATE (0699): onboarding_live_readonly_installations(), the tenant's only view of the installer flags. */
describe('onboarding_live_readonly_installations (0699)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
  });

  async function install(r: SeedRefs, kind: string, flags: { deleted?: boolean; suspended?: boolean; record?: boolean } = {}) {
    const id = randomUUID();
    const gh = randomInt(1, 2_000_000_000);
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, $4)`, [id, r.accountId, gh, kind]);
    if (flags.record !== false) {
      await admin.query(
        `INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id, deleted_at, suspended_at)
         VALUES ($1, $2, 1, ${flags.deleted ? 'now()' : 'NULL'}, ${flags.suspended ? 'now()' : 'NULL'})`,
        [gh, kind],
      );
    }
    return id;
  }
  const live = (r: SeedRefs) =>
    withTenant(appPool, r.accountId, async (c) =>
      (await c.query(`SELECT installation_id FROM onboarding_live_readonly_installations()`)).rows.map((x) => x.installation_id as string),
    );

  it('returns the calling account\'s live read-only installations and nothing else', async () => {
    const a = await seedAccount(admin, randomUUID());
    const b = await seedAccount(admin, randomUUID());
    const ok = await install(a, 'team_readonly');
    await install(a, 'team_readonly', { deleted: true });
    await install(a, 'team_readonly', { suspended: true });
    await install(a, 'team_readonly', { record: false });
    await install(a, 'team');
    await install(a, 'sitekit');
    const theirs = await install(b, 'team_readonly');
    expect(await live(a)).toEqual([ok]);
    expect(await live(b)).toEqual([theirs]);
  });

  it('follows the flags both ways', async () => {
    const a = await seedAccount(admin, randomUUID());
    const id = await install(a, 'team_readonly');
    const flag = (sql: string) =>
      admin.query(
        `UPDATE installation_installers ii SET ${sql} FROM installations i WHERE i.id = $1 AND ii.gh_installation_id = i.gh_installation_id AND ii.app_kind = i.app_kind`,
        [id],
      );
    expect(await live(a)).toEqual([id]);
    await flag('suspended_at = now()');
    expect(await live(a)).toEqual([]);
    await flag('suspended_at = NULL');
    expect(await live(a)).toEqual([id]);
    await flag('deleted_at = now()');
    expect(await live(a)).toEqual([]);
  });

  it('without an account context it returns nothing, and it takes no argument that could name another account', async () => {
    const a = await seedAccount(admin, randomUUID());
    await install(a, 'team_readonly');
    const c = await appPool.connect();
    try {
      expect((await c.query(`SELECT * FROM onboarding_live_readonly_installations()`)).rows).toEqual([]);
    } finally {
      c.release();
    }
    const def = (await admin.query(
      `SELECT pronargs, prosecdef, pg_get_userbyid(proowner) AS owner, proconfig FROM pg_proc WHERE proname = 'onboarding_live_readonly_installations'`,
    )).rows[0];
    expect(def).toMatchObject({ pronargs: 0, prosecdef: true, owner: 'platform_ops' });
    expect(def.proconfig.join(' ')).toContain('search_path=pg_catalog, public, pg_temp');
  });

  it('app_user still cannot read the installer table itself, and PUBLIC cannot run the function', async () => {
    const a = await seedAccount(admin, randomUUID());
    await expect(withTenant(appPool, a.accountId, (c) => c.query(`SELECT * FROM installation_installers`))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    const acl = (await admin.query(`SELECT proacl::text AS acl FROM pg_proc WHERE proname = 'onboarding_live_readonly_installations'`)).rows[0].acl as string;
    expect(acl).toContain('app_user=X/');
    expect(acl).not.toMatch(/(^\{|,)=X\//);
  });
});
