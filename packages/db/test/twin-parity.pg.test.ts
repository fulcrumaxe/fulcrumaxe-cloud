import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const SHA = (n: number): string => n.toString(16).padStart(40, '0');
const PRIV0 = SHA(0xa1);
const PUB0 = SHA(0xb1);
const PUB1 = SHA(0xb2);
const PRIV1 = SHA(0xa2);

interface Rec {
  result?: string;
  seq?: number | string;
  priv?: string | null;
  pub?: string | null;
  paths?: string[];
  pathCount?: number;
  publish?: number;
  sync?: number;
  conflict?: number;
  advance?: string | null;
  anchor?: string | null;
}
/** A consistent argument set for each result, as the pipeline's TwinParityOutcome would give it. */
const OUTCOMES: Record<string, Rec> = {
  in_parity: { result: 'in_parity', paths: [], pathCount: 0, publish: 0, sync: 0, conflict: 0 },
  publish_pending: { result: 'publish_pending', paths: ['src/a.ts', 'src/b.ts'], pathCount: 2, publish: 2, sync: 0, conflict: 0 },
  sync_pending: { result: 'sync_pending', paths: ['lib/x.ts'], pathCount: 1, publish: 3, sync: 1, conflict: 0 },
  conflict: { result: 'conflict', paths: ['src/both.ts'], pathCount: 1, publish: 1, sync: 2, conflict: 1 },
};

/** D#845 ON-27d2b (migration 1112): the per-twin parity due mark and the parity-result definer. */
describe('twin parity storage [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let adminA: string;
  let memberA: string;
  let adminB: string;
  let opsPool: Pool;

  const addUser = async (acct: SeedRefs, role: string): Promise<string> => {
    const id = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [id, `${id}@example.test`]);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [acct.accountId, id, role]);
    return id;
  };
  const repoFor = async (acct: SeedRefs, owner: string, name: string): Promise<string> => {
    const id = randomUUID();
    await admin.query('INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      id, acct.accountId, acct.installationId, Math.floor(Math.random() * 1e9) + 10, 'team', owner, name,
    ]);
    return id;
  };
  /** A ready twin, seeded (both anchors set), made through the real create definer. */
  const twinFor = async (acct: SeedRefs, user: string, o: { state?: string; seeded?: boolean } = {}) => {
    const tag = randomUUID().slice(0, 8);
    const pub = await repoFor(acct, 'Acme', `pub-${tag}`);
    const priv = await repoFor(acct, 'Acme', `priv-${tag}`);
    const r = await as(acct, user, async (c) => (await c.query<{ o_result: string; o_id: string }>('SELECT o_result, o_id FROM twin_record($1, $2, $3, $4)', [pub, priv, 555, `priv-${tag}`])).rows[0]!);
    expect(r.o_result).toBe('ok');
    const seeded = o.seeded !== false;
    await admin.query('UPDATE repo_twins SET state = $2, published_private_sha = $3, synced_public_sha = $4 WHERE id = $1', [r.o_id, o.state ?? 'ready', seeded ? PRIV0 : null, seeded ? PUB0 : null]);
    return { id: r.o_id, pub, priv, tag };
  };
  const as = <T>(acct: SeedRefs, user: string | null, fn: (c: PoolClient) => Promise<T>) => (user ? withTenant(appPool, acct.accountId, user, fn) : withTenant(appPool, acct.accountId, fn));
  const asRunner = <T>(acct: SeedRefs, fn: (c: PoolClient) => Promise<T>) =>
    withTenant(appPool, acct.accountId, async (c) => {
      await c.query("SELECT set_config('app.runner_id', $1, true)", [randomUUID()]);
      return fn(c);
    });
  const mark = (acct: SeedRefs, user: string | null, twin: string, repo: string | null, name: string | null) =>
    as(acct, user, async (c) => (await c.query<{ o_result: string }>('SELECT o_result FROM twin_parity_mark_due($1, $2, $3)', [twin, repo, name])).rows[0]!.o_result);
  const argsOf = (twin: string, o: Rec) => [
    twin, o.seq ?? 0, o.anchor === undefined ? PUB0 : o.anchor, o.result ?? 'in_parity', o.priv === undefined ? PRIV0 : o.priv, o.pub === undefined ? PUB0 : o.pub, o.paths ?? [], o.pathCount ?? (o.paths ?? []).length, o.publish ?? 0, o.sync ?? 0, o.conflict ?? 0, o.advance ?? null,
  ];
  const RECORD_SQL = 'SELECT o_result, o_state FROM twin_parity_record($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)';
  const record = (acct: SeedRefs, user: string | null, twin: string, o: Rec) =>
    as(acct, user, async (c) => (await c.query<{ o_result: string; o_state: string | null }>(RECORD_SQL, argsOf(twin, o))).rows[0]!);
  const twin = async (id: string) => (await admin.query('SELECT * FROM repo_twins WHERE id = $1', [id])).rows[0];
  const check = async (id: string) => (await admin.query('SELECT * FROM twin_parity_checks WHERE twin_id = $1', [id])).rows[0];
  const dueInSeconds = async (id: string): Promise<number | null> =>
    (await admin.query('SELECT extract(epoch FROM (due_at - now()))::float AS s FROM twin_parity_checks WHERE twin_id = $1', [id])).rows[0]?.s ?? null;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    adminA = await addUser(a, 'admin');
    memberA = await addUser(a, 'member');
    adminB = await addUser(b, 'admin');
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
    await opsPool.end();
  });

  describe('closed to everyone but the webhook path', () => {
    it('both functions are owned by repo_twins_owner, SECURITY DEFINER with a pinned search_path, closed to PUBLIC and platform_ops, open to app_user alone', async () => {
      const rows = (await admin.query(
        `SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig, has_function_privilege('app_user', p.oid, 'EXECUTE') AS app,
                has_function_privilege('platform_ops', p.oid, 'EXECUTE') AS ops, has_function_privilege('public', p.oid, 'EXECUTE') AS everyone
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('twin_parity_mark_due', 'twin_parity_record') ORDER BY 1`,
      )).rows;
      expect(rows.map((r) => r.proname)).toEqual(['twin_parity_mark_due', 'twin_parity_record']);
      for (const r of rows) {
        expect(r).toMatchObject({ owner: 'repo_twins_owner', definer: true, app: true, ops: false, everyone: false });
        expect(r.proconfig).toContain('search_path=pg_catalog, public, pg_temp');
      }
    });

    it('a platform_ops login cannot call them', async () => {
      const t = await twinFor(a, adminA);
      await expect(opsPool.query('SELECT * FROM twin_parity_mark_due($1, $2, NULL)', [t.id, t.pub])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(opsPool.query(RECORD_SQL, argsOf(t.id, OUTCOMES.in_parity!))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('app_user reads its own account rows and writes none directly', async () => {
      const t = await twinFor(a, adminA);
      expect(await mark(a, null, t.id, t.pub, null)).toBe('ok');
      expect((await as(a, null, (c) => c.query('SELECT twin_id FROM twin_parity_checks WHERE twin_id = $1', [t.id]))).rowCount).toBe(1);
      expect((await as(b, null, (c) => c.query('SELECT twin_id FROM twin_parity_checks WHERE twin_id = $1', [t.id]))).rowCount).toBe(0);
      await expect(as(a, null, (c) => c.query('UPDATE twin_parity_checks SET due_at = NULL WHERE twin_id = $1', [t.id]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(as(a, null, (c) => c.query('DELETE FROM twin_parity_checks WHERE twin_id = $1', [t.id]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(as(a, null, (c) => c.query('INSERT INTO twin_parity_checks (twin_id, account_id) VALUES ($1, $2)', [randomUUID(), a.accountId]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('app_user sees no twin_parity_checks rows for an inactive account, and sees them again once it is active', async () => {
      const t = await twinFor(a, adminA);
      expect(await mark(a, null, t.id, t.pub, null)).toBe('ok');
      const seen = async () => (await as(a, null, (c) => c.query('SELECT twin_id FROM twin_parity_checks WHERE twin_id = $1', [t.id]))).rowCount;
      expect(await seen()).toBe(1);
      await admin.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [a.accountId]);
      try {
        expect(await seen()).toBe(0);
      } finally {
        await admin.query('UPDATE accounts SET deleted_at = NULL WHERE id = $1', [a.accountId]);
      }
      expect(await seen()).toBe(1);
    });

    it.each([
      ['no account', () => withTenant(appPool, randomUUID(), async (c) => { await c.query("SELECT set_config('app.account_id', '', true)"); return c.query('SELECT * FROM twin_parity_mark_due($1, $2, NULL)', [randomUUID(), randomUUID()]); })],
      ['a runner session', () => asRunner(a, (c) => c.query('SELECT * FROM twin_parity_mark_due($1, $2, NULL)', [randomUUID(), randomUUID()]))],
      ['a member who is not owner or admin', () => as(a, memberA, (c) => c.query('SELECT * FROM twin_parity_mark_due($1, $2, NULL)', [randomUUID(), randomUUID()]))],
    ])('mark_due refuses %s', async (_name, run) => {
      await expect(run()).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it.each([
      ['no account', (t: string) => withTenant(appPool, randomUUID(), async (c) => { await c.query("SELECT set_config('app.account_id', '', true)"); return c.query(RECORD_SQL, argsOf(t, OUTCOMES.in_parity!)); })],
      ['a runner session', (t: string) => asRunner(a, (c) => c.query(RECORD_SQL, argsOf(t, OUTCOMES.in_parity!)))],
      ['a member who is not owner or admin', (t: string) => as(a, memberA, (c) => c.query(RECORD_SQL, argsOf(t, OUTCOMES.in_parity!)))],
    ])('record refuses %s', async (_name, run) => {
      const t = await twinFor(a, adminA);
      await expect(run(t.id)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await check(t.id)).toBeUndefined();
    });

    it('both refuse an inactive account', async () => {
      const t = await twinFor(a, adminA);
      await admin.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [a.accountId]);
      try {
        await expect(mark(a, null, t.id, t.pub, null)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await expect(record(a, null, t.id, OUTCOMES.in_parity!)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      } finally {
        await admin.query('UPDATE accounts SET deleted_at = NULL WHERE id = $1', [a.accountId]);
      }
    });
  });

  describe('twin_parity_mark_due', () => {
    it('marks the twin 60 s ahead, counts the mark, keeps the earlier time, and a push to either side marks it', async () => {
      const t = await twinFor(a, adminA);
      expect(await mark(a, null, t.id, t.pub, null)).toBe('ok');
      const s1 = (await dueInSeconds(t.id))!;
      expect(s1).toBeGreaterThan(50);
      expect(s1).toBeLessThanOrEqual(60);
      expect((await check(t.id)).mark_seq).toBe('1');
      await admin.query("UPDATE twin_parity_checks SET due_at = now() + interval '5 seconds' WHERE twin_id = $1", [t.id]);
      expect(await mark(a, null, t.id, t.priv, null)).toBe('ok');
      expect((await dueInSeconds(t.id))!).toBeLessThanOrEqual(5);
      expect((await check(t.id)).mark_seq).toBe('2');
      // a due mark that was cleared is set again
      await admin.query('UPDATE twin_parity_checks SET due_at = NULL WHERE twin_id = $1', [t.id]);
      expect(await mark(a, adminA, t.id, null, `ACME/pub-${t.tag}`)).toBe('ok');
      expect((await dueInSeconds(t.id))!).toBeGreaterThan(50);
    });

    it('finds a side by its owner/name without regard to case, and a conflicting twin is marked too', async () => {
      const t = await twinFor(a, adminA, { state: 'conflict' });
      expect(await mark(a, null, t.id, null, `acme/PRIV-${t.tag}`)).toBe('ok');
    });

    it('refuses a pushed repository that is neither side of the twin, and writes no row', async () => {
      const t = await twinFor(a, adminA);
      const other = await twinFor(a, adminA);
      expect(await mark(a, null, t.id, other.pub, null)).toBe('repo_mismatch');
      expect(await mark(a, null, t.id, other.priv, null)).toBe('repo_mismatch');
      expect(await mark(a, null, t.id, null, `Acme/pub-${other.tag}`)).toBe('repo_mismatch');
      expect(await mark(a, null, t.id, randomUUID(), 'Acme/nowhere')).toBe('repo_mismatch');
      expect(await check(t.id)).toBeUndefined();
      expect(await check(other.id)).toBeUndefined();
    });

    it('marks only the named twin: a sibling twin of the same account is not touched', async () => {
      const t = await twinFor(a, adminA);
      const sibling = await twinFor(a, adminA);
      expect(await mark(a, null, t.id, t.pub, null)).toBe('ok');
      expect(await check(sibling.id)).toBeUndefined();
    });

    it.each(['paused', 'seeding', 'refused', 'failed', 'removed', 'creating'])('a %s twin is not marked', async (state) => {
      const t = await twinFor(a, adminA);
      await admin.query("UPDATE repo_twins SET state = $2, removed_at = CASE WHEN $2 = 'removed' THEN now() END WHERE id = $1", [t.id, state]);
      expect(await mark(a, null, t.id, t.pub, null)).toBe('bad_state');
      expect(await check(t.id)).toBeUndefined();
    });

    it('a ready twin whose private repository row was deleted (the link is set NULL) is bad_state and writes no row', async () => {
      const t = await twinFor(a, adminA);
      await admin.query('DELETE FROM repos WHERE id = $1', [t.priv]);
      const row = await twin(t.id);
      expect(row.state).toBe('ready');
      expect(row.private_repo_id).toBeNull();
      expect(await mark(a, null, t.id, t.pub, null)).toBe('bad_state');
      expect(await check(t.id)).toBeUndefined();
    });

    it('another account cannot mark a twin of this one (not found, nothing written, even naming its real repositories)', async () => {
      const t = await twinFor(a, adminA);
      expect(await mark(b, adminB, t.id, t.pub, null)).toBe('not_found');
      expect(await mark(b, null, t.id, null, `Acme/pub-${t.tag}`)).toBe('not_found');
      expect(await check(t.id)).toBeUndefined();
    });

    it("an RLS-bypassing client naming a foreign account finds nothing either (the function's own account predicate, on top of row security)", async () => {
      const t = await twinFor(a, adminA);
      await admin.query('BEGIN');
      try {
        await admin.query("SELECT set_config('app.account_id', $1, true)", [b.accountId]);
        const r = await admin.query('SELECT o_result FROM twin_parity_mark_due($1, $2, NULL)', [t.id, t.pub]);
        expect(r.rows[0].o_result).toBe('not_found');
      } finally {
        await admin.query('ROLLBACK');
      }
      expect(await check(t.id)).toBeUndefined();
    });

    it('refuses a missing or malformed argument', async () => {
      const t = await twinFor(a, adminA);
      await expect(mark(a, null, t.id, null, null)).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      await expect(mark(a, null, t.id, null, 'no-slash')).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      await expect(mark(a, null, t.id, null, 'a/b/c')).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      await expect(as(a, null, (c) => c.query('SELECT * FROM twin_parity_mark_due(NULL, $1, NULL)', [t.pub]))).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
    });
  });

  describe('twin_parity_record, one outcome each', () => {
    it.each(['in_parity', 'publish_pending', 'sync_pending', 'conflict'])('%s is recorded with its counts, paths and tips, the twin state follows, and the due mark is cleared', async (name) => {
      const o = OUTCOMES[name]!;
      const t = await twinFor(a, adminA);
      expect(await mark(a, null, t.id, t.pub, null)).toBe('ok');
      const r = await record(a, null, t.id, { ...o, seq: 1, priv: PRIV1, pub: PUB1 });
      expect(r).toEqual({ o_result: 'ok', o_state: name === 'conflict' ? 'conflict' : 'ready' });
      expect((await twin(t.id)).state).toBe(name === 'conflict' ? 'conflict' : 'ready');
      expect(await check(t.id)).toMatchObject({
        last_result: name, private_sha: PRIV1, public_sha: PUB1, paths: o.paths, path_count: o.pathCount, publish_count: o.publish, sync_count: o.sync, conflict_count: o.conflict, due_at: null,
      });
      expect((await check(t.id)).checked_at).not.toBeNull();
      // no advance asked for: the anchor stays, whatever the result
      expect((await twin(t.id)).synced_public_sha).toBe(PUB0);
    });

    it('a conflict clears when a later result says in parity: the twin is ready again', async () => {
      const t = await twinFor(a, adminA);
      expect((await record(a, null, t.id, OUTCOMES.conflict!)).o_state).toBe('conflict');
      expect((await record(a, adminA, t.id, OUTCOMES.publish_pending!)).o_state).toBe('ready');
      expect((await twin(t.id)).state).toBe('ready');
    });

    it('records the first result of a twin that was never marked (no row yet)', async () => {
      const t = await twinFor(a, adminA);
      expect(await check(t.id)).toBeUndefined();
      expect((await record(a, null, t.id, OUTCOMES.in_parity!)).o_result).toBe('ok');
      expect((await check(t.id)).due_at).toBeNull();
    });
  });

  describe('twin_parity_record, advanceSyncedTo', () => {
    it('without it the anchor and the twin row stay exactly as they were', async () => {
      const t = await twinFor(a, adminA);
      const before = await twin(t.id);
      await record(a, null, t.id, { ...OUTCOMES.in_parity!, pub: PUB1 });
      const after = await twin(t.id);
      expect(after.synced_public_sha).toBe(PUB0);
      expect(after.updated_at).toEqual(before.updated_at);
    });

    it.each(['in_parity', 'publish_pending'])('with it (%s) synced_public_sha moves to the public tip that was compared', async (name) => {
      const t = await twinFor(a, adminA);
      await admin.query("UPDATE repo_twins SET updated_at = now() - interval '1 hour' WHERE id = $1", [t.id]);
      const before = await twin(t.id);
      expect(await record(a, null, t.id, { ...OUTCOMES[name]!, pub: PUB1, advance: PUB1 })).toEqual({ o_result: 'ok', o_state: 'ready' });
      const after = await twin(t.id);
      expect(after.synced_public_sha).toBe(PUB1);
      expect(after.published_private_sha).toBe(PRIV0);
      expect(after.updated_at.getTime()).toBeGreaterThan(before.updated_at.getTime());
    });

    it('is refused with a sync_pending or conflict result, and nothing is written', async () => {
      const t = await twinFor(a, adminA);
      for (const name of ['sync_pending', 'conflict']) {
        await expect(record(a, null, t.id, { ...OUTCOMES[name]!, pub: PUB1, advance: PUB1 })).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      }
      expect((await twin(t.id)).synced_public_sha).toBe(PUB0);
      expect(await check(t.id)).toBeUndefined();
    });

    it('is refused when it is not the public tip that was compared (a different sha, or no tip given)', async () => {
      const t = await twinFor(a, adminA);
      await expect(record(a, null, t.id, { ...OUTCOMES.in_parity!, pub: PUB1, advance: SHA(0xee) })).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      await expect(record(a, null, t.id, { ...OUTCOMES.in_parity!, pub: null, advance: PUB1 })).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      expect((await twin(t.id)).synced_public_sha).toBe(PUB0);
    });

    it('moves nothing else the sync and publish rows own', async () => {
      const t = await twinFor(a, adminA);
      await admin.query('UPDATE repo_twins SET sync_head = $2, sync_verified_at = now(), sync_pr = 7, publish_pr = 9, failure_code = $3 WHERE id = $1', [t.id, SHA(0xc3), 'some_code']);
      const before = await twin(t.id);
      await record(a, null, t.id, { ...OUTCOMES.in_parity!, pub: PUB1, advance: PUB1 });
      const after = await twin(t.id);
      for (const col of ['sync_head', 'sync_verified_at', 'sync_pr', 'publish_pr', 'published_private_sha', 'failure_code', 'overlay_globs', 'install_paths', 'private_repo_id', 'public_repo_id']) {
        expect(after[col], col).toEqual(before[col]);
      }
    });
  });

  describe('twin_parity_record, the due mark and the twin states', () => {
    it('keeps the twin due when a push marked it after the check claimed it, and clears it when none did', async () => {
      const t = await twinFor(a, adminA);
      await mark(a, null, t.id, t.pub, null);
      const claimed = (await check(t.id)).mark_seq;
      await mark(a, null, t.id, t.priv, null); // a push arrives during the check
      await record(a, null, t.id, { ...OUTCOMES.in_parity!, seq: claimed });
      expect((await check(t.id)).due_at).not.toBeNull();
      await record(a, null, t.id, { ...OUTCOMES.in_parity!, seq: (await check(t.id)).mark_seq });
      expect((await check(t.id)).due_at).toBeNull();
    });

    it.each(['paused', 'seeding', 'refused', 'failed', 'removed'])('a %s twin: bad_state, the due mark is cleared, and nothing else is written', async (state) => {
      const t = await twinFor(a, adminA);
      await mark(a, null, t.id, t.pub, null);
      await admin.query("UPDATE repo_twins SET state = $2, removed_at = CASE WHEN $2 = 'removed' THEN now() END WHERE id = $1", [t.id, state]);
      const seq = (await check(t.id)).mark_seq;
      expect(await record(a, null, t.id, { ...OUTCOMES.conflict!, seq })).toEqual({ o_result: 'bad_state', o_state: state });
      const row = await check(t.id);
      expect(row).toMatchObject({ due_at: null, last_result: null });
      expect((await twin(t.id)).state).toBe(state);
    });

    it('a twin that was never seeded (an anchor missing) is bad_state', async () => {
      const t = await twinFor(a, adminA, { seeded: false });
      expect((await record(a, null, t.id, OUTCOMES.in_parity!)).o_result).toBe('bad_state');
      expect((await twin(t.id)).synced_public_sha).toBeNull();
    });

    it('a ready twin whose private repository row was deleted is bad_state: the due mark is cleared and nothing else is written', async () => {
      const t = await twinFor(a, adminA);
      await mark(a, null, t.id, t.pub, null);
      await admin.query('DELETE FROM repos WHERE id = $1', [t.priv]);
      const seq = (await check(t.id)).mark_seq;
      expect(await record(a, null, t.id, { ...OUTCOMES.conflict!, seq })).toEqual({ o_result: 'bad_state', o_state: 'ready' });
      expect(await check(t.id)).toMatchObject({ due_at: null, last_result: null });
      expect((await twin(t.id)).state).toBe('ready');
    });

    it('bad_state keeps the due mark when a push marked the twin after the check claimed it (a stale mark_seq)', async () => {
      const t = await twinFor(a, adminA);
      await mark(a, null, t.id, t.pub, null);
      const claimed = (await check(t.id)).mark_seq;
      await mark(a, null, t.id, t.priv, null); // a push arrives during the check
      await admin.query("UPDATE repo_twins SET state = 'paused' WHERE id = $1", [t.id]);
      expect((await record(a, null, t.id, { ...OUTCOMES.in_parity!, seq: claimed })).o_result).toBe('bad_state');
      const row = await check(t.id);
      expect(row.due_at).not.toBeNull();
      expect(row.mark_seq).toBe('2');
      // the check that did see the latest mark clears it
      expect((await record(a, null, t.id, { ...OUTCOMES.in_parity!, seq: row.mark_seq })).o_result).toBe('bad_state');
      expect((await check(t.id)).due_at).toBeNull();
    });

    it.each([
      ['published_private_sha', 'synced_public_sha'],
      ['synced_public_sha', 'published_private_sha'],
    ])('a twin with only %s missing is bad_state (the other anchor is set)', async (missing, kept) => {
      const t = await twinFor(a, adminA);
      await admin.query(`UPDATE repo_twins SET ${missing} = NULL WHERE id = $1`, [t.id]);
      const before = await twin(t.id);
      expect(before[kept]).not.toBeNull();
      expect((await record(a, null, t.id, { ...OUTCOMES.in_parity!, pub: PUB1, advance: PUB1 })).o_result).toBe('bad_state');
      expect(await twin(t.id)).toEqual(before);
      expect(await check(t.id)).toBeUndefined();
    });

    it('an unknown twin is not_found', async () => {
      expect((await record(a, null, randomUUID(), OUTCOMES.in_parity!)).o_result).toBe('not_found');
    });
  });

  describe('twin_parity_record, validation', () => {
    const bad: Array<[string, Rec]> = [
      ['an unknown result', { ...OUTCOMES.in_parity!, result: 'unavailable' }],
      ['a malformed private sha', { ...OUTCOMES.in_parity!, priv: 'ABC' }],
      ['a malformed public sha', { ...OUTCOMES.in_parity!, pub: 'A'.repeat(40) }],
      ['a negative mark', { ...OUTCOMES.in_parity!, seq: -1 }],
      ['in_parity with a count', { ...OUTCOMES.in_parity!, publish: 1 }],
      ['publish_pending with nothing to publish', { ...OUTCOMES.publish_pending!, publish: 0, paths: [], pathCount: 0 }],
      ['publish_pending with a sync count', { ...OUTCOMES.publish_pending!, sync: 1 }],
      ['sync_pending with a conflict count', { ...OUTCOMES.sync_pending!, conflict: 1 }],
      ['conflict with no conflict count', { ...OUTCOMES.conflict!, conflict: 0, pathCount: 0, paths: [] }],
      ['a path count that is not the result kind\'s count', { ...OUTCOMES.publish_pending!, pathCount: 5 }],
      ['paths fewer than the count', { ...OUTCOMES.publish_pending!, paths: ['src/a.ts'] }],
      ['a repeated path', { ...OUTCOMES.publish_pending!, paths: ['src/a.ts', 'src/a.ts'] }],
      ['an absolute path', { ...OUTCOMES.publish_pending!, paths: ['/etc/x', 'src/b.ts'] }],
      ['a climbing path', { ...OUTCOMES.publish_pending!, paths: ['a/../b', 'src/b.ts'] }],
      ['a path with a control character', { ...OUTCOMES.publish_pending!, paths: ['a\nb', 'src/b.ts'] }],
      ['a negative count', { ...OUTCOMES.in_parity!, sync: -1 }],
      ['sync_pending with nothing to sync', { ...OUTCOMES.sync_pending!, sync: 0, paths: [], pathCount: 0 }],
      ['in_parity with a sync count', { ...OUTCOMES.in_parity!, sync: 1 }],
      ['in_parity with a conflict count', { ...OUTCOMES.in_parity!, conflict: 1 }],
      ['a path with an empty segment (//)', { ...OUTCOMES.publish_pending!, paths: ['src//a.ts', 'src/b.ts'] }],
      ['a path over 1024 characters', { ...OUTCOMES.publish_pending!, paths: [`d/${'x'.repeat(1023)}`, 'src/b.ts'] }],
    ];
    it.each(bad)('refuses %s and writes nothing', async (_name, o) => {
      const t = await twinFor(a, adminA);
      await expect(record(a, null, t.id, o)).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      expect(await check(t.id)).toBeUndefined();
      expect((await twin(t.id)).state).toBe('ready');
    });

    it('accepts a path of exactly 1024 characters', async () => {
      const t = await twinFor(a, adminA);
      const long = `d/${'x'.repeat(1022)}`;
      expect(long).toHaveLength(1024);
      expect((await record(a, null, t.id, { result: 'publish_pending', paths: [long], pathCount: 1, publish: 1 })).o_result).toBe('ok');
      expect((await check(t.id)).paths).toEqual([long]);
    });

    it('keeps at most 200 paths while the count stays exact; 201 paths are refused', async () => {
      const t = await twinFor(a, adminA);
      const paths = Array.from({ length: 200 }, (_, i) => `d/f${i}.ts`);
      expect((await record(a, null, t.id, { result: 'publish_pending', paths, pathCount: 350, publish: 350 })).o_result).toBe('ok');
      expect(await check(t.id)).toMatchObject({ path_count: 350, publish_count: 350 });
      expect((await check(t.id)).paths).toHaveLength(200);
      await expect(record(a, null, t.id, { result: 'publish_pending', paths: [...paths, 'd/extra.ts'], pathCount: 201, publish: 201 })).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
    });
  });

  describe('twin_parity_record, tenants', () => {
    it('writes only the named twin: a sibling twin of the same account keeps its state, anchor and rows', async () => {
      const t = await twinFor(a, adminA);
      const sibling = await twinFor(a, adminA);
      await mark(a, null, sibling.id, sibling.pub, null);
      const before = { twin: await twin(sibling.id), check: await check(sibling.id) };
      await record(a, null, t.id, { ...OUTCOMES.conflict!, pub: PUB1 });
      await record(a, null, t.id, { ...OUTCOMES.in_parity!, pub: PUB1, advance: PUB1 });
      expect(await twin(sibling.id)).toEqual(before.twin);
      expect(await check(sibling.id)).toEqual(before.check);
    });

    it('another account cannot record on a twin of this one: not found, and the twin, its anchor and its rows are unchanged', async () => {
      const t = await twinFor(a, adminA);
      await mark(a, null, t.id, t.pub, null);
      const before = { twin: await twin(t.id), check: await check(t.id) };
      expect((await record(b, adminB, t.id, { ...OUTCOMES.in_parity!, pub: PUB1, advance: PUB1, seq: 1 })).o_result).toBe('not_found');
      expect((await record(b, null, t.id, { ...OUTCOMES.conflict!, seq: 1 })).o_result).toBe('not_found');
      expect(await twin(t.id)).toEqual(before.twin);
      expect(await check(t.id)).toEqual(before.check);
    });

    it("with the owner role's row policies opened wide (rolled back after), the functions' own account predicate still turns a foreign account away", async () => {
      const t = await twinFor(a, adminA);
      await admin.query('BEGIN');
      try {
        await admin.query('ALTER POLICY repo_twins_owner_use ON repo_twins USING (true) WITH CHECK (true)');
        await admin.query('ALTER POLICY repo_twins_owner_use ON repos USING (true)');
        await admin.query('ALTER POLICY repo_twins_owner_use ON twin_parity_checks USING (true) WITH CHECK (true)');
        await admin.query("SELECT set_config('app.account_id', $1, true)", [b.accountId]);
        expect((await admin.query('SELECT o_result FROM twin_parity_mark_due($1, $2, NULL)', [t.id, t.pub])).rows[0].o_result).toBe('not_found');
        expect((await admin.query(RECORD_SQL, argsOf(t.id, { ...OUTCOMES.in_parity!, pub: PUB1, advance: PUB1 }))).rows[0].o_result).toBe('not_found');
      } finally {
        await admin.query('ROLLBACK');
      }
      expect((await twin(t.id)).synced_public_sha).toBe(PUB0);
      expect(await check(t.id)).toBeUndefined();
    });

    it('an RLS-bypassing client naming a foreign account finds nothing either', async () => {
      const t = await twinFor(a, adminA);
      await admin.query('BEGIN');
      try {
        await admin.query("SELECT set_config('app.account_id', $1, true)", [b.accountId]);
        const r = await admin.query(RECORD_SQL, argsOf(t.id, { ...OUTCOMES.in_parity!, pub: PUB1, advance: PUB1 }));
        expect(r.rows[0].o_result).toBe('not_found');
      } finally {
        await admin.query('ROLLBACK');
      }
      expect((await twin(t.id)).synced_public_sha).toBe(PUB0);
      expect(await check(t.id)).toBeUndefined();
    });
  });
});
