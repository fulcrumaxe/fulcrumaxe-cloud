import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#2 H09c (correction C37 criteria 3 and 4): the `agent_run_writer` role,
 * the two SECURITY DEFINER functions, and the invariants they enforce.
 * Every "as the writer" call below runs on a LOGIN that is a member of
 * app_user AND agent_run_writer (the test cluster's stand-in for the
 * production runner login); every "as app_user" call runs on a plain
 * app_user pool.
 */
const CREATE_SQL = `SELECT agent_run_create($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::text, $6::text, $7::text,
                                            $8::text, $9::uuid, $10::bigint, $11::uuid,
                                            jsonb_build_object('accountId', $2::uuid::text), repeat('a', 64)) AS id`;
const SET_STATUS_SQL = `SELECT agent_run_set_status($1::uuid, $2::uuid, $3::text, $4::text, $5::jsonb,
                                                     $6::bigint, $7::bigint, $8::numeric, $9::text) AS updated`;

describe('agent_runs writer (0642)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let writerPool: Pool;
  let refs: SeedRefs;
  let other: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    writerPool = createPool(process.env.DATABASE_URL_RUN_WRITER!);
    refs = await seedAccount(admin, randomUUID());
    other = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await writerPool.end();
  });

  async function create(
    pool: Pool,
    accountId: string,
    over: Partial<Record<'id' | 'workItemId' | 'role' | 'headSha' | 'repoId' | 'prNumber' | 'specVersionId', string | number | null>> = {},
    tenant: string = accountId,
  ): Promise<string> {
    const id = (over.id as string | undefined) ?? randomUUID();
    await withTenant(pool, tenant, async (c) => {
      await c.query(CREATE_SQL, [
        id,
        accountId,
        over.workItemId ?? null,
        null,
        over.role ?? 'code-reviewer',
        'production',
        over.headSha ?? null,
        over.repoId ? 'sandbox' : null,
        over.repoId ?? null,
        over.prNumber ?? null,
        over.specVersionId ?? null,
      ]);
    });
    return id;
  }

  async function setStatus(
    accountId: string,
    runId: string,
    from: string,
    to: string,
    envelope: unknown = null,
    tenant: string = accountId,
  ): Promise<boolean> {
    return withTenant(writerPool, tenant, async (c) => {
      const { rows } = await c.query<{ updated: boolean }>(SET_STATUS_SQL, [
        accountId,
        runId,
        from,
        to,
        envelope === null ? null : JSON.stringify(envelope),
        null,
        null,
        null,
        null,
      ]);
      return rows[0]!.updated;
    });
  }

  describe('criterion 3: role and function shape', () => {
    it('agent_run_writer is NOLOGIN, unprivileged, and app_user is not a member of it (pg_auth_members)', async () => {
      const { rows } = await admin.query(
        `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
           FROM pg_roles WHERE rolname = 'agent_run_writer'`,
      );
      expect(rows).toEqual([
        { rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false },
      ]);
      const members = await admin.query(
        `SELECT pg_get_userbyid(member) AS member FROM pg_auth_members WHERE roleid = 'agent_run_writer'::regrole`,
      );
      expect(members.rows.map((r: { member: string }) => r.member)).not.toContain('app_user');
      const { rows: has } = await admin.query(`SELECT pg_has_role('app_user', 'agent_run_writer', 'MEMBER') AS m`);
      expect(has[0].m).toBe(false);
      // agent_run_writer owns no table privilege at all -- only EXECUTE.
      const { rows: tp } = await admin.query(
        `SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE grantee = 'agent_run_writer'`,
      );
      expect(tp[0].n).toBe(0);
    });

    it('both functions are SECURITY DEFINER, owned by platform_ops, search_path pinned, EXECUTE only for agent_run_writer', async () => {
      const { rows } = await admin.query(
        `SELECT p.proname, p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
                (SELECT array_agg(DISTINCT
                          CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
                          ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END)
                   FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE')::text[] AS executors
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
            AND p.proname IN ('agent_run_create', 'agent_run_set_status') ORDER BY p.proname`,
      );
      expect(rows.map((r: { proname: string }) => r.proname)).toEqual(['agent_run_create', 'agent_run_set_status']);
      for (const r of rows) {
        expect(r.prosecdef).toBe(true);
        expect(r.owner).toBe('platform_ops');
        expect(r.proconfig).toEqual(['search_path=pg_catalog, public, pg_temp']);
        // 0754: runner_lease_definer holds EXECUTE on agent_run_create only, so the follow-up run it makes goes through the one create path.
        // 0759: runner_mode_switch_definer holds EXECUTE on agent_run_set_status only, so the cancellation it makes on a mode switch goes through the one status writer.
        expect(r.executors).toEqual(r.proname === 'agent_run_create' ? ['agent_run_writer', 'platform_ops', 'runner_lease_definer'] : ['agent_run_writer', 'platform_ops', 'runner_mode_switch_definer']);
      }
    });

    it('app_user calling either function gets 42501', async () => {
      await expect(create(appUserPool, refs.accountId)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(
        withTenant(appUserPool, refs.accountId, (c) =>
          c.query(SET_STATUS_SQL, [refs.accountId, refs.runId, 'pending', 'running', null, null, null, null, null]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
  });

  describe('criterion 4: created_at', () => {
    it('is stamped by the database at insert; no caller-supplied value exists on either path', async () => {
      const id = await create(writerPool, refs.accountId);
      const { rows } = await admin.query(
        `SELECT created_at, abs(extract(epoch FROM (now() - created_at))) AS age_s FROM agent_runs WHERE id = $1`,
        [id],
      );
      expect(Number(rows[0].age_s)).toBeLessThan(30);
      // The function has no created_at parameter at all.
      const { rows: args } = await admin.query(
        `SELECT pg_get_function_arguments(p.oid) AS a FROM pg_proc p WHERE p.proname = 'agent_run_create'`,
      );
      expect(args[0].a).not.toMatch(/created_at/);
      // A direct INSERT naming created_at (an 'infinity' / far-future value
      // included) is refused even for the login that CAN call the writer:
      // it holds no INSERT privilege on agent_runs at all.
      for (const value of ["'infinity'", "'9999-12-31'", "now() + interval '10 years'"]) {
        await expect(
          withTenant(writerPool, refs.accountId, (c) =>
            c.query(
              `INSERT INTO agent_runs (account_id, role, runtime, status, created_at)
               VALUES ($1, 'code-reviewer', 'production', 'pending', ${value})`,
              [refs.accountId],
            ),
          ),
          value,
        ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });
  });

  describe('criterion 4: the identity-freeze trigger applies to every role, superuser included', () => {
    const FROZEN: Array<[string, string]> = [
      ['created_at', "now() + interval '1 day'"],
      ['account_id', '$2::uuid'],
      ['role', "'executor'"],
      ['runtime', "'local'"],
      ['head_sha', "'deadbeef'"],
    ];

    for (const [column, value] of FROZEN) {
      it(`UPDATE of ${column} is refused (42501) even for the superuser`, async () => {
        const id = await create(writerPool, refs.accountId, { headSha: 'abc123' });
        const params = value.includes('$2') ? [id, other.accountId] : [id];
        await expect(
          admin.query(`UPDATE agent_runs SET ${column} = ${value} WHERE id = $1`, params),
        ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      });
    }

    it('work_item_id and spec_version_id cannot be changed directly, not even to NULL', async () => {
      const id = await create(writerPool, refs.accountId, { workItemId: refs.workItemId });
      await expect(
        admin.query(`UPDATE agent_runs SET work_item_id = NULL WHERE id = $1`, [id]),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(
        admin.query(`UPDATE agent_runs SET spec_version_id = $2 WHERE id = $1`, [id, randomUUID()]),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('the composite FK ON DELETE SET NULL still nulls work_item_id when the work item is deleted', async () => {
      const victim = await seedAccount(admin, randomUUID());
      const id = await create(writerPool, victim.accountId, { workItemId: victim.workItemId });
      // Detach the seeded run so only `id` references the work item's FK.
      await admin.query(`DELETE FROM work_items WHERE id = $1`, [victim.workItemId]);
      const { rows } = await admin.query(`SELECT work_item_id FROM agent_runs WHERE id = $1`, [id]);
      expect(rows[0].work_item_id).toBeNull();
    });
  });

  describe('criterion 4: status moves only along legal edges', () => {
    it('pending -> running -> succeeded works; illegal edges are refused (23514) and change nothing', async () => {
      const id = await create(writerPool, refs.accountId);
      expect(await setStatus(refs.accountId, id, 'pending', 'running')).toBe(true);
      await expect(setStatus(refs.accountId, id, 'running', 'pending')).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(setStatus(refs.accountId, id, 'pending', 'succeeded')).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      expect(await setStatus(refs.accountId, id, 'running', 'succeeded')).toBe(true);
      await expect(setStatus(refs.accountId, id, 'succeeded', 'running')).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      const { rows } = await admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [id]);
      expect(rows[0].status).toBe('succeeded');
    });

    it('is compare-and-set: a stale `from` touches nothing and returns false', async () => {
      const id = await create(writerPool, refs.accountId);
      expect(await setStatus(refs.accountId, id, 'running', 'succeeded')).toBe(false);
      const { rows } = await admin.query(`SELECT status FROM agent_runs WHERE id = $1`, [id]);
      expect(rows[0].status).toBe('pending');
    });
  });

  describe('criterion 4: the envelope', () => {
    it('is refused with a non-terminal status, set with a terminal one, and never changes afterwards', async () => {
      const id = await create(writerPool, refs.accountId);
      await expect(setStatus(refs.accountId, id, 'pending', 'running', { verdict: 'pass' })).rejects.toMatchObject({
        code: PG_ERROR.CHECK_VIOLATION,
      });
      expect(await setStatus(refs.accountId, id, 'pending', 'running')).toBe(true);
      expect(await setStatus(refs.accountId, id, 'running', 'succeeded', { verdict: 'pass' })).toBe(true);
      const { rows } = await admin.query(`SELECT envelope FROM agent_runs WHERE id = $1`, [id]);
      expect(rows[0].envelope).toEqual({ verdict: 'pass' });
      // Terminal statuses have no outgoing edge, so a second envelope
      // cannot arrive through the writer.
      for (const to of ['failed', 'running', 'succeeded', 'cancelled']) {
        await expect(setStatus(refs.accountId, id, 'succeeded', to, { verdict: 'needs-fix' }), to).rejects.toMatchObject({
          code: PG_ERROR.CHECK_VIOLATION,
        });
      }
      const after = await admin.query(`SELECT envelope FROM agent_runs WHERE id = $1`, [id]);
      expect(after.rows[0].envelope).toEqual({ verdict: 'pass' });
    });

    it('the metering columns and session id ride along on the same call', async () => {
      const id = await create(writerPool, refs.accountId);
      await withTenant(writerPool, refs.accountId, async (c) => {
        await c.query(SET_STATUS_SQL, [refs.accountId, id, 'pending', 'running', null, 7, 8, '1.5', 'sess-1']);
      });
      const { rows } = await admin.query(`SELECT tokens_in, tokens_out, usd, cc_session_id FROM agent_runs WHERE id = $1`, [id]);
      expect(rows[0]).toEqual({ tokens_in: '7', tokens_out: '8', usd: '1.5000', cc_session_id: 'sess-1' });
    });
  });

  describe('criterion 4: tenant binding', () => {
    it('the writer refuses an account that is not the caller\'s tenant context (42501), for create and set_status', async () => {
      await expect(create(writerPool, other.accountId, {}, refs.accountId)).rejects.toMatchObject({
        code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
      });
      await expect(setStatus(other.accountId, other.runId, 'pending', 'running', null, refs.accountId)).rejects.toMatchObject({
        code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
      });
    });

    it('a run cannot point at another account\'s work item, dispatch repo or spec version', async () => {
      await expect(create(writerPool, refs.accountId, { workItemId: other.workItemId })).rejects.toMatchObject({
        code: PG_ERROR.FOREIGN_KEY_VIOLATION,
      });
      await expect(
        create(writerPool, refs.accountId, { role: 'executor', repoId: other.repoId, prNumber: 5 }),
      ).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
      await expect(create(writerPool, refs.accountId, { specVersionId: randomUUID() })).rejects.toMatchObject({
        code: PG_ERROR.FOREIGN_KEY_VIOLATION,
      });
    });

    it('a run in the caller\'s own account, work item and repo is accepted', async () => {
      const id = await create(writerPool, refs.accountId, {
        workItemId: refs.workItemId,
        role: 'executor',
        repoId: refs.repoId,
        prNumber: 5,
      });
      const { rows } = await admin.query(
        `SELECT status, account_id, work_item_id, dispatch_repo_id, dispatch_pr_number::int AS pr FROM agent_runs WHERE id = $1`,
        [id],
      );
      expect(rows[0]).toEqual({
        status: 'pending',
        account_id: refs.accountId,
        work_item_id: refs.workItemId,
        dispatch_repo_id: refs.repoId,
        pr: 5,
      });
    });
  });
});
