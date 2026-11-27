import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/** D#845 ON-27d4c (migration 1117): `twin_merge_record`, the audit row of a person's Merge on a twin's card. */
describe('twin_merge_record [pg]', () => {
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
  const SQL = 'SELECT o_result FROM twin_merge_record($1, $2, $3)';
  const merge = (acct: SeedRefs, user: string | null, twin: string, which = 'publish', n = 41) => as(acct, user, async (c) => (await c.query<{ o_result: string }>(SQL, [twin, which, n])).rows[0]!.o_result);
  const rows = async (acct: SeedRefs) => (await admin.query<{ actor: string; payload: Record<string, unknown> }>("SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'twin.merged' ORDER BY created_at, id", [acct.accountId])).rows;

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
    const p = (await admin.query("SELECT pg_get_userbyid(proowner) AS owner, prosecdef, proconfig, has_function_privilege('platform_ops', oid, 'EXECUTE') AS ops, has_function_privilege('public', oid, 'EXECUTE') AS everyone, has_function_privilege('app_user', oid, 'EXECUTE') AS app FROM pg_proc WHERE proname = 'twin_merge_record'")).rows[0];
    expect(p).toEqual({ owner: 'repo_twins_owner', prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], ops: false, everyone: false, app: true });
  });

  it('writes one twin.merged row per call: the person as actor, a payload of exactly the twin, which pull request and its number', async () => {
    const t = await twinFor(a, adminA);
    expect(await merge(a, adminA, t, 'publish', 41)).toBe('ok');
    expect(await merge(a, a.userId, t, 'sync', 52)).toBe('ok');
    const got = (await rows(a)).filter((r) => r.payload.twin_id === t);
    expect(got).toEqual([
      { actor: adminA, payload: { twin_id: t, pr: 'publish', number: 41 } },
      { actor: a.userId, payload: { twin_id: t, pr: 'sync', number: 52 } },
    ]);
  });

  it('refuses a member, a runner session, a session with no person and a platform_ops login, and writes nothing', async () => {
    const t = await twinFor(a, adminA);
    const before = (await rows(a)).length;
    await expect(merge(a, memberA, t)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(asRunner(a, adminA, (c) => c.query(SQL, [t, 'publish', 1]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(merge(a, null, t)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    await expect(opsPool.query(SQL, [t, 'publish', 1])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    expect((await rows(a)).length).toBe(before);
  });

  it("another account's twin is not_found and writes nothing in either account; a bad argument is refused", async () => {
    const t = await twinFor(a, adminA);
    const beforeA = (await rows(a)).length;
    const beforeB = (await rows(b)).length;
    expect(await merge(b, adminB, t)).toBe('not_found');
    expect(await merge(a, adminA, randomUUID())).toBe('not_found');
    expect((await rows(a)).length).toBe(beforeA);
    expect((await rows(b)).length).toBe(beforeB);
    for (const [which, n] of [['other', 1], ['publish', 0], ['publish', -3]] as const) await expect(merge(a, adminA, t, which, n)).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
  });

  it.each(['seeding', 'refused', 'failed', 'removed'])('a %s twin is bad_state and writes nothing', async (state) => {
    const t = await twinFor(a, adminA, state);
    const before = (await rows(a)).length;
    expect(await merge(a, adminA, t)).toBe('bad_state');
    expect((await rows(a)).length).toBe(before);
  });

  it.each(['ready', 'paused', 'conflict'])('a %s twin is audited', async (state) => {
    const t = await twinFor(a, adminA, state);
    expect(await merge(a, adminA, t)).toBe('ok');
  });

  it("pins the audit policy's exact action list: 1116's eight plus twin.merged, nothing more and nothing less", async () => {
    const pol = (await admin.query<{ with_check: string }>("SELECT with_check FROM pg_policies WHERE tablename = 'audit_log' AND policyname = 'repo_twins_owner_audit'")).rows[0]!;
    const actions = [...pol.with_check.matchAll(/'(twin\.[a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(actions).toEqual(['twin.connected', 'twin.created', 'twin.install_paths_added', 'twin.merged', 'twin.paused', 'twin.paths_changed', 'twin.refused', 'twin.removed', 'twin.resumed'].sort());
    // every other quoted word in the check is the setting's name or empty: no action of another family slipped in
    const others = [...pol.with_check.matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]!).filter((w) => !w.startsWith('twin.'));
    expect(others).toEqual(['app.account_id']);
  });
});
