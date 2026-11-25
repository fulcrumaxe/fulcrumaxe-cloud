import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/** D#845 ON-27a (migration 1097): repo_twins, its two definers, the pairing exclusion, tenant scoping and who can write. */
describe('repo twins [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let adminA: string;
  let memberA: string;

  const addUser = async (acct: SeedRefs, role: string): Promise<string> => {
    const id = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [id, `${id}@example.test`]);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [acct.accountId, id, role]);
    return id;
  };
  const repoFor = async (acct: SeedRefs): Promise<string> => {
    const id = randomUUID();
    await admin.query('INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, $4, $5)', [id, acct.accountId, acct.installationId, Math.floor(Math.random() * 1e9) + 10, 'team']);
    return id;
  };
  const as = <T>(acct: SeedRefs, user: string, fn: (c: PoolClient) => Promise<T>) => withTenant(appPool, acct.accountId, user, fn);
  const record = (acct: SeedRefs, user: string, pub: string, priv: string | null, name = 'widgets-private', gh: number | null = 777) =>
    as(acct, user, async (c) => (await c.query<{ o_result: string; o_id: string | null }>('SELECT o_result, o_id FROM twin_record($1, $2, $3, $4)', [pub, priv, gh, name])).rows[0]!);
  const change = (acct: SeedRefs, user: string, id: string, action: string) =>
    as(acct, user, async (c) => (await c.query<{ o_result: string; o_state: string | null }>('SELECT o_result, o_state FROM twin_change($1, $2)', [id, action])).rows[0]!);
  const twin = async (id: string) => (await admin.query('SELECT * FROM repo_twins WHERE id = $1', [id])).rows[0];
  const audits = async (acct: SeedRefs) => (await admin.query(`SELECT action, actor, payload FROM audit_log WHERE account_id = $1 AND action LIKE 'twin.%' ORDER BY created_at, id`, [acct.accountId])).rows;
  const pair = (acct: SeedRefs, repo: string) =>
    admin.query(`INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/widgets', ARRAY['private/**'])`, [repo, acct.accountId]);

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    adminA = await addUser(a, 'admin');
    memberA = await addUser(a, 'member');
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
  });

  it('app_user can read its own twins and write none of them: every write is a definer', async () => {
    const pub = await repoFor(a);
    const { o_id } = await record(a, a.userId, pub, null);
    for (const sql of [
      `INSERT INTO repo_twins (account_id, public_repo_id, private_name, state) VALUES ($1, $2, 'x', 'ready')`,
      `UPDATE repo_twins SET state = 'ready' WHERE account_id = $1`,
      `DELETE FROM repo_twins WHERE account_id = $1`,
    ]) {
      await expect(as(a, a.userId, (c) => c.query(sql, sql.startsWith('INSERT') ? [a.accountId, pub] : [a.accountId]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    }
    expect((await twin(o_id!)).state).toBe('not_connected');
    expect((await as(a, memberA, (c) => c.query('SELECT id FROM repo_twins WHERE id = $1', [o_id]))).rows).toHaveLength(1);
  });

  it('records a twin: not_connected without the private repo, seeding with it; one audit row of ids and states, by the person', async () => {
    const pub = await repoFor(a);
    const priv = await repoFor(a);
    const first = await record(a, a.userId, pub, null, 'one-private', 11);
    expect(first.o_result).toBe('ok');
    expect(await twin(first.o_id!)).toMatchObject({ state: 'not_connected', private_repo_id: null, private_name: 'one-private', private_gh_repo_id: '11', created_by: a.userId, overlay_globs: [], publish_pr: null });
    await change(a, a.userId, first.o_id!, 'remove');
    // A removed twin is revived by a new create, now with its private repo, and starts clean.
    const again = await record(a, adminA, pub, priv, 'two-private', 12);
    expect(again).toEqual({ o_result: 'ok', o_id: first.o_id });
    expect(await twin(first.o_id!)).toMatchObject({ state: 'seeding', private_repo_id: priv, private_name: 'two-private', created_by: adminA, removed_at: null });
    const log = (await audits(a)).filter((l) => l.payload.twin_id === first.o_id);
    expect(log.map((l) => l.action)).toEqual(['twin.created', 'twin.removed', 'twin.created']);
    expect(log[2]).toMatchObject({ actor: adminA, payload: { twin_id: first.o_id, public_repo_id: pub, private_repo_id: priv, state: 'seeding' } });
  });

  it('only an owner or admin may write; a member and a stranger are refused and nothing is written or audited', async () => {
    const pub = await repoFor(a);
    const before = (await audits(a)).length;
    await expect(record(a, memberA, pub, null)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(record(a, randomUUID(), pub, null)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    expect((await admin.query('SELECT 1 FROM repo_twins WHERE public_repo_id = $1', [pub])).rows).toHaveLength(0);
    const mine = await record(a, a.userId, pub, null);
    await expect(change(a, memberA, mine.o_id!, 'pause')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    expect((await twin(mine.o_id!)).state).toBe('not_connected');
    expect((await audits(a)).length).toBe(before + 1);
  });

  it("another account's twin and repos are out of reach: not_found, no row change, no read", async () => {
    const pubA = await repoFor(a);
    const pubB = await repoFor(b);
    const ta = await record(a, a.userId, pubA, null);
    // B names A's repo, and A names B's: both answer not_found and write nothing.
    expect((await record(b, b.userId, pubA, null)).o_result).toBe('not_found');
    expect((await record(a, a.userId, pubB, null)).o_result).toBe('not_found');
    const privA = await repoFor(a);
    expect((await record(b, b.userId, pubB, privA)).o_result).toBe('not_found');
    expect((await change(b, b.userId, ta.o_id!, 'pause')).o_result).toBe('not_found');
    expect((await change(b, b.userId, ta.o_id!, 'remove')).o_result).toBe('not_found');
    expect((await twin(ta.o_id!)).state).toBe('not_connected');
    expect((await as(b, b.userId, (c) => c.query('SELECT id FROM repo_twins WHERE id = $1 OR public_repo_id = $2', [ta.o_id, pubA]))).rows).toEqual([]);
    expect((await admin.query('SELECT 1 FROM repo_twins WHERE account_id = $1 AND public_repo_id = $2', [b.accountId, pubA])).rows).toEqual([]);
    expect((await audits(b)).filter((l) => l.payload.twin_id === ta.o_id)).toEqual([]);
  });

  it('a repo has at most one twin and never a twin and a pairing: either repo of the pair, in both orders', async () => {
    const pub = await repoFor(a);
    const priv = await repoFor(a);
    const other = await repoFor(a);
    const t = await record(a, a.userId, pub, priv);
    expect(await record(a, a.userId, pub, null)).toEqual({ o_result: 'twin_exists', o_id: null });
    // The private repo of a live twin cannot be the private repo of another.
    expect((await record(a, a.userId, other, priv)).o_result).toBe('twin_exists');
    expect((await admin.query('SELECT 1 FROM repo_twins WHERE public_repo_id = $1', [other])).rows).toHaveLength(0);
    // A repo with a pairing, public or private side, cannot get a twin.
    const paired = await repoFor(a);
    await pair(a, paired);
    expect((await record(a, a.userId, paired, null)).o_result).toBe('pairing_exists');
    const free = await repoFor(a);
    expect((await record(a, a.userId, free, paired)).o_result).toBe('pairing_exists');
    expect((await admin.query('SELECT 1 FROM repo_twins WHERE public_repo_id IN ($1, $2)', [paired, free])).rows).toHaveLength(0);
    await change(a, a.userId, t.o_id!, 'remove');
    expect((await record(a, a.userId, other, priv)).o_result).toBe('ok');
  });

  it('pause, resume and remove move the state the table says, audit each, and refuse what the state does not allow', async () => {
    const pub = await repoFor(a);
    const priv = await repoFor(a);
    const t = (await record(a, a.userId, pub, priv)).o_id!;
    expect(await change(a, a.userId, t, 'resume')).toEqual({ o_result: 'bad_state', o_state: 'seeding' });
    expect(await change(a, a.userId, t, 'pause')).toEqual({ o_result: 'ok', o_state: 'paused' });
    expect(await change(a, a.userId, t, 'pause')).toEqual({ o_result: 'bad_state', o_state: 'paused' });
    // Resume goes to what the columns say: seeding before the seed, ready after it.
    expect(await change(a, a.userId, t, 'resume')).toEqual({ o_result: 'ok', o_state: 'seeding' });
    await admin.query(`UPDATE repo_twins SET published_private_sha = $2, state = 'ready' WHERE id = $1`, [t, 'a'.repeat(40)]);
    await change(a, a.userId, t, 'pause');
    expect(await change(a, a.userId, t, 'resume')).toEqual({ o_result: 'ok', o_state: 'ready' });
    expect(await change(a, a.userId, t, 'remove')).toEqual({ o_result: 'ok', o_state: 'removed' });
    expect((await twin(t)).removed_at).not.toBeNull();
    for (const action of ['pause', 'resume', 'remove']) expect(await change(a, a.userId, t, action)).toEqual({ o_result: 'bad_state', o_state: 'removed' });
    const log = (await audits(a)).filter((l) => l.payload.twin_id === t);
    expect(log.map((l) => [l.action, l.payload.from, l.payload.to])).toEqual([
      ['twin.created', undefined, undefined],
      ['twin.paused', 'seeding', 'paused'],
      ['twin.resumed', 'paused', 'seeding'],
      ['twin.paused', 'ready', 'paused'],
      ['twin.resumed', 'paused', 'ready'],
      ['twin.removed', 'ready', 'removed'],
    ]);
    // Never a GitHub repo: the row keeps the private repo it had, and nothing here deletes anything.
    expect((await twin(t)).private_repo_id).toBe(priv);
    await expect(change(a, a.userId, t, 'delete')).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
  });

  it('the table refuses a bad state, the same repo on both sides, a removed state without a stamp, and an unbounded private set', async () => {
    const pub = await repoFor(a);
    const t = (await record(a, a.userId, pub, null)).o_id!;
    for (const [sql, args] of [
      [`UPDATE repo_twins SET state = 'live' WHERE id = $1`, [t]],
      [`UPDATE repo_twins SET private_repo_id = public_repo_id WHERE id = $1`, [t]],
      [`UPDATE repo_twins SET state = 'removed' WHERE id = $1`, [t]],
      [`UPDATE repo_twins SET overlay_globs = (SELECT array_agg('p' || g) FROM generate_series(1, 101) g) WHERE id = $1`, [t]],
      [`UPDATE repo_twins SET published_private_sha = 'xyz' WHERE id = $1`, [t]],
      [`UPDATE repo_twins SET private_name = '../x' WHERE id = $1`, [t]],
    ] as const) {
      await expect(admin.query(sql, [...args])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    }
  });
});
