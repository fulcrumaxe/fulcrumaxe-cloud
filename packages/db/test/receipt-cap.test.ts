import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { writeReceipt, type WriteReceiptInput } from '../src/receiptWriter.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * DP3b-5 and 3b-6 (D#7 DP-C3a): the class-1 cap in run_receipt_counts, the
 * class-1 definer, and the run_events guard against forged class-1 rows.
 */
const INVOKER_LOGIN = 'fx_receipt_invoker_test';
const DEFINER = 'decision_receipt_write_class1';

describe('class-1 receipt cap (0665)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let receiptPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${INVOKER_LOGIN}') THEN
          CREATE ROLE ${INVOKER_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
      END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${INVOKER_LOGIN}`);
    const u = new URL(process.env.DATABASE_URL_APP_USER!);
    u.username = INVOKER_LOGIN;
    u.password = '';
    receiptPool = createPool(u.toString());
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await receiptPool.end();
  });

  const input = (s: SeedRefs, cls: WriteReceiptInput['class']): WriteReceiptInput => ({
    class: cls,
    runId: s.runId,
    workItemId: s.workItemId,
    decisionType: {
      automated_with_monitoring: 'dependency_patch_bump',
      human_over_the_loop: 'test_strategy_choice',
      human_in_the_loop: 'publish_release_artifact',
    }[cls],
    chosen: 'bump',
    rejectedAlternative: 'skip',
    dialVersion: 1,
    quotedInputs: [],
  });
  const kinds = async (s: SeedRefs) =>
    Object.fromEntries(
      (
        await admin.query(
          `SELECT kind, count(*)::int AS n FROM run_events WHERE run_id = $1 AND kind LIKE 'decision_receipt%' GROUP BY kind`,
          [s.runId],
        )
      ).rows.map((r) => [r.kind, r.n]),
    );
  const counter = async (s: SeedRefs) =>
    (await admin.query(`SELECT * FROM run_receipt_counts WHERE run_id = $1`, [s.runId])).rows[0];
  const writeMany = (s: SeedRefs, cls: WriteReceiptInput['class'], n: number) =>
    withTenant(receiptPool, s.accountId, s.userId, async (c) => {
      const outcomes: string[] = [];
      for (let i = 0; i < n; i++) {
        const r = await writeReceipt(c, input(s, cls));
        outcomes.push(r.store === 'run_events' ? r.outcome : 'durable');
      }
      return outcomes;
    });

  describe('3b-5: the cap', () => {
    it('250 class-1 receipts: 200 receipts, 1 overflow row, class1_collapsed = 50', async () => {
      const s = await seedAccount(admin, randomUUID());
      const outcomes = await writeMany(s, 'automated_with_monitoring', 250);
      expect(outcomes.slice(0, 200).every((o) => o === 'written')).toBe(true);
      expect(outcomes[200]).toBe('overflow');
      expect(outcomes.slice(201).every((o) => o === 'collapsed')).toBe(true);
      expect(await kinds(s)).toEqual({ decision_receipt: 200, decision_receipt_overflow: 1 });
      expect(await counter(s)).toMatchObject({ class1_written: 200, class1_collapsed: 50 });
      const overflow = await admin.query(
        `SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'decision_receipt_overflow'`,
        [s.runId],
      );
      expect(overflow.rows[0].payload).toEqual({ cap: 200, counter: 'run_receipt_counts' });
    });

    it('250 class-2 receipts: 250 durable rows and no counter row', async () => {
      const s = await seedAccount(admin, randomUUID());
      await writeMany(s, 'human_over_the_loop', 250);
      const { rows } = await admin.query(`SELECT count(*)::int AS n FROM decision_receipts WHERE run_id = $1`, [s.runId]);
      expect(rows[0].n).toBe(250);
      expect(await counter(s)).toBeUndefined();
      expect(await kinds(s)).toEqual({});
    });

    it('two concurrent writers at count 199 produce exactly one overflow row', async () => {
      const s = await seedAccount(admin, randomUUID());
      await admin.query(
        `INSERT INTO run_receipt_counts (account_id, run_id, class1_written) VALUES ($1, $2, 199)`,
        [s.accountId, s.runId],
      );
      const [a, b] = await Promise.all([writeMany(s, 'automated_with_monitoring', 1), writeMany(s, 'automated_with_monitoring', 1)]);
      expect([a[0], b[0]].sort()).toEqual(['overflow', 'written']);
      expect(await kinds(s)).toEqual({ decision_receipt: 1, decision_receipt_overflow: 1 });
      expect(await counter(s)).toMatchObject({ class1_written: 200, class1_collapsed: 1 });
    });

    it('the counter row goes with its run', async () => {
      const s = await seedAccount(admin, randomUUID());
      await writeMany(s, 'automated_with_monitoring', 1);
      await admin.query(`DELETE FROM agent_runs WHERE id = $1`, [s.runId]);
      expect(await counter(s)).toBeUndefined();
    });

    it('a class-1 receipt cannot name another tenant\'s run', async () => {
      const s = await seedAccount(admin, randomUUID());
      const other = await seedAccount(admin, randomUUID());
      await expect(
        withTenant(receiptPool, s.accountId, s.userId, (c) =>
          writeReceipt(c, { ...input(s, 'automated_with_monitoring'), runId: other.runId }),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    });
  });

  describe('3b-5: run_receipt_counts privileges and guard', () => {
    it('has RLS enabled and forced', async () => {
      const { rows } = await admin.query(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.run_receipt_counts'::regclass`,
      );
      expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    });

    it('app_user holds SELECT and nothing else; only receipt_writer holds UPDATE', async () => {
      const { rows } = await admin.query(
        `SELECT r.rolname,
                has_table_privilege(r.oid, 'public.run_receipt_counts', 'SELECT') AS sel,
                has_table_privilege(r.oid, 'public.run_receipt_counts', 'INSERT') AS ins,
                has_table_privilege(r.oid, 'public.run_receipt_counts', 'DELETE') AS del,
                has_any_column_privilege(r.oid, 'public.run_receipt_counts', 'UPDATE') AS upd
           FROM pg_roles r
          WHERE r.rolname IN ('app_user', 'platform_ops', 'partner_user', 'agent_run_writer', 'receipt_writer_invoker', 'receipt_writer')
          ORDER BY 1`,
      );
      const by = Object.fromEntries(rows.map((r) => [r.rolname, r]));
      expect(by.app_user).toMatchObject({ sel: true, ins: false, del: false, upd: false });
      expect(by.receipt_writer).toMatchObject({ sel: true, ins: true, del: false, upd: true });
      for (const role of ['platform_ops', 'partner_user', 'agent_run_writer', 'receipt_writer_invoker']) {
        expect(by[role]).toMatchObject({ ins: false, del: false, upd: false });
      }
    });

    it('an app_user UPDATE fails with 42501', async () => {
      const s = await seedAccount(admin, randomUUID());
      await writeMany(s, 'automated_with_monitoring', 1);
      await expect(
        withTenant(appUserPool, s.accountId, (c) =>
          c.query(`UPDATE run_receipt_counts SET class1_collapsed = 5 WHERE run_id = $1`, [s.runId]),
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('app_user reads its own tenant\'s counter and not another\'s', async () => {
      const s = await seedAccount(admin, randomUUID());
      const other = await seedAccount(admin, randomUUID());
      await writeMany(s, 'automated_with_monitoring', 2);
      const read = (t: SeedRefs) =>
        withTenant(appUserPool, t.accountId, (c) => c.query(`SELECT class1_written FROM run_receipt_counts`));
      expect((await read(s)).rows).toEqual([{ class1_written: 2 }]);
      expect((await read(other)).rows).toEqual([]);
    });

    it('a receipt_writer UPDATE that lowers a count fails on the trigger', async () => {
      const s = await seedAccount(admin, randomUUID());
      await writeMany(s, 'automated_with_monitoring', 3);
      await admin.query('BEGIN');
      try {
        await admin.query(`SELECT set_config('app.account_id', $1, true)`, [s.accountId]);
        await admin.query(`SET LOCAL ROLE receipt_writer`);
        await expect(
          admin.query(`UPDATE run_receipt_counts SET class1_written = 1 WHERE run_id = $1`, [s.runId]),
        ).rejects.toThrow(/run_receipt_counts_count_lowered/);
      } finally {
        await admin.query('ROLLBACK');
      }
    });

    it('the guard also freezes the identity columns, for every role', async () => {
      const s = await seedAccount(admin, randomUUID());
      await writeMany(s, 'automated_with_monitoring', 1);
      await expect(
        admin.query(`UPDATE run_receipt_counts SET run_id = $2 WHERE run_id = $1`, [s.runId, randomUUID()]),
      ).rejects.toThrow(/run_receipt_counts_identity_frozen/);
    });
  });

  describe('3b-5: the class-1 definer', () => {
    it('is SECURITY DEFINER, owned by receipt_writer, search_path pinned, EXECUTE for the invoker only', async () => {
      const { rows } = await admin.query(
        `SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig,
                (SELECT array_agg(DISTINCT pg_get_userbyid(a.grantee)::text)
                   FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner) AS grantees,
                p.proargnames
           FROM pg_proc p WHERE p.proname = '${DEFINER}'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        prosecdef: true,
        owner: 'receipt_writer',
        proconfig: ['search_path=pg_catalog, public, pg_temp'],
        grantees: ['receipt_writer_invoker'],
      });
      for (const name of rows[0].proargnames as string[]) expect(name).not.toMatch(/actor|user|account/i);
    });

    it('the plain app_user pool cannot call it (42501)', async () => {
      const s = await seedAccount(admin, randomUUID());
      await expect(
        withTenant(appUserPool, s.accountId, s.userId, (c) => writeReceipt(c, input(s, 'automated_with_monitoring'))),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('refuses a missing tenant and a missing run with named errors', async () => {
      const c = await receiptPool.connect();
      try {
        const call = (run: string | null) =>
          c.query(`SELECT ${DEFINER}('t', 'a', 'b', 1, '[]'::jsonb, NULL, $1::uuid, 1)`, [run]);
        await expect(call(randomUUID())).rejects.toThrow(/receipt_no_tenant/);
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.account_id', $1, true)`, [randomUUID()]);
        await expect(call(null)).rejects.toThrow(/receipt_missing_run_id/);
        await c.query('ROLLBACK');
      } finally {
        c.release();
      }
    });
  });

  describe('3b-6: class-1 forgery', () => {
    const insertKind = (pool: Pool, s: SeedRefs, kind: string) =>
      withTenant(pool, s.accountId, s.userId, (c) =>
        c.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 900, $3, '{}'::jsonb)`, [
          s.accountId,
          s.runId,
          kind,
        ]),
      );

    it.each(['decision_receipt', 'decision_receipt_overflow'])('app_user cannot insert kind %s', async (kind) => {
      const s = await seedAccount(admin, randomUUID());
      await expect(insertKind(appUserPool, s, kind)).rejects.toThrow(/run_events_receipt_kind_forbidden/);
      await expect(insertKind(receiptPool, s, kind)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('not even a superuser session can insert a receipt kind outside the writer', async () => {
      const s = await seedAccount(admin, randomUUID());
      await expect(
        admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind) VALUES ($1, $2, 901, 'decision_receipt')`, [
          s.accountId,
          s.runId,
        ]),
      ).rejects.toThrow(/run_events_receipt_kind_forbidden/);
    });

    it('any other kind still inserts as app_user', async () => {
      const s = await seedAccount(admin, randomUUID());
      await expect(insertKind(appUserPool, s, 'some_other_kind')).resolves.toBeDefined();
    });
  });
});
