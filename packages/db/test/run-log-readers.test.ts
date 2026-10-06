import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#2 RLR-1 (0697, 0698): `run_log_readers` is reachable by the runner login only (a member of agent_run_writer),
 * pinned to its tenant, and `run_events` carries a unique source-line key for agent.output rows.
 */
const TABLE_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] as const;

describe('run_log_readers (0697) and run_events.source_line (0698)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let opsPool: Pool;
  let partnerPool: Pool;
  let runnerPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    partnerPool = createPool(process.env.DATABASE_URL_PARTNER_USER!);
    runnerPool = createPool(process.env.DATABASE_URL_RUN_WRITER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    for (const r of [a, b]) {
      await withTenant(runnerPool, r.accountId, (c) =>
        c.query(`INSERT INTO run_log_readers (run_id, account_id, cmd_id, record_path) VALUES ($1::uuid, $2, 'cmd', '/fx/run/' || $1::text || '.rec')`, [r.runId, r.accountId]),
      );
    }
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, appPool, opsPool, partnerPool, runnerPool]) await p.end();
  });

  describe('grants: the runner login only (RL3)', () => {
    it('no login role, and not PUBLIC, holds any privilege on the table or its columns unless it is a member of agent_run_writer', async () => {
      const roles = (await admin.query(`SELECT rolname FROM pg_roles WHERE NOT rolsuper AND rolname NOT LIKE 'pg\\_%'`)).rows.map((r: { rolname: string }) => r.rolname);
      expect(roles).toEqual(expect.arrayContaining(['app_user', 'platform_ops', 'partner_user', 'agent_run_writer', 'fx_run_writer_test']));
      for (const role of roles) {
        const runner = (await admin.query(`SELECT pg_has_role($1, 'agent_run_writer', 'USAGE') AS m`, [role])).rows[0].m as boolean;
        for (const priv of TABLE_PRIVS) {
          const has = (await admin.query(`SELECT has_table_privilege($1, 'run_log_readers', $2) AS v`, [role, priv])).rows[0].v;
          if (!runner) expect(has, `${role} ${priv}`).toBe(false);
        }
        if (!runner) {
          const cols = (await admin.query(`SELECT attname FROM pg_attribute WHERE attrelid = 'run_log_readers'::regclass AND attnum > 0 AND NOT attisdropped`)).rows;
          for (const { attname } of cols) {
            for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
              const v = (await admin.query(`SELECT has_column_privilege($1, 'run_log_readers', $2, $3) AS v`, [role, attname, priv])).rows[0].v;
              expect(v, `${role} ${priv} ${attname}`).toBe(false);
            }
          }
        }
      }
      const { rows: pub } = await admin.query(`SELECT count(*)::int AS n FROM pg_class c, aclexplode(c.relacl) x WHERE c.oid = 'run_log_readers'::regclass AND x.grantee = 0`);
      expect(pub[0].n).toBe(0);
    });

    it('agent_run_writer holds no table-level privilege; its column privileges are exactly the read set, the identity insert set and the cursor/lease update set', async () => {
      const table = await admin.query(
        `SELECT x.privilege_type AS p FROM pg_class c, aclexplode(c.relacl) x WHERE c.oid = 'run_log_readers'::regclass AND x.grantee = 'agent_run_writer'::regrole::oid`,
      );
      expect(table.rows).toEqual([]);
      const cols = async (priv: string) =>
        (await admin.query(
          `SELECT attname FROM pg_attribute a, aclexplode(a.attacl) x
            WHERE a.attrelid = 'run_log_readers'::regclass AND x.grantee = 'agent_run_writer'::regrole::oid AND x.privilege_type = $1 ORDER BY 1`,
          [priv],
        )).rows.map((r: { attname: string }) => r.attname);
      expect(await cols('INSERT')).toEqual(['account_id', 'cmd_id', 'record_path', 'run_id']);
      expect(await cols('UPDATE')).toEqual(['byte_offset', 'epoch', 'lease_until', 'next_seq', 'read_failures', 'side_effects', 'state', 'updated_at']);
      expect(await cols('SELECT')).toHaveLength(13);
      expect(await cols('REFERENCES')).toEqual([]);
    });

    it('app_user, platform_ops and partner_user are refused on every statement', async () => {
      for (const pool of [appPool, opsPool, partnerPool]) {
        for (const sql of [
          `SELECT run_id FROM run_log_readers`,
          `UPDATE run_log_readers SET epoch = epoch + 1`,
          `INSERT INTO run_log_readers (run_id, account_id, cmd_id, record_path) VALUES ('${randomUUID()}', '${a.accountId}', 'x', 'x')`,
          `DELETE FROM run_log_readers`,
        ]) {
          await expect(withTenant(pool, a.accountId, (c) => c.query(sql)), sql).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        }
      }
    });

    it('the runner cannot change the identity columns, delete, or leave the record path', async () => {
      for (const sql of [
        `UPDATE run_log_readers SET cmd_id = 'other'`,
        `UPDATE run_log_readers SET record_path = '/tmp/x'`,
        `UPDATE run_log_readers SET account_id = '${b.accountId}'`,
        `DELETE FROM run_log_readers`,
      ]) {
        await expect(withTenant(runnerPool, a.accountId, (c) => c.query(sql)), sql).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
      const run = randomUUID();
      await expect(
        withTenant(runnerPool, a.accountId, (c) => c.query(`INSERT INTO run_log_readers (run_id, account_id, cmd_id, record_path) VALUES ($1, $2, 'x', '/fx/run/elsewhere.rec')`, [run, a.accountId])),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });
  });

  describe('tenant isolation', () => {
    it('RLS is enabled and forced, with one policy, for the runner role only', async () => {
      const { rows } = await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'run_log_readers'::regclass`);
      expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const pol = await admin.query(`SELECT polname, polroles::regrole[]::text AS roles FROM pg_policy WHERE polrelid = 'run_log_readers'::regclass`);
      expect(pol.rows).toEqual([{ polname: 'runner_tenant', roles: '{agent_run_writer}' }]);
    });

    it('the runner sees only its own tenant, none without a tenant, and cannot write across tenants', async () => {
      const mine = await withTenant(runnerPool, a.accountId, async (c) => (await c.query(`SELECT run_id FROM run_log_readers`)).rows.map((r) => r.run_id));
      expect(mine).toEqual([a.runId]);
      const none = await runnerPool.query(`SELECT run_id FROM run_log_readers`);
      expect(none.rows).toEqual([]);
      const touched = await withTenant(runnerPool, b.accountId, (c) => c.query(`UPDATE run_log_readers SET epoch = 99 WHERE run_id = $1`, [a.runId]));
      expect(touched.rowCount).toBe(0);
      expect((await admin.query(`SELECT epoch FROM run_log_readers WHERE run_id = $1`, [a.runId])).rows[0].epoch).toBe('0');
      await expect(
        withTenant(runnerPool, b.accountId, (c) =>
          c.query(`INSERT INTO run_log_readers (run_id, account_id, cmd_id, record_path) VALUES ($1::uuid, $2, 'x', '/fx/run/' || $1::text || '.rec')`, [a.runId, a.accountId]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
  });

  describe('shape', () => {
    it('refuses an oversize or non-object state, and a reader row for a run that is not the account\'s', async () => {
      const set = (state: string) => withTenant(runnerPool, a.accountId, (c) => c.query(`UPDATE run_log_readers SET state = $1::jsonb WHERE run_id = $2`, [state, a.runId]));
      await expect(set(JSON.stringify({ big: 'x'.repeat(262144) }))).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(set('[1]')).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(set(JSON.stringify({ ok: 'x'.repeat(1000) }))).resolves.toBeDefined();
      const run = randomUUID();
      await expect(
        withTenant(runnerPool, a.accountId, (c) =>
          c.query(`INSERT INTO run_log_readers (run_id, account_id, cmd_id, record_path) VALUES ($1::uuid, $2, 'x', '/fx/run/' || $1::text || '.rec')`, [run, a.accountId]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    });
  });

  describe('run_events.source_line (0698)', () => {
    const add = (r: SeedRefs, seq: number, kind: string, line: number | null) =>
      withTenant(runnerPool, r.accountId, (c) =>
        c.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload, source_line) VALUES ($1, $2, $3, $4, '{}', $5)`, [r.accountId, r.runId, seq, kind, line]),
      );

    it('one agent.output row per run and line; other kinds and other runs are not held to the key', async () => {
      await add(a, 9001, 'agent.output', 5);
      await expect(add(a, 9002, 'agent.output', 5)).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
      await add(a, 9003, 'agent.output', 6);
      await add(a, 9004, 'agent.output', null);
      await add(a, 9005, 'agent.output', null);
      await add(a, 9006, 'checkpoint', 5);
      await add(b, 9001, 'agent.output', 5);
    });

    it('only the runner login may write a source_line: an app_user insert with one is refused, without one it is allowed', async () => {
      const ins = (seq: number, line: number | null) =>
        withTenant(appPool, a.accountId, (c) =>
          c.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload, source_line) VALUES ($1, $2, $3, 'agent.output', '{}', $4)`, [a.accountId, a.runId, seq, line]),
        );
      await expect(ins(9101, 77)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(ins(9102, null)).resolves.toBeDefined();
    });

    it('platform_ops, whose reads of run_events are column-scoped, cannot read the column', async () => {
      expect((await admin.query(`SELECT has_column_privilege('platform_ops', 'run_events', 'source_line', 'SELECT') AS v`)).rows[0].v).toBe(false);
    });
  });
});
