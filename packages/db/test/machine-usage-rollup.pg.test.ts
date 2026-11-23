import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { insertRunner } from './helpers/runnerFixtures.js';

/**
 * [pg] D#845 MC-11a, migration 1063: each newly stored `usage_tick` adds its counts to machine_usage_daily (source 'engine_session'), once, keyed by account, runner, repo, day and tier.
 * The rows are read by their tenant only and written by the two definers only. The `run` source is tested with the real run path in packages/worker (runnerUsage.pg.test.ts).
 * Every read names the account itself; the admin client reads past RLS, so a missing predicate cannot hide, and A's SECOND repo and a FOREIGN account each hold rows that must not count.
 */
describe('machine usage rollup (migration 1063) [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let A: SeedRefs;
  let B: SeedRefs;
  let repo2: string;
  let runnerA: string;
  let runnerB: string;
  let seq: number;
  let instance: string;
  const ghId = async (repo: string): Promise<number> => Number((await admin.query<{ g: string }>('SELECT gh_repo_id AS g FROM repos WHERE id = $1', [repo])).rows[0]!.g);
  const tickBody = (tier: string, i = 10, o = 20, cr = 3, cw = 4) => ({ model_tier: tier, input_tokens: i, output_tokens: o, cache_read_tokens: cr, cache_write_tokens: cw, window_s: 60 });
  const ev = (s: number, body: object, ts = new Date().toISOString()) => ({ seq: s, ts, kind: 'usage_tick', body });
  /** Ingest as the runner's own session: app_user, the account's tenant, `app.runner_id` set. */
  const ingest = async (events: object[], o: { account?: SeedRefs; runner?: string; repo?: string; inst?: string } = {}) => {
    const acct = o.account ?? A;
    const runner = o.runner ?? runnerA;
    const gh = await ghId(o.repo ?? acct.repoId);
    return withTenant(appPool, acct.accountId, acct.userId, async (c) => {
      await c.query(`SELECT set_config('app.runner_id', $1, true)`, [runner]);
      return (await c.query(`SELECT * FROM engine_events_ingest($1::uuid, $2::uuid, $3::bigint, $4::uuid, '1.2.3', $5::jsonb)`, [acct.accountId, runner, gh, o.inst ?? instance, JSON.stringify(events)])).rows[0] as { o_outcome: string; o_accepted: number; o_duplicates: number };
    });
  };
  const rows = async (account: SeedRefs, extra = '') =>
    (await admin.query<{ repo_id: string; day: string; source: string; model_tier: string; input_tokens: string; output_tokens: string; cache_read_tokens: string; cache_write_tokens: string }>(
      `SELECT repo_id, day::text, source, model_tier, input_tokens::text, output_tokens::text, cache_read_tokens::text, cache_write_tokens::text FROM machine_usage_daily WHERE account_id = $1 ${extra} ORDER BY day, model_tier, repo_id`, [account.accountId])).rows;
  const today = (): string => new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
    repo2 = (await admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, NULL, $2, 'web', 'acme', 'second', 'runner_local') RETURNING id`, [A.accountId, 6_200_000 + Math.floor(Math.random() * 90_000)])).rows[0]!.id;
    await admin.query(`UPDATE repos SET execution_mode = 'runner_local' WHERE id = ANY ($1::uuid[])`, [[A.repoId, B.repoId]]);
    runnerA = await insertRunner(admin, A.accountId, A.userId, {});
    runnerB = await insertRunner(admin, B.accountId, B.userId, {});
    await admin.query('UPDATE runners SET allowed_repo_ids = $2::uuid[], protocol_version = 27 WHERE id = $1', [runnerA, [A.repoId, repo2]]);
    await admin.query('UPDATE runners SET allowed_repo_ids = $2::uuid[], protocol_version = 27 WHERE id = $1', [runnerB, [B.repoId]]);
    for (const [acct, repos] of [[A, [A.repoId, repo2]], [B, [B.repoId]]] as const) {
      await admin.query('INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, true, false)', [acct.accountId]);
      for (const r of repos) await admin.query('INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)', [acct.accountId, r]);
    }
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });
  beforeEach(async () => {
    await admin.query('DELETE FROM machine_usage_daily WHERE account_id = ANY ($1::uuid[])', [[A.accountId, B.accountId]]);
    instance = randomUUID();
    seq = 0;
  });

  it('one tick adds once: its four counts, under today, the repo, the runner and the tier', async () => {
    const r = await ingest([ev(seq++, tickBody('sonnet'))]);
    expect(r).toMatchObject({ o_outcome: 'ok', o_accepted: 1 });
    expect(await rows(A)).toEqual([{ repo_id: A.repoId, day: today(), source: 'engine_session', model_tier: 'sonnet', input_tokens: '10', output_tokens: '20', cache_read_tokens: '3', cache_write_tokens: '4' }]);
    expect((await admin.query('SELECT runner_id FROM machine_usage_daily WHERE account_id = $1', [A.accountId])).rows).toEqual([{ runner_id: runnerA }]);
    expect(await rows(B)).toEqual([]);
  });

  it('two ticks of one key add up; a replayed batch, and a batch that overlaps a stored one, add nothing', async () => {
    await ingest([ev(seq++, tickBody('opus', 1, 2, 3, 4)), ev(seq++, tickBody('opus', 10, 20, 30, 40))]);
    const first = await rows(A);
    expect(first).toMatchObject([{ model_tier: 'opus', input_tokens: '11', output_tokens: '22', cache_read_tokens: '33', cache_write_tokens: '44' }]);
    const replay = await ingest([ev(0, tickBody('opus', 1, 2, 3, 4)), ev(1, tickBody('opus', 10, 20, 30, 40))]);
    expect(replay.o_outcome).toBe('seq_not_increasing');
    const overlap = await ingest([ev(1, tickBody('opus', 10, 20, 30, 40)), ev(2, tickBody('opus', 100, 0, 0, 0))]);
    expect(overlap.o_outcome).toBe('seq_not_increasing');
    expect(await rows(A)).toEqual(first);
  });

  it("the day is the arrival day, not the runner's timestamp; days, repos and tiers stay separate rows, and the same account's other repo never leaks into the first", async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    await ingest([ev(seq++, tickBody('sonnet', 1, 1, 1, 1)), ev(seq++, tickBody('sonnet', 2, 2, 2, 2), yesterday), ev(seq++, tickBody('haiku', 4, 4, 4, 4))]);
    expect((await rows(A)).map((r) => [r.day, r.model_tier, r.input_tokens])).toEqual([[today(), 'haiku', '4'], [today(), 'sonnet', '3']]);
    // Another day's row is another row: move today's to yesterday, and the next tick starts a fresh one.
    await admin.query(`UPDATE machine_usage_daily SET day = day - 1 WHERE account_id = $1`, [A.accountId]);
    await ingest([ev(seq++, tickBody('sonnet', 16, 16, 16, 16))]);
    await ingest([ev(0, tickBody('sonnet', 8, 8, 8, 8))], { repo: repo2, inst: randomUUID() });
    const got = (await rows(A)).map((r) => [r.repo_id === A.repoId ? 'r1' : 'r2', r.day === today() ? 'today' : 'yesterday', r.model_tier, r.input_tokens]);
    expect(got.sort()).toEqual([['r1', 'today', 'sonnet', '16'], ['r1', 'yesterday', 'haiku', '4'], ['r1', 'yesterday', 'sonnet', '3'], ['r2', 'today', 'sonnet', '8']].sort());
    expect(await rows(A, `AND repo_id = '${A.repoId}'`)).toHaveLength(3);
  });

  it('deleting repos whose rows share a key with a no-repo row works one at a time and two at once, and the account\'s token totals do not change', async () => {
    const mk = async (n: number): Promise<string> => (await admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, NULL, $2, 'web', 'acme', $3, 'runner_local') RETURNING id`, [A.accountId, 6_400_000 + Math.floor(Math.random() * 90_000), `del${n}`])).rows[0]!.id;
    const put = (repo: string | null, tokens: number) => admin.query(`INSERT INTO machine_usage_daily (account_id, runner_id, repo_id, day, source, model_tier, input_tokens) VALUES ($1, $2, $3, current_date, 'run', 'sonnet', $4)`, [A.accountId, runnerA, repo, tokens]);
    const total = async () => (await admin.query<{ t: string }>(`SELECT COALESCE(sum(input_tokens), 0)::text AS t FROM machine_usage_daily WHERE account_id = $1`, [A.accountId])).rows[0]!.t;
    for (const together of [false, true]) {
      await admin.query('DELETE FROM machine_usage_daily WHERE account_id = $1', [A.accountId]);
      const [r3, r4] = [await mk(3), await mk(4)];
      await put(null, 1);
      await put(r3, 10);
      await put(r4, 100);
      expect(await total()).toBe('111');
      if (together) await admin.query('DELETE FROM repos WHERE account_id = $1 AND id = ANY ($2::uuid[])', [A.accountId, [r3, r4]]);
      else for (const r of [r3, r4]) await admin.query('DELETE FROM repos WHERE account_id = $1 AND id = $2', [A.accountId, r]);
      expect(await total()).toBe('111');
      expect((await rows(A, 'AND repo_id IS NULL')).map((r) => r.input_tokens).sort()).toEqual(['1', '10', '100']);
    }
  });

  it('a tick over 1e12 in any count, or with a tier that is not one, refuses the whole batch and stores nothing', async () => {
    expect((await ingest([ev(seq++, tickBody('sonnet')), ev(seq++, tickBody('sonnet', 1_000_000_000_001))])).o_outcome).toBe('invalid_message');
    expect((await ingest([ev(seq++, tickBody('Not A Tier'))])).o_outcome).toBe('invalid_message');
    expect((await ingest([ev(seq++, { ...tickBody('sonnet'), extra: 1 })])).o_outcome).toBe('invalid_message');
    expect(await rows(A)).toEqual([]);
    expect((await ingest([ev(seq++, tickBody('sonnet', 1_000_000_000_000))])).o_outcome).toBe('ok');
  });

  it('another tenant reads none of it, through RLS or by naming the account, and a foreign account has its own rows', async () => {
    await ingest([ev(0, tickBody('sonnet'))]);
    await ingest([ev(0, tickBody('sonnet', 99))], { account: B, runner: runnerB, inst: randomUUID() });
    const read = (acct: SeedRefs, named: string) => withTenant(appPool, acct.accountId, acct.userId, async (c) => (await c.query(`SELECT input_tokens::text FROM machine_usage_daily WHERE account_id = $1`, [named])).rows);
    expect(await read(B, A.accountId)).toEqual([]);
    expect(await read(A, B.accountId)).toEqual([]);
    expect(await read(A, A.accountId)).toEqual([{ input_tokens: '10' }]);
    expect(await read(B, B.accountId)).toEqual([{ input_tokens: '99' }]);
    expect((await admin.query('SELECT 1 FROM machine_usage_daily WHERE account_id = $1 AND runner_id = $2', [B.accountId, runnerA])).rows).toEqual([]);
  });

  it('a session cannot write the table directly: insert, update and delete are all refused (42501)', async () => {
    await ingest([ev(0, tickBody('sonnet'))]);
    for (const sql of [
      `INSERT INTO machine_usage_daily (account_id, runner_id, day, source, model_tier) VALUES ('${A.accountId}', '${runnerA}', current_date, 'run', 'forged')`,
      'UPDATE machine_usage_daily SET input_tokens = 0',
      'DELETE FROM machine_usage_daily',
    ]) await expect(withTenant(appPool, A.accountId, A.userId, (c) => c.query(sql)), sql).rejects.toMatchObject({ code: '42501' });
    expect(await rows(A)).toMatchObject([{ input_tokens: '10' }]);
  });
});
