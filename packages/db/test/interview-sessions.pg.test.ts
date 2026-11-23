import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedF2, type F2Fixture } from './helpers/members.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * [pg] migration 1065, the interview sessions: what each role can write, who can read what (own, owner/admin, nobody else), the rev trigger, the
 * read-only terminal states, the three definers and the bounds inside `interview_session_start`. Fixtures go in through the admin client, which
 * reads past RLS, so a missing predicate cannot hide behind the policy.
 */
describe('interview sessions (migration 1065) [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let opsPool: Pool;
  let A: F2Fixture;
  let B: F2Fixture;

  const insert = async (f: F2Fixture, by: string, o: { status?: string; startedAgo?: string } = {}): Promise<string> =>
    (
      await admin.query<{ id: string }>(
        `INSERT INTO interview_sessions (account_id, created_by, manifest_id, manifest_version, status, started_at, finished_at)
         VALUES ($1, $2, 'prd', '1', $3, now() - $4::interval, CASE WHEN $3 = 'finished' THEN now() END) RETURNING id`,
        [f.accountId, by, o.status ?? 'active', o.startedAgo ?? '0 seconds'],
      )
    ).rows[0]!.id;
  const as = <T>(f: F2Fixture, user: string, fn: (c: PoolClient) => Promise<T>): Promise<T> => withTenant(appPool, f.accountId, user, fn);
  const ids = async (f: F2Fixture, user: string): Promise<string[]> => (await as(f, user, (c) => c.query<{ id: string }>('SELECT id FROM interview_sessions'))).rows.map((r) => r.id);
  const wipe = (f: F2Fixture) => admin.query('DELETE FROM interview_sessions WHERE account_id = $1', [f.accountId]);

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!, { max: 20 } as never);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    A = await seedF2(admin);
    B = await seedF2(admin);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end(), opsPool.end()]);
  });

  describe('who can read and write', () => {
    it('a person reads their own, an owner or admin reads the account, another member reads none, another account reads none', async () => {
      await wipe(A);
      const mine = await insert(A, A.m1);
      const theirs = await insert(A, A.m2);
      const foreign = await insert(B, B.m1);
      expect(await ids(A, A.m1)).toEqual([mine]);
      expect((await ids(A, A.a1)).sort()).toEqual([mine, theirs].sort());
      expect((await ids(A, A.o2)).sort()).toEqual([mine, theirs].sort());
      expect(await ids(A, A.m2)).toEqual([theirs]);
      // The admin reads past RLS with a foreign account id and finds nothing of A's under B.
      expect((await admin.query('SELECT 1 FROM interview_sessions WHERE account_id = $1 AND id = ANY($2)', [B.accountId, [mine, theirs]])).rowCount).toBe(0);
      expect(await ids(B, B.m1)).toEqual([foreign]);
      // A user id that is not a member of the account matches nothing as itself.
      expect(await ids(A, B.m1)).toEqual([]);
    });

    it('a member cannot read another member\'s session by id, and an admin cannot write it', async () => {
      await wipe(A);
      const s = await insert(A, A.m1);
      expect((await as(A, A.m2, (c) => c.query('SELECT 1 FROM interview_sessions WHERE id = $1', [s]))).rowCount).toBe(0);
      expect((await as(A, A.a1, (c) => c.query(`UPDATE interview_sessions SET answers = '{"x":{}}' WHERE id = $1`, [s]))).rowCount).toBe(0);
      expect((await as(A, A.m1, (c) => c.query(`UPDATE interview_sessions SET answers = '{"x":{}}' WHERE id = $1`, [s]))).rowCount).toBe(1);
    });

    it('app_user cannot insert or delete a row, and can update only answers, followups and repo_id', async () => {
      await wipe(A);
      const s = await insert(A, A.m1);
      await expect(as(A, A.m1, (c) => c.query(`INSERT INTO interview_sessions (account_id, created_by, manifest_id, manifest_version) VALUES ($1, $2, 'prd', '1')`, [A.accountId, A.m1]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(as(A, A.m1, (c) => c.query('DELETE FROM interview_sessions WHERE id = $1', [s]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const forbidden: Array<[string, unknown]> = [
        ['status', 'finished'],
        ['spent_usd', 0],
        ['turn_count', 5],
        ['turn_in_flight_until', new Date(Date.now() + 60_000)],
        ['project_discussion_id', randomUUID()],
        ['finished_at', new Date()],
        ['rev', 99],
        ['manifest_version', '2'],
        ['created_by', A.m2],
        ['account_id', B.accountId],
        ['started_at', new Date()],
      ];
      for (const [col, val] of forbidden) {
        await expect(as(A, A.m1, (c) => c.query(`UPDATE interview_sessions SET ${col} = $2 WHERE id = $1`, [s, val])), col).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
      for (const col of ['answers', 'followups']) {
        expect((await as(A, A.m1, (c) => c.query(`UPDATE interview_sessions SET ${col} = '{"s":{}}' WHERE id = $1`, [s]))).rowCount, col).toBe(1);
      }
    });

    it('a runner session sees and writes nothing, and a platform_ops login cannot start one', async () => {
      await wipe(A);
      await insert(A, A.m1);
      const seen = await as(A, A.m1, async (c) => {
        await c.query(`SELECT set_config('app.runner_id', $1, true)`, [randomUUID()]);
        return (await c.query('SELECT 1 FROM interview_sessions')).rowCount;
      });
      expect(seen).toBe(0);
      await expect(withTenant(opsPool, A.accountId, A.m1, (c) => c.query(`SELECT interview_session_start('prd', '1', NULL)`))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('the session functions and row tests are executable by app_user alone, and the guard trigger function by nobody else', async () => {
      const { rows } = await admin.query<{ proname: string; public_exec: boolean; app_exec: boolean }>(
        `SELECT proname, has_function_privilege('public', oid, 'EXECUTE') AS public_exec, has_function_privilege('app_user', oid, 'EXECUTE') AS app_exec
           FROM pg_proc WHERE proname LIKE 'interview\\_%' AND pronamespace = 'public'::regnamespace`,
      );
      const by = new Map(rows.map((r) => [r.proname, r]));
      for (const fn of ['interview_session_start', 'interview_session_abandon', 'interview_session_counts', 'interview_session_is_own', 'interview_session_is_readable']) expect(by.get(fn), fn).toMatchObject({ public_exec: false, app_exec: true });
      for (const fn of ['interview_assert_person', 'interview_sessions_guard']) expect(by.get(fn), fn).toMatchObject({ public_exec: false, app_exec: false });
    });
  });

  describe('rev and the read-only states', () => {
    it('bumps rev when the answers, followups, repo or status change, and not for a counter', async () => {
      await wipe(A);
      const s = await insert(A, A.m1);
      const rev = async () => (await admin.query<{ rev: number }>('SELECT rev FROM interview_sessions WHERE id = $1', [s])).rows[0]!.rev;
      expect(await rev()).toBe(1);
      await as(A, A.m1, (c) => c.query(`UPDATE interview_sessions SET answers = '{"a":{}}' WHERE id = $1`, [s]));
      expect(await rev()).toBe(2);
      await as(A, A.m1, (c) => c.query(`UPDATE interview_sessions SET answers = answers WHERE id = $1`, [s]));
      expect(await rev()).toBe(2);
      await admin.query('UPDATE interview_sessions SET spent_usd = 0.5, turn_count = 3, turn_in_flight_until = now() WHERE id = $1', [s]);
      expect(await rev()).toBe(2);
      await admin.query(`UPDATE interview_sessions SET status = 'capped' WHERE id = $1`, [s]);
      expect(await rev()).toBe(3);
      // Even a direct write cannot set it.
      await admin.query('UPDATE interview_sessions SET rev = 50 WHERE id = $1', [s]);
      expect(await rev()).toBe(3);
    });

    it('a finished or abandoned session cannot change its answers, status, repo or link, even through the admin connection; its counters still settle', async () => {
      await wipe(A);
      for (const status of ['finished', 'abandoned']) {
        const s = await insert(A, A.m1, { status });
        for (const set of [`answers = '{"z":{}}'`, `followups = '{"z":1}'`, `status = 'active'`, `project_discussion_id = gen_random_uuid()`]) {
          await expect(admin.query(`UPDATE interview_sessions SET ${set} WHERE id = $1`, [s]), `${status} ${set}`).rejects.toMatchObject({ code: '23000' });
        }
        await admin.query('UPDATE interview_sessions SET spent_usd = 0.25, turn_in_flight_until = NULL WHERE id = $1', [s]);
        // The person's own UPDATE finds no row at all.
        expect((await as(A, A.m1, (c) => c.query(`UPDATE interview_sessions SET answers = '{}' WHERE id = $1`, [s]))).rowCount).toBe(0);
      }
    });

    it('the pinned manifest and identity never change, and the project link is set once', async () => {
      await wipe(A);
      const s = await insert(A, A.m1);
      await expect(admin.query(`UPDATE interview_sessions SET manifest_version = '2' WHERE id = $1`, [s])).rejects.toMatchObject({ code: '23000' });
      const d = randomUUID();
      await admin.query('UPDATE interview_sessions SET project_discussion_id = $2 WHERE id = $1', [s, d]);
      await expect(admin.query('UPDATE interview_sessions SET project_discussion_id = $2 WHERE id = $1', [s, randomUUID()])).rejects.toMatchObject({ code: '23000' });
    });

    it('refuses an answers document over 64 KiB and a non-object', async () => {
      await wipe(A);
      const s = await insert(A, A.m1);
      await expect(as(A, A.m1, (c) => c.query('UPDATE interview_sessions SET answers = $2::jsonb WHERE id = $1', [s, JSON.stringify({ x: 'y'.repeat(65_536) })]))).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(as(A, A.m1, (c) => c.query(`UPDATE interview_sessions SET answers = '[]' WHERE id = $1`, [s]))).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });
  });

  describe('the start bounds', () => {
    const start = (f: F2Fixture, user: string) => as(f, user, (c) => c.query<{ id: string }>(`SELECT interview_session_start('prd', '1', NULL) AS id`));
    const setPaid = (f: F2Fixture, paid: boolean) => admin.query('UPDATE accounts SET hosted_plan_paid = $2 WHERE id = $1', [f.accountId, paid]);
    const bound = (e: unknown) => ({ code: 'IV429', detail: (e as { detail: string }).detail });

    it('an unpaid account holds 2 live sessions in all, and a third start names the account bound', async () => {
      await wipe(A);
      await setPaid(A, false);
      await start(A, A.m1);
      await start(A, A.m2);
      await expect(start(A, A.a1)).rejects.toSatisfy((e) => bound(e).code === 'IV429' && bound(e).detail === 'active_per_account');
    });

    it('a capped session still counts as live; an abandoned or finished one frees its place', async () => {
      await wipe(A);
      await setPaid(A, false);
      await insert(A, A.m1, { status: 'capped' });
      await insert(A, A.m1, { status: 'abandoned' });
      await insert(A, A.m1, { status: 'finished' });
      await start(A, A.m1);
      await expect(start(A, A.m1)).rejects.toSatisfy((e) => bound(e).detail === 'active_per_account');
    });

    it('a paid account has no account bound, 3 live sessions per user and 20 starts a day', async () => {
      await wipe(A);
      await setPaid(A, true);
      for (let i = 0; i < 3; i++) await start(A, A.m1);
      await start(A, A.m2);
      await expect(start(A, A.m1)).rejects.toSatisfy((e) => bound(e).detail === 'active_per_user');
      await wipe(A);
      for (let i = 0; i < 20; i++) await insert(A, A.m1, { status: 'abandoned', startedAgo: `${i + 1} hours` });
      await expect(start(A, A.m2)).rejects.toSatisfy((e) => bound(e).detail === 'starts_per_day');
    });

    it('an unpaid account holds 10 starts a day, abandoned ones count, and one older than 24 hours does not', async () => {
      await wipe(A);
      await setPaid(A, false);
      for (let i = 0; i < 9; i++) await insert(A, A.m1, { status: 'abandoned', startedAgo: `${i + 1} hours` });
      await insert(A, A.m1, { status: 'abandoned', startedAgo: '25 hours' });
      await start(A, A.m2);
      await as(A, A.m2, (c) => c.query(`SELECT interview_session_abandon(id, rev) FROM interview_sessions`));
      await expect(start(A, A.m2)).rejects.toSatisfy((e) => bound(e).detail === 'starts_per_day');
    });

    it('counts only the caller\'s account, and a start in one account never changes another\'s', async () => {
      await wipe(A);
      await wipe(B);
      await setPaid(A, false);
      await setPaid(B, false);
      await start(A, A.m1);
      await start(A, A.m2);
      await start(B, B.m1);
      const n = await as(B, B.m1, (c) => c.query<{ active_account: number; starts_24h: number }>('SELECT * FROM interview_session_counts()'));
      expect(n.rows[0]).toMatchObject({ active_account: 1, starts_24h: 1 });
    });

    it('refuses a non-member and a repo of another account, and writes nothing', async () => {
      await wipe(A);
      await expect(as(A, B.m1, (c) => c.query(`SELECT interview_session_start('prd', '1', NULL)`))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const foreignRepo = (await admin.query<{ id: string }>('SELECT id FROM repos WHERE account_id <> $1 LIMIT 1', [A.accountId])).rows[0]?.id ?? randomUUID();
      await expect(as(A, A.m1, (c) => c.query(`SELECT interview_session_start('prd', '1', $1)`, [foreignRepo]))).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
      expect((await admin.query('SELECT 1 FROM interview_sessions WHERE account_id = $1', [A.accountId])).rowCount).toBe(0);
    });
  });

  describe('abandon, the turn link and the funnel view', () => {
    it('answers ok, stale_rev, not_active and not_found, and moves only the caller\'s own live session', async () => {
      await wipe(A);
      const s = await insert(A, A.m1);
      const call = (user: string, id: string, rev: number) => as(A, user, async (c) => (await c.query<{ r: string }>('SELECT interview_session_abandon($1, $2) AS r', [id, rev])).rows[0]!.r);
      expect(await call(A.m1, s, 9)).toBe('stale_rev');
      expect(await call(A.m2, s, 1)).toBe('not_found');
      expect(await call(A.a1, s, 1)).toBe('not_found');
      expect(await call(A.m1, randomUUID(), 1)).toBe('not_found');
      expect(await call(A.m1, s, 1)).toBe('ok');
      expect(await call(A.m1, s, 2)).toBe('not_active');
    });

    it('interview_turns follows the session\'s visibility and takes no write from app_user', async () => {
      await wipe(A);
      const s = await insert(A, A.m1);
      const run = (await admin.query<{ id: string }>(`INSERT INTO agent_runs (account_id, role, runtime, status) VALUES ($1, 'executor', 'local', 'running') RETURNING id`, [A.accountId])).rows[0]!.id;
      await admin.query('INSERT INTO interview_turns (account_id, session_id, seq, agent_run_id) VALUES ($1, $2, 1, $3)', [A.accountId, s, run]);
      const count = (user: string) => as(A, user, async (c) => (await c.query('SELECT 1 FROM interview_turns')).rowCount);
      expect(await count(A.m1)).toBe(1);
      expect(await count(A.a1)).toBe(1);
      expect(await count(A.m2)).toBe(0);
      await expect(as(A, A.m1, (c) => c.query('INSERT INTO interview_turns (account_id, session_id, seq, agent_run_id) VALUES ($1, $2, 2, $3)', [A.accountId, s, randomUUID()]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('v_interview_funnel is security_invoker and shows each caller only the sessions they can read', async () => {
      await wipe(A);
      const mine = await insert(A, A.m1);
      await insert(A, A.m2, { status: 'finished' });
      const opts = (await admin.query<{ reloptions: string[] }>(`SELECT reloptions FROM pg_class WHERE relname = 'v_interview_funnel'`)).rows[0]!.reloptions;
      expect(opts).toContain('security_invoker=true');
      const view = (user: string) => as(A, user, async (c) => (await c.query<{ session_id: string }>('SELECT session_id FROM v_interview_funnel')).rows.map((r) => r.session_id));
      expect(await view(A.m1)).toEqual([mine]);
      expect(await view(A.a1)).toHaveLength(2);
    });
  });
  describe('repo deletion and concurrent starts', () => {
    const repo = async (f: F2Fixture) => (await admin.query<{ id: string }>(`INSERT INTO repos (account_id, gh_repo_id, product) VALUES ($1, $2, 'p') RETURNING id`, [f.accountId, Math.floor(Math.random() * 1e9)])).rows[0]!.id;

    it('deleting a repo clears the link on finished and abandoned sessions, changing nothing else (rev included), as admin and as app_user', async () => {
      await wipe(A);
      for (const [status, byApp] of [['finished', false], ['abandoned', true]] as const) {
        const r = await repo(A);
        const s = (await admin.query<{ id: string }>(
          `INSERT INTO interview_sessions (account_id, created_by, manifest_id, manifest_version, status, finished_at, repo_id, answers)
           VALUES ($1, $2, 'prd', '1', $3, CASE WHEN $3 = 'finished' THEN now() END, $4, '{"a":{}}') RETURNING id`, [A.accountId, A.m1, status, r])).rows[0]!.id;
        const before = (await admin.query('SELECT rev, status, answers, finished_at FROM interview_sessions WHERE id = $1', [s])).rows[0];
        if (byApp) await as(A, A.m2, (c) => c.query('DELETE FROM repos WHERE id = $1', [r]));
        else await admin.query('DELETE FROM repos WHERE id = $1', [r]);
        const after = (await admin.query('SELECT rev, status, answers, finished_at, repo_id FROM interview_sessions WHERE id = $1', [s])).rows[0];
        expect(after.repo_id).toBeNull();
        expect({ rev: after.rev, status: after.status, answers: after.answers, finished_at: after.finished_at }).toEqual(before);
        // Only to NULL: pointing a terminal row at a repo is still refused.
        await expect(admin.query('UPDATE interview_sessions SET repo_id = $2 WHERE id = $1', [s, await repo(A)])).rejects.toMatchObject({ code: '23000' });
      }
    });

    it('six parallel starts on an unpaid account leave exactly 2 live sessions', async () => {
      await wipe(A);
      await admin.query('UPDATE accounts SET hosted_plan_paid = false WHERE id = $1', [A.accountId]);
      const users = [A.m1, A.m2, A.a1, A.a2, A.o1, A.o2];
      const r = await Promise.allSettled(users.map((u) => as(A, u, (c) => c.query(`SELECT interview_session_start('prd', '1', NULL)`))));
      expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(2);
      expect(r.filter((x) => x.status === 'rejected' && (x.reason as { code?: string }).code === 'IV429')).toHaveLength(4);
      expect((await admin.query(`SELECT 1 FROM interview_sessions WHERE account_id = $1 AND status IN ('active', 'capped')`, [A.accountId])).rowCount).toBe(2);
    });
  });
});
