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

/** D#845 ON-27d4a (migration 1116): the twin work lists, the claim and lease, the anchor on a parity result (FU-312) and the visibility record (FU-311). */
describe('twin work [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let writerPool: Pool;
  let opsPool: Pool;
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
  const repoFor = async (acct: SeedRefs, owner: string, name: string): Promise<string> => {
    const id = randomUUID();
    await admin.query('INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      id, acct.accountId, acct.installationId, Math.floor(Math.random() * 1e9) + 10, 'team', owner, name,
    ]);
    return id;
  };
  const as = <T>(acct: SeedRefs, user: string | null, fn: (c: PoolClient) => Promise<T>) => (user ? withTenant(appPool, acct.accountId, user, fn) : withTenant(appPool, acct.accountId, fn));
  const asRunner = <T>(acct: SeedRefs, fn: (c: PoolClient) => Promise<T>) =>
    withTenant(appPool, acct.accountId, async (c) => {
      await c.query("SELECT set_config('app.runner_id', $1, true)", [randomUUID()]);
      return fn(c);
    });
  /** A twin made through the real create definer, then set to the given state; `last_result` makes a check row. */
  const twinFor = async (acct: SeedRefs, user: string, o: { state?: string; result?: string; due?: string; syncPr?: number; seeded?: boolean } = {}) => {
    const tag = randomUUID().slice(0, 8);
    const pub = await repoFor(acct, 'Acme', `pub-${tag}`);
    const priv = await repoFor(acct, 'Acme', `priv-${tag}`);
    const r = await as(acct, user, async (c) => (await c.query<{ o_result: string; o_id: string }>('SELECT o_result, o_id FROM twin_record($1, $2, $3, $4)', [pub, priv, 555, `priv-${tag}`])).rows[0]!);
    expect(r.o_result).toBe('ok');
    const seeded = o.seeded !== false && (o.state ?? 'ready') !== 'seeding';
    await admin.query('UPDATE repo_twins SET state = $2, published_private_sha = $3, synced_public_sha = $4, sync_pr = $5 WHERE id = $1', [r.o_id, o.state ?? 'ready', seeded ? PRIV0 : null, seeded ? PUB0 : null, o.syncPr ?? null]);
    if (o.result !== undefined || o.due !== undefined) {
      // `due` is a SQL expression written in this file, never input.
      await admin.query(`INSERT INTO twin_parity_checks (twin_id, account_id, last_result, due_at) VALUES ($1, $2, $3, ${o.due ?? 'NULL'})`, [r.o_id, acct.accountId, o.result ?? null]);
    }
    return { id: r.o_id, pub, priv };
  };
  const claim = (acct: SeedRefs, user: string | null, twin: string, kind: string) =>
    as(acct, user, async (c) => (await c.query<{ o_result: string; o_mark_seq: string | null; o_anchor: string | null }>('SELECT o_result, o_mark_seq, o_anchor FROM twin_work_claim($1, $2)', [twin, kind])).rows[0]!);
  const visibility = (acct: SeedRefs, user: string | null, twin: string, priv: string, pub: string | null) =>
    as(acct, user, async (c) => (await c.query<{ o_result: string }>('SELECT o_result FROM twin_visibility_record($1, $2, $3)', [twin, priv, pub])).rows[0]!.o_result);
  const RECORD = 'SELECT o_result, o_state FROM twin_parity_record($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)';
  const record = (acct: SeedRefs, twin: string, anchor: string | null, result: string, seq = 0) =>
    as(acct, null, async (c) => (await c.query<{ o_result: string; o_state: string | null }>(RECORD, [twin, seq, anchor, result, PRIV0, PUB1, [], 0, 0, 0, 0, null])).rows[0]!);
  const twin = async (id: string) => (await admin.query('SELECT * FROM repo_twins WHERE id = $1', [id])).rows[0];
  const check = async (id: string) => (await admin.query('SELECT * FROM twin_parity_checks WHERE twin_id = $1', [id])).rows[0];
  const secondsTo = async (col: string, id: string): Promise<number | null> =>
    (await admin.query(`SELECT extract(epoch FROM (${col} - now()))::float AS s FROM twin_parity_checks WHERE twin_id = $1`, [id])).rows[0]?.s ?? null;
  const workList = async (): Promise<Map<string, string>> =>
    new Map((await writerPool.query<{ twin_id: string; o_kind: string }>('SELECT twin_id, o_kind FROM twin_work_list(200)')).rows.map((r) => [r.twin_id, r.o_kind]));
  const parityList = async () => (await writerPool.query<{ account_id: string; twin_id: string; due_now: boolean }>('SELECT account_id, twin_id, due_now FROM twin_parity_list_due(200)')).rows;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    writerPool = createPool(process.env.DATABASE_URL_RUN_WRITER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    adminA = await addUser(a, 'admin');
    memberA = await addUser(a, 'member');
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
    await opsPool.end();
    await writerPool.end();
  });

  describe('the two lists', () => {
    it('are open to the run-writer login alone', async () => {
      for (const [name, pool] of [['platform_ops', opsPool], ['app_user', appPool]] as const) {
        await expect(pool.query('SELECT * FROM twin_work_list(10)'), name).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await expect(pool.query('SELECT * FROM twin_parity_list_due(10)'), name).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
      await expect(writerPool.query('SELECT * FROM twin_work_list(0)')).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      await expect(writerPool.query('SELECT * FROM twin_parity_list_due(201)')).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
    });

    it('twin_work_list names the next job of a seeding twin and of a ready twin with something to publish or to bring in, across accounts, and nothing else', async () => {
      const adminB = await addUser(b, 'admin');
      const seeding = await twinFor(a, adminA, { state: 'seeding' });
      const publish = await twinFor(a, adminA, { result: 'publish_pending' });
      const sync = await twinFor(b, adminB, { result: 'sync_pending' });
      const syncOpen = await twinFor(a, adminA, { result: 'sync_pending', syncPr: 7 });
      const inParity = await twinFor(a, adminA, { result: 'in_parity' });
      const conflict = await twinFor(a, adminA, { state: 'conflict', result: 'conflict' });
      const paused = await twinFor(a, adminA, { state: 'paused', result: 'publish_pending' });
      const noPrivate = await twinFor(a, adminA, { result: 'publish_pending' });
      await admin.query('DELETE FROM repos WHERE id = $1', [noPrivate.priv]);
      const listed = await workList();
      expect(listed.get(seeding.id)).toBe('seed');
      expect(listed.get(publish.id)).toBe('publish');
      expect(listed.get(sync.id)).toBe('sync');
      for (const t of [syncOpen, inParity, conflict, paused, noPrivate]) expect(listed.has(t.id), t.id).toBe(false);
      const cols = (await writerPool.query('SELECT * FROM twin_work_list(1)')).fields.map((f) => f.name);
      expect(cols).toEqual(['account_id', 'twin_id', 'o_kind']);
    });

    it('twin_work_list leaves out a twin under a lease until it ends, and one of a deleted account', async () => {
      const t = await twinFor(a, adminA, { result: 'publish_pending' });
      expect((await workList()).has(t.id)).toBe(true);
      await admin.query("UPDATE twin_parity_checks SET work_lease_until = now() + interval '1 minute' WHERE twin_id = $1", [t.id]);
      expect((await workList()).has(t.id)).toBe(false);
      await admin.query("UPDATE twin_parity_checks SET work_lease_until = now() - interval '1 second' WHERE twin_id = $1", [t.id]);
      expect((await workList()).has(t.id)).toBe(true);
      await admin.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [a.accountId]);
      try {
        expect((await workList()).has(t.id)).toBe(false);
      } finally {
        await admin.query('UPDATE accounts SET deleted_at = NULL WHERE id = $1', [a.accountId]);
      }
    });

    it('twin_parity_list_due lists ready and conflicting twins with a due time, earliest first, and says which are due now', async () => {
      const soon = await twinFor(a, adminA, { due: "now() + interval '1 hour'" });
      void soon;
      const due = await twinFor(a, adminA, { state: 'conflict', result: 'conflict' });
      await admin.query("UPDATE twin_parity_checks SET due_at = now() - interval '1 minute' WHERE twin_id = $1", [due.id]);
      const later = await twinFor(a, adminA, { result: 'in_parity' });
      const paused = await twinFor(a, adminA, { state: 'paused', result: 'in_parity' });
      await admin.query("UPDATE twin_parity_checks SET due_at = now() - interval '1 minute' WHERE twin_id = $1", [paused.id]);
      const rows = await parityList();
      expect(rows.find((r) => r.twin_id === due.id)).toMatchObject({ account_id: a.accountId, due_now: true });
      expect(rows.some((r) => r.twin_id === later.id), 'no due time').toBe(false);
      expect(rows.some((r) => r.twin_id === paused.id), 'paused').toBe(false);
      const order = rows.map((r) => r.twin_id);
      expect(order.indexOf(due.id)).toBeLessThan(order.length);
    });
  });

  describe('twin_work_claim', () => {
    it('refuses a platform_ops login, a runner session, a member and an inactive account, and a bad kind', async () => {
      const t = await twinFor(a, adminA, { due: 'now()' });
      await expect(opsPool.query('SELECT * FROM twin_work_claim($1, $2)', [t.id, 'parity'])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(asRunner(a, (c) => c.query('SELECT * FROM twin_work_claim($1, $2)', [t.id, 'parity']))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(claim(a, memberA, t.id, 'parity')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(claim(a, null, t.id, 'merge')).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      await admin.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [a.accountId]);
      try {
        await expect(claim(a, null, t.id, 'parity')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      } finally {
        await admin.query('UPDATE accounts SET deleted_at = NULL WHERE id = $1', [a.accountId]);
      }
    });

    it('a parity check is claimed once: the due time moves five minutes ahead, and the answer carries mark_seq and the synced tip', async () => {
      const t = await twinFor(a, adminA, { due: "now() - interval '1 second'" });
      await admin.query('UPDATE twin_parity_checks SET mark_seq = 4 WHERE twin_id = $1', [t.id]);
      expect(await claim(a, null, t.id, 'parity')).toEqual({ o_result: 'ok', o_mark_seq: '4', o_anchor: PUB0 });
      const s = (await secondsTo('due_at', t.id))!;
      expect(s).toBeGreaterThan(290);
      expect(s).toBeLessThanOrEqual(300);
      expect((await claim(a, null, t.id, 'parity')).o_result).toBe('not_due');
      expect((await parityList()).find((r) => r.twin_id === t.id)!.due_now).toBe(false);
    });

    it('a parity check that is not due, or has no row, is not_due; a twin that is not ready or in conflict is bad_state', async () => {
      const later = await twinFor(a, adminA, { due: "now() + interval '1 minute'" });
      expect((await claim(a, null, later.id, 'parity')).o_result).toBe('not_due');
      const bare = await twinFor(a, adminA);
      expect((await claim(a, adminA, bare.id, 'parity')).o_result).toBe('not_due');
      const paused = await twinFor(a, adminA, { state: 'paused', due: 'now()' });
      expect((await claim(a, null, paused.id, 'parity')).o_result).toBe('bad_state');
    });

    it.each([
      ['seed', { state: 'seeding' }],
      ['publish', { result: 'publish_pending' }],
      ['sync', { result: 'sync_pending' }],
    ])('a %s is leased for five minutes: the first claim wins, the second is leased, and the list drops it', async (kind, o) => {
      const t = await twinFor(a, adminA, o);
      expect((await workList()).get(t.id)).toBe(kind);
      expect((await claim(a, null, t.id, kind)).o_result).toBe('ok');
      const s = (await secondsTo('work_lease_until', t.id))!;
      expect(s).toBeGreaterThan(290);
      expect(s).toBeLessThanOrEqual(300);
      expect((await claim(a, null, t.id, kind)).o_result).toBe('leased');
      expect((await workList()).has(t.id)).toBe(false);
      await admin.query("UPDATE twin_parity_checks SET work_lease_until = now() - interval '1 second' WHERE twin_id = $1", [t.id]);
      expect((await claim(a, null, t.id, kind)).o_result).toBe('ok');
    });

    it('each kind re-checks what the list read: the wrong state, a twin whose sync pull request is open, an in-parity twin', async () => {
      const ready = await twinFor(a, adminA, { result: 'in_parity' });
      for (const kind of ['seed', 'publish', 'sync']) expect((await claim(a, null, ready.id, kind)).o_result, kind).toBe('bad_state');
      const open = await twinFor(a, adminA, { result: 'sync_pending', syncPr: 3 });
      expect((await claim(a, null, open.id, 'sync')).o_result).toBe('bad_state');
      const seeding = await twinFor(a, adminA, { state: 'seeding' });
      expect((await claim(a, null, seeding.id, 'publish')).o_result).toBe('bad_state');
      expect(await check(ready.id)).toMatchObject({ work_lease_until: null });
    });

    it('does not touch another account\'s twin, by a session or by an RLS-bypassing client naming a foreign account', async () => {
      const t = await twinFor(a, adminA, { result: 'publish_pending', due: 'now()' });
      expect((await claim(b, null, t.id, 'publish')).o_result).toBe('not_found');
      await admin.query('BEGIN');
      try {
        await admin.query("SELECT set_config('app.account_id', $1, true)", [b.accountId]);
        expect((await admin.query('SELECT o_result FROM twin_work_claim($1, $2)', [t.id, 'parity'])).rows[0].o_result).toBe('not_found');
      } finally {
        await admin.query('ROLLBACK');
      }
      expect(await check(t.id)).toMatchObject({ work_lease_until: null });
    });
  });

  describe('FU-312: twin_parity_record with the anchor', () => {
    it('the old eleven-argument function is gone', async () => {
      const { rows } = await admin.query("SELECT pronargs FROM pg_proc WHERE proname = 'twin_parity_record' AND pronamespace = 'public'::regnamespace");
      expect(rows.map((r) => r.pronargs)).toEqual([12]);
    });

    it('writes the result while the stored anchor is the one the check was computed from', async () => {
      const t = await twinFor(a, adminA, { due: "now() - interval '1 second'" });
      const c = await claim(a, null, t.id, 'parity');
      expect(await record(a, t.id, c.o_anchor, 'in_parity', Number(c.o_mark_seq))).toEqual({ o_result: 'ok', o_state: 'ready' });
      expect(await check(t.id)).toMatchObject({ last_result: 'in_parity', due_at: null });
    });

    it('drops a result whose anchor has moved: nothing of it is written, the twin is due at once, and the answer says stale', async () => {
      const t = await twinFor(a, adminA, { due: "now() - interval '1 second'" });
      const c = await claim(a, null, t.id, 'parity');
      await admin.query('UPDATE repo_twins SET synced_public_sha = $2 WHERE id = $1', [t.id, PUB1]); // a sync merged during the check
      const before = await twin(t.id);
      expect(await record(a, t.id, c.o_anchor, 'in_parity', Number(c.o_mark_seq))).toEqual({ o_result: 'stale', o_state: 'ready' });
      expect(await twin(t.id)).toEqual(before);
      const row = await check(t.id);
      expect(row).toMatchObject({ last_result: null, private_sha: null });
      expect((await secondsTo('due_at', t.id))!).toBeLessThanOrEqual(0.5);
      // the next claim computes it again from the anchor it has now
      const again = await claim(a, null, t.id, 'parity');
      expect(again).toMatchObject({ o_result: 'ok', o_anchor: PUB1 });
      expect((await record(a, t.id, again.o_anchor, 'in_parity', Number(again.o_mark_seq))).o_result).toBe('ok');
    });

    it('a result with no anchor, or a malformed one, is refused', async () => {
      const t = await twinFor(a, adminA);
      await expect(record(a, t.id, null, 'in_parity')).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      await expect(record(a, t.id, 'abc', 'in_parity')).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
    });
  });

  describe('FU-311: twin_visibility_record', () => {
    it('is owned by repo_twins_owner, SECURITY DEFINER, closed to PUBLIC and platform_ops, and refuses a runner, a member and an inactive account', async () => {
      const t = await twinFor(a, adminA);
      const p = (await admin.query("SELECT pg_get_userbyid(proowner) AS owner, prosecdef, has_function_privilege('platform_ops', oid, 'EXECUTE') AS ops, has_function_privilege('public', oid, 'EXECUTE') AS everyone FROM pg_proc WHERE proname = 'twin_visibility_record'")).rows[0];
      expect(p).toEqual({ owner: 'repo_twins_owner', prosecdef: true, ops: false, everyone: false });
      await expect(opsPool.query('SELECT * FROM twin_visibility_record($1, $2, $3)', [t.id, 'private', null])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(asRunner(a, (c) => c.query('SELECT * FROM twin_visibility_record($1, $2, $3)', [t.id, 'private', null]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(visibility(a, memberA, t.id, 'private', null)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(visibility(a, null, t.id, 'unknown', null)).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      await expect(visibility(a, null, t.id, 'private', 'maybe')).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
    });

    it.each(['seeding', 'ready', 'conflict', 'failed'])('a %s twin whose private repository is public is refused with twin_not_private, and asking again says refused', async (state) => {
      const t = await twinFor(a, adminA, { state });
      expect(await visibility(a, null, t.id, 'public', null)).toBe('refused');
      expect(await twin(t.id)).toMatchObject({ state: 'refused', failure_code: 'twin_not_private' });
      expect((await twin(t.id)).failure_at).not.toBeNull();
      expect(await visibility(a, adminA, t.id, 'public', 'public')).toBe('refused');
    });

    it('an automatic refusal writes one twin.refused audit row (ids, code and the state it left, no person for a person-less session), and asking again writes no second', async () => {
      const t = await twinFor(a, adminA, { state: 'ready' });
      const rows = async () => (await admin.query("SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'twin.refused' AND payload->>'twin_id' = $2", [a.accountId, t.id])).rows;
      expect(await visibility(a, null, t.id, 'public', null)).toBe('refused');
      expect(await rows()).toEqual([{ actor: null, payload: { twin_id: t.id, code: 'twin_not_private', from: 'ready' } }]);
      expect(await visibility(a, null, t.id, 'public', null)).toBe('refused');
      expect(await rows()).toHaveLength(1);
      const u = await twinFor(a, adminA, { state: 'seeding' });
      expect(await visibility(a, adminA, u.id, 'public', null)).toBe('refused');
      expect((await admin.query("SELECT actor FROM audit_log WHERE action = 'twin.refused' AND payload->>'twin_id' = $1", [u.id])).rows).toEqual([{ actor: adminA }]);
    });

    it('a twin that is removed or refused for another reason is bad_state, and is left as it is (a paused one is refused too since migration 1118: see twin-issue-import.pg.test.ts)', async () => {
      for (const [state, code] of [['removed', null], ['refused', 'head_unconfirmed']] as const) {
        const t = await twinFor(a, adminA, { state: state === 'removed' ? 'ready' : state });
        await admin.query("UPDATE repo_twins SET state = $2, failure_code = $3, removed_at = CASE WHEN $2 = 'removed' THEN now() END WHERE id = $1", [t.id, state, code]);
        expect(await visibility(a, null, t.id, 'public', null), state).toBe('bad_state');
        expect(await twin(t.id)).toMatchObject({ state, failure_code: code });
      }
    });

    it('a public repository that turned private is a note, not a refusal; it clears when the repository is public again, and an unread public side leaves it', async () => {
      const t = await twinFor(a, adminA);
      expect(await visibility(a, null, t.id, 'private', 'private')).toBe('ok');
      expect(await twin(t.id)).toMatchObject({ state: 'ready', note: 'public_repo_private', failure_code: null });
      expect(await visibility(a, null, t.id, 'private', null)).toBe('ok');
      expect((await twin(t.id)).note).toBe('public_repo_private');
      expect(await visibility(a, null, t.id, 'private', 'public')).toBe('ok');
      expect((await twin(t.id)).note).toBeNull();
    });

    it("another account's twin is not found and unchanged, by a session or by an RLS-bypassing client naming a foreign account", async () => {
      const t = await twinFor(a, adminA);
      expect(await visibility(b, null, t.id, 'public', null)).toBe('not_found');
      await admin.query('BEGIN');
      try {
        await admin.query("SELECT set_config('app.account_id', $1, true)", [b.accountId]);
        expect((await admin.query('SELECT o_result FROM twin_visibility_record($1, $2, $3)', [t.id, 'public', 'private'])).rows[0].o_result).toBe('not_found');
      } finally {
        await admin.query('ROLLBACK');
      }
      expect(await twin(t.id)).toMatchObject({ state: 'ready', failure_code: null, note: null });
    });
  });

  describe('twin_work_claim under a race: the row lock is what makes one claim win', () => {
    const open = async () => {
      const c = await appPool.connect();
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.account_id', $1, true)", [a.accountId]);
      return c;
    };
    // The second claim starts while the first transaction is still open, so it can only answer after the first commits (it blocks on FOR UPDATE), and it must then see the first's write.
    it.each([
      ['publish', 'ready', 'publish_pending', 'NULL', 'leased'],
      ['seed', 'seeding', undefined, 'NULL', 'leased'],
      ['parity', 'ready', 'in_parity', 'now()', 'not_due'],
    ])('two concurrent %s claims: exactly one wins and the second sees its write', async (kind, state, result, due, loser) => {
      const t = await twinFor(a, adminA, { state, result: result ?? undefined, due });
      const c1 = await open();
      const c2 = await open();
      try {
        const r1 = (await c1.query<{ o_result: string }>('SELECT o_result FROM twin_work_claim($1, $2)', [t.id, kind])).rows[0]!.o_result;
        expect(r1).toBe('ok');
        const second = c2.query<{ o_result: string }>('SELECT o_result FROM twin_work_claim($1, $2)', [t.id, kind]);
        let settled = false;
        void second.then(() => { settled = true; }, () => { settled = true; });
        await new Promise((r) => setTimeout(r, 300));
        expect(settled).toBe(false);
        await c1.query('COMMIT');
        expect((await second).rows[0]!.o_result).toBe(loser);
        await c2.query('COMMIT');
      } finally {
        c1.release();
        c2.release();
      }
    });
  });
});
