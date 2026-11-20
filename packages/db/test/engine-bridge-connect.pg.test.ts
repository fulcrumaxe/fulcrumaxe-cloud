import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import {
  BRIDGE_RATE_MAX, bridgePhase, countRecentBridgeCommands, hasPendingBridgeCommand, latestBridgeCommand, listBridgeRunners, recentBridgeRetryAfterS, reportedBridges, rootWasOffered,
} from '../src/engineBridgeConnect.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { insertRunner } from './helpers/runnerFixtures.js';

/**
 * [pg] D#845 ON-BR-2, migration 1042: every query behind Connect and Disconnect names the account (and the repo, and the runner) itself, on top of RLS. Each is read here through the
 * RLS-bypassing admin client, so a missing predicate cannot hide behind a policy: a foreign account id reads nothing, and the same account's SECOND repo (and second runner) never shows
 * the first one's rows. The tenant side (RLS itself) is read through the app role at the end.
 */
describe('engine bridge connect: every query is scoped (migration 1042) [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let A: SeedRefs;
  let B: SeedRefs;
  let repo2: string;
  let runner1: string;
  let runner2: string;
  let foreignRunner: string;
  const ROOT = '/work/acme/site';
  let seq = 0;

  const command = async (over: { repo?: string; runner?: string; account?: string; kind?: string; state?: string; ack?: object | null; issuedAgo?: string; ackedAgo?: string } = {}): Promise<string> => {
    const state = over.state ?? 'pending';
    const acked = state === 'applied' || state === 'refused';
    const account = over.account ?? A.accountId;
    const r = await admin.query<{ id: string }>(
      `INSERT INTO engine_commands (account_id, runner_id, repo_id, command_seq, kind, args, issued_by, issued_at, expires_at, state, refusal, delivered_at, acked_at, ack_result)
       VALUES ($1, $2, $3, $4, $5, '{}', $6, now() - $7::interval, now() - $7::interval + interval '600 seconds', $8, $9, $10, $11, $12::jsonb) RETURNING id`,
      [account, over.runner ?? runner1, over.repo ?? A.repoId, ++seq, over.kind ?? 'bridge_enable', account === A.accountId ? A.userId : B.userId, over.issuedAgo ?? '0 seconds', state, state === 'refused' ? 'checkout_ambiguous' : null, acked ? new Date() : state === 'delivered' ? new Date() : null, acked ? new Date(Date.now() - (over.ackedAgo === undefined ? 0 : Number(over.ackedAgo) * 1000)) : null, over.ack === undefined ? null : JSON.stringify(over.ack)],
    );
    return r.rows[0]!.id;
  };
  const clear = async (): Promise<void> => {
    await admin.query('DELETE FROM engine_runner_bridges WHERE account_id = ANY ($1::uuid[])', [[A.accountId, B.accountId]]);
    await admin.query('DELETE FROM engine_commands WHERE account_id = ANY ($1::uuid[])', [[A.accountId, B.accountId]]);
  };

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
    await admin.query("UPDATE repos SET gh_repo_id = $2, gh_owner = 'acme', gh_name = 'one', execution_mode = 'runner_local' WHERE id = $1", [A.repoId, 7_300_000 + Math.floor(Math.random() * 99_999)]);
    repo2 = (await admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, NULL, $2, 'web', 'acme', 'two', 'runner_local') RETURNING id`, [A.accountId, 7_400_000 + Math.floor(Math.random() * 99_999)])).rows[0]!.id;
    runner1 = await insertRunner(admin, A.accountId, A.userId, { keepPlan: true });
    runner2 = await insertRunner(admin, A.accountId, A.userId, { keepPlan: true });
    foreignRunner = await insertRunner(admin, B.accountId, B.userId, { keepPlan: true });
    // The foreign runner is (wrongly) paired with account A's repo, and the second runner with the second repo only.
    await admin.query('UPDATE runners SET allowed_repo_ids = $2::uuid[], protocol_version = 24, last_seen_at = now() WHERE id = $1', [runner1, [A.repoId, repo2]]);
    await admin.query('UPDATE runners SET allowed_repo_ids = $2::uuid[], protocol_version = 23, last_seen_at = now() WHERE id = $1', [runner2, [repo2]]);
    await admin.query('UPDATE runners SET allowed_repo_ids = $2::uuid[], protocol_version = 24, last_seen_at = now() WHERE id = $1', [foreignRunner, [A.repoId]]);
  });
  afterAll(async () => {
    await clear();
    admin.release();
    await Promise.all([adminPool.end(), appUserPool.end()]);
  });

  it('listBridgeRunners: the account\'s own runners paired with that repo, no other account\'s, no other repo\'s; a foreign account id gets null', async () => {
    const one = await listBridgeRunners(admin, A.accountId, A.repoId);
    expect(one!.map((r) => r.id)).toEqual([runner1]);
    const two = await listBridgeRunners(admin, A.accountId, repo2);
    expect(two!.map((r) => r.id).sort()).toEqual([runner1, runner2].sort());
    expect(two!.find((r) => r.id === runner2)!.protocol_ok).toBe(false);
    expect(await listBridgeRunners(admin, B.accountId, A.repoId)).toBeNull();
    expect(await listBridgeRunners(admin, A.accountId, randomUUID())).toBeNull();
    // A repo that does not run on a runner has no runners.
    await admin.query("UPDATE repos SET execution_mode = 'sandbox' WHERE id = $1", [repo2]);
    expect(await listBridgeRunners(admin, A.accountId, repo2)).toEqual([]);
    await admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [repo2]);
  });

  it('countRecentBridgeCommands and recentBridgeRetryAfterS: the account\'s own commands only, bridge kinds only, the window only', async () => {
    await clear();
    for (let i = 0; i < BRIDGE_RATE_MAX; i++) await command({ repo: i % 2 === 0 ? A.repoId : repo2, kind: i % 2 === 0 ? 'bridge_enable' : 'bridge_disable', state: 'cancelled' });
    await command({ kind: 'pause_loop' });
    await command({ issuedAgo: '11 minutes' });
    expect(await countRecentBridgeCommands(admin, A.accountId)).toBe(BRIDGE_RATE_MAX);
    expect(await countRecentBridgeCommands(admin, B.accountId)).toBe(0);
    expect(await recentBridgeRetryAfterS(admin, A.accountId)).toBeGreaterThan(1);
    expect(await recentBridgeRetryAfterS(admin, B.accountId)).toBe(1);
  });

  it('hasPendingBridgeCommand: that account and that repo, undelivered and alive only', async () => {
    await clear();
    const id = await command();
    expect(await hasPendingBridgeCommand(admin, A.accountId, A.repoId)).toBe(true);
    expect(await hasPendingBridgeCommand(admin, B.accountId, A.repoId)).toBe(false);
    expect(await hasPendingBridgeCommand(admin, A.accountId, repo2)).toBe(false);
    await admin.query("UPDATE engine_commands SET state = 'delivered', delivered_at = now() WHERE id = $1", [id]);
    expect(await hasPendingBridgeCommand(admin, A.accountId, A.repoId)).toBe(false);
    await command({ kind: 'pause_loop', repo: repo2 });
    expect(await hasPendingBridgeCommand(admin, A.accountId, repo2)).toBe(false);
    await command({ issuedAgo: '11 minutes' });
    expect(await hasPendingBridgeCommand(admin, A.accountId, A.repoId)).toBe(false);
  });

  it('rootWasOffered: that account, that repo, that runner, an answer from the last 10 minutes, a refused enable', async () => {
    await clear();
    await command({ state: 'refused', ack: { result: 'ambiguous', candidates: [ROOT, '/work/b/site'] } });
    expect(await rootWasOffered(admin, A.accountId, A.repoId, runner1, ROOT)).toBe(true);
    expect(await rootWasOffered(admin, B.accountId, A.repoId, runner1, ROOT)).toBe(false);
    expect(await rootWasOffered(admin, A.accountId, repo2, runner1, ROOT)).toBe(false);
    expect(await rootWasOffered(admin, A.accountId, A.repoId, runner2, ROOT)).toBe(false);
    expect(await rootWasOffered(admin, A.accountId, A.repoId, foreignRunner, ROOT)).toBe(false);
    expect(await rootWasOffered(admin, A.accountId, A.repoId, runner1, '/work/c/site')).toBe(false);
    expect(await rootWasOffered(admin, A.accountId, A.repoId, runner1, '/work/b')).toBe(false); // a prefix of an offer is no offer
    await clear();
    await command({ state: 'refused', ack: { result: 'ambiguous', candidates: [ROOT, '/work/b/site'] }, ackedAgo: '700' });
    expect(await rootWasOffered(admin, A.accountId, A.repoId, runner1, ROOT)).toBe(false);
  });

  it('latestBridgeCommand: the newest bridge command of that account and repo, with its result; none for another', async () => {
    await clear();
    await command({ repo: repo2, kind: 'bridge_disable', state: 'applied' });
    await command({ state: 'refused', ack: { result: 'not_found', skipped: ['/work/skipped/site'] } });
    await command({ kind: 'pause_loop' });
    const mine = await latestBridgeCommand(admin, A.accountId, A.repoId, 900);
    expect(mine).toMatchObject({ kind: 'bridge_enable', state: 'refused', result: 'not_found', candidates: [], skipped: ['/work/skipped/site'] });
    expect((await latestBridgeCommand(admin, A.accountId, repo2, 900))!.kind).toBe('bridge_disable');
    expect(await latestBridgeCommand(admin, B.accountId, A.repoId, 900)).toBeNull();
    const none = await admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, NULL, $2, 'web', 'acme', 'three', 'runner_local') RETURNING id`, [A.accountId, 7_500_000 + Math.floor(Math.random() * 99_999)]);
    expect(await latestBridgeCommand(admin, A.accountId, none.rows[0]!.id, 900)).toBeNull();
  });

  it('reportedBridges: that account and repo, fresh reports of runners that are not revoked', async () => {
    await clear();
    await admin.query('INSERT INTO engine_runner_bridges (account_id, runner_id, repo_id, root) VALUES ($1, $2, $3, $4)', [A.accountId, runner1, A.repoId, ROOT]);
    await admin.query('INSERT INTO engine_runner_bridges (account_id, runner_id, repo_id, root) VALUES ($1, $2, $3, $4)', [A.accountId, runner1, repo2, '/work/two/site']);
    expect((await reportedBridges(admin, A.accountId, A.repoId)).map((b) => b.root)).toEqual([ROOT]);
    expect((await reportedBridges(admin, A.accountId, repo2)).map((b) => b.root)).toEqual(['/work/two/site']);
    expect(await reportedBridges(admin, B.accountId, A.repoId)).toEqual([]);
    await admin.query("UPDATE engine_runner_bridges SET reported_at = now() - interval '25 hours' WHERE repo_id = $1", [A.repoId]);
    expect(await reportedBridges(admin, A.accountId, A.repoId)).toEqual([]);
    await admin.query("UPDATE runners SET revoked_at = now(), revoked_reason = 'test' WHERE id = $1", [runner1]);
    expect(await reportedBridges(admin, A.accountId, repo2)).toEqual([]);
    await admin.query('UPDATE runners SET revoked_at = NULL, revoked_reason = NULL WHERE id = $1', [runner1]);
  });

  it('a person of another account reads none of a report through RLS, and a runner session writes only its own rows', async () => {
    await clear();
    await admin.query('INSERT INTO engine_runner_bridges (account_id, runner_id, repo_id, root) VALUES ($1, $2, $3, $4)', [A.accountId, runner1, A.repoId, ROOT]);
    expect(await withTenant(appUserPool, B.accountId, B.userId, async (c) => (await c.query('SELECT 1 FROM engine_runner_bridges')).rowCount)).toBe(0);
    expect(await withTenant(appUserPool, A.accountId, A.userId, async (c) => (await c.query('SELECT 1 FROM engine_runner_bridges')).rowCount)).toBe(1);
    // A person (no runner session) writes nothing, even in their own account.
    await expect(withTenant(appUserPool, A.accountId, A.userId, (c) => c.query('INSERT INTO engine_runner_bridges (account_id, runner_id, repo_id, root) VALUES ($1, $2, $3, NULL)', [A.accountId, runner1, repo2]))).rejects.toThrow();
    expect(await withTenant(appUserPool, A.accountId, A.userId, async (c) => (await c.query("UPDATE engine_runner_bridges SET root = '/work/x/y'")).rowCount)).toBe(0);
    expect(await withTenant(appUserPool, A.accountId, A.userId, async (c) => (await c.query('DELETE FROM engine_runner_bridges')).rowCount)).toBe(0);
    // Runner 2 of the same account cannot touch runner 1's row, and cannot write a row in runner 1's name.
    const asRunner2 = <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> =>
      withTenant(appUserPool, A.accountId, A.userId, async (c) => {
        await c.query("SELECT set_config('app.runner_id', $1, true)", [runner2]);
        return fn(c);
      });
    expect(await asRunner2(async (c) => (await c.query("UPDATE engine_runner_bridges SET root = '/work/hijack/x'")).rowCount)).toBe(0);
    expect(await asRunner2(async (c) => (await c.query('DELETE FROM engine_runner_bridges')).rowCount)).toBe(0);
    await expect(asRunner2((c) => c.query('INSERT INTO engine_runner_bridges (account_id, runner_id, repo_id, root) VALUES ($1, $2, $3, NULL)', [A.accountId, runner1, repo2]))).rejects.toThrow();
    // And runner 2 writes its own.
    expect(await asRunner2(async (c) => (await c.query('INSERT INTO engine_runner_bridges (account_id, runner_id, repo_id, root) VALUES ($1, $2, $3, NULL)', [A.accountId, runner2, repo2])).rowCount)).toBe(1);
    // A runner session reads only its own runner's rows (as engine_commands does), while a person of the account reads them all.
    expect(await asRunner2(async (c) => (await c.query<{ runner_id: string }>('SELECT runner_id FROM engine_runner_bridges')).rows.map((r) => r.runner_id))).toEqual([runner2]);
    expect(await withTenant(appUserPool, A.accountId, A.userId, async (c) => (await c.query('SELECT 1 FROM engine_runner_bridges')).rowCount)).toBe(2);
  });
});

describe('bridgePhase: a disconnect that ran out unanswered (ruling 8)', () => {
  const now = new Date();
  const cmd = (over: Record<string, unknown>) =>
    ({ id: 'x', kind: 'bridge_disable', runner_id: 'r', state: 'expired', refusal: null, result: null, root_tail: null, candidates: [], issued_at: new Date(now.getTime() - 700_000), expires_at: new Date(now.getTime() - 100_000), delivered_at: null, acked_at: null, ...over }) as never;
  it('is disconnect_failed, never connected, for an expired, unconfirmed or lapsed delivered disconnect while the runners still report the repo', () => {
    for (const state of ['expired', 'not_confirmed', 'delivered']) expect(bridgePhase({ connected: true, command: cmd({ state }), now }), state).toBe('disconnect_failed');
  });
  it('is disconnecting while the command is alive, and idle once the report no longer lists the repo', () => {
    expect(bridgePhase({ connected: true, command: cmd({ state: 'delivered', expires_at: new Date(now.getTime() + 60_000) }), now })).toBe('disconnecting');
    expect(bridgePhase({ connected: true, command: cmd({ state: 'pending', expires_at: new Date(now.getTime() + 60_000) }), now })).toBe('disconnecting');
    expect(bridgePhase({ connected: false, command: cmd({ state: 'expired' }), now })).toBe('idle');
  });
  it('a disconnect the runner refused reads disconnect_refused, not connected, while the repo is still reported; it ends with the report', () => {
    expect(bridgePhase({ connected: true, command: cmd({ state: 'refused', refusal: 'bridge_failed', acked_at: now }), now })).toBe('disconnect_refused');
    expect(bridgePhase({ connected: false, command: cmd({ state: 'refused', refusal: 'bridge_failed', acked_at: now }), now })).toBe('idle');
    expect(bridgePhase({ connected: true, command: cmd({ kind: 'bridge_enable', state: 'refused', refusal: 'bridge_failed', acked_at: now }), now })).toBe('connected');
  });
  it('is taken over by a newer connect or an applied disconnect', () => {
    expect(bridgePhase({ connected: true, command: cmd({ kind: 'bridge_enable', state: 'pending', expires_at: new Date(now.getTime() + 60_000) }), now })).toBe('connecting');
    expect(bridgePhase({ connected: true, command: cmd({ state: 'applied' }), now })).toBe('connected');
  });
});
