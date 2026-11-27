import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/** D#845 ON-27f (migration 1118): `twin_issue_imports` and `twin_issue_record`, the record that keeps "Bring this issue" to once per public issue. */
describe('twin_issue_record [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let opsPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let adminA: string;
  let memberA: string;
  let adminB: string;

  const addUser = async (acct: SeedRefs, role: string): Promise<string> => {
    const id = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [id, `${id}@example.test`]);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [acct.accountId, id, role]);
    return id;
  };
  const repoFor = async (acct: SeedRefs, name: string): Promise<string> => {
    const id = randomUUID();
    await admin.query('INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      id, acct.accountId, acct.installationId, Math.floor(Math.random() * 1e9) + 10, 'team', 'Acme', name,
    ]);
    return id;
  };
  const as = <T>(acct: SeedRefs, user: string | null, fn: (c: PoolClient) => Promise<T>) => (user ? withTenant(appPool, acct.accountId, user, fn) : withTenant(appPool, acct.accountId, fn));
  const asRunner = <T>(acct: SeedRefs, user: string, fn: (c: PoolClient) => Promise<T>) =>
    withTenant(appPool, acct.accountId, user, async (c) => {
      await c.query("SELECT set_config('app.runner_id', $1, true)", [randomUUID()]);
      return fn(c);
    });
  const twinFor = async (acct: SeedRefs, user: string, state = 'ready') => {
    const tag = randomUUID().slice(0, 8);
    const pub = await repoFor(acct, `pub-${tag}`);
    const priv = await repoFor(acct, `priv-${tag}`);
    const r = await as(acct, user, async (c) => (await c.query<{ o_id: string }>('SELECT o_id FROM twin_record($1, $2, $3, $4)', [pub, priv, 555, `priv-${tag}`])).rows[0]!);
    await admin.query("UPDATE repo_twins SET state = $2, removed_at = CASE WHEN $2 = 'removed' THEN now() END WHERE id = $1", [r.o_id, state]);
    return r.o_id;
  };
  const SQL = 'SELECT o_result, o_private_issue FROM twin_issue_record($1, $2, $3, $4)';
  const CLAIM = 'SELECT o_result, o_private_issue, o_claim FROM twin_issue_claim($1, $2)';
  type Row = { o_result: string; o_private_issue: number | null; o_claim?: string | null };
  const NO_CLAIM = randomUUID();
  const claim = (acct: SeedRefs, user: string | null, twin: string, pub = 12) => as(acct, user, async (c) => (await c.query<Row>(CLAIM, [twin, pub])).rows[0]!);
  /** The route's two database steps in one session: claim, then (for the winner) record. A refused claim is the answer. */
  const record = (acct: SeedRefs, user: string | null, twin: string, pub = 12, priv = 3) =>
    as(acct, user, async (c) => {
      const got = (await c.query<Row>(CLAIM, [twin, pub])).rows[0]!;
      return got.o_result === 'claimed' ? (await c.query<Row>(SQL, [twin, pub, priv, got.o_claim])).rows[0]! : { o_result: got.o_result, o_private_issue: got.o_private_issue };
    });
  const audit = async (acct: SeedRefs) => (await admin.query<{ actor: string; payload: Record<string, unknown> }>("SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'twin.issue_brought' ORDER BY created_at, id", [acct.accountId])).rows;
  const imports = async (twin: string) => (await admin.query<{ public_issue: number; private_issue: number; brought_by: string | null }>('SELECT public_issue, private_issue, brought_by FROM twin_issue_imports WHERE twin_id = $1 ORDER BY public_issue', [twin])).rows;

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

  it('is owned by repo_twins_owner, SECURITY DEFINER, pinned to its search_path, and closed to PUBLIC and platform_ops', async () => {
    const p = (await admin.query("SELECT pg_get_userbyid(proowner) AS owner, prosecdef, proconfig, has_function_privilege('platform_ops', oid, 'EXECUTE') AS ops, has_function_privilege('public', oid, 'EXECUTE') AS everyone, has_function_privilege('app_user', oid, 'EXECUTE') AS app FROM pg_proc WHERE proname = 'twin_issue_record'")).rows[0];
    expect(p).toEqual({ owner: 'repo_twins_owner', prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], ops: false, everyone: false, app: true });
    const all = (await admin.query("SELECT proname, pg_get_userbyid(proowner) AS owner, prosecdef, has_function_privilege('platform_ops', oid, 'EXECUTE') AS ops, has_function_privilege('public', oid, 'EXECUTE') AS everyone, has_function_privilege('app_user', oid, 'EXECUTE') AS app FROM pg_proc WHERE proname IN ('twin_issue_claim', 'twin_issue_release', 'twin_issue_record') ORDER BY proname")).rows;
    expect(all).toEqual(['twin_issue_claim', 'twin_issue_record', 'twin_issue_release'].map((proname) => ({ proname, owner: 'repo_twins_owner', prosecdef: true, ops: false, everyone: false, app: true })));
  });

  it('records a pair once: the first call is ok with one audit row (the person as actor, a payload of exactly the twin and the two numbers); the second is already with the number recorded first and writes nothing', async () => {
    const t = await twinFor(a, adminA);
    expect(await record(a, adminA, t, 12, 3)).toEqual({ o_result: 'ok', o_private_issue: 3 });
    expect(await record(a, a.userId, t, 12, 9)).toEqual({ o_result: 'already', o_private_issue: 3 });
    expect(await imports(t)).toEqual([{ public_issue: 12, private_issue: 3, brought_by: adminA }]);
    expect((await audit(a)).filter((r) => r.payload.twin_id === t)).toEqual([{ actor: adminA, payload: { twin_id: t, public_issue: 12, private_issue: 3 } }]);
    // another public issue of the same twin is its own pair
    expect(await record(a, adminA, t, 13, 4)).toEqual({ o_result: 'ok', o_private_issue: 4 });
    expect((await imports(t)).map((r) => [r.public_issue, r.private_issue])).toEqual([[12, 3], [13, 4]]);
  });

  const recordWith = (user: string, t: string, pub: number, priv: number, claimId: string | null | undefined) => as(a, user, async (c) => (await c.query<Row>(SQL, [t, pub, priv, claimId])).rows[0]!);
  const viewOf = (r: Row) => ({ o_result: r.o_result, o_private_issue: r.o_private_issue });

  it('claim first: the winner is claimed (with a claim id), a click while the claim is live is in_progress, and a recorded number is already; the audit row is written once, when the number is recorded', async () => {
    const t = await twinFor(a, adminA);
    const first = await claim(a, adminA, t, 20);
    expect(viewOf(first)).toEqual({ o_result: 'claimed', o_private_issue: null });
    expect(first.o_claim).toMatch(/^[0-9a-f-]{36}$/);
    expect(viewOf(await claim(a, a.userId, t, 20))).toEqual({ o_result: 'in_progress', o_private_issue: null });
    expect((await audit(a)).filter((r) => r.payload.twin_id === t)).toEqual([]);
    expect(await imports(t)).toEqual([{ public_issue: 20, private_issue: null, brought_by: adminA }]);
    expect(viewOf(await recordWith(adminA, t, 20, 6, first.o_claim))).toEqual({ o_result: 'ok', o_private_issue: 6 });
    expect(viewOf(await claim(a, a.userId, t, 20))).toEqual({ o_result: 'already', o_private_issue: 6 });
    expect(viewOf(await recordWith(adminA, t, 20, 9, first.o_claim))).toEqual({ o_result: 'already', o_private_issue: 6 });
    expect((await audit(a)).filter((r) => r.payload.twin_id === t)).toEqual([{ actor: adminA, payload: { twin_id: t, public_issue: 20, private_issue: 6 } }]);
  });

  it('two concurrent claims in two transactions: exactly one claimed, the other in_progress (or already), and one pair row', async () => {
    const t = await twinFor(a, adminA);
    const once = () => as(a, adminA, async (c) => {
      const got = (await c.query<Row>(CLAIM, [t, 30])).rows[0]!;
      await new Promise((r) => setTimeout(r, 150));
      return got;
    });
    const both = await Promise.all([once(), once()]);
    expect(both.map((r) => r.o_result).sort()).toEqual(['claimed', 'in_progress']);
    expect(await imports(t)).toHaveLength(1);
  });

  it('an expired claim without a number is retaken with a new claim id; a live one is not; a recorded pair never expires', async () => {
    const t = await twinFor(a, adminA);
    const first = await claim(a, adminA, t, 40);
    expect(first.o_result).toBe('claimed');
    await admin.query("UPDATE twin_issue_imports SET claim_until = now() + interval '1 minute' WHERE twin_id = $1", [t]);
    expect((await claim(a, a.userId, t, 40)).o_result).toBe('in_progress');
    await admin.query("UPDATE twin_issue_imports SET claim_until = now() - interval '1 second' WHERE twin_id = $1", [t]);
    const second = await claim(a, a.userId, t, 40);
    expect(second.o_result).toBe('claimed');
    expect(second.o_claim).not.toBe(first.o_claim);
    const left = (await admin.query<{ s: number }>("SELECT extract(epoch FROM claim_until - now())::int AS s FROM twin_issue_imports WHERE twin_id = $1", [t])).rows[0]!.s;
    expect(left).toBeGreaterThan(240);
    expect(left).toBeLessThanOrEqual(300);
    expect((await imports(t))[0]!.brought_by).toBe(a.userId);
    await recordWith(a.userId, t, 40, 8, second.o_claim);
    await admin.query("UPDATE twin_issue_imports SET claim_until = now() - interval '1 day' WHERE twin_id = $1", [t]);
    expect(viewOf(await claim(a, adminA, t, 40))).toEqual({ o_result: 'already', o_private_issue: 8 });
  });

  it('a slow bring: its claim was retaken, so its record says stale and writes nothing (no number, no audit row); the retaker records normally', async () => {
    const t = await twinFor(a, adminA);
    const slow = await claim(a, adminA, t, 45);
    await admin.query("UPDATE twin_issue_imports SET claim_until = now() - interval '1 second' WHERE twin_id = $1", [t]);
    const fast = await claim(a, a.userId, t, 45);
    expect(fast.o_result).toBe('claimed');
    expect(viewOf(await recordWith(adminA, t, 45, 3, slow.o_claim))).toEqual({ o_result: 'stale', o_private_issue: null });
    expect(await imports(t)).toEqual([{ public_issue: 45, private_issue: null, brought_by: a.userId }]);
    expect((await audit(a)).filter((r) => r.payload.twin_id === t)).toEqual([]);
    expect(viewOf(await recordWith(a.userId, t, 45, 4, fast.o_claim))).toEqual({ o_result: 'ok', o_private_issue: 4 });
    // a record with a claim id nobody holds is stale too, and a missing one is refused
    const other = await claim(a, adminA, t, 46);
    expect(other.o_result).toBe('claimed');
    expect(viewOf(await recordWith(adminA, t, 46, 5, NO_CLAIM))).toEqual({ o_result: 'stale', o_private_issue: null });
    await expect(recordWith(adminA, t, 46, 5, null)).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
  });

  it('release gives back only that very claim, while it has no number: another claim of the same pair, another person\'s claim and a recorded pair stay', async () => {
    const t = await twinFor(a, adminA);
    const rel = (user: string, n: number, claimId: string | null | undefined) => as(a, user, (c) => c.query('SELECT twin_issue_release($1, $2, $3)', [t, n, claimId]));
    const mine = await claim(a, adminA, t, 50);
    await rel(a.userId, 50, mine.o_claim);
    await rel(adminA, 50, NO_CLAIM);
    expect(await imports(t)).toHaveLength(1);
    await rel(adminA, 50, mine.o_claim);
    expect(await imports(t)).toEqual([]);
    // a slow bring's release must not drop the claim that replaced it
    const slow = await claim(a, adminA, t, 51);
    await admin.query("UPDATE twin_issue_imports SET claim_until = now() - interval '1 second' WHERE twin_id = $1", [t]);
    const fast = await claim(a, adminA, t, 51);
    await rel(adminA, 51, slow.o_claim);
    expect(await imports(t)).toEqual([{ public_issue: 51, private_issue: null, brought_by: adminA }]);
    await rel(adminA, 51, fast.o_claim);
    expect(await imports(t)).toEqual([]);
    const done = await claim(a, a.userId, t, 52);
    await recordWith(a.userId, t, 52, 5, done.o_claim);
    await as(a, a.userId, (c) => c.query('SELECT twin_issue_release($1, $2, $3)', [t, 52, done.o_claim]));
    expect(await imports(t)).toEqual([{ public_issue: 52, private_issue: 5, brought_by: a.userId }]);
  });

  it('record without a claim is no_claim and writes nothing; claim on another account\'s twin is not_found', async () => {
    const t = await twinFor(a, adminA);
    expect(viewOf(await recordWith(adminA, t, 60, 2, NO_CLAIM))).toEqual({ o_result: 'no_claim', o_private_issue: null });
    expect(await imports(t)).toEqual([]);
    expect(await audit(a).then((r) => r.filter((x) => x.payload.twin_id === t))).toEqual([]);
    expect(viewOf(await claim(b, adminB, t, 60))).toEqual({ o_result: 'not_found', o_private_issue: null });
  });

  it('twin_visibility_record (restated by 1118): a PAUSED twin found public is refused with twin_not_private and one audit row; a private paused twin stays; a twin already refused that way answers refused', async () => {
    const t = await twinFor(a, adminA, 'paused');
    const seen = (user: string, st: string) => as(a, user, async (c) => (await c.query<{ o_result: string }>('SELECT o_result FROM twin_visibility_record($1, $2, NULL)', [t, st])).rows[0]!.o_result);
    expect(await seen(adminA, 'private')).toBe('ok');
    expect((await admin.query<{ state: string }>('SELECT state FROM repo_twins WHERE id = $1', [t])).rows[0]!.state).toBe('paused');
    expect(await seen(adminA, 'public')).toBe('refused');
    expect((await admin.query<{ state: string; failure_code: string }>('SELECT state, failure_code FROM repo_twins WHERE id = $1', [t])).rows[0]).toEqual({ state: 'refused', failure_code: 'twin_not_private' });
    expect((await admin.query("SELECT payload FROM audit_log WHERE account_id = $1 AND action = 'twin.refused' AND payload->>'twin_id' = $2", [a.accountId, t])).rows.map((r) => r.payload)).toEqual([{ twin_id: t, code: 'twin_not_private', from: 'paused' }]);
    expect(await seen(adminA, 'public')).toBe('refused');
    const removed = await twinFor(a, adminA, 'removed');
    expect(await as(a, adminA, async (c) => (await c.query<{ o_result: string }>('SELECT o_result FROM twin_visibility_record($1, $2, NULL)', [removed, 'public'])).rows[0]!.o_result)).toBe('bad_state');
  });

  it('two twins of one account count the same public issue number separately', async () => {
    const t1 = await twinFor(a, adminA);
    const t2 = await twinFor(a, adminA);
    expect((await record(a, adminA, t1, 5, 1)).o_result).toBe('ok');
    expect((await record(a, adminA, t2, 5, 1)).o_result).toBe('ok');
  });

  it('refuses a member, a runner session, a session with no person and a platform_ops login, and writes nothing', async () => {
    const t = await twinFor(a, adminA);
    await expect(record(a, memberA, t)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(asRunner(a, adminA, (c) => c.query(SQL, [t, 1, 1, NO_CLAIM]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(record(a, null, t)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(opsPool.query(SQL, [t, 1, 1, NO_CLAIM])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    for (const fn of ['twin_issue_claim($1, $2)', 'twin_issue_release($1, $2, $3)']) {
      await expect(as(a, memberA, (c) => c.query(`SELECT * FROM ${fn}`, [t, 1, NO_CLAIM].slice(0, fn.includes("$3") ? 3 : 2))), fn).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(asRunner(a, adminA, (c) => c.query(`SELECT * FROM ${fn}`, [t, 1, NO_CLAIM].slice(0, fn.includes("$3") ? 3 : 2))), fn).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(as(a, null, (c) => c.query(`SELECT * FROM ${fn}`, [t, 1, NO_CLAIM].slice(0, fn.includes("$3") ? 3 : 2))), fn).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(opsPool.query(`SELECT * FROM ${fn}`, [t, 1, NO_CLAIM].slice(0, fn.includes("$3") ? 3 : 2)), fn).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    }
    expect(await imports(t)).toEqual([]);
    expect((await audit(a)).filter((r) => r.payload.twin_id === t)).toEqual([]);
  });

  it("another account's twin is not_found and writes nothing in either account; a bad argument is refused", async () => {
    const t = await twinFor(a, adminA);
    expect(await record(b, adminB, t)).toEqual({ o_result: 'not_found', o_private_issue: null });
    expect(await record(a, adminA, randomUUID())).toEqual({ o_result: 'not_found', o_private_issue: null });
    expect(await imports(t)).toEqual([]);
    for (const [pub, priv] of [[0, 1], [-1, 1], [1, 0], [1, -5]] as const) await expect(record(a, adminA, t, pub, priv)).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
  });

  it.each(['seeding', 'refused', 'failed', 'removed'])('a %s twin is bad_state and writes nothing', async (state) => {
    const t = await twinFor(a, adminA, state);
    expect(await record(a, adminA, t)).toEqual({ o_result: 'bad_state', o_private_issue: null });
    expect(await imports(t)).toEqual([]);
  });

  it.each(['ready', 'paused', 'conflict'])('a %s twin records', async (state) => {
    const t = await twinFor(a, adminA, state);
    expect((await record(a, adminA, t)).o_result).toBe('ok');
  });

  it('the table is read under row security (own account only), is written by nothing but the definer, and the unique pair is enforced by the table itself', async () => {
    const ta = await twinFor(a, adminA);
    const tb = await twinFor(b, adminB);
    await record(a, adminA, ta, 70, 7);
    await record(b, adminB, tb, 70, 7);
    expect(await as(a, memberA, async (c) => (await c.query('SELECT twin_id FROM twin_issue_imports')).rows.map((r) => r.twin_id))).toEqual(expect.arrayContaining([ta]));
    expect(await as(a, memberA, async (c) => (await c.query('SELECT twin_id FROM twin_issue_imports WHERE twin_id = $1', [tb])).rows)).toEqual([]);
    // the admin client, asked for the other account's rows by id, still finds only what exists for that account
    expect((await admin.query('SELECT 1 FROM twin_issue_imports WHERE account_id = $1 AND twin_id = $2', [a.accountId, tb])).rowCount).toBe(0);
    await expect(as(a, adminA, (c) => c.query('INSERT INTO twin_issue_imports (twin_id, account_id, public_issue, private_issue) VALUES ($1, $2, 1, 1)', [ta, a.accountId]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(as(a, adminA, (c) => c.query('UPDATE twin_issue_imports SET private_issue = 99'))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(as(a, adminA, (c) => c.query('DELETE FROM twin_issue_imports'))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(admin.query('INSERT INTO twin_issue_imports (twin_id, account_id, public_issue, private_issue, claim_until) VALUES ($1, $2, 70, 8, now())', [ta, a.accountId])).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    // the twin's own FK pins the pair: an account that does not own the twin cannot hold a row for it
    await expect(admin.query('INSERT INTO twin_issue_imports (twin_id, account_id, public_issue, private_issue, claim_until) VALUES ($1, $2, 71, 8, now())', [ta, b.accountId])).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
  });

  it("pins the audit policy's exact action list: 1117's nine plus twin.issue_brought, nothing more and nothing less", async () => {
    const pol = (await admin.query<{ with_check: string }>("SELECT with_check FROM pg_policies WHERE tablename = 'audit_log' AND policyname = 'repo_twins_owner_audit'")).rows[0]!;
    const actions = [...pol.with_check.matchAll(/'(twin\.[a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(actions).toEqual(['twin.connected', 'twin.created', 'twin.install_paths_added', 'twin.issue_brought', 'twin.merged', 'twin.paused', 'twin.paths_changed', 'twin.refused', 'twin.removed', 'twin.resumed'].sort());
    const others = [...pol.with_check.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]!).filter((w) => !w.startsWith('twin.'));
    expect(others).toEqual(['app.account_id']);
  });

  it("pins the table's policies: app_user reads by account (SELECT only), repo_twins_owner uses its own account's rows, and no other role has one", async () => {
    const pols = (await admin.query<{ policyname: string; cmd: string; roles: string[] }>("SELECT policyname, cmd, roles::text[] AS roles FROM pg_policies WHERE tablename = 'twin_issue_imports' ORDER BY policyname")).rows;
    expect(pols).toEqual([
      { policyname: 'repo_twins_owner_use', cmd: 'ALL', roles: ['repo_twins_owner'] },
      { policyname: 'tenant_isolation_select', cmd: 'SELECT', roles: ['app_user'] },
    ]);
    const t = (await admin.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'twin_issue_imports'")).rows[0];
    expect(t).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });
});
