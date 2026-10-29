import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { listAccountNotifyRecipients, listAsksDueForNotify, stampAskNotified, stampAskRenotified } from '../src/askNotify.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * [pg] D#7 DP12b-1, migration 0930: the database side of ask notification. Four platform_ops-owned definers (ask_notify_due, the two
 * compare-and-set stamps, account_notify_recipients), executable by the receipt invoker only. "As the invoker" is a LOGIN that is a member of
 * app_user and receipt_writer_invoker (the stand-in for the production receipt login). Fixed ids and states only; no clock is asserted on.
 */
const INVOKER_LOGIN = 'fx_ask_notify_invoker_test';
const OPTIONS = [{ id: 'apply', label: 'QUESTION-OPTION-TEXT apply' }, { id: 'skip', label: 'QUESTION-OPTION-TEXT skip' }];
const TYPE = 'test_strategy_choice';
const FUNCTIONS = ['ask_notify_due(integer)', 'ask_stamp_notified(uuid)', 'ask_stamp_renotified(uuid)', 'account_notify_recipients(uuid)'];

describe('ask notification definers (0930)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let invokerPool: Pool;
  let opsPool: Pool;
  let refs: SeedRefs;
  let other: SeedRefs;

  async function addUser(accountId: string, role: 'owner' | 'admin' | 'member', email?: string): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [id, email ?? `${id}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, id, role]);
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
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    refs = await seedAccount(admin, randomUUID());
    other = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appUserPool.end(), invokerPool.end(), opsPool.end()]);
  });

  /** A raised ask on a fresh item, optionally moved to a state. */
  async function ask(t: SeedRefs = refs, state: 'open' | 'overdue' | 'answered' | 'proceeded' | 'withdrawn' = 'open', timeout: 'stop_and_flag' | 'proceed_recommended' = 'stop_and_flag'): Promise<string> {
    const itemId = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'issue', 'internal', 'in_progress')`, [itemId, t.accountId, t.repoId]);
    const id = (await withTenant(invokerPool, t.accountId, async (c) =>
      (await c.query<{ id: string }>(
        `SELECT decision_ask_raise('human_over_the_loop', $1::text, $2::uuid, NULL, $3::jsonb, 'apply', 'because', '["trusted"]'::jsonb, 60, $4, 0) AS id`,
        [TYPE, itemId, JSON.stringify(OPTIONS), timeout])).rows[0]!.id));
    if (state === 'answered') {
      await admin.query(`UPDATE decision_asks SET state = 'answered', answered_option = 'skip', answered_by = $2, answered_at = now() WHERE id = $1`, [id, t.userId]);
    } else if (state === 'proceeded') {
      await admin.query(`UPDATE decision_asks SET state = 'proceeded', answered_option = proposed, answered_at = now() WHERE id = $1`, [id]);
    } else if (state !== 'open') {
      await admin.query(`UPDATE decision_asks SET state = $2 WHERE id = $1`, [id, state]);
    }
    return id;
  }
  const row = async (id: string) => (await admin.query(`SELECT state, notified_at, renotified_at FROM decision_asks WHERE id = $1`, [id])).rows[0]!;
  const dueIds = async () => (await listAsksDueForNotify(invokerPool, 500)).map((d) => d.askId);

  describe('what the migration pins', () => {
    const q = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows.map((r) => r.x as string);
    const policy = async (name: string) =>
      (await admin.query(`SELECT cmd, roles::text AS roles, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND tablename = 'decision_asks' AND policyname = $1`, [name])).rows;

    it('the four definers: owner platform_ops, pinned search_path, EXECUTE for the invoker only, nothing for PUBLIC or app_user', async () => {
      const rows = (await admin.query(
        `SELECT p.oid::regprocedure::text AS sig, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
                has_function_privilege('receipt_writer_invoker', p.oid, 'EXECUTE') AS invoker,
                has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user,
                has_function_privilege('platform_ops', p.oid, 'EXECUTE') AS ops,
                EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0) AS public_grant
           FROM pg_proc p WHERE p.oid::regprocedure::text = ANY($1) ORDER BY 1`, [FUNCTIONS])).rows;
      expect(rows.map((r) => r.sig)).toEqual([...FUNCTIONS].sort());
      for (const r of rows) {
        expect(r, r.sig).toMatchObject({ owner: 'platform_ops', definer: true, config: ['search_path=pg_catalog, public, pg_temp'], invoker: true, app_user: false, public_grant: false });
      }
      // the receipt invoker's own members get it through the role; no other role holds EXECUTE directly
      expect(await q(`SELECT DISTINCT pg_get_userbyid(x.grantee) AS x FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) x
                       WHERE p.oid::regprocedure::text = ANY($1) AND x.grantee <> p.proowner ORDER BY 1`, [FUNCTIONS])).toEqual(['receipt_writer_invoker']);
    });

    it('the two policies have exactly this text', async () => {
      expect(await policy('platform_ops_ask_notify_select')).toEqual([
        { cmd: 'SELECT', roles: '{platform_ops}', qual: "((SESSION_USER <> 'platform_ops'::name) AND (state = ANY (ARRAY['open'::text, 'overdue'::text])))", with_check: null },
      ]);
      expect(await policy('platform_ops_ask_notify_update')).toEqual([
        {
          cmd: 'UPDATE',
          roles: '{platform_ops}',
          qual: "((SESSION_USER <> 'platform_ops'::name) AND (state = ANY (ARRAY['open'::text, 'overdue'::text])))",
          with_check: "((SESSION_USER <> 'platform_ops'::name) AND (state = ANY (ARRAY['open'::text, 'overdue'::text])))",
        },
      ]);
    });
  });

  describe('ask_notify_due', () => {
    it('returns an open, never-emailed ask once, as a first email; after the stamp it is gone', async () => {
      const id = await ask();
      const found = (await listAsksDueForNotify(invokerPool, 500)).filter((d) => d.askId === id);
      expect(found).toEqual([{ askId: id, accountId: refs.accountId, kind: 'first', timeoutOutcome: 'stop_and_flag' }]);
      expect(await stampAskNotified(invokerPool, id)).toBe(true);
      expect(await dueIds()).not.toContain(id);
    });

    it('returns an overdue ask with no reminder as a reminder, and not after the reminder is stamped', async () => {
      const id = await ask(refs, 'overdue', 'proceed_recommended');
      expect((await listAsksDueForNotify(invokerPool, 500)).filter((d) => d.askId === id)).toEqual([
        { askId: id, accountId: refs.accountId, kind: 'reminder', timeoutOutcome: 'proceed_recommended' },
      ]);
      expect(await stampAskRenotified(invokerPool, id)).toBe(true);
      expect(await dueIds()).not.toContain(id);
    });

    it('never returns a proceeded, answered or withdrawn ask, nor an ask of an inactive account', async () => {
      const ended = [await ask(refs, 'proceeded'), await ask(refs, 'answered'), await ask(refs, 'withdrawn')];
      const t = await seedAccount(admin, randomUUID());
      const gone = await ask(t);
      await admin.query(`UPDATE accounts SET deleted_at = now() WHERE id = $1`, [t.accountId]);
      const ids = await dueIds();
      for (const id of [...ended, gone]) expect(ids).not.toContain(id);
    });

    it('carries no question or option text: the result has exactly four columns, none of them free text', async () => {
      await ask();
      const res = await invokerPool.query('SELECT * FROM ask_notify_due(500)');
      expect(res.fields.map((f) => f.name)).toEqual(['o_ask_id', 'o_account_id', 'o_kind', 'o_timeout_outcome']);
      expect(JSON.stringify(res.rows)).not.toContain('QUESTION-OPTION-TEXT');
    });

    it('refuses a limit outside 1 to 500 and honours the limit', async () => {
      await ask();
      await ask();
      await expect(invokerPool.query('SELECT * FROM ask_notify_due(0)')).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      await expect(invokerPool.query('SELECT * FROM ask_notify_due(501)')).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      expect((await listAsksDueForNotify(invokerPool, 1)).length).toBe(1);
    });
  });

  describe('the compare-and-set stamps', () => {
    it('stamp notified: true once, false the second time, and the column is set exactly once', async () => {
      const id = await ask();
      expect(await stampAskNotified(invokerPool, id)).toBe(true);
      const first = (await row(id)).notified_at as Date;
      expect(first).toBeInstanceOf(Date);
      expect(await stampAskNotified(invokerPool, id)).toBe(false);
      expect((await row(id)).notified_at).toEqual(first);
      expect((await row(id)).renotified_at).toBeNull();
    });

    it('stamp renotified: only for an overdue ask, true once then false', async () => {
      const open = await ask();
      expect(await stampAskRenotified(invokerPool, open)).toBe(false);
      expect((await row(open)).renotified_at).toBeNull();
      const od = await ask(refs, 'overdue');
      expect(await stampAskRenotified(invokerPool, od)).toBe(true);
      expect(await stampAskRenotified(invokerPool, od)).toBe(false);
    });

    it('stamps nothing for an ended or unknown ask', async () => {
      for (const state of ['answered', 'proceeded', 'withdrawn'] as const) {
        const id = await ask(refs, state);
        expect(await stampAskNotified(invokerPool, id), state).toBe(false);
        expect(await stampAskRenotified(invokerPool, id), state).toBe(false);
        expect((await row(id)).notified_at, state).toBeNull();
      }
      expect(await stampAskNotified(invokerPool, '00000000-0000-4000-8000-000000000001')).toBe(false);
    });
  });

  describe('account_notify_recipients', () => {
    it('returns owners and admins only, deduplicated; a member and a removed user are absent', async () => {
      const t = await seedAccount(admin, randomUUID());
      await ask(t);
      await addUser(t.accountId, 'owner', 'owner-fixed@example.test');
      await addUser(t.accountId, 'admin', 'admin-fixed@example.test');
      await addUser(t.accountId, 'member', 'member-fixed@example.test');
      const removed = await addUser(t.accountId, 'admin', 'removed-fixed@example.test');
      await admin.query(`DELETE FROM account_members WHERE user_id = $1`, [removed]);
      const emails = await listAccountNotifyRecipients(invokerPool, t.accountId);
      expect(emails).toEqual(expect.arrayContaining(['owner-fixed@example.test', 'admin-fixed@example.test']));
      expect(emails).not.toContain('member-fixed@example.test');
      expect(emails).not.toContain('removed-fixed@example.test');
      expect(new Set(emails).size).toBe(emails.length);
    });

    it('never returns another account\'s people', async () => {
      await ask(refs);
      await ask(other);
      await addUser(other.accountId, 'owner', 'other-owner-fixed@example.test');
      expect(await listAccountNotifyRecipients(invokerPool, refs.accountId)).not.toContain('other-owner-fixed@example.test');
    });

    it('returns zero rows, not an error, for an account with no owner or admin, no pending ask, or an unknown id', async () => {
      const bare = await seedAccount(admin, randomUUID());
      await admin.query(`DELETE FROM account_members WHERE account_id = $1`, [bare.accountId]);
      await ask(bare);
      expect(await listAccountNotifyRecipients(invokerPool, bare.accountId)).toEqual([]);
      const quiet = await seedAccount(admin, randomUUID());
      await addUser(quiet.accountId, 'owner', 'quiet-owner-fixed@example.test');
      expect(await listAccountNotifyRecipients(invokerPool, quiet.accountId)).toEqual([]);
      expect(await listAccountNotifyRecipients(invokerPool, '00000000-0000-4000-8000-000000000002')).toEqual([]);
    });
  });

  describe('account_notify_recipients on a deleted account', () => {
    it('returns nothing for a soft-deleted account that still has an owner, an admin and an open ask', async () => {
      const t = await seedAccount(admin, randomUUID());
      await ask(t);
      await addUser(t.accountId, 'owner', 'gone-owner-fixed@example.test');
      await addUser(t.accountId, 'admin', 'gone-admin-fixed@example.test');
      expect(await listAccountNotifyRecipients(invokerPool, t.accountId)).toEqual(expect.arrayContaining(['gone-owner-fixed@example.test', 'gone-admin-fixed@example.test']));
      await admin.query(`UPDATE accounts SET deleted_at = now() WHERE id = $1`, [t.accountId]);
      expect(await listAccountNotifyRecipients(invokerPool, t.accountId)).toEqual([]);
    });
  });

  describe('who may call, and what the notify role cannot do directly', () => {
    it('the in-function platform_ops refusal holds on its own, with EXECUTE granted (rolled back)', async () => {
      for (const [name, sql, params] of [
        ['ask_notify_due(integer)', 'SELECT * FROM ask_notify_due($1::integer)', [10]],
        ['ask_stamp_notified(uuid)', 'SELECT ask_stamp_notified($1::uuid)', ['00000000-0000-4000-8000-000000000003']],
        ['ask_stamp_renotified(uuid)', 'SELECT ask_stamp_renotified($1::uuid)', ['00000000-0000-4000-8000-000000000003']],
        ['account_notify_recipients(uuid)', 'SELECT * FROM account_notify_recipients($1::uuid)', ['00000000-0000-4000-8000-000000000003']],
      ] as Array<[string, string, unknown[]]>) {
        const c = await adminPool.connect();
        try {
          await c.query('BEGIN');
          await c.query(`GRANT EXECUTE ON FUNCTION ${name} TO platform_ops`);
          await c.query('SET LOCAL SESSION AUTHORIZATION platform_ops');
          await expect(c.query(sql, params), name).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE, message: expect.stringContaining('refused for a platform_ops login') });
        } finally {
          await c.query('ROLLBACK').catch(() => undefined);
          c.release();
        }
      }
    });

    const calls: Array<[string, string, unknown[]]> = [
      ['ask_notify_due', 'SELECT * FROM ask_notify_due($1::integer)', [10]],
      ['ask_stamp_notified', 'SELECT ask_stamp_notified($1::uuid)', ['00000000-0000-4000-8000-000000000003']],
      ['ask_stamp_renotified', 'SELECT ask_stamp_renotified($1::uuid)', ['00000000-0000-4000-8000-000000000003']],
      ['account_notify_recipients', 'SELECT * FROM account_notify_recipients($1::uuid)', ['00000000-0000-4000-8000-000000000003']],
    ];

    it('a platform_ops login is refused by each function itself, and its row policies show it nothing', async () => {
      for (const [name, sql, params] of calls) {
        await expect(opsPool.query(sql, params), name).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
      await ask();
      expect((await opsPool.query(`SELECT count(*)::int AS n FROM decision_asks WHERE state IN ('open', 'overdue')`)).rows[0].n).toBe(0);
      expect((await opsPool.query(`UPDATE decision_asks SET notified_at = now() WHERE state IN ('open', 'overdue')`)).rowCount).toBe(0);
    });

    it('app_user holds no EXECUTE on any of them', async () => {
      for (const [name, sql, params] of calls) {
        await expect(appUserPool.query(sql, params), name).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });

    it('the intended caller gets the data', async () => {
      const id = await ask();
      for (const [name, sql, params] of calls) {
        await expect(invokerPool.query(sql, params), name).resolves.toBeDefined();
      }
      expect(await dueIds()).toContain(id);
    });

    it('the notify role cannot UPDATE the table directly, and the stamps open no other column', async () => {
      const id = await ask();
      await expect(invokerPool.query(`UPDATE decision_asks SET notified_at = now() WHERE id = $1`, [id])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      // the immutability trigger still holds for every role, owner included
      await expect(admin.query(`UPDATE decision_asks SET proposed = 'skip' WHERE id = $1`, [id])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await stampAskNotified(invokerPool, id);
      const after = await admin.query(`SELECT proposed, answer_due_at, state, answered_option FROM decision_asks WHERE id = $1`, [id]);
      expect(after.rows[0]).toMatchObject({ proposed: 'apply', state: 'open', answered_option: null });
    });
  });
});
