import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { findRlsViolations } from '../src/rlsInventory.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * [pg] EB-8a, migration 1029: the engine_commands table. The args are closed by the database as well as the route, the row is tenant-scoped (a person
 * of another account and another account's runner see and change nothing), only an owner or admin writes in their own name, a runner moves only its
 * own rows along one path, and nothing can delete a row.
 */
describe('engine_commands (migration 1029) [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let A: SeedRefs;
  let B: SeedRefs;
  let runnerA: string;
  let runnerA2: string;
  let runnerB: string;
  let admin1: string;
  let member1: string;

  const seq = { n: 0 };
  const insertAs = (accountId: string, userId: string, over: Record<string, unknown> = {}, runner: string | null = null) =>
    withTenant(appUserPool, accountId, userId, async (c) => {
      if (runner) await c.query("SELECT set_config('app.runner_id', $1, true)", [runner]);
      const v = { runner_id: runnerA, repo_id: A.repoId, kind: 'start_day', args: {}, issued_by: userId, ...over };
      return c.query(
        `INSERT INTO engine_commands (account_id, runner_id, repo_id, command_seq, kind, args, issued_by, issued_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, now(), now() + interval '600 seconds') RETURNING id`,
        [accountId, v.runner_id, v.repo_id, ++seq.n, v.kind, JSON.stringify(v.args), v.issued_by],
      );
    });
  const adminInsert = async (state = 'pending', runner = runnerA): Promise<string> => {
    const delivered = ['delivered', 'applied', 'refused', 'not_confirmed'].includes(state);
    const acked = ['applied', 'refused', 'not_confirmed'].includes(state);
    const r = await admin.query<{ id: string }>(
      `INSERT INTO engine_commands (account_id, runner_id, repo_id, command_seq, kind, args, issued_by, issued_at, expires_at, state, refusal, delivered_at, acked_at)
       VALUES ($1, $2, $3, $4, 'start_day', '{}', $5, now(), now() + interval '600 seconds', $6, $7, $8, $9) RETURNING id`,
      [A.accountId, runner, A.repoId, ++seq.n, A.userId, state, state === 'refused' ? 'ceiling' : null, delivered ? new Date() : null, acked ? new Date() : null],
    );
    return r.rows[0]!.id;
  };
  const asRunner = <T>(runner: string, accountId: string, userId: string, fn: (c: PoolClient) => Promise<T>) =>
    withTenant(appUserPool, accountId, userId, async (c) => {
      await c.query("SELECT set_config('app.runner_id', $1, true)", [runner]);
      return fn(c);
    });
  const stateOf = async (id: string) => (await admin.query<{ state: string }>('SELECT state FROM engine_commands WHERE id = $1', [id])).rows[0]?.state;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
    runnerA = await insertRunner(admin, A.accountId, A.userId);
    runnerA2 = await insertRunner(admin, A.accountId, A.userId);
    runnerB = await insertRunner(admin, B.accountId, B.userId);
    admin1 = randomUUID();
    member1 = randomUUID();
    for (const [id, role] of [[admin1, 'admin'], [member1, 'member']] as const) {
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [id, `${id}@example.test`]);
      await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [A.accountId, id, role]);
    }
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appUserPool.end()]);
  });

  describe('the table', () => {
    it('has RLS enabled and forced, and no DELETE for app_user', async () => {
      expect(await findRlsViolations(admin)).not.toContain('engine_commands');
      const id = await adminInsert();
      await expect(withTenant(appUserPool, A.accountId, A.userId, (c) => c.query('DELETE FROM engine_commands WHERE id = $1', [id]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await stateOf(id)).toBe('pending');
    });

    it.each([
      ['start_day', {}, true],
      ['pause_loop', { x: 1 }, false],
      ['resume_loop', {}, true],
      ['answer_ask', { ask_id: '0123456789abcdef', choice: 'approve' }, true],
      ['answer_ask', { ask_id: '0123456789abcdef', choice: 'defer', note: 'go ahead' }, true],
      ['answer_ask', { ask_id: '0123456789ABCDEF', choice: 'approve' }, false],
      ['answer_ask', { ask_id: '0123456789abcdef', choice: 'maybe' }, false],
      ['answer_ask', { choice: 'approve' }, false],
      ['answer_ask', { ask_id: '0123456789abcdef', choice: 'approve', extra: 1 }, false],
      ['answer_ask', { ask_id: '0123456789abcdef', choice: 'approve', note: 'two\nlines' }, false],
      ['answer_ask', { ask_id: '0123456789abcdef', choice: 'approve', note: 'bidi ‮ text' }, false],
      ['answer_ask', { ask_id: '0123456789abcdef', choice: 'approve', note: 'x'.repeat(501) }, false],
      ['answer_ask', { ask_id: '0123456789abcdef', choice: 'approve', note: '' }, false],
      ['set_dial', { dial_class: 'agent.spawn', level: 3, ttl: 'for_today' }, true],
      ['set_dial', { dial_class: 'cost.spend', level: 3, ttl: 'none' }, false],
      ['set_dial', { dial_class: 'sandbox.modify', level: 3, ttl: 'none' }, false],
      ['set_dial', { dial_class: 'agent.spawn', level: 6, ttl: 'none' }, false],
      ['set_dial', { dial_class: 'agent.spawn', level: 3 }, false],
      ['request_spawn', { role: 'executor', discussion: 842 }, true],
      ['request_spawn', { role: 'team-lead', discussion: 842 }, false],
      ['request_spawn', { role: 'executor', discussion: 0 }, false],
      ['request_spawn', { role: 'executor', discussion: 2147483648 }, false],
      ['request_spawn', { role: 'executor', discussion: '842' }, false],
      ['stop_agent', { agent_id: 'agent-1_x' }, true],
      ['stop_agent', { agent_id: 'bad id' }, false],
      ['stop_agent', {}, false],
    ])('the database closes %s %j (accepted: %s)', async (kind, args, ok) => {
      const attempt = insertAs(A.accountId, A.userId, { kind, args });
      if (ok) await expect(attempt).resolves.toBeDefined();
      else await expect(attempt).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it('refuses a command that lives longer than 600 s, and one that lives not at all', async () => {
      const bad = (interval: string) =>
        admin.query(
          `INSERT INTO engine_commands (account_id, runner_id, repo_id, command_seq, kind, args, issued_by, issued_at, expires_at) VALUES ($1, $2, $3, $4, 'start_day', '{}', $5, now(), now() + $6::interval)`,
          [A.accountId, runnerA, A.repoId, ++seq.n, A.userId, interval],
        );
      await expect(bad('601 seconds')).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(bad('0 seconds')).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(bad('600 seconds')).resolves.toBeDefined();
    });

    it('keeps a sequence number unique per runner and repo', async () => {
      const n = ++seq.n;
      const ins = () =>
        admin.query(`INSERT INTO engine_commands (account_id, runner_id, repo_id, command_seq, kind, args, issued_by, issued_at, expires_at) VALUES ($1, $2, $3, $4, 'start_day', '{}', $5, now(), now() + interval '600 seconds')`, [A.accountId, runnerA, A.repoId, n, A.userId]);
      await ins();
      await expect(ins()).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    });

    it('refuses a runner or a repo of another account, even to the admin role (composite keys)', async () => {
      const ins = (runner: string, repo: string) =>
        admin.query(`INSERT INTO engine_commands (account_id, runner_id, repo_id, command_seq, kind, args, issued_by, issued_at, expires_at) VALUES ($1, $2, $3, $4, 'start_day', '{}', $5, now(), now() + interval '600 seconds')`, [A.accountId, runner, repo, ++seq.n, A.userId]);
      await expect(ins(runnerB, A.repoId)).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
      await expect(ins(runnerA, B.repoId)).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    });

    it('refuses a state that disagrees with its stamps', async () => {
      const bad = (state: string, delivered: boolean, acked: boolean) =>
        admin.query(
          `INSERT INTO engine_commands (account_id, runner_id, repo_id, command_seq, kind, args, issued_by, issued_at, expires_at, state, delivered_at, acked_at)
           VALUES ($1, $2, $3, $4, 'start_day', '{}', $5, now(), now() + interval '600 seconds', $6, $7, $8)`,
          [A.accountId, runnerA, A.repoId, ++seq.n, A.userId, state, delivered ? new Date() : null, acked ? new Date() : null],
        );
      await expect(bad('delivered', false, false)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(bad('applied', true, false)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(bad('pending', true, false)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(bad('refused', true, true)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });
  });

  describe('who can write, and who can read', () => {
    it('an owner and an admin insert in their own name', async () => {
      await expect(insertAs(A.accountId, A.userId)).resolves.toBeDefined();
      await expect(insertAs(A.accountId, admin1)).resolves.toBeDefined();
    });

    it('a member, a stranger and a runner session cannot insert (RLS)', async () => {
      await expect(insertAs(A.accountId, member1)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(insertAs(A.accountId, B.userId)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(insertAs(A.accountId, A.userId, {}, runnerA)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('an owner cannot issue in another person\'s name', async () => {
      await expect(insertAs(A.accountId, A.userId, { issued_by: admin1 })).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('cross-tenant: an owner of B inserts into A\'s account only as a refusal, and reads none of A\'s rows', async () => {
      const id = await adminInsert();
      await expect(withTenant(appUserPool, B.accountId, B.userId, (c) => c.query(`INSERT INTO engine_commands (account_id, runner_id, repo_id, command_seq, kind, args, issued_by, issued_at, expires_at) VALUES ($1, $2, $3, 1, 'start_day', '{}', $4, now(), now() + interval '600 seconds')`, [A.accountId, runnerA, A.repoId, B.userId]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const seen = await withTenant(appUserPool, B.accountId, B.userId, (c) => c.query('SELECT id FROM engine_commands WHERE id = $1', [id]));
      expect(seen.rowCount).toBe(0);
      const cancelled = await withTenant(appUserPool, B.accountId, B.userId, (c) => c.query(`UPDATE engine_commands SET state = 'cancelled' WHERE id = $1`, [id]));
      expect(cancelled.rowCount).toBe(0);
      expect(await stateOf(id)).toBe('pending');
    });

    it('every member of the account reads its rows; a runner session reads only its own runner\'s', async () => {
      const mine = await adminInsert('pending', runnerA);
      const other = await adminInsert('pending', runnerA2);
      const asMember = await withTenant(appUserPool, A.accountId, member1, (c) => c.query('SELECT id FROM engine_commands WHERE id = ANY($1::uuid[])', [[mine, other]]));
      expect(asMember.rows.map((r) => r.id).sort()).toEqual([mine, other].sort());
      const asRunnerA = await asRunner(runnerA, A.accountId, A.userId, (c) => c.query('SELECT id FROM engine_commands WHERE id = ANY($1::uuid[])', [[mine, other]]));
      expect(asRunnerA.rows.map((r) => r.id)).toEqual([mine]);
    });
  });

  describe('the one path a row may take', () => {
    it('an owner or admin cancels a pending command; a member and a stranger cannot', async () => {
      const id = await adminInsert();
      const cancel = (who: string, account = A.accountId) => withTenant(appUserPool, account, who, (c) => c.query(`UPDATE engine_commands SET state = 'cancelled' WHERE id = $1`, [id]));
      expect((await cancel(member1)).rowCount).toBe(0);
      expect((await cancel(B.userId, B.accountId)).rowCount).toBe(0);
      expect(await stateOf(id)).toBe('pending');
      expect((await cancel(admin1)).rowCount).toBe(1);
      expect(await stateOf(id)).toBe('cancelled');
    });

    it('a person cannot cancel a delivered command, nor deliver one', async () => {
      const delivered = await adminInsert('delivered');
      const r = await withTenant(appUserPool, A.accountId, A.userId, (c) => c.query(`UPDATE engine_commands SET state = 'cancelled' WHERE id = $1`, [delivered]));
      expect(r.rowCount).toBe(0);
      const pending = await adminInsert();
      await expect(withTenant(appUserPool, A.accountId, A.userId, (c) => c.query(`UPDATE engine_commands SET state = 'delivered', delivered_at = now() WHERE id = $1`, [pending]))).rejects.toBeDefined();
      expect(await stateOf(pending)).toBe('pending');
    });

    it('the runner moves its own pending command to delivered, then to one outcome', async () => {
      const id = await adminInsert('pending', runnerA);
      await asRunner(runnerA, A.accountId, A.userId, (c) => c.query(`UPDATE engine_commands SET state = 'delivered', delivered_at = now() WHERE id = $1`, [id]));
      expect(await stateOf(id)).toBe('delivered');
      await asRunner(runnerA, A.accountId, A.userId, (c) => c.query(`UPDATE engine_commands SET state = 'refused', acked_at = now(), refusal = 'halted' WHERE id = $1`, [id]));
      expect(await stateOf(id)).toBe('refused');
      // Nothing moves a finished command.
      await expect(asRunner(runnerA, A.accountId, A.userId, (c) => c.query(`UPDATE engine_commands SET state = 'applied', acked_at = now(), refusal = NULL WHERE id = $1`, [id]))).rejects.toBeDefined();
      expect(await stateOf(id)).toBe('refused');
    });

    it('the runner stores a refusal of an ask that already has an answer, and the check still refuses a code outside the list', async () => {
      const id = await adminInsert('delivered', runnerA);
      await asRunner(runnerA, A.accountId, A.userId, (c) => c.query(`UPDATE engine_commands SET state = 'refused', acked_at = now(), refusal = 'already_answered' WHERE id = $1`, [id]));
      expect(await stateOf(id)).toBe('refused');
      expect((await admin.query<{ refusal: string }>('SELECT refusal FROM engine_commands WHERE id = $1', [id])).rows[0]?.refusal).toBe('already_answered');
      const other = await adminInsert('delivered', runnerA);
      await expect(asRunner(runnerA, A.accountId, A.userId, (c) => c.query(`UPDATE engine_commands SET state = 'refused', acked_at = now(), refusal = 'not_a_code' WHERE id = $1`, [other]))).rejects.toBeDefined();
      expect(await stateOf(other)).toBe('delivered');
    });

    it('another runner of the same account, and a runner of another account, change nothing', async () => {
      const id = await adminInsert('pending', runnerA);
      const deliver = (runner: string, account: string, user: string) => asRunner(runner, account, user, (c) => c.query(`UPDATE engine_commands SET state = 'delivered', delivered_at = now() WHERE id = $1`, [id]));
      expect((await deliver(runnerA2, A.accountId, A.userId)).rowCount).toBe(0);
      expect((await deliver(runnerB, B.accountId, B.userId)).rowCount).toBe(0);
      expect(await stateOf(id)).toBe('pending');
    });

    it('a runner cannot cancel, skip delivery, deliver an expired command, or change what the command says', async () => {
      const id = await adminInsert('pending', runnerA);
      const as = (sql: string) => asRunner(runnerA, A.accountId, A.userId, (c) => c.query(sql, [id]));
      await expect(as(`UPDATE engine_commands SET state = 'cancelled' WHERE id = $1`)).rejects.toBeDefined();
      await expect(as(`UPDATE engine_commands SET state = 'applied', delivered_at = now(), acked_at = now() WHERE id = $1`)).rejects.toBeDefined();
      await expect(as(`UPDATE engine_commands SET kind = 'pause_loop' WHERE id = $1`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(as(`UPDATE engine_commands SET expires_at = expires_at + interval '1 minute' WHERE id = $1`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await admin.query(`UPDATE engine_commands SET issued_at = now() - interval '700 seconds', expires_at = now() - interval '100 seconds' WHERE id = $1`, [id]);
      await expect(as(`UPDATE engine_commands SET state = 'delivered', delivered_at = now() WHERE id = $1`)).rejects.toBeDefined();
      await as(`UPDATE engine_commands SET state = 'expired' WHERE id = $1`);
      expect(await stateOf(id)).toBe('expired');
    });

    it('a revoked runner moves nothing', async () => {
      const revoked = await insertRunner(admin, A.accountId, A.userId);
      await admin.query(`UPDATE runners SET revoked_at = now() WHERE id = $1`, [revoked]);
      const id = await adminInsert('pending', revoked);
      const r = await asRunner(revoked, A.accountId, A.userId, (c) => c.query(`UPDATE engine_commands SET state = 'delivered', delivered_at = now() WHERE id = $1`, [id]));
      expect(r.rowCount).toBe(0);
    });
  });
});
