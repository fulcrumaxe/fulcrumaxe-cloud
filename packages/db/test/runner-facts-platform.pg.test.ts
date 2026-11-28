import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const FN = 'runner_facts_platform_record(text)';

/** D#587 B-7c (migration 1122): the platform a runner reports beside `os`, and the definer that writes it. */
describe('migration 1122: runner_facts.platform and runner_facts_platform_record', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let admin: PoolClient;
  let a: SeedRefs;
  let b: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    admin = await adminPool.connect();
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  async function runner(who: SeedRefs, os: 'linux' | 'macos' = 'linux', facts = true): Promise<string> {
    const id = await insertRunner(admin, who.accountId, who.userId);
    if (facts) await admin.query(`INSERT INTO runner_facts (runner_id, account_id, os, arch, mem_gb_bucket, cpus, sandbox_engine) VALUES ($1, $2, $3, 'x64', 16, 8, 'os_sandbox')`, [id, who.accountId, os]);
    return id;
  }
  const record = (platform: string | null, o: { runnerId?: string | null; accountId?: string } = {}): Promise<boolean> =>
    withTenant(appPool, o.accountId ?? a.accountId, async (c) => {
      if (o.runnerId !== null && o.runnerId !== undefined) await c.query(`SELECT set_config('app.runner_id', $1, true)`, [o.runnerId]);
      return (await c.query<{ ok: boolean }>('SELECT runner_facts_platform_record($1::text) AS ok', [platform])).rows[0]!.ok;
    });
  const stored = async (id: string) => (await admin.query<{ os: string; platform: string | null }>('SELECT os, platform FROM runner_facts WHERE runner_id = $1', [id])).rows[0]!;

  it('keeps the os check as it was and leaves an existing row with no platform (an old runner stays valid)', async () => {
    const r = await runner(a);
    expect(await stored(r)).toEqual({ os: 'linux', platform: null });
    await expect(admin.query(`UPDATE runner_facts SET os = 'wsl2' WHERE runner_id = $1`, [r])).rejects.toMatchObject({ code: '23514' });
    await expect(admin.query(`UPDATE runner_facts SET platform = 'windows' WHERE runner_id = $1`, [r])).rejects.toMatchObject({ code: '23514' });
  });

  it('stores wsl2 and linux for a Linux row, macos for a macOS row, and NULL clears it', async () => {
    const r = await runner(a);
    expect(await record('wsl2', { runnerId: r })).toBe(true);
    expect(await stored(r)).toEqual({ os: 'linux', platform: 'wsl2' });
    expect(await record('linux', { runnerId: r })).toBe(true);
    expect((await stored(r)).platform).toBe('linux');
    expect(await record(null, { runnerId: r })).toBe(true);
    expect((await stored(r)).platform).toBeNull();
    const m = await runner(a, 'macos');
    expect(await record('macos', { runnerId: m })).toBe(true);
    expect(await stored(m)).toEqual({ os: 'macos', platform: 'macos' });
  });

  it('refuses a platform that disagrees with the os (and clears what the row had, so nothing stale shows) and an unknown platform', async () => {
    const lin = await runner(a);
    const mac = await runner(a, 'macos');
    expect(await record('macos', { runnerId: lin })).toBe(false);
    expect(await record('wsl2', { runnerId: mac })).toBe(false);
    expect(await record('linux', { runnerId: mac })).toBe(false);
    expect((await stored(lin)).platform).toBeNull();
    expect((await stored(mac)).platform).toBeNull();
    expect(await record('wsl2', { runnerId: lin })).toBe(true);
    expect(await record('macos', { runnerId: lin })).toBe(false);
    expect((await stored(lin)).platform).toBeNull();
    for (const bad of ['windows', 'WSL2', '', 'wsl1']) await expect(record(bad, { runnerId: lin }), bad).rejects.toMatchObject({ code: '22023' });
  });

  it('touches only the runner the session names', async () => {
    const r = await runner(a);
    const other = await runner(a);
    expect(await record('wsl2', { runnerId: r })).toBe(true);
    expect((await stored(other)).platform).toBeNull();
  });

  it('answers false for a runner with no facts row', async () => {
    const r = await runner(a, 'linux', false);
    expect(await record('wsl2', { runnerId: r })).toBe(false);
    expect((await admin.query('SELECT 1 FROM runner_facts WHERE runner_id = $1', [r])).rowCount).toBe(0);
  });

  it("is refused with no runner in the session, for a revoked runner and for another account's runner", async () => {
    const mine = await runner(a);
    const foreign = await runner(b);
    await expect(record('wsl2')).rejects.toMatchObject({ code: '42501' });
    await expect(record('wsl2', { runnerId: foreign })).rejects.toMatchObject({ code: '42501' });
    expect((await stored(foreign)).platform).toBeNull();
    await admin.query('UPDATE runners SET revoked_at = now() WHERE id = $1', [mine]);
    await expect(record('wsl2', { runnerId: mine })).rejects.toMatchObject({ code: '42501' });
    expect((await stored(mine)).platform).toBeNull();
  });

  it('only the facts definer may write the column; app_user may read it', async () => {
    for (const who of ['app_user', 'platform_ops', 'partner_user', 'agent_run_writer']) {
      expect((await admin.query(`SELECT has_column_privilege($1, 'runner_facts', 'platform', 'UPDATE') AS ok`, [who])).rows[0]!.ok, who).toBe(false);
    }
    expect((await admin.query(`SELECT has_column_privilege('runner_facts_definer', 'runner_facts', 'platform', 'UPDATE') AS ok`)).rows[0]!.ok).toBe(true);
    expect((await admin.query(`SELECT has_column_privilege('app_user', 'runner_facts', 'platform', 'SELECT') AS ok`)).rows[0]!.ok).toBe(true);
  });

  it('is a SECURITY DEFINER with a pinned search_path, owned by the facts role, executable by app_user alone', async () => {
    const { rows } = await admin.query(
      `SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
              coalesce((SELECT array_agg(DISTINCT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee)::text END) FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner), '{}') AS grantees
         FROM pg_proc p WHERE p.oid = $1::regprocedure`,
      [FN],
    );
    expect(rows[0]).toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], owner: 'runner_facts_definer', grantees: ['app_user'] });
    expect((await admin.query(`SELECT has_function_privilege('platform_ops', $1::regprocedure, 'EXECUTE') AS ok`, [FN])).rows[0]!.ok).toBe(false);
    const ops = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    try {
      await expect(ops.query(`SELECT runner_facts_platform_record('wsl2')`)).rejects.toMatchObject({ code: '42501' });
    } finally {
      await ops.end();
    }
  });

  // The hello that declares `platform_fact_v1` is stored through runner_capabilities_record, whose closed list and table CHECK take it (the same two places 1108 widened for twin_v1).
  it('the capability list takes platform_fact_v1 next to everything before it, through the definer and the table check, and still refuses a code it does not know', async () => {
    const r = await runner(a);
    const caps = ['proposal_verifier', 'kvm_fact_v1', 'survey_public_v1', 'twin_v1', 'platform_fact_v1'];
    const call = (list: unknown) =>
      withTenant(appPool, a.accountId, async (c) => {
        await c.query(`SELECT set_config('app.runner_id', $1, true)`, [r]);
        await c.query('SELECT runner_capabilities_record($1::text[])', [list]);
      });
    await call(caps);
    expect((await admin.query('SELECT capabilities FROM runner_capabilities WHERE runner_id = $1', [r])).rows[0]!.capabilities).toEqual(caps);
    await expect(call(['platform_fact_v2'])).rejects.toMatchObject({ code: '22023' });
    await expect(call(['platform_fact_v1', 'platform_fact_v1'])).rejects.toMatchObject({ code: '22023' });
    await expect(admin.query(`UPDATE runner_capabilities SET capabilities = ARRAY['platform_fact']::text[] WHERE runner_id = $1`, [r])).rejects.toMatchObject({ code: '23514' });
    await expect(admin.query(`UPDATE runner_capabilities SET capabilities = ARRAY['platform_fact_v1']::text[] WHERE runner_id = $1`, [r])).resolves.toBeTruthy();
  });
});
