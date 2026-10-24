import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const ROLE = 'runner_capabilities_definer';
const FN = 'runner_capabilities_record(text[])';

/** D#483 S4-b2c (0893): runner_capabilities, its definer, and the privilege line around them (0783's shape). */
describe('migration 0893: runner_capabilities and runner_capabilities_record [pg]', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let admin: PoolClient;
  let a: SeedRefs;
  let b: SeedRefs;
  let runner: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    admin = await adminPool.connect();
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    runner = await insertRunner(admin, a.accountId, a.userId);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  const stored = (id = runner) => admin.query(`SELECT capabilities FROM runner_capabilities WHERE runner_id = $1`, [id]).then((r) => (r.rows[0]?.capabilities as string[] | undefined) ?? null);
  /** The definer, as the web tier's login in a runner's session context (what the runner middleware sets), the way hello calls it. */
  const record = (caps: unknown, o: { runnerId?: string | null; accountId?: string } = {}): Promise<unknown> =>
    withTenant(appPool, o.accountId ?? a.accountId, async (client) => {
      if (o.runnerId !== null) await client.query(`SELECT set_config('app.runner_id', $1, true)`, [o.runnerId ?? runner]);
      await client.query('SELECT runner_capabilities_record($1::text[])', [caps]);
    });

  it('stores the list as sent and REWRITES it on every hello: a later hello with none clears it (a downgraded runner loses it)', async () => {
    await record(['proposal_verifier']);
    expect(await stored()).toEqual(['proposal_verifier']);
    await record([]);
    expect(await stored()).toEqual([]);
    await record(['proposal_verifier']);
    expect(await stored()).toEqual(['proposal_verifier']);
  });

  it('refuses an unknown code, a repeat, a null element, a null list or a nested array (22023), and writes nothing', async () => {
    await record(['proposal_verifier']);
    for (const bad of [['shell'], ['proposal_verifier', 'proposal_verifier'], [null], null, [['proposal_verifier']]]) {
      await expect(record(bad), JSON.stringify(bad)).rejects.toMatchObject({ code: '22023' });
    }
    expect(await stored()).toEqual(['proposal_verifier']);
    // The CHECK holds the same line for a write that does not go through the definer.
    const other = await insertRunner(admin, a.accountId, a.userId);
    await expect(admin.query(`INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, '{shell}')`, [other, a.accountId])).rejects.toMatchObject({ code: '23514' });
  });

  // D#6 RUNNER-WAKE R3a (0895): wake_v1 is the second closed code, through the definer and under the CHECK alike.
  it('0895: stores wake_v1, alone or with proposal_verifier, and still refuses a repeat or a near miss', async () => {
    await record(['wake_v1']);
    expect(await stored()).toEqual(['wake_v1']);
    await record(['proposal_verifier', 'wake_v1']);
    expect(await stored()).toEqual(['proposal_verifier', 'wake_v1']);
    for (const bad of [['wake_v1', 'wake_v1'], ['wake_v2'], ['Wake_v1'], ['wake_v1', 'shell']]) {
      await expect(record(bad), JSON.stringify(bad)).rejects.toMatchObject({ code: '22023' });
    }
    expect(await stored()).toEqual(['proposal_verifier', 'wake_v1']);
    const other = await insertRunner(admin, a.accountId, a.userId);
    await admin.query(`INSERT INTO runner_capabilities (runner_id, account_id, capabilities) VALUES ($1, $2, '{wake_v1,proposal_verifier}')`, [other, a.accountId]);
    await expect(admin.query(`UPDATE runner_capabilities SET capabilities = '{wake_v1,wake_v2}' WHERE runner_id = $1`, [other])).rejects.toMatchObject({ code: '23514' });
    await record(['proposal_verifier']);
  });

  it('names the runner from the session only: none, a malformed one, an unknown one, a revoked one or another account’s is refused (42501)', async () => {
    const before = await stored();
    for (const runnerId of [null, 'not-a-uuid', randomUUID()]) await expect(record(['proposal_verifier'], { runnerId }), String(runnerId)).rejects.toMatchObject({ code: '42501' });
    await expect(record([], { accountId: b.accountId })).rejects.toMatchObject({ code: '42501' });
    const revoked = await insertRunner(admin, a.accountId, a.userId);
    await admin.query(`UPDATE runners SET revoked_at = now() WHERE id = $1`, [revoked]);
    await expect(record(['proposal_verifier'], { runnerId: revoked })).rejects.toMatchObject({ code: '42501' });
    expect(await stored(revoked)).toBeNull();
    expect(await stored()).toEqual(before);
  });

  it('the role is NOLOGIN, unprivileged, has no member, is a member of nothing and owns exactly its function; the function is pinned and EXECUTE is app_user’s alone', async () => {
    const { rows } = await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1`, [ROLE]);
    expect(rows[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
    expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE roleid = $1::regrole OR member = $1::regrole`, [ROLE])).rowCount).toBe(0);
    const owned = await admin.query<{ sig: string }>(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proowner = $1::regrole`, [ROLE]);
    expect(owned.rows.map((r) => r.sig)).toEqual([FN]);
    expect((await admin.query(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS ok`, [ROLE])).rows[0].ok).toBe(false);
    const fn = await admin.query(
      `SELECT p.prosecdef, p.proconfig,
              coalesce((SELECT array_agg(DISTINCT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee)::text END) FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner), '{}') AS grantees
         FROM pg_proc p WHERE p.oid = $1::regprocedure`,
      [FN],
    );
    expect(fn.rows[0]).toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], grantees: ['app_user'] });
  });

  it('platform_ops holds nothing; app_user, partner_user and agent_run_writer cannot write it; row security is forced; runners gains no column', async () => {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      expect((await admin.query(`SELECT has_table_privilege('platform_ops', 'runner_capabilities', $1) AS ok`, [privilege])).rows[0].ok, privilege).toBe(false);
    }
    expect((await admin.query(`SELECT has_function_privilege('platform_ops', $1::regprocedure, 'EXECUTE') AS ok`, [FN])).rows[0].ok).toBe(false);
    for (const who of ['app_user', 'partner_user', 'agent_run_writer']) {
      expect((await admin.query(`SELECT has_any_column_privilege($1, 'runner_capabilities', 'INSERT, UPDATE') AS ok`, [who])).rows[0].ok, who).toBe(false);
      expect((await admin.query(`SELECT has_table_privilege($1, 'runner_capabilities', 'DELETE, TRUNCATE') AS ok`, [who])).rows[0].ok, who).toBe(false);
    }
    expect((await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'runner_capabilities'::regclass`)).rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    expect((await admin.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'runners' AND column_name = 'capabilities'`)).rowCount).toBe(0);
    const ops = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    try {
      await expect(ops.query(`SELECT 1 FROM runner_capabilities`)).rejects.toMatchObject({ code: '42501' });
      await expect(ops.query(`SELECT runner_capabilities_record('{}')`)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await ops.end();
    }
  });

  it("a tenant reads its own rows only; another account's runner row is invisible", async () => {
    await record(['proposal_verifier']);
    const mine = await withTenant(appPool, a.accountId, (c) => c.query(`SELECT runner_id FROM runner_capabilities WHERE runner_id = $1`, [runner]));
    expect(mine.rowCount).toBe(1);
    const theirs = await withTenant(appPool, b.accountId, (c) => c.query(`SELECT runner_id FROM runner_capabilities WHERE runner_id = $1`, [runner]));
    expect(theirs.rowCount).toBe(0);
  });

  it('the row follows its runner when it is deleted', async () => {
    const gone = await insertRunner(admin, a.accountId, a.userId);
    await record(['proposal_verifier'], { runnerId: gone });
    await admin.query(`DELETE FROM runners WHERE id = $1`, [gone]);
    expect(await stored(gone)).toBeNull();
  });
});
