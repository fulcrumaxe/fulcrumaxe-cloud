import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * DP11b (D#7 DP-C9 section 3, criteria 3b and 6): decision_ask_answer(), its column grants and the partial
 * unique index on receipt_id. "As the invoker" runs on a LOGIN that is a member of app_user AND
 * receipt_writer_invoker (the stand-in for the production receipt login).
 */
const INVOKER_LOGIN = 'fx_receipt_invoker_test';
const OPTIONS = [{ id: 'apply', label: 'Apply the change' }, { id: 'skip', label: 'Skip it' }];
const TYPE = 'test_strategy_choice';

describe('decision_ask_answer (0797)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let invokerPool: Pool;
  let refs: SeedRefs;
  let other: SeedRefs;
  let adminUser: string;
  let memberUser: string;
  let strangerUser: string;

  async function addUser(accountId: string | null, role: 'admin' | 'member'): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [id, `${id}@example.test`]);
    if (accountId) await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, id, role]);
    return id;
  }

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
    invokerPool = createPool(u.toString());
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    refs = await seedAccount(admin, randomUUID());
    other = await seedAccount(admin, randomUUID());
    adminUser = await addUser(refs.accountId, 'admin');
    memberUser = await addUser(refs.accountId, 'member');
    strangerUser = await addUser(null, 'member');
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appUserPool.end(), invokerPool.end()]);
  });

  const RAISE_SQL = `SELECT decision_ask_raise('human_over_the_loop', $1::text, $2::uuid, $3::uuid, $4::jsonb, 'apply',
                                                'because', '["trusted"]'::jsonb, 60, 'stop_and_flag') AS id`;
  const raise = (t: SeedRefs = refs, run: string | null = t.runId): Promise<string> =>
    withTenant(invokerPool, t.accountId, async (c) => (await c.query<{ id: string }>(RAISE_SQL, [TYPE, t.workItemId, run, JSON.stringify(OPTIONS)])).rows[0]!.id);
  /** A receipt as the answering person would have written it: matching type, choice, run and actor. */
  async function receipt(t: SeedRefs, o: { choice?: string; run?: string | null; actor?: string; type?: string } = {}): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO decision_receipts (account_id, run_id, work_item_id, decision_type, class, chosen, rejected_alternative,
                                      dial_version, input_trust_classes, actor, catalogue_version)
       VALUES ($1, $2, $3, $4, 'human_over_the_loop', $5, 'deny', 0, '["trusted"]'::jsonb, $6, 1) RETURNING id`,
      [t.accountId, o.run === undefined ? t.runId : o.run, t.workItemId, o.type ?? TYPE, o.choice ?? 'skip', o.actor ?? t.userId],
    );
    return rows[0]!.id;
  }
  /** Calls the definer as `user` (null: no user) of `t`, optionally with a token set. */
  function answer(askId: string, choice: string, receiptId: string | null, as: { t?: SeedRefs; user?: string | null; token?: string; pool?: Pool } = {}): Promise<void> {
    const t = as.t ?? refs;
    const user = as.user === undefined ? t.userId : as.user;
    const run = async (c: PoolClient) => { await c.query('SELECT decision_ask_answer($1::uuid, $2::text, $3::uuid)', [askId, choice, receiptId]); };
    const pool = as.pool ?? invokerPool;
    if (user === null) return withTenant(pool, t.accountId, run);
    return as.token ? withTenant(pool, t.accountId, user, as.token, run) : withTenant(pool, t.accountId, user, run);
  }
  const readAsk = async (id: string) => (await admin.query(`SELECT * FROM decision_asks WHERE id = $1`, [id])).rows[0];
  const stillOpen = async (id: string) => expect((await readAsk(id)).state).toBe('open');

  describe('the definer\'s shape', () => {
    it('is owned by receipt_writer, security definer, pinned search_path, EXECUTE for the invoker only', async () => {
      const { rows } = await admin.query(
        `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig,
                (SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END)
                   FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner) AS grantees,
                (SELECT array_agg(n) FROM unnest(p.proargnames) n) AS names
           FROM pg_proc p WHERE p.proname = 'decision_ask_answer'`,
      );
      expect(rows).toEqual([{
        owner: 'receipt_writer', prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'],
        grantees: ['receipt_writer_invoker'], names: ['p_ask_id', 'p_choice', 'p_receipt_id'],
      }]);
    });

    it('plain app_user cannot call it', async () => {
      const id = await raise();
      await expect(answer(id, 'skip', await receipt(refs), { pool: appUserPool })).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await stillOpen(id);
    });

    it('has a partial unique index on receipt_id', async () => {
      const { rows } = await admin.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'decision_asks_receipt_id_key'`);
      expect(rows[0].indexdef).toMatch(/UNIQUE INDEX .*\(receipt_id\) WHERE \(receipt_id IS NOT NULL\)/);
      const [a, b, r] = [await raise(), await raise(), await receipt(refs)];
      await answer(a, 'skip', r);
      await expect(admin.query(`UPDATE decision_asks SET receipt_id = $1 WHERE id = $2`, [r, b])).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    });
  });

  describe('the named exceptions', () => {
    it('ask_session_required: a token, no user, or a user who is not a member', async () => {
      const id = await raise();
      const r = await receipt(refs);
      await expect(answer(id, 'skip', r, { token: randomUUID() })).rejects.toThrow(/^ask_session_required/);
      await expect(answer(id, 'skip', r, { user: null })).rejects.toThrow(/^ask_session_required/);
      await expect(answer(id, 'skip', r, { user: strangerUser })).rejects.toThrow(/^ask_session_required/);
      await stillOpen(id);
    });

    it('ask_forbidden: a member who is not owner or admin; an admin and an owner may answer', async () => {
      const [m, a, o] = [await raise(), await raise(), await raise()];
      await expect(answer(m, 'skip', await receipt(refs, { actor: memberUser }), { user: memberUser })).rejects.toThrow(/^ask_forbidden/);
      await stillOpen(m);
      await answer(a, 'skip', await receipt(refs, { actor: adminUser }), { user: adminUser });
      await answer(o, 'deny', await receipt(refs, { choice: 'deny' }));
      expect(await readAsk(a)).toMatchObject({ state: 'answered', answered_by: adminUser, answered_option: 'skip' });
      expect(await readAsk(o)).toMatchObject({ state: 'answered', answered_by: refs.userId, answered_option: 'deny' });
    });

    it('ask_not_found: an unknown id, and another tenant\'s ask', async () => {
      const foreign = await raise(other);
      const r = await receipt(refs);
      await expect(answer(randomUUID(), 'skip', r)).rejects.toThrow(/^ask_not_found/);
      await expect(answer(foreign, 'skip', r)).rejects.toThrow(/^ask_not_found/);
      await stillOpen(foreign);
    });

    it('ask_bad_choice: not an option of this ask', async () => {
      const id = await raise();
      await expect(answer(id, 'merge', await receipt(refs, { choice: 'merge' }))).rejects.toThrow(/^ask_bad_choice/);
      await stillOpen(id);
    });

    it('ask_no_run: the ask has no run', async () => {
      const id = await raise(refs, null);
      await expect(answer(id, 'skip', await receipt(refs))).rejects.toThrow(/^ask_no_run/);
      await stillOpen(id);
    });

    it('ask_receipt_mismatch: no receipt, a different tenant\'s, choice, type, run or person', async () => {
      const id = await raise();
      const bad = [
        null, randomUUID(), await receipt(other), await receipt(refs, { choice: 'apply' }), await receipt(refs, { type: 'nonbreaking_refactor_approach' }),
        await receipt(refs, { run: null }), await receipt(refs, { actor: adminUser }), await receipt(refs, { actor: 'policy' }),
      ];
      for (const r of bad) await expect(answer(id, 'skip', r)).rejects.toThrow(/^ask_receipt_mismatch/);
      await stillOpen(id);
    });

    it('ask_receipt_mismatch: a receipt another ask already carries', async () => {
      const [a, b, r] = [await raise(), await raise(), await receipt(refs)];
      await answer(a, 'skip', r);
      await expect(answer(b, 'skip', r)).rejects.toThrow(/^ask_receipt_mismatch/);
      await stillOpen(b);
    });

    it('ask_already_answered: the CAS finds no open or overdue ask, and writes nothing', async () => {
      const [id, p, w] = [await raise(), await raise(), await raise()];
      await answer(id, 'skip', await receipt(refs));
      const before = await readAsk(id);
      await expect(answer(id, 'apply', await receipt(refs, { choice: 'apply' }))).rejects.toThrow(/^ask_already_answered/);
      expect(await readAsk(id)).toEqual(before);
      await admin.query(`UPDATE decision_asks SET state = 'proceeded', answered_option = proposed, answered_at = now() WHERE id = $1`, [p]);
      await admin.query(`UPDATE decision_asks SET state = 'withdrawn' WHERE id = $1`, [w]);
      for (const x of [p, w]) await expect(answer(x, 'skip', await receipt(refs))).rejects.toThrow(/^ask_already_answered/);
    });

    it('an overdue ask can be answered, and the receipt is linked in the same update', async () => {
      const id = await raise();
      await admin.query(`UPDATE decision_asks SET state = 'overdue' WHERE id = $1`, [id]);
      const r = await receipt(refs);
      await answer(id, 'skip', r);
      expect(await readAsk(id)).toMatchObject({ state: 'answered', answered_option: 'skip', answered_by: refs.userId, receipt_id: r });
    });
  });
});
