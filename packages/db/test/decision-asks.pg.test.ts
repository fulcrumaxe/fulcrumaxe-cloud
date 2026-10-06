import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * DP11a-1 (D#7 DP-C5): the decision_asks table and decision_ask_raise().
 * "As the invoker" calls run on a LOGIN that is a member of app_user AND
 * receipt_writer_invoker (stand-in for the production receipt login).
 */
const INVOKER_LOGIN = 'fx_receipt_invoker_test';
const RAISE_SQL = `SELECT decision_ask_raise($1::text, $2::text, $3::uuid, $4::uuid, $5::jsonb, $6::text,
                                              $7::text, $8::jsonb, $9::integer, $10::text) AS id`;
const OPTIONS = [
  { id: 'apply', label: 'Apply the change' },
  { id: 'skip', label: 'Skip it' },
];

type Args = {
  cls?: string;
  type?: string;
  workItem?: string;
  run?: string | null;
  options?: unknown;
  proposed?: string | null;
  rationale?: string | null;
  trust?: unknown;
  window?: number | null;
  outcome?: string | null;
};

describe('decision_asks (0666)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let invokerPool: Pool;
  let refs: SeedRefs;
  let other: SeedRefs;

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
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await invokerPool.end();
  });

  const params = (a: Args): unknown[] => [
    a.cls ?? 'human_over_the_loop',
    a.type ?? 'test_strategy_choice',
    a.workItem ?? refs.workItemId,
    a.run === undefined ? null : a.run,
    JSON.stringify(a.options === undefined ? OPTIONS : a.options),
    a.proposed === undefined ? 'apply' : a.proposed,
    a.rationale === undefined ? 'because' : a.rationale,
    JSON.stringify(a.trust === undefined ? ['trusted'] : a.trust),
    a.window === undefined ? 60 : a.window,
    a.outcome === undefined ? 'stop_and_flag' : a.outcome,
  ];
  const raise = (a: Args = {}, tenant: SeedRefs = refs, pool: Pool = invokerPool): Promise<string> =>
    withTenant(pool, tenant.accountId, async (c) => (await c.query<{ id: string }>(RAISE_SQL, params(a))).rows[0]!.id);
  const readBack = async (id: string) => (await admin.query(`SELECT * FROM decision_asks WHERE id = $1`, [id])).rows[0];

  describe('the raise definer', () => {
    it('inserts an open ask with repo_id from the work item and a due time from the window', async () => {
      const id = await raise({ run: refs.runId, window: 90 });
      const row = await readBack(id);
      expect(row).toMatchObject({
        account_id: refs.accountId,
        repo_id: refs.repoId,
        work_item_id: refs.workItemId,
        run_id: refs.runId,
        decision_type: 'test_strategy_choice',
        options: OPTIONS,
        proposed: 'apply',
        rationale: 'because',
        input_trust_classes: ['trusted'],
        timeout_outcome: 'stop_and_flag',
        state: 'open',
        answered_option: null,
        answered_by: null,
        receipt_id: null,
      });
      expect(Math.round((row.answer_due_at - row.raised_at) / 60000)).toBe(90);
    });

    it('a work item without a repo raises an ask with a NULL repo_id', async () => {
      const wi = randomUUID();
      await admin.query(
        `INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, NULL, 'feature', 'internal')`,
        [wi, refs.accountId],
      );
      expect((await readBack(await raise({ workItem: wi }))).repo_id).toBeNull();
    });

    it('refuses class 1 with a named error, and any class that is not 2 or 3', async () => {
      await expect(raise({ cls: 'automated_with_monitoring' })).rejects.toThrow(/ask_class1_never_asks/);
      await expect(raise({ cls: 'bogus' })).rejects.toThrow(/ask_bad_class/);
    });

    it('refuses a proposed option that is not in options', async () => {
      await expect(raise({ proposed: 'merge' })).rejects.toThrow(/ask_proposed_not_in_options/);
      await expect(raise({ proposed: null })).rejects.toThrow(/ask_proposed_not_in_options/);
    });

    const longLabel = 'x'.repeat(201);
    it.each([
      ['one option', [OPTIONS[0]]],
      ['seven options', Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, label: 'l' }))],
      ['not an array', { id: 'apply', label: 'l' }],
      ['an upper-case id', [{ id: 'Apply', label: 'l' }, OPTIONS[1]]],
      ['an id longer than 32 characters', [{ id: `a${'b'.repeat(32)}`, label: 'l' }, OPTIONS[1]]],
      ['the reserved id deny', [{ id: 'deny', label: 'l' }, OPTIONS[1]]],
      ['a label over 200 characters', [{ id: 'apply', label: longLabel }, OPTIONS[1]]],
      ['an empty label', [{ id: 'apply', label: '' }, OPTIONS[1]]],
      ['a duplicate id', [OPTIONS[0], { id: 'apply', label: 'again' }]],
      ['an extra key', [{ ...OPTIONS[0], hint: 'x' }, OPTIONS[1]]],
    ])('refuses options with %s', async (_name, options) => {
      await expect(raise({ options })).rejects.toThrow(/ask_options_invalid/);
    });

    it('accepts six options and a label of exactly 200 characters', async () => {
      const options = [{ id: 'apply', label: 'x'.repeat(200) }, ...Array.from({ length: 5 }, (_, i) => ({ id: `o${i}`, label: 'l' }))];
      expect((await readBack(await raise({ options }))).options).toHaveLength(6);
    });

    it('bounds the rationale at 4 KiB of bytes', async () => {
      await raise({ rationale: 'a'.repeat(4096) });
      await expect(raise({ rationale: 'a'.repeat(4097) })).rejects.toThrow(/ask_rationale_invalid/);
      await expect(raise({ rationale: 'é'.repeat(2049) })).rejects.toThrow(/ask_rationale_invalid/);
      await expect(raise({ rationale: null })).rejects.toThrow(/ask_rationale_invalid/);
    });

    it('bounds the answer window at 15 minutes to 14 days', async () => {
      await raise({ window: 15 });
      await raise({ window: 20160 });
      for (const window of [14, 20161, 0, -5, null]) {
        await expect(raise({ window })).rejects.toThrow(/ask_window_out_of_range/);
      }
    });

    it('takes only the two timeout outcomes, and an array of trust classes', async () => {
      await raise({ outcome: 'proceed_recommended' });
      await expect(raise({ outcome: 'denied' })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(raise({ trust: { a: 1 } })).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it('refuses a call with no tenant', async () => {
      const c = await invokerPool.connect();
      try {
        await expect(c.query(RAISE_SQL, params({}))).rejects.toThrow(/ask_no_tenant/);
      } finally {
        c.release();
      }
    });
  });

  describe('tenant isolation and the only way in', () => {
    it("cannot name another tenant's work item or run", async () => {
      await expect(raise({ workItem: other.workItemId })).rejects.toThrow(/ask_work_item_not_found/);
      await expect(raise({ run: other.runId })).rejects.toThrow(/ask_run_not_for_work_item/);
    });

    it('refuses a run of a different work item in the same account, and a run with no work item', async () => {
      const wi = randomUUID();
      const runNoItem = randomUUID();
      await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'feature', 'internal')`, [wi, refs.accountId, refs.repoId]);
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, NULL, 'executor', 'local', 'running')`,
        [runNoItem, refs.accountId],
      );
      await expect(raise({ workItem: wi, run: refs.runId })).rejects.toThrow(/ask_run_not_for_work_item/);
      await expect(raise({ run: runNoItem })).rejects.toThrow(/ask_run_not_for_work_item/);
      await raise({ run: refs.runId });
    });

    it("app_user sees its own tenant's asks and never another's", async () => {
      const mine = await raise();
      const theirs = await raise({ workItem: other.workItemId }, other);
      const ids = (t: SeedRefs) =>
        withTenant(appUserPool, t.accountId, async (c) => (await c.query(`SELECT id FROM decision_asks`)).rows.map((r) => r.id));
      const seenByMe = await ids(refs);
      expect(seenByMe).toContain(mine);
      expect(seenByMe).not.toContain(theirs);
      expect(await ids(other)).toContain(theirs);
    });

    const DIRECT = `INSERT INTO decision_asks (account_id, work_item_id, decision_type, options, proposed, rationale,
                      input_trust_classes, answer_due_at, timeout_outcome)
                    VALUES ($1, $2, 'x', $3::jsonb, 'apply', 'r', '[]', now() + interval '1 hour', 'stop_and_flag')`;
    it.each([
      ['app_user', () => appUserPool],
      ['the invoker login (a member of app_user)', () => invokerPool],
    ])('a direct INSERT as %s fails with 42501', async (_who, pool) => {
      await expect(
        withTenant(pool(), refs.accountId, refs.userId, (c) => c.query(DIRECT, [refs.accountId, refs.workItemId, JSON.stringify(OPTIONS)])),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it.each(['UPDATE decision_asks SET state = $1', 'DELETE FROM decision_asks WHERE $1 <> $1'])(
      'app_user cannot %s',
      async (sql) => {
        await raise();
        await expect(withTenant(appUserPool, refs.accountId, (c) => c.query(sql, ['withdrawn']))).rejects.toMatchObject({
          code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
        });
      },
    );

    it('a plain app_user login cannot EXECUTE the definer', async () => {
      await expect(raise({}, refs, appUserPool)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('a work item that has an ask cannot be hard-deleted (NO ACTION)', async () => {
      const s = await seedAccount(admin, randomUUID());
      await raise({ workItem: s.workItemId }, s);
      await expect(
        withTenant(appUserPool, s.accountId, (c) => c.query(`DELETE FROM work_items WHERE id = $1`, [s.workItemId])),
      ).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    });

    it('deleting the run leaves the ask in place with run_id NULL', async () => {
      const s = await seedAccount(admin, randomUUID());
      const id = await raise({ workItem: s.workItemId, run: s.runId }, s);
      await admin.query(`DELETE FROM agent_runs WHERE id = $1`, [s.runId]);
      expect(await readBack(id)).toMatchObject({ state: 'open', run_id: null });
    });
  });

  describe('the state machine', () => {
    type State = 'open' | 'overdue' | 'answered' | 'proceeded' | 'withdrawn';
    /** The columns a transition to `to` sets, so that only the guard can reject it. */
    const patch = (to: State): string => {
      const done = `answered_option = 'apply', answered_at = now()`;
      const clear = `answered_option = NULL, answered_at = NULL, answered_by = NULL`;
      return {
        open: clear,
        overdue: clear,
        withdrawn: clear,
        answered: `${done}, answered_by = '${refs.userId}'`,
        proceeded: `${done}, answered_by = NULL`,
      }[to];
    };
    const move = (id: string, to: State) => admin.query(`UPDATE decision_asks SET state = '${to}', ${patch(to)} WHERE id = $1`, [id]);
    const askIn = async (state: State): Promise<string> => {
      const id = await raise();
      if (state !== 'open') await move(id, state);
      return id;
    };
    const overdueThen = async (to: State) => {
      const id = await raise();
      await move(id, 'overdue');
      await move(id, to);
      return id;
    };

    it.each<[State, State]>([
      ['open', 'overdue'],
      ['open', 'answered'],
      ['open', 'proceeded'],
      ['open', 'withdrawn'],
    ])('%s -> %s is allowed', async (from, to) => {
      const id = await askIn(from);
      await move(id, to);
      expect((await readBack(id)).state).toBe(to);
    });

    it.each<State>(['answered', 'proceeded', 'withdrawn'])('overdue -> %s is allowed', async (to) => {
      expect((await readBack(await overdueThen(to))).state).toBe(to);
    });

    const illegal: [State, State][] = [
      ['overdue', 'open'],
      ...(['answered', 'proceeded', 'withdrawn'] as const).flatMap((from) =>
        (['open', 'overdue', 'answered', 'proceeded', 'withdrawn'] as const).filter((to) => to !== from).map((to): [State, State] => [from, to]),
      ),
    ];
    it.each(illegal)('%s -> %s is refused', async (from, to) => {
      const id = await askIn(from);
      await expect(move(id, to)).rejects.toThrow(/decision_asks_illegal_transition/);
      expect((await readBack(id)).state).toBe(from);
    });

    it.each<State>(['answered', 'proceeded', 'withdrawn'])('a %s ask cannot change its answer or its receipt', async (state) => {
      const id = await askIn(state);
      await expect(admin.query(`UPDATE decision_asks SET receipt_id = gen_random_uuid() WHERE id = $1`, [id])).rejects.toThrow(
        /decision_asks_terminal/,
      );
      await expect(admin.query(`UPDATE decision_asks SET notified_at = now() WHERE id = $1`, [id])).rejects.toThrow(
        /decision_asks_terminal/,
      );
    });

    it('the raise-time terms are frozen in every state', async () => {
      const id = await raise();
      for (const set of [
        `proposed = 'skip'`,
        `timeout_outcome = 'proceed_recommended'`,
        `answer_due_at = answer_due_at + interval '1 day'`,
        `options = '[{"id":"a","label":"a"},{"id":"b","label":"b"}]'`,
        `rationale = 'other'`,
        `account_id = '${other.accountId}'`,
        `work_item_id = '${other.workItemId}'`,
      ]) {
        await expect(admin.query(`UPDATE decision_asks SET ${set} WHERE id = $1`, [id])).rejects.toThrow(/decision_asks_frozen/);
      }
    });

    it('an answer must be one of the ask\'s options or deny, and a proceeded ask resolves to proposed', async () => {
      const id = await raise();
      await expect(
        admin.query(`UPDATE decision_asks SET state = 'answered', answered_option = 'merge', answered_at = now(), answered_by = $2 WHERE id = $1`, [id, refs.userId]),
      ).rejects.toThrow(/decision_asks_bad_answer/);
      await expect(
        admin.query(`UPDATE decision_asks SET state = 'proceeded', answered_option = 'skip', answered_at = now() WHERE id = $1`, [id]),
      ).rejects.toThrow(/decision_asks_bad_answer/);
      await admin.query(`UPDATE decision_asks SET state = 'answered', answered_option = 'deny', answered_at = now(), answered_by = $2 WHERE id = $1`, [id, refs.userId]);
      expect((await readBack(id)).answered_option).toBe('deny');
    });
  });

  it('answered_option is only set in answered or proceeded states', async () => {
    const id = await raise();
    for (const set of [`answered_option = 'apply'`, `state = 'withdrawn', answered_option = 'apply'`, `answered_at = now()`]) {
      await expect(admin.query(`UPDATE decision_asks SET ${set} WHERE id = $1`, [id])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    }
  });

  describe('mutation proofs: definer checks', () => {
    it('with the run check removed, a run of another work item is stored', async () => {
      const wi = randomUUID();
      await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance) VALUES ($1, $2, $3, 'feature', 'internal')`, [wi, refs.accountId, refs.repoId]);
      const { rows } = await admin.query<{ def: string }>(
        `SELECT pg_get_functiondef('decision_ask_raise(text,text,uuid,uuid,jsonb,text,text,jsonb,integer,text)'::regprocedure) AS def`,
      );
      const mutated = rows[0]!.def.replace('IF p_run_id IS NOT NULL AND NOT EXISTS', 'IF false AND NOT EXISTS');
      expect(mutated).not.toBe(rows[0]!.def);
      await admin.query('BEGIN');
      try {
        await admin.query(mutated);
        await admin.query(`SELECT set_config('app.account_id', $1, true)`, [refs.accountId]);
        const r = await admin.query(RAISE_SQL, params({ workItem: wi, run: refs.runId }));
        expect((await admin.query(`SELECT run_id FROM decision_asks WHERE id = $1`, [r.rows[0].id])).rows[0].run_id).toBe(refs.runId);
      } finally {
        await admin.query('ROLLBACK');
      }
      await expect(raise({ workItem: wi, run: refs.runId })).rejects.toThrow(/ask_run_not_for_work_item/);
    });

    it('with the check removed from the definer, a proposed option outside options is stored', async () => {
      const { rows } = await admin.query<{ def: string }>(
        `SELECT pg_get_functiondef('decision_ask_raise(text,text,uuid,uuid,jsonb,text,text,jsonb,integer,text)'::regprocedure) AS def`,
      );
      const mutated = rows[0]!.def.replace('IF p_proposed IS NULL OR NOT EXISTS', 'IF false AND NOT EXISTS');
      expect(mutated).not.toBe(rows[0]!.def);
      await admin.query('BEGIN');
      try {
        await admin.query(mutated);
        await admin.query(`SELECT set_config('app.account_id', $1, true)`, [refs.accountId]);
        const r = await admin.query(RAISE_SQL, params({ proposed: 'merge' }));
        expect((await admin.query(`SELECT proposed FROM decision_asks WHERE id = $1`, [r.rows[0].id])).rows[0].proposed).toBe('merge');
      } finally {
        await admin.query('ROLLBACK');
      }
      await expect(raise({ proposed: 'merge' })).rejects.toThrow(/ask_proposed_not_in_options/);
    });
  });
});
