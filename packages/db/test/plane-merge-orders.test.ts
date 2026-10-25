import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * Migration 0910 (D#6 PUBLIC-MERGE PR2a): plane_merge_orders on a real Postgres with the whole chain applied. Covers the shapes, the one open order per
 * item, every move of the state table (allowed and refused) and that a finished order is final, the once-only write credential, tenant isolation under the
 * app role, and the catalog facts (forced RLS, no DELETE, the guard function's pinned path and closed grants).
 */
describe('plane_merge_orders (migration 0910)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let runnerA: string;
  const HEAD = 'a'.repeat(40);
  const REVIEWED = 'b'.repeat(40);
  const DIGEST = 'c'.repeat(64);

  const as = <T>(who: SeedRefs, fn: (c: PoolClient) => Promise<T>) => withTenant(appPool, who.accountId, who.userId, fn);

  async function freshItem(who: SeedRefs): Promise<{ itemId: string; pushId: string }> {
    const itemId = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'feature', 'internal')`, [itemId, who.accountId, who.repoId]);
    const { rows } = await admin.query(
      `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest, state, head_sha, tip_sha, pr_number, pr_url, source_head)
       VALUES ($1, $2, $3, 'acme/pub', $4, 'pr_opened', $5, $5, 7, 'https://github.com/acme/pub/pull/7', $6) RETURNING id`,
      [who.accountId, itemId, who.repoId, DIGEST, HEAD, REVIEWED],
    );
    return { itemId, pushId: rows[0].id as string };
  }
  const insertOrder = (who: SeedRefs, item: { itemId: string; pushId: string }, over: Record<string, unknown> = {}) => {
    const v = { code_repo: 'acme/pub', pr_number: 7, expected_public_head: HEAD, reviewed_head: REVIEWED, pairing_digest: DIGEST, deadline: new Date(Date.now() + 3_600_000), ...over };
    return as(who, (c) =>
      c.query<{ id: string; state: string }>(
        `INSERT INTO plane_merge_orders (account_id, work_item_id, plane_push_id, repo_id, code_repo, pr_number, expected_public_head, reviewed_head, pairing_digest, deadline_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, state`,
        [who.accountId, item.itemId, item.pushId, who.repoId, v.code_repo, v.pr_number, v.expected_public_head, v.reviewed_head, v.pairing_digest, v.deadline],
      ),
    );
  };
  const upd = (who: SeedRefs, id: string, set: string, params: unknown[] = []) => as(who, (c) => c.query(`UPDATE plane_merge_orders SET ${set} WHERE id = $1`, [id, ...params]));
  const stateOf = async (id: string) => (await admin.query(`SELECT state FROM plane_merge_orders WHERE id = $1`, [id])).rows[0].state as string;

  /** An order moved to `state` by the legal path, so each case starts from a row that satisfies every shape check. */
  async function orderIn(state: string): Promise<{ id: string; item: { itemId: string; pushId: string } }> {
    const item = await freshItem(a);
    const id = (await insertOrder(a, item)).rows[0]!.id;
    const claim = `state = 'claimed', runner_id = '${runnerA}', lease_generation = 1, attempts = 1, lease_expires_at = now() + interval '10 minutes'`;
    const authorize = `state = 'authorized', write_token_issued_at = now()`;
    const done = (to: string, extra = '') => `state = '${to}', outcome_code = 'x_code', finished_at = now() ${extra}`;
    if (state === 'pending') return { id, item };
    if (state === 'claimed') await upd(a, id, claim);
    else if (state === 'authorized') {
      await upd(a, id, claim);
      await upd(a, id, authorize);
    } else if (state === 'merged') {
      await upd(a, id, claim);
      await upd(a, id, authorize);
      await upd(a, id, done('merged'));
    } else if (['blocked', 'head_moved', 'failed'].includes(state)) {
      await upd(a, id, claim);
      await upd(a, id, done(state));
    } else await upd(a, id, done(state));
    return { id, item };
  }

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    runnerA = await insertRunner(admin, a.accountId, a.userId);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
  });

  it('stores a pending order with no runner and no lease, defaults the credential label, and stamps the clock', async () => {
    const item = await freshItem(a);
    const id = (await insertOrder(a, item)).rows[0]!.id;
    const row = (await admin.query(`SELECT * FROM plane_merge_orders WHERE id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ state: 'pending', runner_id: null, lease_generation: 0, attempts: 0, lease_expires_at: null, write_token_issued_at: null, read_token_generation: null, token_purpose: 'app_installation_single_use', outcome_code: null, finished_at: null });
    expect(row.created_at).toBeInstanceOf(Date);
  });

  it('enforces the shapes in the database', async () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ['no slash', { code_repo: 'widgets' }],
      ['dots', { code_repo: 'acme/..' }],
      ['pr 0', { pr_number: 0 }],
      ['short public head', { expected_public_head: 'abc' }],
      ['upper-case reviewed head', { reviewed_head: 'B'.repeat(40) }],
      ['short digest', { pairing_digest: 'abc' }],
    ];
    for (const [label, over] of bad) await expect(insertOrder(a, await freshItem(a), over), label).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    const { id } = await orderIn('pending');
    const refused: Array<[string, string]> = [
      ['an unknown state', `state = 'nope'`],
      ['a fourth attempt', `attempts = 4`],
      ['a claimed order without a lease', `state = 'claimed', lease_generation = 0`],
      ['a pending order that names a runner', `runner_id = '${runnerA}'`],
      ['a pending order with a write credential', `write_token_issued_at = now()`],
      ['an outcome code with capitals', `outcome_code = 'Bad Code'`],
      ['a purpose with spaces', `token_purpose = 'a b'`],
      ['a finished state without finished_at', `state = 'expired', outcome_code = 'x'`],
      ['finished_at on an open order', `finished_at = now(), outcome_code = 'x'`],
      ['a read credential for a generation not yet leased', `read_token_generation = 1`],
    ];
    for (const [label, set] of refused) await expect(upd(a, id, set), label).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    expect(await stateOf(id)).toBe('pending');
    const claimed = await orderIn('claimed');
    await expect(upd(a, claimed.id, `state = 'authorized'`), 'authorized without its issue time').rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    await expect(upd(a, claimed.id, `state = 'merged', outcome_code = 'merged', finished_at = now()`), 'merged without a write credential').rejects.toBeTruthy();
  });

  it('refuses an INSERT that is not a fresh pending order (0912): every other state or counter, written directly', async () => {
    const cols = `(account_id, work_item_id, plane_push_id, repo_id, code_repo, pr_number, expected_public_head, reviewed_head, pairing_digest, deadline_at`;
    const born: Array<[string, string, string]> = [
      ['already claimed', `, state, runner_id, lease_generation, lease_expires_at, attempts`, `, 'claimed', '${runnerA}', 1, now() + interval '10 minutes', 1`],
      ['already authorized', `, state, runner_id, lease_generation, lease_expires_at, attempts, write_token_issued_at`, `, 'authorized', '${runnerA}', 1, now() + interval '10 minutes', 1, now()`],
      ['already merged', `, state, write_token_issued_at, outcome_code, finished_at`, `, 'merged', now(), 'merged', now()`],
      ['already expired', `, state, outcome_code, finished_at`, `, 'expired', 'runner_merge_timeout', now()`],
      ['with a runner', `, runner_id`, `, '${runnerA}'`],
      ['with attempts', `, attempts`, `, 2`],
      ['with a lease generation', `, lease_generation`, `, 2`],
      ['with a read credential mark', `, lease_generation, state, runner_id, lease_expires_at, read_token_generation`, `, 1, 'claimed', '${runnerA}', now() + interval '10 minutes', 1`],
      ['with an outcome code', `, outcome_code`, `, 'x_code'`],
    ];
    for (const [label, extraCols, extraVals] of born) {
      const item = await freshItem(a);
      await expect(
        as(a, (c) =>
          c.query(`INSERT INTO plane_merge_orders ${cols}${extraCols}) VALUES ($1, $2, $3, $4, 'acme/pub', 7, $5, $6, $7, now() + interval '1 hour'${extraVals})`, [a.accountId, item.itemId, item.pushId, a.repoId, HEAD, REVIEWED, DIGEST]),
        ),
        label,
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    }
    // The ordinary insert still works.
    expect((await insertOrder(a, await freshItem(a))).rows[0]!.state).toBe('pending');
  });

  it('allows one open order per item, and another once it is finished', async () => {
    const item = await freshItem(a);
    const first = (await insertOrder(a, item)).rows[0]!.id;
    await expect(insertOrder(a, item)).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    await upd(a, first, `state = 'superseded', outcome_code = 'superseded_by_new_order', finished_at = now()`);
    const second = (await insertOrder(a, item)).rows[0]!.id;
    expect(second).not.toBe(first);
    // A claimed or authorized order is open too.
    await upd(a, second, `state = 'claimed', runner_id = '${runnerA}', lease_generation = 1, attempts = 1, lease_expires_at = now() + interval '10 minutes'`);
    await expect(insertOrder(a, item)).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
  });

  describe('the table of moves', () => {
    const OPEN = ['pending', 'claimed', 'authorized'];
    const TERMINAL = ['merged', 'blocked', 'head_moved', 'superseded', 'failed', 'expired'];
    const ALLOWED: Record<string, string[]> = {
      pending: ['claimed', 'blocked', 'superseded', 'expired'],
      claimed: ['pending', 'authorized', 'blocked', 'head_moved', 'superseded', 'failed', 'expired'],
      authorized: ['merged', 'head_moved', 'superseded', 'failed', 'expired'],
    };
    /** The columns each target state needs to satisfy the shape checks, so a refusal can only come from the move table. */
    const target = (from: string, to: string): string => {
      const fin = `outcome_code = 'x_code', finished_at = now()`;
      if (to === 'pending') return `state = 'pending', runner_id = NULL, lease_expires_at = NULL`;
      if (to === 'claimed') return `state = 'claimed', runner_id = '${runnerA}', lease_generation = 1, attempts = 1, lease_expires_at = now() + interval '10 minutes'`;
      if (to === 'authorized') return `state = 'authorized', write_token_issued_at = now()`;
      if (to === 'merged') return `state = 'merged', ${fin}${from === 'authorized' ? '' : ', write_token_issued_at = now()'}`;
      return `state = '${to}', ${fin}`;
    };

    for (const from of OPEN) {
      for (const to of [...OPEN, ...TERMINAL].filter((s) => s !== from)) {
        const ok = ALLOWED[from]!.includes(to);
        it(`${from} -> ${to} is ${ok ? 'allowed' : 'refused'}`, async () => {
          const { id } = await orderIn(from);
          const run = upd(a, id, target(from, to));
          if (ok) {
            await run;
            expect(await stateOf(id)).toBe(to);
          } else {
            await expect(run).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
            expect(await stateOf(id)).toBe(from);
          }
        });
      }
    }

    for (const from of TERMINAL) {
      it(`a ${from} order never changes again, not even its note`, async () => {
        const { id } = await orderIn(from);
        for (const set of [`outcome_code = 'other'`, `state = 'pending', runner_id = NULL, lease_expires_at = NULL, finished_at = NULL, outcome_code = NULL`, `attempts = attempts`]) {
          await expect(upd(a, id, set), set).rejects.toBeTruthy();
        }
        expect(await stateOf(id)).toBe(from);
      });
    }
  });

  it('identity is fixed, counters only grow, and the write credential is issued once', async () => {
    const { id } = await orderIn('authorized');
    for (const set of [`work_item_id = '${randomUUID()}'`, `code_repo = 'acme/else'`, `pr_number = 8`, `expected_public_head = '${'d'.repeat(40)}'`, `reviewed_head = '${'d'.repeat(40)}'`, `pairing_digest = '${'d'.repeat(64)}'`, `token_purpose = 'other'`, `deadline_at = now() + interval '9 hours'`, `created_at = now() - interval '1 day'`]) {
      await expect(upd(a, id, set), set).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    }
    await expect(upd(a, id, `write_token_issued_at = now() + interval '1 second'`), 'write credential moved').rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    await expect(upd(a, id, `write_token_issued_at = NULL`), 'write credential cleared').rejects.toBeTruthy();
    await expect(upd(a, id, `lease_generation = 0`), 'generation shrinks').rejects.toBeTruthy();
    await expect(upd(a, id, `attempts = 0`), 'attempts shrink').rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    const claimed = await orderIn('claimed');
    await upd(a, claimed.id, `read_token_generation = 1`);
    await expect(upd(a, claimed.id, `read_token_generation = NULL`), 'read credential cleared').rejects.toBeTruthy();
    const before = (await admin.query(`SELECT updated_at FROM plane_merge_orders WHERE id = $1`, [claimed.id])).rows[0].updated_at as Date;
    await new Promise((r) => setTimeout(r, 15));
    await upd(a, claimed.id, `lease_expires_at = now() + interval '9 minutes'`);
    const after = (await admin.query(`SELECT updated_at FROM plane_merge_orders WHERE id = $1`, [claimed.id])).rows[0].updated_at as Date;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  it('a claimed order survives the deletion of its runner row, and no runner then matches it', async () => {
    const item = await freshItem(a);
    const id = (await insertOrder(a, item)).rows[0]!.id;
    const gone = await insertRunner(admin, a.accountId, a.userId);
    await upd(a, id, `state = 'claimed', runner_id = '${gone}', lease_generation = 1, attempts = 1, lease_expires_at = now() + interval '10 minutes'`);
    await admin.query(`DELETE FROM runners WHERE id = $1`, [gone]);
    const row = (await admin.query(`SELECT state, runner_id FROM plane_merge_orders WHERE id = $1`, [id])).rows[0];
    expect(row).toEqual({ state: 'claimed', runner_id: null });
  });

  describe('tenant isolation', () => {
    it('another account sees none of the orders, changes none, and cannot place one against them', async () => {
      const { id, item } = await orderIn('pending');
      expect((await as(b, (c) => c.query(`SELECT id FROM plane_merge_orders WHERE id = $1`, [id]))).rows).toHaveLength(0);
      expect((await as(b, (c) => c.query(`UPDATE plane_merge_orders SET state = 'expired', outcome_code = 'x', finished_at = now() WHERE id = $1`, [id]))).rowCount).toBe(0);
      expect(await stateOf(id)).toBe('pending');
      // Inserting under B's tenant with A's account id is refused by the policy; with B's id but A's item or push, by the composite keys.
      await expect(as(b, (c) => c.query(`INSERT INTO plane_merge_orders (account_id, work_item_id, plane_push_id, repo_id, code_repo, pr_number, expected_public_head, reviewed_head, pairing_digest, deadline_at) VALUES ($1, $2, $3, $4, 'acme/pub', 7, $5, $6, $7, now())`, [a.accountId, item.itemId, item.pushId, a.repoId, HEAD, REVIEWED, DIGEST]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(as(b, (c) => c.query(`INSERT INTO plane_merge_orders (account_id, work_item_id, plane_push_id, repo_id, code_repo, pr_number, expected_public_head, reviewed_head, pairing_digest, deadline_at) VALUES ($1, $2, $3, $4, 'acme/pub', 7, $5, $6, $7, now())`, [b.accountId, item.itemId, item.pushId, b.repoId, HEAD, REVIEWED, DIGEST]))).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    });
    it('without a tenant the app role sees nothing, and it can never delete', async () => {
      const { id } = await orderIn('pending');
      expect((await appPool.query(`SELECT id FROM plane_merge_orders`).catch((e: unknown) => ({ rows: [], e }))).rows).toHaveLength(0);
      await expect(as(a, (c) => c.query(`DELETE FROM plane_merge_orders WHERE id = $1`, [id]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
    it('deleting the account (or the push record, or the item) removes its orders', async () => {
      const item = await freshItem(a);
      const id = (await insertOrder(a, item)).rows[0]!.id;
      await admin.query(`DELETE FROM work_items WHERE id = $1`, [item.itemId]);
      expect((await admin.query(`SELECT 1 FROM plane_merge_orders WHERE id = $1`, [id])).rows).toHaveLength(0);
    });
  });

  describe('the catalog', () => {
    it('has forced row-level security with the tenant policy, and only SELECT, INSERT and UPDATE for the app role', async () => {
      const t = (await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'plane_merge_orders'`)).rows[0];
      expect(t).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      const pol = (await admin.query(`SELECT polname, polroles::regrole[]::text AS roles FROM pg_policy WHERE polrelid = 'plane_merge_orders'::regclass`)).rows;
      expect(pol).toEqual([{ polname: 'tenant_isolation', roles: '{app_user}' }]);
      const priv = async (p: string) => (await admin.query(`SELECT has_table_privilege('app_user', 'plane_merge_orders', $1) AS ok`, [p])).rows[0].ok as boolean;
      expect([await priv('SELECT'), await priv('INSERT'), await priv('UPDATE')]).toEqual([true, true, true]);
      expect([await priv('DELETE'), await priv('TRUNCATE')]).toEqual([false, false]);
      expect((await admin.query(`SELECT has_table_privilege('public', 'plane_merge_orders', 'SELECT') AS ok`)).rows[0].ok).toBe(false);
    });
    it('the guard function has a pinned search path, is not executable by public or the app role, and the triggers are in place', async () => {
      const fn = (await admin.query(`SELECT proconfig, prosecdef, has_function_privilege('app_user', oid, 'EXECUTE') AS app, has_function_privilege('public', oid, 'EXECUTE') AS pub FROM pg_proc WHERE proname = 'plane_merge_orders_guard'`)).rows;
      expect(fn).toHaveLength(1);
      expect(fn[0].proconfig).toEqual(['search_path=pg_catalog, pg_temp']);
      expect(fn[0]).toMatchObject({ prosecdef: false, app: false, pub: false });
      const trg = (await admin.query(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'plane_merge_orders'::regclass AND NOT tgisinternal`)).rows.map((r) => r.tgname);
      expect(trg).toEqual(['plane_merge_orders_guard']);
    });
    it('the one-open index is partial over the three open states', async () => {
      const def = (await admin.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'plane_merge_orders_one_open'`)).rows[0].indexdef as string;
      expect(def).toMatch(/UNIQUE INDEX.*\(account_id, work_item_id\)/);
      for (const s of ['pending', 'claimed', 'authorized']) expect(def).toContain(`'${s}'`);
    });
  });
});
