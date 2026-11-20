import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { SESSION_LIVE_WITHIN_S, WATCH_TARGET_LIVE_WITHIN_S, detailHighWaterSeq, findEngineTarget, insertWatchCommand } from '../src/engineCommands.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { insertRunner } from './helpers/runnerFixtures.js';

/**
 * [pg] D#845 watch mode, migration 1043: the `watch` command's closed args (with 1042's cases carried whole), the one place a watch is built (`insertWatchCommand`: the runner's protocol, the
 * `before` cursor against the detail session's high-water mark, `until` from the row's own clock) and where it goes (`findEngineTarget(..., 'watch')`: operate is not needed, the watch
 * switch and a ticked repo are). Every query names the account and the repo itself; the admin client reads past RLS so a missing predicate cannot hide, and the same account's SECOND
 * repo and a FOREIGN account each have rows that must never count.
 */
describe('engine watch (migration 1043) [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let A: SeedRefs;
  let B: SeedRefs;
  let repo2: string;
  let runner: string;
  let foreignRunner: string;

  const argsOk = async (kind: string, args: unknown): Promise<boolean> => (await admin.query<{ ok: boolean }>('SELECT engine_command_args_ok($1, $2::jsonb) AS ok', [kind, JSON.stringify(args)])).rows[0]!.ok;
  const UNTIL = '2026-11-20T10:05:00.000Z';
  const session = async (o: { account?: SeedRefs; repo?: string; runner?: string; kind?: string; lastSeq?: number | null; heardAgo?: string } = {}): Promise<void> => {
    const account = o.account ?? A;
    await admin.query(
      `INSERT INTO engine_sessions (account_id, runner_id, repo_id, engine_instance_id, engine_version, session_kind, last_seq, last_event_at, last_heartbeat_at, last_heard_at)
       VALUES ($1, $2, $3, $4, '1.2.3', $5, $6, now() - $7::interval, now() - $7::interval, now() - $7::interval)`,
      [account.accountId, o.runner ?? (account === A ? runner : foreignRunner), o.repo ?? account.repoId, randomUUID(), o.kind ?? 'detail', o.lastSeq === undefined ? 10 : o.lastSeq, o.heardAgo ?? '0 seconds'],
    );
  };
  const setProtocol = (v: number | null) => admin.query('UPDATE runners SET protocol_version = $2 WHERE id = $1', [runner, v]);
  const settings = async (watch: boolean, operate: boolean): Promise<void> => {
    await admin.query('DELETE FROM engine_bridge_settings WHERE account_id = $1', [A.accountId]);
    await admin.query('INSERT INTO engine_bridge_settings (account_id, watch_enabled, operate_enabled) VALUES ($1, $2, $3)', [A.accountId, watch, operate]);
  };
  const tick = async (repo: string, on: boolean): Promise<void> => {
    await admin.query('DELETE FROM engine_bridge_repos WHERE account_id = $1 AND repo_id = $2', [A.accountId, repo]);
    if (on) await admin.query('INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)', [A.accountId, repo]);
  };

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
    repo2 = (await admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, NULL, $2, 'web', 'acme', 'second', 'runner_local') RETURNING id`, [A.accountId, 6_100_000 + Math.floor(Math.random() * 90_000)])).rows[0]!.id;
    await admin.query(`UPDATE repos SET execution_mode = 'runner_local' WHERE id = ANY ($1::uuid[])`, [[A.repoId, B.repoId]]);
    runner = await insertRunner(admin, A.accountId, A.userId, {});
    foreignRunner = await insertRunner(admin, B.accountId, B.userId, {});
    await admin.query('UPDATE runners SET allowed_repo_ids = $2::uuid[] WHERE id = $1', [runner, [A.repoId, repo2]]);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appUserPool.end()]);
  });
  beforeEach(async () => {
    await admin.query('DELETE FROM engine_commands WHERE account_id = ANY ($1::uuid[])', [[A.accountId, B.accountId]]);
    await admin.query('DELETE FROM engine_sessions WHERE account_id = ANY ($1::uuid[])', [[A.accountId, B.accountId]]);
    await setProtocol(23);
    await settings(true, false);
    await tick(A.repoId, true);
  });

  describe('engine_command_args_ok', () => {
    it('keeps every case of 1042 (the seven engine kinds and the two bridge kinds), unchanged', async () => {
      expect(await argsOk('start_day', {})).toBe(true);
      expect(await argsOk('start_day', { x: 1 })).toBe(false);
      expect(await argsOk('pause_loop', {})).toBe(true);
      expect(await argsOk('resume_loop', {})).toBe(true);
      expect(await argsOk('answer_ask', { ask_id: '0123456789abcdef', choice: 'approve' })).toBe(true);
      expect(await argsOk('answer_ask', { ask_id: 'nope', choice: 'approve' })).toBe(false);
      expect(await argsOk('set_dial', { dial_class: 'docs.write', level: 3, ttl: 'none' })).toBe(true);
      expect(await argsOk('set_dial', { dial_class: 'cost.spend', level: 3, ttl: 'none' })).toBe(false);
      expect(await argsOk('request_spawn', { role: 'executor', discussion: 5 })).toBe(true);
      expect(await argsOk('request_spawn', { role: 'root', discussion: 5 })).toBe(false);
      expect(await argsOk('stop_agent', { agent_id: 'a-1' })).toBe(true);
      expect(await argsOk('stop_agent', { agent_id: '' })).toBe(false);
      expect(await argsOk('bridge_disable', {})).toBe(true);
      expect(await argsOk('bridge_disable', { repo_root: '/x/y' })).toBe(false);
      expect(await argsOk('bridge_enable', {})).toBe(true);
      expect(await argsOk('bridge_enable', { repo_root: '/work/site' })).toBe(true);
      expect(await argsOk('bridge_enable', { repo_root: 'relative' })).toBe(false);
      expect(await argsOk('bridge_enable', { repo_root: '/a/../b' })).toBe(false);
      expect(await argsOk('made_up', {})).toBe(false);
    });

    it('takes a watch with a UTC until, and an optional before that is a whole non-negative number within a safe integer', async () => {
      expect(await argsOk('watch', { until: UNTIL })).toBe(true);
      expect(await argsOk('watch', { until: '2026-11-20T10:05:00Z' })).toBe(true);
      expect(await argsOk('watch', { until: '2024-02-29T23:59:59Z' })).toBe(true);
      expect(await argsOk('watch', { until: '2026-12-31T23:59:59.999999999Z' })).toBe(true);
      expect(await argsOk('watch', { until: UNTIL, before: 0 })).toBe(true);
      expect(await argsOk('watch', { until: UNTIL, before: 9_007_199_254_740_991 })).toBe(true);
    });

    it.each([
      ['no until', {}],
      ['a before alone', { before: 5 }],
      ['an until that is not a string', { until: 1_700_000_000 }],
      ['an until with an offset', { until: '2026-11-20T10:05:00+02:00' }],
      ['an until with no zone', { until: '2026-11-20T10:05:00' }],
      ['a month 13', { until: '2026-13-20T10:05:00Z' }],
      ['an hour 24', { until: '2026-11-20T24:05:00Z' }],
      ['a day that is not in its month (30 February)', { until: '2026-02-30T10:05:00Z' }],
      ['29 February of a year that has none', { until: '2025-02-29T10:05:00.000Z' }],
      ['31 April', { until: '2026-04-31T10:05:00Z' }],
      ['year 0', { until: '0000-01-01T10:05:00Z' }],
      ['an until with text after it', { until: `${UNTIL} x` }],
      ['an extra key', { until: UNTIL, note: 'x' }],
      ['a negative before', { until: UNTIL, before: -1 }],
      ['a fractional before', { until: UNTIL, before: 1.5 }],
      ['a string before', { until: UNTIL, before: '5' }],
      ['a null before', { until: UNTIL, before: null }],
      ['a before over the safe integer', { until: UNTIL, before: 9_007_199_254_740_992 }],
      ['a before in exponent form', { until: UNTIL, before: 1e3 + 0.5 }],
    ])('refuses %s', async (_name, args) => {
      expect(await argsOk('watch', args)).toBe(false);
    });

    it('the table holds it: a watch row is stored with good args and refused (CHECK) with bad ones', async () => {
      const insert = (args: object) =>
        admin.query(
          `INSERT INTO engine_commands (account_id, runner_id, repo_id, command_seq, kind, args, issued_by, issued_at, expires_at) VALUES ($1, $2, $3, 1, 'watch', $4::jsonb, $5, now(), now() + interval '600 seconds')`,
          [A.accountId, runner, A.repoId, JSON.stringify(args), A.userId],
        );
      await expect(insert({ until: 'tomorrow' })).rejects.toThrow(/engine_commands_args_closed/);
      await insert({ until: UNTIL });
    });
  });

  describe('slim_status in the closed body (the backstop behind the protocol schema)', () => {
    const closed = async (body: unknown): Promise<boolean> => (await admin.query<{ ok: boolean }>(`SELECT engine_body_closed('slim_status', $1::jsonb) AS ok`, [JSON.stringify(body)])).rows[0]!.ok;
    const good = { sources: { bridge: 0, host: null, engine: 86_400 }, reason: 'unwatched' };

    it('takes exactly the three sources, each 0 to 86400 or null, and the one reason', async () => {
      expect(await closed(good)).toBe(true);
      expect(await closed({ ...good, sources: { bridge: null, host: null, engine: null } })).toBe(true);
    });

    it.each([
      ['an age of 86401', { sources: { bridge: 0, host: null, engine: 86_401 }, reason: 'unwatched' }],
      ['an age of 100000', { sources: { bridge: 100_000, host: null, engine: 1 }, reason: 'unwatched' }],
      ['a negative age', { sources: { bridge: 0, host: -1, engine: 1 }, reason: 'unwatched' }],
      ['a fraction', { sources: { bridge: 0, host: 1.5, engine: 1 }, reason: 'unwatched' }],
      ['a missing source', { sources: { bridge: 0, engine: 1 }, reason: 'unwatched' }],
      ['an extra source', { sources: { bridge: 0, host: 1, engine: 1, other: 1 }, reason: 'unwatched' }],
      ['sources that are not an object', { sources: [0, 1, 2], reason: 'unwatched' }],
      ['another reason', { ...good, reason: 'watched' }],
      ['no reason', { sources: good.sources }],
      ['an extra key', { ...good, note: 'x' }],
    ])('refuses %s', async (_name, body) => {
      expect(await closed(body)).toBe(false);
    });
  });

  describe('insertWatchCommand', () => {
    const issue = (over: Partial<Parameters<typeof insertWatchCommand>[1]> = {}) =>
      withTenant(appUserPool, A.accountId, A.userId, (c) => insertWatchCommand(c, { accountId: A.accountId, runnerId: runner, repoId: A.repoId, issuedBy: A.userId, haltEpoch: 0, untilSeconds: 300, ...over }));

    it('inserts a pending watch whose until is exactly the asked seconds after the row\'s own issue time, and never more than 600', async () => {
      const res = await issue({ untilSeconds: 300 });
      expect(res.status).toBe('ok');
      const row = (await admin.query(`SELECT kind, state, args, (args ->> 'until')::timestamptz - date_trunc('milliseconds', issued_at) AS ahead, expires_at - issued_at AS life FROM engine_commands WHERE account_id = $1`, [A.accountId])).rows[0];
      expect(row).toMatchObject({ kind: 'watch', state: 'pending' });
      expect(row.ahead).toEqual({ minutes: 5 });
      expect(row.life).toEqual({ minutes: 10 });
      const long = await issue({ untilSeconds: 100_000 });
      expect(long.status).toBe('ok');
      const ahead = (await admin.query(`SELECT max((args ->> 'until')::timestamptz - date_trunc('milliseconds', issued_at)) AS m FROM engine_commands WHERE account_id = $1`, [A.accountId])).rows[0].m;
      expect(ahead).toEqual({ minutes: 10 });
      const short = await issue({ untilSeconds: 0 });
      expect(short.status).toBe('ok');
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('refuses a non-finite untilSeconds (%s) before it reaches the clamp, and writes nothing', async (untilSeconds) => {
      await expect(issue({ untilSeconds })).rejects.toThrow(/finite/);
      expect(Number((await admin.query('SELECT count(*) AS n FROM engine_commands WHERE account_id = $1', [A.accountId])).rows[0].n)).toBe(0);
    });

    it('is refused runner_too_old for a runner whose hello is below the watch protocol or unknown, and writes nothing', async () => {
      for (const v of [22, 1, null]) {
        await setProtocol(v);
        expect(await issue(), String(v)).toEqual({ status: 'runner_too_old' });
      }
      await setProtocol(23);
      expect((await issue()).status).toBe('ok');
      expect(Number((await admin.query('SELECT count(*) AS n FROM engine_commands WHERE account_id = $1', [A.accountId])).rows[0].n)).toBe(1);
    });

    it('checks a before against the detail session\'s high-water mark with watchBeforeWithinHighWater: at it is fine, one past is refused, and with no detail session only none is', async () => {
      expect(await issue({ before: 0 })).toEqual({ status: 'before_ahead' });
      await session({ lastSeq: 10 });
      expect((await issue({ before: 10 })).status).toBe('ok');
      expect(await issue({ before: 11 })).toEqual({ status: 'before_ahead' });
      expect((await issue({ before: 0 })).status).toBe('ok');
      expect((await issue()).status).toBe('ok');
    });

    it('counts the high-water of THIS account\'s repo\'s detail sessions only: not an engine or bridge session, not the same account\'s second repo, not a foreign account', async () => {
      await session({ kind: 'engine', lastSeq: 500 });
      await session({ kind: 'bridge', lastSeq: 500 });
      await session({ repo: repo2, lastSeq: 500 });
      await session({ account: B, lastSeq: 500 });
      expect(await detailHighWaterSeq(admin, A.accountId, A.repoId)).toBe(-1);
      expect(await issue({ before: 1 })).toEqual({ status: 'before_ahead' });
      await session({ lastSeq: 7 });
      await session({ lastSeq: 9 });
      expect(await detailHighWaterSeq(admin, A.accountId, A.repoId)).toBe(9);
      // The admin client reads past RLS: a foreign account id reads none of A's, and A's id none of B's.
      expect(await detailHighWaterSeq(admin, B.accountId, A.repoId)).toBe(-1);
      expect(await detailHighWaterSeq(admin, A.accountId, B.repoId)).toBe(-1);
      expect(await detailHighWaterSeq(admin, B.accountId, B.repoId)).toBe(500);
    });

    it('the row\'s own policy still holds: only an owner or admin of the account issues a watch, and never into another account', async () => {
      await expect(withTenant(appUserPool, A.accountId, B.userId, (c) => insertWatchCommand(c, { accountId: A.accountId, runnerId: runner, repoId: A.repoId, issuedBy: B.userId, haltEpoch: 0, untilSeconds: 60 }))).rejects.toThrow();
      expect(Number((await admin.query('SELECT count(*) AS n FROM engine_commands WHERE account_id = $1', [A.accountId])).rows[0].n)).toBe(0);
    });
  });

  describe('findEngineTarget for a watch', () => {
    const find = (kind?: 'watch', repo = A.repoId) => withTenant(appUserPool, A.accountId, A.userId, (c) => findEngineTarget(c, A.accountId, repo, kind));

    it('needs no operate: with operate off a watch finds its runner, and any other kind is operate_off', async () => {
      await session({ kind: 'bridge' });
      expect(await find('watch')).toMatchObject({ status: 'ok', runnerId: runner });
      expect(await find()).toEqual({ status: 'operate_off' });
    });

    it('needs the watch switch (watch_off) and a ticked repo (repo_not_enabled), in that order, whatever operate says', async () => {
      await session({ kind: 'bridge' });
      await settings(false, false);
      expect(await find('watch')).toEqual({ status: 'watch_off' });
      await admin.query('DELETE FROM engine_bridge_settings WHERE account_id = $1', [A.accountId]);
      expect(await find('watch')).toEqual({ status: 'watch_off' });
      await settings(true, true);
      await tick(A.repoId, false);
      expect(await find('watch')).toEqual({ status: 'repo_not_enabled' });
      await tick(repo2, true);
      expect(await find('watch')).toEqual({ status: 'repo_not_enabled' });
      await tick(A.repoId, true);
      expect(await find('watch')).toMatchObject({ status: 'ok' });
    });

    it('finds a runner heard from within three slim intervals for a watch, and only 3 minutes for any other kind', async () => {
      await settings(true, true);
      expect(SESSION_LIVE_WITHIN_S).toBe(180);
      expect(WATCH_TARGET_LIVE_WITHIN_S).toBeGreaterThanOrEqual(900);
      await session({ kind: 'bridge', heardAgo: `${SESSION_LIVE_WITHIN_S + 120} seconds` });
      expect(await find('watch')).toMatchObject({ status: 'ok' });
      expect(await find()).toEqual({ status: 'not_connected' });
      await admin.query('DELETE FROM engine_sessions WHERE account_id = $1', [A.accountId]);
      await session({ kind: 'bridge', heardAgo: `${WATCH_TARGET_LIVE_WITHIN_S + 60} seconds` });
      expect(await find('watch')).toEqual({ status: 'not_connected' });
    });

    it('never finds a foreign account\'s runner or the same account\'s other repo\'s session', async () => {
      await session({ account: B, kind: 'bridge' });
      await session({ repo: repo2, kind: 'bridge' });
      expect(await find('watch')).toEqual({ status: 'not_connected' });
      expect(await find('watch', B.repoId)).toEqual({ status: 'no_repo' });
    });
  });
});
