import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { findRlsViolations } from '../src/rlsInventory.js';

/** 0750: the halt marker and the trigger that refuses a run on a halted item (DP8 criteria 3 and 13). */
describe('work item halt marker (0750)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let a: SeedRefs;
  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    a = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
  });

  async function item(account: SeedRefs = a): Promise<string> {
    const id = randomUUID();
    await admin.query("INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'feature', 'internal', 'in_progress')", [id, account.accountId, account.repoId]);
    return id;
  }
  const insertRun = (workItemId: string | null, account: SeedRefs = a) =>
    admin.query("INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, execution_mode) VALUES ($1, $2, $3, 'code-reviewer', 'production', 'pending', 'sandbox')", [
      randomUUID(),
      account.accountId,
      workItemId,
    ]);
  const halt = (id: string) => admin.query('UPDATE work_items SET halted_at = now(), halt_action_id = $2, halt_epoch = halt_epoch + 1 WHERE id = $1', [id, randomUUID()]);

  it('an insert for a halted item raises HX409; a null item and an un-halted item in the same account are unaffected', async () => {
    const halted = await item();
    const other = await item();
    await halt(halted);
    await expect(insertRun(halted)).rejects.toMatchObject({ code: 'HX409', message: 'work_item_halted' });
    await expect(insertRun(null)).resolves.toBeDefined();
    await expect(insertRun(other)).resolves.toBeDefined();
    expect((await admin.query('SELECT count(*)::int AS n FROM agent_runs WHERE work_item_id = $1', [halted])).rows[0].n).toBe(0);
  });

  it('the check reads the item in its own account only', async () => {
    const b = await seedAccount(admin, randomUUID());
    const mine = await item();
    await halt(mine);
    // A run in another account naming this item is refused by the tenant FK (23503). It must not be answered HX409: that
    // would tell account b whether an item of account a is halted.
    const err = await insertRun(mine, b).then(() => null, (e: unknown) => e as { code?: string });
    expect(err).not.toBeNull();
    expect(err?.code).toBe('23503');
  });

  it('the marker pair is all or nothing, and the epoch counts halts', async () => {
    const id = await item();
    await expect(admin.query('UPDATE work_items SET halted_at = now() WHERE id = $1', [id])).rejects.toMatchObject({ code: '23514' });
    await halt(id);
    await halt(id);
    expect((await admin.query('SELECT halt_epoch FROM work_items WHERE id = $1', [id])).rows[0].halt_epoch).toBe(2);
  });

  it('the trigger function is the migration owner\'s invoker function with a pinned search_path and no PUBLIC execute; the helper is a definer of its own NOLOGIN role, callable by platform_ops and the migration owner only', async () => {
    const { rows } = await admin.query(
      `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig, has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
         FROM pg_proc p WHERE p.proname IN ('agent_runs_refuse_halted_item', 'work_item_halt_lock') ORDER BY 1`,
    );
    const trig = rows.find((r) => r.proname === 'agent_runs_refuse_halted_item');
    const helper = rows.find((r) => r.proname === 'work_item_halt_lock');
    const tableOwner = (await admin.query(`SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid = 'public.agent_runs'::regclass`)).rows[0].o;
    expect(trig).toMatchObject({ owner: tableOwner, prosecdef: false, public_exec: false });
    expect(trig.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
    expect(helper).toMatchObject({ owner: 'work_item_halt_definer', prosecdef: true, public_exec: false });
    expect(helper.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
    const grantees = await admin.query<{ g: string }>(
      `SELECT pg_get_userbyid(a.grantee) AS g FROM pg_proc p, aclexplode(p.proacl) a WHERE p.proname = 'work_item_halt_lock' AND a.grantee <> p.proowner ORDER BY 1`,
    );
    expect(grantees.rows.map((r) => r.g).sort()).toEqual([tableOwner, 'platform_ops'].sort());
    // The owner is a role nothing can become: NOLOGIN, no member, a member of nothing.
    const role = (await admin.query(`SELECT rolcanlogin, rolsuper, rolbypassrls, (SELECT count(*)::int FROM pg_auth_members WHERE roleid = r.oid) AS members, (SELECT count(*)::int FROM pg_auth_members WHERE member = r.oid) AS memberships FROM pg_roles r WHERE rolname = 'work_item_halt_definer'`)).rows[0];
    expect(role).toMatchObject({ rolcanlogin: false, rolsuper: false, rolbypassrls: false, memberships: 0 });
    expect(role.members).toBeLessThanOrEqual(1);
  });

  it('the three columns are updatable by exactly the roles that can update stage (platform_ops holds none)', async () => {
    const { rows } = await admin.query<{ col: string; grantee: string }>(
      `SELECT c.column_name AS col, c.grantee FROM information_schema.column_privileges c
        WHERE c.table_name = 'work_items' AND c.table_schema = 'public' AND c.privilege_type = 'UPDATE'
          AND c.column_name IN ('stage', 'halted_at', 'halt_action_id', 'halt_epoch')`,
    );
    const by = (col: string) => rows.filter((r) => r.col === col).map((r) => r.grantee).sort();
    const stage = by('stage');
    expect(stage.length).toBeGreaterThan(0);
    for (const col of ['halt_action_id', 'halt_epoch']) expect(by(col)).toEqual(stage);
    expect(by('halted_at').filter((g) => g !== 'work_item_halt_definer')).toEqual(stage);
    expect(by('halted_at')).toContain('work_item_halt_definer');
    expect(by('halted_at')).not.toContain('platform_ops');
    // The row lock is the helper owner's alone, and its policies can never let it write: the update policy's WITH CHECK is false.
    const pols = (await admin.query<{ roles: string[]; cmd: string; with_check: string | null }>(`SELECT roles::text[] AS roles, cmd, with_check FROM pg_policies WHERE tablename = 'work_items' AND policyname LIKE '%halt%'`)).rows;
    expect(pols.length).toBe(2);
    for (const p of pols) expect(p.roles).toEqual(['work_item_halt_definer']);
    expect(pols.find((p) => p.cmd === 'UPDATE')?.with_check).toBe('false');
  });

  it('a direct platform_ops login can neither read nor lock the marker (42501), and neither can the run writer call the helper (42501)', async () => {
    const id = await item();
    const ops = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    try {
      const c = await ops.connect();
      try {
        for (const sql of ['SELECT halted_at FROM work_items WHERE id = $1', 'SELECT id FROM work_items WHERE id = $1 FOR SHARE', 'UPDATE work_items SET halted_at = now() WHERE id = $1']) {
          await c.query('BEGIN');
          await c.query(`SELECT set_config('app.account_id', $1, true)`, [a.accountId]);
          await expect(c.query(sql, [id]), sql).rejects.toMatchObject({ code: '42501' });
          await c.query('ROLLBACK');
        }
      } finally {
        c.release();
      }
    } finally {
      await ops.end();
    }
    const writer = createPool(process.env.DATABASE_URL_RUN_WRITER!);
    try {
      // The helper is not callable by the run writer: the trigger reaches it as the create function's owner (agent-runs-write-guard
      // and agent-runs-writer create runs through the writer, so the positive path is pinned there).
      await expect(withTenant(writer, a.accountId, async (c) => c.query('SELECT work_item_halt_lock($1, $2) AS h', [a.accountId, id]))).rejects.toMatchObject({ code: '42501' });
    } finally {
      await writer.end();
    }
  });

  describe('a platform_ops-owned definer is not tenant-blind on work_items', () => {
    const PROBE = 'taa_halt_probe';
    let b: SeedRefs;
    let bItem: string;
    beforeAll(async () => {
      b = await seedAccount(admin, randomUUID());
      bItem = await item(b);
      await admin.query(
        `CREATE FUNCTION ${PROBE}_read(p_item uuid) RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
           AS $$ SELECT count(*)::int FROM public.work_items WHERE id = p_item AND halted_at IS NULL $$`,
      );
      await admin.query(
        `CREATE FUNCTION ${PROBE}_ids(p_item uuid) RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
           AS $$ SELECT count(*)::int FROM public.work_items WHERE id = p_item $$`,
      );
      await admin.query(
        `CREATE FUNCTION ${PROBE}_lock(p_item uuid) RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
           AS $$ SELECT count(*)::int FROM (SELECT id FROM public.work_items WHERE id = p_item FOR SHARE) x $$`,
      );
      for (const f of ['read', 'ids', 'lock']) await admin.query(`ALTER FUNCTION ${PROBE}_${f}(uuid) OWNER TO platform_ops`);
    });
    afterAll(async () => {
      for (const f of ['read', 'ids', 'lock']) await admin.query(`DROP FUNCTION IF EXISTS ${PROBE}_${f}(uuid)`);
    });

    /** Rows another tenant's item shows to a definer platform_ops owns, called by the run writer (a login that is not platform_ops, so
     * the old session_user policy would have applied) in tenant a's context. A refused privilege is no row. */
    async function seen(fn: string): Promise<{ rows: number; code: string | null }> {
      const writer = createPool(process.env.DATABASE_URL_RUN_WRITER!);
      try {
        return await withTenant(writer, a.accountId, async (c) => {
          await c.query('SAVEPOINT probe');
          try {
            return { rows: (await c.query(`SELECT ${PROBE}_${fn}($1) AS n`, [bItem])).rows[0].n as number, code: null };
          } catch (err) {
            await c.query('ROLLBACK TO SAVEPOINT probe');
            return { rows: 0, code: (err as { code?: string }).code ?? 'unknown' };
          }
        });
      } finally {
        await writer.end();
      }
    }

    it('reads and locks no row of another tenant, and cannot read the marker column at all', async () => {
      expect((await seen('read')).rows).toBe(0);
      expect((await seen('lock')).rows).toBe(0);
      // platform_ops\' older tenant-scoped read of id/account_id is unchanged: the other tenant's item is not visible to it.
      expect(await seen('ids')).toEqual({ rows: 0, code: null });
      // With no grant on the marker columns the refusal is a privilege error, not an empty answer.
      expect((await seen('read')).code).toBe('42501');
      expect((await seen('lock')).code).toBe('42501');
    });
  });

  it('findRlsViolations is still empty', async () => {
    expect(await findRlsViolations(admin)).toEqual([]);
  });
});
