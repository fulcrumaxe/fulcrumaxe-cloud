import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#2 CARRY-17-Q (0684): the 7-day metering flag-rate check as a counts-only
 * SECURITY DEFINER owned by the no-login metering_reporter, the run.metering
 * write guard, and the proof that platform_ops gained nothing else.
 *
 * The function counts the whole platform, so every test starts from an empty
 * set of run.metering rows (the admin connection is a superuser and passes
 * the write guard).
 */
const FN = 'run_metering_flag_rate(integer)';
const COLUMNS = [
  'flag_rate',
  'implausible_usage',
  'metering_silent',
  'no_metering',
  'reported_below_metered',
  'runs_flagged',
  'runs_total',
  'trigger_met',
  'window_days',
];
const FRESH_ROLE = 'fx_metering_fresh_test';

describe('run_metering_flag_rate (0684)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let writerPool: Pool;
  let refsA: SeedRefs;
  let refsB: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    writerPool = createPool(process.env.DATABASE_URL_RUN_WRITER!);
    refsA = await seedAccount(admin, randomUUID());
    refsB = await seedAccount(admin, randomUUID());
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${FRESH_ROLE}') THEN
          CREATE ROLE ${FRESH_ROLE} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
      END $$`);
  });

  beforeEach(async () => {
    await admin.query(`DELETE FROM run_events WHERE kind = 'run.metering'`);
  });

  afterAll(async () => {
    await admin.query(`DELETE FROM run_events WHERE kind = 'run.metering'`);
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
    await writerPool.end();
  });

  async function newRuns(accountId: string, n: number): Promise<string[]> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO agent_runs (account_id, role, runtime, status)
       SELECT $1::uuid, 'executor', 'local', 'succeeded' FROM generate_series(1, $2::int) RETURNING id`,
      [accountId, n],
    );
    return rows.map((r) => r.id);
  }

  async function event(
    accountId: string,
    runId: string,
    seq: number,
    kind: string,
    flags: unknown,
    ageDays = 0,
  ): Promise<void> {
    await admin.query(
      `INSERT INTO run_events (account_id, run_id, seq, kind, payload, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, now() - make_interval(days => $6::int))`,
      [accountId, runId, seq, kind, JSON.stringify({ metered_usd: 1, reported_usd: 1, flags }), ageDays],
    );
  }
  const meter = (accountId: string, runId: string, flags: unknown, seq = 1, ageDays = 0) =>
    event(accountId, runId, seq, 'run.metering', flags, ageDays);

  /** `total` runs, the first `flagged` carrying implausible_usage. */
  async function bulk(total: number, flagged: number): Promise<void> {
    const runs = await newRuns(refsA.accountId, total);
    await admin.query(
      `INSERT INTO run_events (account_id, run_id, seq, kind, payload)
       SELECT $1::uuid, t.r, 1, 'run.metering',
              jsonb_build_object('metered_usd', 1, 'reported_usd', 1,
                'flags', CASE WHEN t.i <= $3::int THEN '["implausible_usage"]'::jsonb ELSE '[]'::jsonb END)
         FROM unnest($2::uuid[]) WITH ORDINALITY AS t(r, i)`,
      [refsA.accountId, runs, flagged],
    );
  }

  const rate = async (days: number | null, pool: Pool = platformOpsPool) =>
    (await pool.query(`SELECT * FROM run_metering_flag_rate($1::int)`, [days])).rows;

  describe('1: counts', () => {
    it('returns the exact counts for a mixed three-account fixture', async () => {
      const [a1, a2, a3] = await newRuns(refsA.accountId, 3);
      const [b1, b2, b3, b4] = await newRuns(refsB.accountId, 4);
      const refsC = await seedAccount(admin, randomUUID());
      const [c1, c2, c3, c4] = await newRuns(refsC.accountId, 4);

      await meter(refsA.accountId, a1!, ['metering_silent']);
      await meter(refsA.accountId, a2!, ['implausible_usage', 'reported_below_metered']);
      await meter(refsA.accountId, a3!, []);
      await meter(refsB.accountId, b1!, ['no_metering']);
      await meter(refsB.accountId, b2!, ['metering_silent']);
      // Two rows for one run: only the lower seq counts (here: unflagged).
      await meter(refsB.accountId, b3!, [], 1);
      await meter(refsB.accountId, b3!, ['implausible_usage'], 2);
      // Outside the 7-day window: ignored.
      await meter(refsB.accountId, b4!, ['implausible_usage'], 1, 8);
      await meter(refsC.accountId, c1!, ['reported_below_metered']);
      // Another kind whose payload also has a flags array: ignored.
      await event(refsC.accountId, c2!, 5, 'agent.output', ['metering_silent']);
      await meter(refsC.accountId, c3!, []);
      await meter(refsC.accountId, c4!, ['model_call_cap']); // a real run, not a trigger flag

      const rows = await rate(7);
      expect(rows).toHaveLength(1);
      const r = rows[0];
      expect({ ...r, flag_rate: undefined }).toEqual({
        window_days: 7,
        runs_total: '9',
        runs_flagged: '4',
        metering_silent: '2',
        implausible_usage: '1',
        reported_below_metered: '2',
        no_metering: '1',
        flag_rate: undefined,
        trigger_met: false,
      });
      expect(Number(r.flag_rate)).toBeCloseTo(4 / 9, 10);
    });

    it('a wider window counts the older row', async () => {
      const [a1] = await newRuns(refsA.accountId, 1);
      await meter(refsA.accountId, a1!, ['metering_silent'], 1, 10);
      expect((await rate(7))[0].runs_total).toBe('0');
      expect(await rate(14)).toMatchObject([{ window_days: 14, runs_total: '1', runs_flagged: '1' }]);
    });

    it('no_metering is shown but is not counted as flagged', async () => {
      const runs = await newRuns(refsA.accountId, 2);
      await meter(refsA.accountId, runs[0]!, ['no_metering']);
      await meter(refsA.accountId, runs[1]!, ['no_metering', 'metering_silent']);
      expect(await rate(7)).toMatchObject([{ runs_total: '2', runs_flagged: '1', no_metering: '2', metering_silent: '1' }]);
    });
  });

  describe('2: the trigger rule', () => {
    it('199 runs with 3 flagged: not met', async () => {
      await bulk(199, 3);
      expect(await rate(7)).toMatchObject([{ runs_total: '199', runs_flagged: '3', trigger_met: false }]);
    });
    it('200 runs with 2 flagged (exactly 1%): not met', async () => {
      await bulk(200, 2);
      expect(await rate(7)).toMatchObject([{ runs_total: '200', runs_flagged: '2', trigger_met: false }]);
    });
    it('200 runs with 3 flagged: met', async () => {
      await bulk(200, 3);
      expect(await rate(7)).toMatchObject([{ runs_total: '200', runs_flagged: '3', trigger_met: true }]);
    });
    it('no runs: zero total, NULL rate, not met', async () => {
      expect(await rate(7)).toEqual([
        {
          window_days: 7,
          runs_total: '0',
          runs_flagged: '0',
          metering_silent: '0',
          implausible_usage: '0',
          reported_below_metered: '0',
          no_metering: '0',
          flag_rate: null,
          trigger_met: false,
        },
      ]);
    });
  });

  describe('3: the window argument', () => {
    it.each([null, 0, 31])('p_days %s raises invalid_parameter_value', async (days) => {
      await expect(rate(days)).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
    });
    it.each([1, 30])('p_days %s works', async (days) => {
      expect(await rate(days)).toMatchObject([{ window_days: days }]);
    });
  });

  describe('4: output shape', () => {
    it('is one row with exactly the nine count columns', async () => {
      const [a1] = await newRuns(refsA.accountId, 1);
      await meter(refsA.accountId, a1!, ['metering_silent']);
      const res = await platformOpsPool.query(`SELECT * FROM run_metering_flag_rate(7)`);
      expect(res.rows).toHaveLength(1);
      expect(res.fields.map((f) => f.name).sort()).toEqual(COLUMNS);
      expect(Object.keys(res.rows[0]).sort()).toEqual(COLUMNS);
    });
  });

  describe('5: ACL and owner', () => {
    it.each(['app_user', 'partner_user', 'agent_run_writer', 'exposure_writer', FRESH_ROLE])(
      '%s cannot execute it',
      async (role) => {
        const { rows } = await admin.query(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, FN]);
        expect(rows[0].ok).toBe(false);
      },
    );
    it('platform_ops can, and PUBLIC cannot', async () => {
      const { rows } = await admin.query(
        `SELECT has_function_privilege('platform_ops', $1, 'EXECUTE') AS ops,
                (SELECT count(*)::int FROM pg_proc p, aclexplode(p.proacl) a
                  WHERE p.oid = $1::regprocedure AND a.grantee = 0) AS public_grants`,
        [FN],
      );
      expect(rows[0]).toEqual({ ops: true, public_grants: 0 });
    });
    it('a direct app_user call is refused', async () => {
      await expect(rate(7, appUserPool)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
    it('is a definer owned by metering_reporter, which has no login and no members', async () => {
      const fn = await admin.query(
        `SELECT pg_get_userbyid(proowner) AS owner, prosecdef, provolatile FROM pg_proc WHERE oid = $1::regprocedure`,
        [FN],
      );
      expect(fn.rows[0]).toEqual({ owner: 'metering_reporter', prosecdef: true, provolatile: 's' });
      const role = await admin.query(
        `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
           FROM pg_roles WHERE rolname = 'metering_reporter'`,
      );
      expect(role.rows[0]).toEqual({
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolbypassrls: false,
      });
      const members = await admin.query(`SELECT count(*)::int AS n FROM pg_auth_members WHERE roleid = 'metering_reporter'::regrole`);
      expect(members.rows[0].n).toBe(0);
    });
    it('a direct platform_ops login can call it and gets counts', async () => {
      const who = await platformOpsPool.query(`SELECT session_user AS s`);
      expect(who.rows[0].s).toBe('platform_ops');
      expect(await rate(7)).toHaveLength(1);
    });
  });

  describe('6: nothing widened', () => {
    it('a direct platform_ops login reads zero run_events rows', async () => {
      const [a1] = await newRuns(refsA.accountId, 1);
      await meter(refsA.accountId, a1!, []);
      const { rows } = await platformOpsPool.query(`SELECT run_id FROM run_events`);
      expect(rows).toEqual([]);
    });
    it.each(['created_at', 'seq'])('SELECT %s as platform_ops is still refused', async (col) => {
      await expect(platformOpsPool.query(`SELECT ${col} FROM run_events`)).rejects.toMatchObject({
        code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
      });
    });
    it('platform_ops holds no column privilege on run_events beyond 0646 and no INSERT', async () => {
      const { rows } = await admin.query(
        `SELECT column_name FROM information_schema.column_privileges
          WHERE table_name = 'run_events' AND grantee = 'platform_ops' ORDER BY 1`,
      );
      expect([...new Set(rows.map((r) => r.column_name))]).toEqual(['account_id', 'kind', 'payload', 'run_id']);
    });
    it("app_user tenant isolation on run_events is unchanged: A cannot see B's rows", async () => {
      const [a1] = await newRuns(refsA.accountId, 1);
      const [b1] = await newRuns(refsB.accountId, 1);
      await meter(refsA.accountId, a1!, []);
      await meter(refsB.accountId, b1!, []);
      const seen = await withTenant(appUserPool, refsA.accountId, async (c) =>
        (await c.query(`SELECT run_id FROM run_events WHERE kind = 'run.metering'`)).rows.map((r) => r.run_id),
      );
      expect(seen).toEqual([a1]);
    });
  });

  describe('7: what metering_reporter can read', () => {
    it('sees only run.metering rows, never another kind', async () => {
      const [a1] = await newRuns(refsA.accountId, 1);
      await meter(refsA.accountId, a1!, []);
      await event(refsA.accountId, a1!, 7, 'agent.output', []);
      const c = await adminPool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE metering_reporter');
        const { rows } = await c.query(`SELECT DISTINCT kind FROM run_events`);
        expect(rows).toEqual([{ kind: 'run.metering' }]);
        await expect(c.query(`SELECT account_id FROM run_events`)).rejects.toMatchObject({
          code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
        });
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });
  });

  describe('8: the run.metering write guard', () => {
    const insert = (c: PoolClient, s: SeedRefs, seq: number, kind: string) =>
      c.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, $3, $4, '{"flags":[]}')`, [
        s.accountId,
        s.runId,
        seq,
        kind,
      ]);
    const count = async (kind: string) =>
      (await admin.query(`SELECT count(*)::int AS n FROM run_events WHERE kind = $1`, [kind])).rows[0].n;

    it('app_user cannot write the kind, and no row remains', async () => {
      await expect(withTenant(appUserPool, refsA.accountId, (c) => insert(c, refsA, 101, 'run.metering'))).rejects.toMatchObject({
        code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
      });
      expect(await count('run.metering')).toBe(0);
    });
    it('the runner-writer login can', async () => {
      await withTenant(writerPool, refsA.accountId, (c) => insert(c, refsA, 102, 'run.metering'));
      expect(await count('run.metering')).toBe(1);
    });
    it('app_user still writes other kinds', async () => {
      await withTenant(appUserPool, refsA.accountId, (c) => insert(c, refsA, 103, 'agent.output'));
      expect(
        (await admin.query(`SELECT count(*)::int AS n FROM run_events WHERE run_id = $1 AND seq = 103`, [refsA.runId])).rows[0].n,
      ).toBe(1);
    });
    it("0665's receipt guard still refuses its kinds", async () => {
      for (const [i, kind] of ['decision_receipt', 'decision_receipt_overflow'].entries()) {
        await expect(withTenant(appUserPool, refsA.accountId, (c) => insert(c, refsA, 110 + i, kind))).rejects.toMatchObject({
          code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
        });
      }
    });
  });

  describe('9: the index', () => {
    it('is a partial index on created_at for kind run.metering', async () => {
      const { rows } = await admin.query(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'run_events' AND indexname = 'run_events_metering_created_at'`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].indexdef).toMatch(/\(created_at\)/);
      expect(rows[0].indexdef).toMatch(/WHERE \(kind = 'run\.metering'::text\)/);
    });
  });
});
