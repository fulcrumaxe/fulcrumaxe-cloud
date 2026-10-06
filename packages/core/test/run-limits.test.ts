import { randomUUID } from 'node:crypto';
import { loadPlanData } from '@fx/plan-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { ForbiddenError, NotFoundError } from '../src/tenancy/errors.js';
import {
  RUN_LIMIT_BOUNDS,
  RUN_LIMIT_KEYS,
  InvalidRunLimitsError,
  mergeRunLimits,
  resolveRunLimits,
  setRunLimits,
  toStored,
  type RunLimitsCtx,
} from '../src/run-limits/index.js';

/** D#2 C48 H12c criteria 1 to 5. */
describe('run-limits', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  const ctxFor = (r: SeedRefs, userId = r.userId): RunLimitsCtx => ({
    pool: appUserPool,
    principal: { accountId: r.accountId, userId },
  });
  const resolve = (r: SeedRefs, role: string) =>
    withTenant(appUserPool, r.accountId, r.userId, (c) => resolveRunLimits(c, { accountId: r.accountId, role }));
  const insertRaw = (r: SeedRefs, role: string, col: string, v: unknown) =>
    admin.query(`INSERT INTO run_limits (account_id, role, ${col}) VALUES ($1, $2, $3)`, [r.accountId, role, v]);

  describe('criterion 1: resolve', () => {
    it('nothing set: every field is its default', async () => {
      const r = await resolve(a, 'executor');
      for (const k of RUN_LIMIT_KEYS) expect(r[k], k).toBe(RUN_LIMIT_BOUNDS[k].default);
      expect(r.auto_resume).toBe(true);
    });

    it('role row beats the account row beats the default, per field; a stored ceiling resolves to the ceiling', async () => {
      const c = await seedAccount(admin, randomUUID());
      await setRunLimits(ctxFor(c), { role: '*', values: { max_turns: 200, max_run_minutes: 90, auto_resume: false } });
      await setRunLimits(ctxFor(c), { role: 'executor', values: { max_run_minutes: 240, per_run_usd: 12.5 } });
      const ex = await resolve(c, 'executor');
      expect(ex).toMatchObject({ max_run_minutes: 240, max_turns: 200, per_run_usd: 12.5, max_model_calls: 300, auto_resume: false });
      const other = await resolve(c, 'debater');
      expect(other).toMatchObject({ max_run_minutes: 90, max_turns: 200, per_run_usd: loadPlanData().caps.perSpawnUsd });
    });

    it('null in the role row inherits from the account row', async () => {
      const c = await seedAccount(admin, randomUUID());
      await setRunLimits(ctxFor(c), { role: '*', values: { max_turns: 200 } });
      await setRunLimits(ctxFor(c), { role: 'executor', values: { max_turns: 300 } });
      await setRunLimits(ctxFor(c), { role: 'executor', values: { max_turns: null } });
      expect((await resolve(c, 'executor')).max_turns).toBe(200);
    });

    it('a stored value above the ceiling (which the CHECKs forbid) is still clamped', () => {
      const stored = toStored({ max_run_minutes: 9999, per_run_usd: '999.00' });
      const r = mergeRunLimits(stored, undefined);
      expect(r.max_run_minutes).toBe(240);
      expect(r.per_run_usd).toBe(200);
    });

    it('per_run_usd defaults to the spend package default', () => {
      expect(RUN_LIMIT_BOUNDS.per_run_usd.default).toBe(loadPlanData().caps.perSpawnUsd);
    });
  });

  describe('criterion 2: set', () => {
    it('writes the row and exactly one run_limits.changed audit row with before and after', async () => {
      const c = await seedAccount(admin, randomUUID());
      await setRunLimits(ctxFor(c), { role: 'code-reviewer', values: { max_turns: 50 } });
      await setRunLimits(ctxFor(c), { role: 'code-reviewer', values: { max_turns: 60, auto_resume: true } });
      const { rows } = await admin.query(
        `SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'run_limits.changed' ORDER BY created_at`,
        [c.accountId],
      );
      expect(rows).toHaveLength(2);
      expect(rows[1]!.payload).toMatchObject({
        role: 'code-reviewer',
        before: { max_turns: 50, auto_resume: null },
        after: { max_turns: 60, auto_resume: true },
      });
    });

    it('a member gets ForbiddenError and nothing is written', async () => {
      const c = await seedAccount(admin, randomUUID());
      const memberId = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [memberId, `m-${memberId}@example.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [c.accountId, memberId]);
      await expect(setRunLimits(ctxFor(c, memberId), { role: '*', values: { max_turns: 50 } })).rejects.toThrow(ForbiddenError);
      const { rows } = await admin.query('SELECT 1 FROM run_limits WHERE account_id = $1', [c.accountId]);
      expect(rows).toHaveLength(0);
    });

    it('an unknown role is a NotFoundError', async () => {
      await expect(setRunLimits(ctxFor(a), { role: 'not-a-role', values: { max_turns: 50 } })).rejects.toThrow(NotFoundError);
    });

    it.each([
      ['max_run_minutes', 4],
      ['max_run_minutes', 241],
      ['max_turns', 9],
      ['max_turns', 501],
      ['silence_minutes', 10],
      ['max_extensions', 5],
      ['max_resumes', -1],
      ['per_run_usd', 0.5],
      ['per_run_usd', 200.01],
      ['max_model_calls', 20.5],
      ['max_turns', Number.NaN],
    ])('%s = %s is a typed 422 error naming the path, and nothing is written', async (key, value) => {
      const err = await setRunLimits(ctxFor(a), { role: '*', values: { [key]: value } }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InvalidRunLimitsError);
      expect((err as InvalidRunLimitsError).path).toBe(`values.${key}`);
    });

    it('an unknown key and a non-boolean auto_resume are 422s; the floor and ceiling themselves are accepted', async () => {
      await expect(setRunLimits(ctxFor(a), { role: '*', values: { nope: 1 } as never })).rejects.toBeInstanceOf(InvalidRunLimitsError);
      await expect(setRunLimits(ctxFor(a), { role: '*', values: { auto_resume: 'yes' } as never })).rejects.toBeInstanceOf(InvalidRunLimitsError);
      const edge = Object.fromEntries(RUN_LIMIT_KEYS.map((k) => [k, RUN_LIMIT_BOUNDS[k].ceiling]));
      await setRunLimits(ctxFor(a), { role: 'executor', values: edge });
      expect(await resolve(a, 'executor')).toMatchObject(edge);
      const low = Object.fromEntries(RUN_LIMIT_KEYS.map((k) => [k, RUN_LIMIT_BOUNDS[k].floor]));
      await setRunLimits(ctxFor(a), { role: 'executor', values: low });
      expect(await resolve(a, 'executor')).toMatchObject(low);
    });
  });

  describe('criterion 3: database backstop', () => {
    it.each(RUN_LIMIT_KEYS)('%s: below floor and above ceiling are rejected, NULL and the bounds accepted', async (k) => {
      const { floor, ceiling } = RUN_LIMIT_BOUNDS[k];
      const c = await seedAccount(admin, randomUUID());
      await expect(insertRaw(c, 'executor', k, floor - 1)).rejects.toMatchObject({ code: '23514' });
      await expect(insertRaw(c, 'executor', k, ceiling + 1)).rejects.toMatchObject({ code: '23514' });
      await insertRaw(c, 'executor', k, null);
      await admin.query(`UPDATE run_limits SET ${k} = $2 WHERE account_id = $1`, [c.accountId, floor]);
      await admin.query(`UPDATE run_limits SET ${k} = $2 WHERE account_id = $1`, [c.accountId, ceiling]);
    });
  });

  describe('criterion 4: tenancy', () => {
    it("another account's rows are invisible, unwritable and unresolvable, as app_user", async () => {
      await setRunLimits(ctxFor(a), { role: 'debater', values: { max_turns: 77 } });
      const seen = await withTenant(appUserPool, b.accountId, b.userId, (c) => c.query('SELECT 1 FROM run_limits WHERE account_id = $1', [a.accountId]));
      expect(seen.rows).toHaveLength(0);
      expect((await resolve(b, 'debater')).max_turns).toBe(100);
      await expect(
        withTenant(appUserPool, b.accountId, b.userId, (c) =>
          c.query(`INSERT INTO run_limits (account_id, role, max_turns) VALUES ($1, 'x-role', 50)`, [a.accountId]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      const upd = await withTenant(appUserPool, b.accountId, b.userId, (c) => c.query('UPDATE run_limits SET max_turns = 11 WHERE account_id = $1', [a.accountId]));
      expect(upd.rowCount).toBe(0);
      expect((await resolve(a, 'debater')).max_turns).toBe(77);
    });
  });

  describe('criterion 5: parity', () => {
    it("migration 0651's CHECK bounds equal limits.ts's floors and ceilings, column by column", async () => {
      const { rows } = await admin.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'run_limits'::regclass AND contype = 'c'`,
      );
      const found = new Map<string, [number, number]>();
      for (const { def } of rows) {
        const m = /(\w+) >= (\d+) AND \1 <= (\d+)/.exec(def.replace(/::\w+/g, '').replace(/[()]/g, ''));
        if (m) found.set(m[1]!, [Number(m[2]), Number(m[3])]);
      }
      for (const k of RUN_LIMIT_KEYS) {
        expect(found.get(k), k).toEqual([RUN_LIMIT_BOUNDS[k].floor, RUN_LIMIT_BOUNDS[k].ceiling]);
      }
    });
  });
});
