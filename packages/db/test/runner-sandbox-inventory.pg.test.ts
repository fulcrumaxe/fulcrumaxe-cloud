import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const REC = 'runner_sandboxes_record(jsonb)';
const FACTS = 'runner_sandbox_facts_record(integer,integer,integer,text[])';
const TABLES = ['runner_sandboxes', 'runner_sandbox_reports'];
const row = (name: string, over: Record<string, unknown> = {}) => ({ name, state: 'stopped', created_at: '2026-11-01T10:00:00Z', last_used_at: null, disk_bytes: 10, snapshot_count: 0, snapshot_age_s: null, ...over });

/** D#587 B-7a (migration 1040): the inventory tables, the host-limit columns, their definers, RLS and the privilege line around them. */
describe('migration 1040: runner_sandboxes, runner_sandbox_reports and the host limits', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let admin: PoolClient;
  let a: SeedRefs;
  let b: SeedRefs;
  let ra: string; // protocol 21
  let ra2: string; // a second runner of account A
  let rb: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    admin = await adminPool.connect();
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    ra = await insertRunner(admin, a.accountId, a.userId);
    ra2 = await insertRunner(admin, a.accountId, a.userId);
    rb = await insertRunner(admin, b.accountId, b.userId);
    for (const id of [ra, ra2, rb]) await admin.query('UPDATE runners SET protocol_version = 21 WHERE id = $1', [id]);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  const record = (rows: unknown, o: { runnerId?: string | null; accountId?: string } = {}): Promise<unknown> =>
    withTenant(appPool, o.accountId ?? a.accountId, async (client) => {
      if (o.runnerId !== null) await client.query(`SELECT set_config('app.runner_id', $1, true)`, [o.runnerId ?? ra]);
      await client.query('SELECT runner_sandboxes_record($1::jsonb)', [JSON.stringify(rows)]);
    });
  const limits = (args: [number | null, number | null, number | null, string[] | null], o: { runnerId?: string; accountId?: string } = {}): Promise<unknown> =>
    withTenant(appPool, o.accountId ?? a.accountId, async (client) => {
      await client.query(`SELECT set_config('app.runner_id', $1, true)`, [o.runnerId ?? ra]);
      await client.query('SELECT runner_sandbox_facts_record($1::int, $2::int, $3::int, $4::text[])', args);
    });
  const names = (id: string) => admin.query<{ name: string }>('SELECT name FROM runner_sandboxes WHERE runner_id = $1 ORDER BY slot', [id]).then((r) => r.rows.map((x) => x.name));
  const withFacts = async (id: string, accountId: string) =>
    admin.query(`INSERT INTO runner_facts (runner_id, account_id, os, arch, mem_gb_bucket, cpus, sandbox_engine) VALUES ($1, $2, 'linux', 'x64', 16, 8, 'microvm') ON CONFLICT DO NOTHING`, [id, accountId]);

  describe('privileges', () => {
    it('the facts role owns the two entry points, has no member, is a member of nothing and cannot create objects', async () => {
      const owned = await admin.query<{ sig: string }>(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proowner = 'runner_facts_definer'::regrole`);
      expect(owned.rows.map((r) => r.sig)).toEqual(expect.arrayContaining([REC, FACTS]));
      expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE roleid = 'runner_facts_definer'::regrole OR member = 'runner_facts_definer'::regrole`)).rowCount).toBe(0);
      expect((await admin.query(`SELECT has_schema_privilege('runner_facts_definer', 'public', 'CREATE') AS ok`)).rows[0].ok).toBe(false);
    });

    it('platform_ops holds no privilege on either table, any column, or any of the functions', async () => {
      for (const table of TABLES) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
          expect((await admin.query(`SELECT has_table_privilege('platform_ops', $1, $2) AS ok`, [table, privilege])).rows[0].ok, `${table} ${privilege}`).toBe(false);
        }
        expect((await admin.query(`SELECT has_any_column_privilege('platform_ops', $1, 'SELECT, INSERT, UPDATE, REFERENCES') AS ok`, [table])).rows[0].ok, table).toBe(false);
      }
      expect((await admin.query(`SELECT has_column_privilege('platform_ops', 'runner_facts', c, 'SELECT') AS ok FROM unnest(ARRAY['max_vms', 'max_vcpus', 'max_memory_mb', 'bootable_templates']) c`)).rows.every((r) => r.ok === false)).toBe(true);
      for (const fn of [REC, FACTS, 'runner_templates_valid(text[])']) {
        expect((await admin.query(`SELECT has_function_privilege('platform_ops', $1::regprocedure, 'EXECUTE') AS ok`, [fn])).rows[0].ok, fn).toBe(false);
      }
    });

    it('app_user, partner_user and agent_run_writer cannot write either table; both force row security', async () => {
      for (const table of TABLES) {
        for (const who of ['app_user', 'partner_user', 'agent_run_writer']) {
          expect((await admin.query(`SELECT has_any_column_privilege($1, $2, 'INSERT, UPDATE') AS ok`, [who, table])).rows[0].ok, `${who} ${table}`).toBe(false);
          expect((await admin.query(`SELECT has_table_privilege($1, $2, 'DELETE, TRUNCATE') AS ok`, [who, table])).rows[0].ok, `${who} ${table}`).toBe(false);
        }
        expect((await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`, [table])).rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      }
      expect((await admin.query(`SELECT has_table_privilege('runner_facts_definer', 'runner_sandbox_reports', 'DELETE') AS ok`)).rows[0].ok).toBe(false);
      expect((await admin.query(`SELECT has_column_privilege('app_user', 'runner_facts', c, 'UPDATE') AS ok FROM unnest(ARRAY['max_vms', 'max_vcpus', 'max_memory_mb', 'bootable_templates']) c`)).rows.every((r) => r.ok === false)).toBe(true);
    });

    it('each new function is SECURITY DEFINER with a pinned search_path and not executable by PUBLIC; app_user may call the two entry points only', async () => {
      for (const [fn, grantees] of [[REC, ['app_user']], [FACTS, ['app_user']]] as const) {
        const { rows } = await admin.query(
          `SELECT p.prosecdef, p.proconfig,
                  coalesce((SELECT array_agg(DISTINCT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee)::text END) FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner), '{}') AS grantees
             FROM pg_proc p WHERE p.oid = $1::regprocedure`,
          [fn],
        );
        expect(rows[0], fn).toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], grantees });
      }
    });

    it('a direct platform_ops login reads and calls nothing', async () => {
      const ops = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
      try {
        for (const table of TABLES) await expect(ops.query(`SELECT 1 FROM ${table}`), table).rejects.toMatchObject({ code: '42501' });
        await expect(ops.query(`SELECT runner_sandboxes_record('[]'::jsonb)`)).rejects.toMatchObject({ code: '42501' });
        await expect(ops.query(`SELECT runner_sandbox_facts_record(1, 1, 1, '{}'::text[])`)).rejects.toMatchObject({ code: '42501' });
      } finally {
        await ops.end();
      }
    });
  });

  describe('runner_sandboxes_record', () => {
    it('replaces the whole list, stamps the report, and numbers the slots in order', async () => {
      await record([row('a'), row('b', { state: 'running', last_used_at: '2026-11-02T10:00:00Z', snapshot_age_s: 5 })]);
      expect(await names(ra)).toEqual(['a', 'b']);
      expect((await admin.query('SELECT row_count FROM runner_sandbox_reports WHERE runner_id = $1', [ra])).rows[0].row_count).toBe(2);
      await record([row('c')]);
      expect(await names(ra)).toEqual(['c']);
      await record([]);
      expect(await names(ra)).toEqual([]);
      expect((await admin.query('SELECT row_count FROM runner_sandbox_reports WHERE runner_id = $1', [ra])).rows[0].row_count).toBe(0);
    });

    it('raises insufficient_privilege and writes nothing without app.runner_id, with a malformed or unknown one, for a revoked runner and for another account', async () => {
      await record([row('keep')]);
      await expect(record([row('x')], { runnerId: null })).rejects.toMatchObject({ code: '42501' });
      await expect(record([row('x')], { runnerId: 'not-a-uuid' })).rejects.toMatchObject({ code: '42501' });
      await expect(record([row('x')], { runnerId: randomUUID() })).rejects.toMatchObject({ code: '42501' });
      await expect(record([row('x')], { runnerId: rb })).rejects.toMatchObject({ code: '42501' });
      const gone = await insertRunner(admin, a.accountId, a.userId);
      await admin.query('UPDATE runners SET protocol_version = 21, revoked_at = now() WHERE id = $1', [gone]);
      await expect(record([row('x')], { runnerId: gone })).rejects.toMatchObject({ code: '42501' });
      expect(await names(gone)).toEqual([]);
      expect(await names(ra)).toEqual(['keep']);
    });

    it('refuses a runner whose hello declared a protocol below 21 (22023)', async () => {
      const old = await insertRunner(admin, a.accountId, a.userId);
      await admin.query('UPDATE runners SET protocol_version = 20 WHERE id = $1', [old]);
      await expect(record([row('x')], { runnerId: old })).rejects.toMatchObject({ code: '22023' });
      expect(await names(old)).toEqual([]);
    });

    it('refuses what the schema refuses, as 22023, and leaves the old list in place', async () => {
      await record([row('keep')]);
      const { name: _n, ...noName } = row('x');
      const bad: unknown[] = [
        { not: 'an array' },
        Array.from({ length: 201 }, (_v, i) => row(`s${i}`)),
        [{ ...row('x'), log: 'tail' }],
        [noName],
        // An unknown key in place of a required one: the count of keys is still seven, so only the key-set check refuses it.
        [(({ snapshot_age_s: _a, ...rest }) => ({ ...rest, snapshot_note: null }))(row('x'))],
        [row('Upper')], [row('-x')], [row('a_b')], [row('a'.repeat(41))], [row('')],
        [row('x', { state: 'paused' })],
        [row('x', { created_at: 'yesterday' })], [row('x', { created_at: '2026-11-01T10:00:00+02:00' })], [row('x', { last_used_at: 5 })],
        [row('x', { disk_bytes: -1 })], [row('x', { disk_bytes: 1.5 })], [row('x', { disk_bytes: '5' })], [row('x', { disk_bytes: 1e16 })],
        [row('x', { snapshot_count: 10001 })], [row('x', { snapshot_age_s: 2147483648 })],
        [row('x'), row('x')],
        ['text'],
      ];
      for (const rows of bad) await expect(record(rows), JSON.stringify(rows).slice(0, 70)).rejects.toMatchObject({ code: '22023' });
      expect(await names(ra)).toEqual(['keep']);
    });

    it('accepts exactly 200 rows, and the primary key keeps a 201st out whoever writes it', async () => {
      await record(Array.from({ length: 200 }, (_v, i) => row(`s${i}`)));
      expect((await names(ra)).length).toBe(200);
      await expect(admin.query(`INSERT INTO runner_sandboxes (runner_id, slot, account_id, name, state, created_at, disk_bytes, snapshot_count) VALUES ($1, 200, $2, 'extra', 'stopped', now(), 0, 0)`, [ra, a.accountId])).rejects.toMatchObject({ code: '23514' });
      await record([]);
    });

    it('a second row in the same slot is refused (23505), and an out-of-range date is 22008 through the definer', async () => {
      const ins = (slot: number, name: string) =>
        admin.query(`INSERT INTO runner_sandboxes (runner_id, slot, account_id, name, state, created_at, disk_bytes, snapshot_count) VALUES ($1, $2, $3, $4, 'stopped', now(), 0, 0)`, [ra2, slot, a.accountId, name]);
      await ins(0, 'slot-a');
      await expect(ins(0, 'slot-b')).rejects.toMatchObject({ code: '23505' });
      await expect(ins(1, 'slot-a')).rejects.toMatchObject({ code: '23505' });
      await admin.query('DELETE FROM runner_sandboxes WHERE runner_id = $1', [ra2]);
      await expect(record([row('x', { created_at: '2026-13-45T10:00:00Z' })], { runnerId: ra2 })).rejects.toMatchObject({ code: '22008' });
    });

    it('the column checks refuse a bad name, state and size even for the superuser', async () => {
      const ins = (name: string, state: string, disk: number) =>
        admin.query(`INSERT INTO runner_sandboxes (runner_id, slot, account_id, name, state, created_at, disk_bytes, snapshot_count) VALUES ($1, 0, $2, $3, $4, now(), $5, 0)`, [ra2, a.accountId, name, state, disk]);
      await expect(ins('Bad Name', 'stopped', 0)).rejects.toMatchObject({ code: '23514' });
      await expect(ins('ok', 'gone', 0)).rejects.toMatchObject({ code: '23514' });
      await expect(ins('ok', 'stopped', -1)).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('tenant isolation', () => {
    it("account B sees none of account A's rows through the application login, and the superuser's own predicate finds none either way", async () => {
      await record([row('a-only')]);
      await record([row('b-only')], { runnerId: rb, accountId: b.accountId });
      const seenBy = (accountId: string) =>
        withTenant(appPool, accountId, async (client) => (await client.query<{ name: string }>('SELECT name FROM runner_sandboxes ORDER BY name')).rows.map((r) => r.name));
      expect(await seenBy(a.accountId)).toEqual(expect.arrayContaining(['a-only']));
      expect(await seenBy(a.accountId)).not.toContain('b-only');
      expect(await seenBy(b.accountId)).toEqual(['b-only']);
      expect((await admin.query('SELECT 1 FROM runner_sandboxes WHERE account_id = $1 AND runner_id = $2', [b.accountId, ra])).rowCount).toBe(0);
      expect((await admin.query('SELECT 1 FROM runner_sandbox_reports WHERE account_id = $1 AND runner_id = $2', [b.accountId, ra])).rowCount).toBe(0);
      const reports = await withTenant(appPool, b.accountId, async (client) => (await client.query('SELECT runner_id FROM runner_sandbox_reports')).rows.map((r) => r.runner_id));
      expect(reports).toEqual([rb]);
    });

    it('a second runner of the same account has its own list, untouched by the first', async () => {
      await record([row('one')]);
      await record([row('two'), row('three')], { runnerId: ra2 });
      expect(await names(ra)).toEqual(['one']);
      expect(await names(ra2)).toEqual(['two', 'three']);
      await record([], { runnerId: ra2 });
      expect(await names(ra)).toEqual(['one']);
    });

    it('a suspended account reads none of its rows, and the rows follow their runner when it is deleted', async () => {
      const c = await seedAccount(admin, randomUUID());
      const rc = await insertRunner(admin, c.accountId, c.userId);
      await admin.query('UPDATE runners SET protocol_version = 21 WHERE id = $1', [rc]);
      await record([row('c-one')], { runnerId: rc, accountId: c.accountId });
      await admin.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [c.accountId]);
      expect(await withTenant(appPool, c.accountId, async (client) => (await client.query('SELECT 1 FROM runner_sandboxes')).rowCount)).toBe(0);
      await admin.query('UPDATE accounts SET deleted_at = NULL WHERE id = $1', [c.accountId]);
      await admin.query('DELETE FROM runners WHERE id = $1', [rc]);
      expect((await admin.query('SELECT 1 FROM runner_sandboxes WHERE runner_id = $1', [rc])).rowCount).toBe(0);
      expect((await admin.query('SELECT 1 FROM runner_sandbox_reports WHERE runner_id = $1', [rc])).rowCount).toBe(0);
    });
  });

  describe('runner_sandbox_facts_record', () => {
    const stored = (id: string) => admin.query('SELECT max_vms, max_vcpus, max_memory_mb, bootable_templates FROM runner_facts WHERE runner_id = $1', [id]).then((r) => r.rows[0] ?? null);

    it('stores the limits on the facts row, rewrites them, and clears them with nulls', async () => {
      await withFacts(ra, a.accountId);
      await limits([4, 16, 32768, ['fx-agent', 'gpu-1']]);
      expect(await stored(ra)).toEqual({ max_vms: 4, max_vcpus: 16, max_memory_mb: 32768, bootable_templates: ['fx-agent', 'gpu-1'] });
      await limits([0, null, null, null]);
      expect(await stored(ra)).toEqual({ max_vms: 0, max_vcpus: null, max_memory_mb: null, bootable_templates: [] });
    });

    it('touches only the runner the session names, and raises when it has reported no facts (P0002) or is another account\'s (42501)', async () => {
      await withFacts(ra2, a.accountId);
      await limits([2, 2, 2, ['x']]);
      expect(await stored(ra2)).toMatchObject({ max_vms: null });
      const bare = await insertRunner(admin, a.accountId, a.userId);
      await admin.query('UPDATE runners SET protocol_version = 21 WHERE id = $1', [bare]);
      await expect(limits([1, 1, 1, null], { runnerId: bare })).rejects.toMatchObject({ code: 'P0002' });
      await expect(limits([1, 1, 1, null], { runnerId: rb })).rejects.toMatchObject({ code: '42501' });
    });

    it('refuses a value outside its range or a bad or repeated template id (22023), and a protocol below 21', async () => {
      await withFacts(ra, a.accountId);
      for (const args of [[257, null, null, null], [null, 4097, null, null], [null, null, 16777217, null], [null, null, null, ['Bad Id']], [null, null, null, ['a', 'a']], [null, null, null, Array.from({ length: 9 }, (_v, i) => `t${i}`)]] as const) {
        await expect(limits([...args] as [number | null, number | null, number | null, string[] | null]), JSON.stringify(args)).rejects.toMatchObject({ code: '22023' });
      }
      const old = await insertRunner(admin, a.accountId, a.userId);
      await admin.query('UPDATE runners SET protocol_version = 20 WHERE id = $1', [old]);
      await withFacts(old, a.accountId);
      await expect(limits([1, null, null, null], { runnerId: old })).rejects.toMatchObject({ code: '22023' });
    });

    it('the column checks hold for the superuser too', async () => {
      await expect(admin.query('UPDATE runner_facts SET max_vms = 300 WHERE runner_id = $1', [ra])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query(`UPDATE runner_facts SET bootable_templates = '{"Bad Id"}' WHERE runner_id = $1`, [ra])).rejects.toMatchObject({ code: '23514' });
    });
  });
});
