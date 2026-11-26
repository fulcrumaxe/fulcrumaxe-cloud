import { randomInt, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setEngineBridgeSettings } from '../src/engineBridge.js';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/**
 * D#845 ON-13c2 (migration 1105): the operate queue. The triggers that fill it, the claim that holds an account to 4 running rows, the finish, the role gates and the tenant walls. Real Postgres, row security forced; the claim and
 * finish run as the real platform_ops login, the switches as the real app_user through the same function the route calls.
 */
describe('engine operate queue [pg]', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let opsPool: Pool;
  let admin: PoolClient;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    admin = await adminPool.connect();
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end(), opsPool.end()]);
  });

  interface Rig { who: SeedRefs; repos: string[] }
  /** A fresh account with `n` repos, watch on and operate off, every repo ticked. */
  async function rig(n = 1, o: { operate?: boolean; tick?: boolean } = {}): Promise<Rig> {
    const who = await seedAccount(admin, randomUUID());
    const repos = [who.repoId];
    for (let i = 1; i < n; i++) {
      const id = randomUUID();
      await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) SELECT $1, account_id, installation_id, $3, product, 'acme', $4 FROM repos WHERE id = $2`, [id, who.repoId, randomInt(1, 2 ** 40), `r${i}-${id.slice(0, 8)}`]);
      repos.push(id);
    }
    await admin.query(`DELETE FROM engine_bridge_settings WHERE account_id = $1`, [who.accountId]);
    await admin.query(`INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, true, false)`, [who.accountId]);
    if (o.tick !== false) for (const r of repos) await admin.query(`INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)`, [who.accountId, r]);
    if (o.operate === true) await admin.query(`UPDATE engine_bridge_settings SET operate_enabled = true WHERE account_id = $1`, [who.accountId]);
    return { who, repos };
  }
  const setOperate = (r: Rig, on: boolean) => admin.query(`UPDATE engine_bridge_settings SET operate_enabled = $2 WHERE account_id = $1`, [r.who.accountId, on]);
  interface QRow { repo_id: string; operate_epoch: number; action: string; state: string; attempts: number }
  const rows = async (accountId: string, where = 'true'): Promise<QRow[]> =>
    (await admin.query<QRow>(`SELECT repo_id, operate_epoch, action, state, attempts FROM engine_operate_queue WHERE account_id = $1 AND ${where} ORDER BY action, repo_id`, [accountId])).rows;
  const epochOf = async (accountId: string) => (await admin.query<{ e: number }>(`SELECT operate_epoch AS e FROM engine_bridge_settings WHERE account_id = $1`, [accountId])).rows[0]!.e;
  interface Claimed { o_account: string; o_repo: string; o_epoch: number; o_action: string; o_attempts: number }
  const claim = async (accountId: string | null, repoId: string | null = null, limit = 500, pool: Pool = opsPool): Promise<Claimed[]> =>
    (await pool.query<Claimed>('SELECT * FROM engine_operate_queue_claim($1::uuid, $2::uuid, $3::integer)', [accountId, repoId, limit])).rows;
  const finish = async (c: { o_account: string; o_repo: string; o_epoch: number; o_action: string }, outcome: string, accountId = c.o_account): Promise<boolean> =>
    (await opsPool.query<{ r: boolean }>('SELECT engine_operate_queue_finish($1::uuid, $2::uuid, $3::integer, $4, $5) AS r', [accountId, c.o_repo, c.o_epoch, c.o_action, outcome])).rows[0]!.r;
  const code = async (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: { code?: string; message?: string }) => e.code ?? `error:${e.message}`);

  describe('the table', () => {
    it('is closed to every tenant and operator role: row security forced, one role with a grant, no policy for anyone else', async () => {
      const t = (await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'engine_operate_queue'`)).rows[0];
      expect(t).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      for (const role of ['app_user', 'platform_ops']) {
        expect((await admin.query(`SELECT has_table_privilege($1, 'engine_operate_queue', 'SELECT,INSERT,UPDATE,DELETE') AS a, has_any_column_privilege($1, 'engine_operate_queue', 'SELECT,INSERT,UPDATE') AS b`, [role])).rows[0]).toEqual({ a: false, b: false });
      }
      expect((await admin.query(`SELECT DISTINCT unnest(roles)::text AS r FROM pg_policies WHERE tablename = 'engine_operate_queue'`)).rows.map((r) => r.r)).toEqual(['engine_start_definer']);
      await expect(appPool.query('SELECT 1 FROM engine_operate_queue')).rejects.toMatchObject({ code: '42501' });
      await expect(opsPool.query('SELECT 1 FROM engine_operate_queue')).rejects.toMatchObject({ code: '42501' });
      await expect(appPool.query(`INSERT INTO engine_operate_queue (account_id, repo_id, operate_epoch, action) VALUES ($1, $1, 1, 'start')`, [randomUUID()])).rejects.toMatchObject({ code: '42501' });
    });
    it('holds the shape: a key of account, repo, epoch and action; closed actions and states; a running row has a claim time', async () => {
      const r = await rig();
      const ins = (action: string, state: string, epoch = 7, claimed = 'NULL') =>
        code(admin.query(`INSERT INTO engine_operate_queue (account_id, repo_id, operate_epoch, action, state, claimed_at) VALUES ($1, $2, $3, $4, $5, ${claimed})`, [r.who.accountId, r.repos[0], epoch, action, state]));
      expect(await ins('start', 'pending')).toBe('ok');
      expect(await ins('start', 'pending')).toBe('23505');
      expect(await ins('stop', 'pending')).toBe('ok');
      expect(await ins('restart', 'pending', 8)).toBe('23514');
      expect(await ins('start', 'waiting', 8)).toBe('23514');
      expect(await ins('start', 'running', 8)).toBe('23514');
      expect(await ins('start', 'running', 8, 'now()')).toBe('ok');
      expect(await ins('start', 'pending', 0)).toBe('23514');
      expect(await code(admin.query(`INSERT INTO engine_operate_queue (account_id, repo_id, operate_epoch, action) VALUES ($1, $2, 9, 'start')`, [r.who.accountId, randomUUID()]))).toBe('23503');
    });
  });

  describe('the triggers', () => {
    it('turning operate on queues one start per ticked repo at the new epoch, and turning it off one stop per repo at the next', async () => {
      const r = await rig(3);
      expect(await rows(r.who.accountId)).toEqual([]);
      await setOperate(r, true);
      expect(await epochOf(r.who.accountId)).toBe(1);
      expect(await rows(r.who.accountId)).toEqual([...r.repos].sort().map((repo_id) => ({ repo_id, operate_epoch: 1, action: 'start', state: 'pending', attempts: 0 })));
      await setOperate(r, false);
      expect(await epochOf(r.who.accountId)).toBe(2);
      expect((await rows(r.who.accountId, `action = 'stop'`)).map((x) => [x.repo_id, x.operate_epoch, x.state]).sort()).toEqual([...r.repos].sort().map((id) => [id, 2, 'pending']));
      expect((await rows(r.who.accountId, `action = 'start'`)).map((x) => x.operate_epoch)).toEqual([1, 1, 1]);
    });
    it('queues only the account\'s own ticked repos: an unticked repo gets nothing, and another account is untouched', async () => {
      const r = await rig(3, { tick: false });
      const other = await rig(2);
      await admin.query(`INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)`, [r.who.accountId, r.repos[0]]);
      await setOperate(r, true);
      expect((await rows(r.who.accountId)).map((x) => x.repo_id)).toEqual([r.repos[0]]);
      expect(await rows(other.who.accountId)).toEqual([]);
      await setOperate(other, true);
      expect(await rows(other.who.accountId)).toHaveLength(2);
      expect(await rows(r.who.accountId)).toHaveLength(1);
    });
    it('queues nothing for an account whose operate never went on, and for an insert with operate off', async () => {
      const r = await rig(2);
      await admin.query(`UPDATE engine_bridge_settings SET watch_enabled = false WHERE account_id = $1`, [r.who.accountId]);
      await admin.query(`UPDATE engine_bridge_settings SET watch_enabled = true WHERE account_id = $1`, [r.who.accountId]);
      await admin.query(`DELETE FROM engine_bridge_repos WHERE account_id = $1 AND repo_id = $2`, [r.who.accountId, r.repos[0]]);
      expect(await epochOf(r.who.accountId)).toBe(0);
      expect(await rows(r.who.accountId)).toEqual([]);
    });
    it('queues a start when a repo is ticked while operate is on, and a stop when it is unticked; a tick while operate is off queues nothing', async () => {
      const r = await rig(2, { operate: true, tick: false });
      await admin.query(`INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)`, [r.who.accountId, r.repos[1]]);
      expect(await rows(r.who.accountId)).toEqual([{ repo_id: r.repos[1], operate_epoch: 1, action: 'start', state: 'pending', attempts: 0 }]);
      await admin.query(`DELETE FROM engine_bridge_repos WHERE account_id = $1 AND repo_id = $2`, [r.who.accountId, r.repos[1]]);
      expect(await rows(r.who.accountId, `action = 'stop'`)).toEqual([{ repo_id: r.repos[1], operate_epoch: 1, action: 'stop', state: 'pending', attempts: 0 }]);
      await setOperate(r, false);
      const before = await rows(r.who.accountId);
      await admin.query(`INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)`, [r.who.accountId, r.repos[0]]);
      expect(await rows(r.who.accountId)).toEqual(before);
    });
    it('makes two causes of one stop one row: operate off, then the repo unticked', async () => {
      const r = await rig(2, { operate: true });
      await setOperate(r, false);
      await admin.query(`DELETE FROM engine_bridge_repos WHERE account_id = $1 AND repo_id = $2`, [r.who.accountId, r.repos[0]]);
      await admin.query(`DELETE FROM engine_bridge_repos WHERE account_id = $1 AND repo_id = $2`, [r.who.accountId, r.repos[0]]);
      const stops = await rows(r.who.accountId, `action = 'stop' AND repo_id = '${r.repos[0]}'`);
      expect(stops).toHaveLength(1);
      expect(stops[0]!.operate_epoch).toBe(2);
    });
    it('makes a finished row pending again when its cause happens again, and leaves a pending or running one alone', async () => {
      const r = await rig(1, { operate: true, tick: false });
      const tick = () => admin.query(`INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)`, [r.who.accountId, r.repos[0]]);
      const untick = () => admin.query(`DELETE FROM engine_bridge_repos WHERE account_id = $1 AND repo_id = $2`, [r.who.accountId, r.repos[0]]);
      await tick();
      const [c] = await claim(r.who.accountId);
      expect(await finish(c!, 'retry')).toBe(true);
      await untick();
      await tick();
      expect((await rows(r.who.accountId, `action = 'start'`))[0]).toMatchObject({ state: 'pending', attempts: 1 });
      await admin.query(`UPDATE engine_operate_queue SET claimed_at = now() - interval '1 minute' WHERE account_id = $1`, [r.who.accountId]);
      const [c2] = (await claim(r.who.accountId, null, 500)).filter((x) => x.o_action === 'start');
      expect(c2).toBeDefined();
      await untick();
      await tick();
      expect((await rows(r.who.accountId, `action = 'start'`))[0]).toMatchObject({ state: 'running' });
      expect(await finish(c2!, 'done')).toBe(true);
      await untick();
      await tick();
      expect((await rows(r.who.accountId, `action = 'start'`))[0]).toMatchObject({ state: 'pending', attempts: 0 });
    });
    it('lets a project be removed while it is ticked and operated: the cascade leaves no row that points at nothing', async () => {
      const r = await rig(2, { operate: true });
      expect(await rows(r.who.accountId)).toHaveLength(2);
      await admin.query(`DELETE FROM repos WHERE id = $1`, [r.repos[1]]);
      expect((await rows(r.who.accountId)).map((x) => x.repo_id)).toEqual([r.repos[0]]);
      expect((await admin.query(`SELECT count(*)::int AS n FROM engine_bridge_repos WHERE repo_id = $1`, [r.repos[1]])).rows[0].n).toBe(0);
    });
    it('does all of it for the real switch route\'s write, in the request, and signs no job there', async () => {
      const r = await rig(2);
      const read = new Map(r.repos.map((id) => [id.toLowerCase(), 'private' as const]));
      const jobs = async () => (await admin.query(`SELECT count(*)::int AS n FROM machine_jobs WHERE account_id = $1`, [r.who.accountId])).rows[0].n;
      const before = await jobs();
      await withTenant(appPool, r.who.accountId, r.who.userId, (cl) => setEngineBridgeSettings(cl, r.who.userId, { operate_enabled: true }, read));
      expect((await rows(r.who.accountId)).map((x) => [x.action, x.operate_epoch, x.state])).toEqual([['start', 1, 'pending'], ['start', 1, 'pending']]);
      await withTenant(appPool, r.who.accountId, r.who.userId, (cl) => setEngineBridgeSettings(cl, r.who.userId, { repo_ids: [r.repos[0]!] }, read));
      expect((await rows(r.who.accountId, `action = 'stop'`)).map((x) => [x.repo_id, x.operate_epoch])).toEqual([[r.repos[1], 1]]);
      await withTenant(appPool, r.who.accountId, r.who.userId, (cl) => setEngineBridgeSettings(cl, r.who.userId, { operate_enabled: false }, new Map()));
      expect((await rows(r.who.accountId, `operate_epoch = 2`)).map((x) => [x.repo_id, x.action])).toEqual([[r.repos[0], 'stop']]);
      expect(await jobs()).toBe(before);
    });
    it('cannot be called as a function: a tenant reaches only the trigger check, an operator has no EXECUTE', async () => {
      expect(await code(appPool.query('SELECT engine_operate_queue_enqueue()'))).toBe('0A000');
      expect(await code(opsPool.query('SELECT engine_operate_queue_enqueue()'))).toBe('42501');
    });
  });

  describe('the claim', () => {
    it('holds an account to 4 running rows: 10 repos start 4, and the next claim waits for a finish', async () => {
      const r = await rig(10, { operate: true });
      const first = await claim(r.who.accountId);
      expect(first).toHaveLength(4);
      expect((await rows(r.who.accountId, `state = 'running'`))).toHaveLength(4);
      expect(await claim(r.who.accountId)).toEqual([]);
      expect(await finish(first[0]!, 'done')).toBe(true);
      expect(await claim(r.who.accountId)).toHaveLength(1);
      expect(await claim(r.who.accountId)).toEqual([]);
      for (const c of first.slice(1)) await finish(c, 'done');
      expect(await claim(r.who.accountId)).toHaveLength(3);
      expect((await rows(r.who.accountId, `state = 'running'`)).length).toBeLessThanOrEqual(4);
    });
    it('honours the caller\'s limit, narrows to a repo, and gives each account its own 4', async () => {
      const a = await rig(6, { operate: true });
      const b = await rig(6, { operate: true });
      expect(await claim(a.who.accountId, null, 2)).toHaveLength(2);
      const one = await claim(a.who.accountId, a.repos[5]!);
      expect(one.every((c) => c.o_repo === a.repos[5])).toBe(true);
      await claim(a.who.accountId);
      await claim(b.who.accountId);
      expect((await rows(a.who.accountId, `state = 'running'`)).length).toBe(4);
      expect((await rows(b.who.accountId, `state = 'running'`)).length).toBe(4);
      expect((await rows(b.who.accountId, `state = 'pending'`)).length).toBe(2);
    });
    it('never passes 4 for one account when claimers race', async () => {
      const r = await rig(12, { operate: true });
      const got = (await Promise.all(Array.from({ length: 8 }, () => claim(r.who.accountId)))).flat();
      expect(got).toHaveLength(4);
      expect(new Set(got.map((c) => c.o_repo)).size).toBe(4);
      expect((await rows(r.who.accountId, `state = 'running'`))).toHaveLength(4);
    });
    it('serializes two claimers of one account on the account lock: a claim that finds the account\'s transaction open waits for it, then sees its 4 running rows and takes none', async () => {
      const r = await rig(12, { operate: true });
      const a = await opsPool.connect();
      try {
        await a.query('BEGIN');
        const got = (await a.query<Claimed>('SELECT * FROM engine_operate_queue_claim($1::uuid, NULL, 500)', [r.who.accountId])).rows;
        expect(got).toHaveLength(4);
        let settled = false;
        const b = claim(r.who.accountId).then((x) => { settled = true; return x; });
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(settled).toBe(false);
        await a.query('COMMIT');
        expect(await b).toEqual([]);
        expect((await rows(r.who.accountId, `state = 'running'`))).toHaveLength(4);
      } finally {
        await a.query('ROLLBACK').catch(() => undefined);
        a.release();
      }
    });
    it('takes stops before starts', async () => {
      const r = await rig(6, { operate: true });
      for (const repo of r.repos.slice(0, 2)) await admin.query(`DELETE FROM engine_bridge_repos WHERE account_id = $1 AND repo_id = $2`, [r.who.accountId, repo]);
      const got = await claim(r.who.accountId);
      expect(got.filter((c) => c.o_action === 'stop')).toHaveLength(2);
      expect(got.filter((c) => c.o_action === 'start')).toHaveLength(2);
      const idle = await rig(6, { operate: true });
      await admin.query(`DELETE FROM engine_bridge_repos WHERE account_id = $1 AND repo_id = $2`, [idle.who.accountId, idle.repos[5]]);
      await admin.query(`UPDATE engine_operate_queue SET enqueued_at = now() - interval '1 hour' WHERE account_id = $1 AND action = 'start'`, [idle.who.accountId]);
      expect((await claim(idle.who.accountId, null, 1)).map((c) => c.o_action)).toEqual(['stop']);
    });
    it('drops a row of an epoch that is not the account\'s now, and any row a week old', async () => {
      const r = await rig(3, { operate: true });
      await setOperate(r, false);
      const stops = await claim(r.who.accountId);
      expect(stops.map((c) => [c.o_action, c.o_epoch])).toEqual([['stop', 2], ['stop', 2], ['stop', 2]]);
      expect((await rows(r.who.accountId, `action = 'start'`)).map((x) => x.state)).toEqual(['done', 'done', 'done']);
      await setOperate(r, true);
      const starts = await claim(r.who.accountId);
      expect(starts.map((c) => [c.o_action, c.o_epoch])).toEqual([['start', 3], ['start', 3], ['start', 3]]);
      expect((await rows(r.who.accountId, `operate_epoch = 2`)).map((x) => x.state)).toEqual(['done', 'done', 'done']);
      for (const c of stops) expect(await finish(c, 'done')).toBe(false);
      const old = await rig(3, { operate: true });
      await admin.query(`UPDATE engine_operate_queue SET enqueued_at = now() - interval '8 days' WHERE account_id = $1 AND repo_id = $2`, [old.who.accountId, old.repos[0]]);
      const fresh = await claim(old.who.accountId);
      expect(fresh.map((c) => c.o_repo).sort()).toEqual(old.repos.filter((id) => id !== old.repos[0]).sort());
      expect((await rows(old.who.accountId, `repo_id = '${old.repos[0]}'`))[0]!.state).toBe('done');
    });
    it('gives back a row whose drain died, once it has been running for ten minutes', async () => {
      const r = await rig(1, { operate: true });
      const [c] = await claim(r.who.accountId);
      expect(c).toBeDefined();
      await admin.query(`UPDATE engine_operate_queue SET claimed_at = now() - interval '9 minutes' WHERE account_id = $1`, [r.who.accountId]);
      expect(await claim(r.who.accountId)).toEqual([]);
      await admin.query(`UPDATE engine_operate_queue SET claimed_at = now() - interval '11 minutes' WHERE account_id = $1`, [r.who.accountId]);
      const again = await claim(r.who.accountId);
      expect(again).toHaveLength(1);
      expect(again[0]!.o_attempts).toBe(1);
    });
    it('makes a retried row wait 30 seconds an attempt, up to 5 minutes; a release counts no attempt and waits for nothing', async () => {
      const r = await rig(1, { operate: true });
      const [c] = await claim(r.who.accountId);
      expect(await finish(c!, 'release')).toBe(true);
      expect((await claim(r.who.accountId))).toHaveLength(1);
      expect(await finish(c!, 'retry')).toBe(true);
      expect((await rows(r.who.accountId))[0]).toMatchObject({ state: 'pending', attempts: 1 });
      expect(await claim(r.who.accountId)).toEqual([]);
      await admin.query(`UPDATE engine_operate_queue SET claimed_at = now() - interval '31 seconds' WHERE account_id = $1`, [r.who.accountId]);
      expect(await claim(r.who.accountId)).toHaveLength(1);
      await finish(c!, 'retry');
      await finish(c!, 'retry');
      await admin.query(`UPDATE engine_operate_queue SET attempts = 40, state = 'pending', claimed_at = now() - interval '4 minutes' WHERE account_id = $1`, [r.who.accountId]);
      expect(await claim(r.who.accountId)).toEqual([]);
      await admin.query(`UPDATE engine_operate_queue SET claimed_at = now() - interval '301 seconds' WHERE account_id = $1`, [r.who.accountId]);
      expect(await claim(r.who.accountId)).toHaveLength(1);
    });
  });

  describe('the finish', () => {
    it('moves a running row only, and says whether it did', async () => {
      const r = await rig(1, { operate: true });
      const row = { o_account: r.who.accountId, o_repo: r.repos[0]!, o_epoch: 1, o_action: 'start' };
      expect(await finish(row, 'done')).toBe(false);
      await claim(r.who.accountId);
      expect(await finish(row, 'done')).toBe(true);
      expect(await finish(row, 'done')).toBe(false);
      expect(await finish({ ...row, o_action: 'stop' }, 'done')).toBe(false);
      expect(await finish({ ...row, o_epoch: 2 }, 'done')).toBe(false);
      expect((await rows(r.who.accountId))[0]!.state).toBe('done');
    });
    it('is bound to the account named: another account\'s id moves nothing', async () => {
      const a = await rig(1, { operate: true });
      const b = await rig(1, { operate: true });
      const [ca] = await claim(a.who.accountId);
      expect(await finish(ca!, 'done', b.who.accountId)).toBe(false);
      expect((await rows(a.who.accountId))[0]!.state).toBe('running');
      expect((await rows(b.who.accountId))[0]!.state).toBe('pending');
      expect(await claim(b.who.accountId, b.repos[0])).toHaveLength(1);
      expect((await rows(a.who.accountId))[0]!.state).toBe('running');
    });
    it('refuses a bad action or outcome', async () => {
      const r = await rig(1, { operate: true });
      expect(await code(opsPool.query(`SELECT engine_operate_queue_finish($1::uuid, $2::uuid, 1, 'start', 'drop')`, [r.who.accountId, r.repos[0]]))).toBe('22023');
      expect(await code(opsPool.query(`SELECT engine_operate_queue_finish($1::uuid, $2::uuid, 1, 'restart', 'done')`, [r.who.accountId, r.repos[0]]))).toBe('22023');
      expect(await code(opsPool.query(`SELECT engine_operate_queue_finish(NULL::uuid, $1::uuid, 1, 'start', 'done')`, [r.repos[0]]))).toBe('22023');
    });
  });

  describe('who may call it', () => {
    it('lets platform_ops alone: a tenant login, the superuser, a session carrying a person or a runner, and PUBLIC are refused', async () => {
      const r = await rig(1, { operate: true });
      const args = [r.who.accountId, r.repos[0], 1, 'start', 'done'];
      for (const pool of [appPool, adminPool]) {
        expect(await code(pool.query('SELECT * FROM engine_operate_queue_claim($1::uuid, NULL, 5)', [r.who.accountId]))).toBe('42501');
        expect(await code(pool.query('SELECT engine_operate_queue_finish($1::uuid, $2::uuid, $3::integer, $4, $5)', args))).toBe('42501');
        expect(await code(pool.query('SELECT * FROM engine_operate_on_starts_due($1::uuid, NULL, 5)', [r.who.accountId]))).toBe('42501');
      }
      for (const setting of ['app.user_id', 'app.runner_id']) {
        const c = await opsPool.connect();
        try {
          await c.query('BEGIN');
          await c.query(`SELECT set_config($1, $2, true)`, [setting, randomUUID()]);
          expect(await code(c.query('SELECT * FROM engine_operate_queue_claim($1::uuid, NULL, 5)', [r.who.accountId]))).toBe('42501');
          await c.query('ROLLBACK');
        } finally {
          c.release();
        }
      }
      expect((await admin.query(`SELECT count(*)::int AS n FROM information_schema.routine_privileges WHERE routine_name LIKE 'engine_operate_%' AND grantee = 'PUBLIC'`)).rows[0].n).toBe(0);
      expect((await rows(r.who.accountId))[0]!.state).toBe('pending');
    });
    it('refuses a bad limit and a repo with no account', async () => {
      for (const sql of ['SELECT * FROM engine_operate_queue_claim(NULL, NULL, 0)', 'SELECT * FROM engine_operate_queue_claim(NULL, NULL, 501)', `SELECT * FROM engine_operate_queue_claim(NULL, '${randomUUID()}', 5)`, 'SELECT * FROM engine_operate_queue_claim(NULL, NULL, NULL)']) {
        expect(await code(opsPool.query(sql))).toBe('22023');
      }
    });
    it('reads through the RLS-bypassing client: a foreign account id sees 0 rows, and the claim for one account returns none of another\'s', async () => {
      const a = await rig(2, { operate: true });
      const b = await rig(2, { operate: true });
      expect(await rows(randomUUID())).toEqual([]);
      expect((await claim(a.who.accountId)).every((c) => c.o_account === a.who.accountId)).toBe(true);
      expect((await rows(b.who.accountId)).every((x) => x.state === 'pending')).toBe(true);
    });
  });
});
