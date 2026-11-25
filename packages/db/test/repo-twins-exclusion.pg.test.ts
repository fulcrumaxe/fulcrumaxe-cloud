import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/** D#845 ON-27a2 (migration 1099): the cross-column and code_repo exclusion, the shared repo-row lock, and the connect the repo sync calls. */
describe('repo twins exclusion and connect [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;

  const repoFor = async (acct: SeedRefs, opts: { gh?: number; owner?: string; name?: string; installed?: boolean } = {}): Promise<string> => {
    const id = randomUUID();
    await admin.query('INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
      id, acct.accountId, opts.installed === false ? null : acct.installationId, opts.gh ?? Math.floor(Math.random() * 1e9) + 10, 'team', opts.owner ?? null, opts.name ?? null,
    ]);
    return id;
  };
  const as = <T>(acct: SeedRefs, fn: (c: PoolClient) => Promise<T>) => withTenant(appPool, acct.accountId, acct.userId, fn);
  const record = (acct: SeedRefs, pub: string, priv: string | null, gh: number | null = 777) =>
    as(acct, async (c) => (await c.query<{ o_result: string; o_id: string | null }>('SELECT o_result, o_id FROM twin_record($1, $2, $3, $4)', [pub, priv, gh, 'widgets-private'])).rows[0]!);
  /** What the repo sync does: its own session has an account and no person. */
  const connect = (acct: SeedRefs) => withTenant(appPool, acct.accountId, async (c) => (await c.query<{ n: number }>('SELECT twin_connect_seen() AS n')).rows[0]!.n);
  const twin = async (id: string) => (await admin.query('SELECT * FROM repo_twins WHERE id = $1', [id])).rows[0];
  const pair = (acct: SeedRefs, repo: string, codeRepo: string) =>
    admin.query(`INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, $3, ARRAY['private/**'])`, [repo, acct.accountId, codeRepo]);

  /** A transaction of the person's own that stays open: the way to hold a lock while another session tries for it. */
  const open = async (acct: SeedRefs): Promise<PoolClient> => {
    const c = await appPool.connect();
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)", [acct.accountId, acct.userId]);
    return c;
  };
  const settle = async (c: PoolClient, how: 'COMMIT' | 'ROLLBACK'): Promise<void> => {
    try {
      await c.query(how);
    } finally {
      c.release();
    }
  };

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
  });

  it("a repo that is the other role of a live twin is refused, both ways, and it is the check that refuses (the same call is fine once the twin is removed)", async () => {
    const pub = await repoFor(a);
    const priv = await repoFor(a);
    const t = await record(a, pub, priv);
    expect(t.o_result).toBe('ok');
    const fresh = await repoFor(a);
    // The twin's private repo as the public repo of a new twin, and the twin's public repo as the private repo of a new twin.
    expect(await record(a, priv, fresh)).toEqual({ o_result: 'twin_exists', o_id: null });
    expect(await record(a, fresh, pub)).toEqual({ o_result: 'twin_exists', o_id: null });
    expect(await record(a, priv, null)).toEqual({ o_result: 'twin_exists', o_id: null });
    expect((await admin.query('SELECT 1 FROM repo_twins WHERE public_repo_id IN ($1, $2)', [priv, fresh])).rows).toHaveLength(0);
    await as(a, (c) => c.query('SELECT o_result FROM twin_change($1, $2)', [t.o_id, 'remove']));
    expect((await record(a, priv, fresh)).o_result).toBe('ok');
  });

  it("a repo that a pairing names as its public repo (code_repo) cannot get a twin, as the public or the private side; another account's pairing with the same name does not matter", async () => {
    const pub = await repoFor(a, { owner: 'acme', name: 'widgets' });
    const priv = await repoFor(a, { owner: 'acme', name: 'Widgets-Private' });
    const third = await repoFor(a);
    await pair(a, third, 'ACME/widgets');
    expect(await record(a, pub, null)).toEqual({ o_result: 'pairing_exists', o_id: null });
    await pair(a, await repoFor(a), 'acme/widgets-private');
    const other = await repoFor(a);
    expect(await record(a, other, priv)).toEqual({ o_result: 'pairing_exists', o_id: null });
    expect((await admin.query('SELECT 1 FROM repo_twins WHERE public_repo_id IN ($1, $2)', [pub, other])).rows).toHaveLength(0);
    // A second account that pairs the same name changes nothing for the first; its own repos with that name are its own.
    const bPub = await repoFor(b, { owner: 'acme', name: 'gadgets' });
    await pair(a, await repoFor(a), 'acme/gadgets');
    expect((await record(b, bPub, null)).o_result).toBe('ok');
  });

  it('twin_record takes the repo rows first: a pairing that is open (uncommitted) makes the twin wait and then refuse, and the reverse', async () => {
    // The pairing side first (it takes the same lock in setRepoPairing), then the twin.
    const pub = await repoFor(a);
    const priv = await repoFor(a);
    const pairing = await open(a);
    await pairing.query('SELECT id FROM repos WHERE account_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE', [a.accountId, [pub]]);
    await pairing.query(`INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/x', ARRAY['p/**'])`, [pub, a.accountId]);
    const waiting = record(a, pub, priv);
    const early = await Promise.race([waiting.then(() => 'answered'), new Promise((r) => setTimeout(() => r('waiting'), 400))]);
    expect(early).toBe('waiting');
    await settle(pairing, 'COMMIT');
    expect(await waiting).toEqual({ o_result: 'pairing_exists', o_id: null });

    // The twin side first: while its transaction is open, the repo rows are locked against a pairing's lock.
    const pub2 = await repoFor(a);
    const priv2 = await repoFor(a);
    const twinTx = await open(a);
    const made = (await twinTx.query<{ o_result: string }>('SELECT o_result FROM twin_record($1, $2, 5, $3)', [pub2, priv2, 'x-private'])).rows[0]!;
    expect(made.o_result).toBe('ok');
    for (const id of [pub2, priv2]) {
      const rival = await open(a);
      await rival.query("SET LOCAL lock_timeout = '300ms'");
      await expect(rival.query('SELECT id FROM repos WHERE account_id = $1 AND id = $2 FOR UPDATE', [a.accountId, id])).rejects.toMatchObject({ code: '55P03' });
      await settle(rival, 'ROLLBACK');
    }
    await settle(twinTx, 'COMMIT');
  });

  it("connects a not_connected twin to the repo the App now sees, by the GitHub id it recorded, in its own account only, with one audit row", async () => {
    const gh = Math.floor(Math.random() * 1e9) + 5e9;
    const pub = await repoFor(a);
    const t = (await record(a, pub, null, gh)).o_id!;
    // Nothing to connect yet: the repo is unknown, then known but not attached to an installation, then in another account.
    expect(await connect(a)).toBe(0);
    const detached = await repoFor(a, { gh, installed: false });
    expect(await connect(a)).toBe(0);
    await repoFor(b, { gh });
    expect(await connect(a)).toBe(0);
    expect((await twin(t)).state).toBe('not_connected');
    // The other account's session sees nothing to do either, and touches nothing.
    expect(await connect(b)).toBe(0);
    await admin.query('UPDATE repos SET installation_id = $2 WHERE id = $1', [detached, a.installationId]);
    expect(await connect(a)).toBe(1);
    expect(await twin(t)).toMatchObject({ state: 'seeding', private_repo_id: detached });
    expect(await connect(a)).toBe(0);
    const log = (await admin.query(`SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'twin.connected'`, [a.accountId])).rows;
    expect(log).toEqual([{ actor: 'system', payload: { twin_id: t, public_repo_id: pub, private_repo_id: detached, from: 'not_connected', to: 'seeding' } }]);
  });

  it('a repo that cannot be connected (a pairing, another live twin) leaves the twin not_connected, and the call itself succeeds', async () => {
    const gh1 = Math.floor(Math.random() * 1e9) + 6e9;
    const gh2 = gh1 + 1;
    const t1 = (await record(a, await repoFor(a), null, gh1)).o_id!;
    const t2 = (await record(a, await repoFor(a), null, gh2)).o_id!;
    const paired = await repoFor(a, { gh: gh1 });
    await pair(a, paired, 'acme/elsewhere');
    // gh2's repo is already the private repo of another live twin.
    const held = await repoFor(a, { gh: gh2 });
    await admin.query(`INSERT INTO repo_twins (account_id, public_repo_id, private_repo_id, private_name, state) VALUES ($1, $2, $3, 'held-private', 'seeding')`, [a.accountId, await repoFor(a), held]);
    expect(await connect(a)).toBe(0);
    expect((await twin(t1)).state).toBe('not_connected');
    expect((await twin(t2)).state).toBe('not_connected');
    // A removed twin is not connected either.
    await as(a, (c) => c.query('SELECT o_result FROM twin_change($1, $2)', [t1, 'remove']));
    await admin.query('DELETE FROM repo_pairing WHERE repo_id = $1', [paired]);
    expect(await connect(a)).toBe(0);
    expect((await twin(t1)).state).toBe('removed');
  });

  it("never connects a twin to its own public repo (the repo the twin's recorded GitHub id names is the public one)", async () => {
    const gh = Math.floor(Math.random() * 1e9) + 7e9;
    const pub = await repoFor(a, { gh });
    const t = (await record(a, pub, null, gh)).o_id!;
    expect(await connect(a)).toBe(0);
    expect(await twin(t)).toMatchObject({ state: 'not_connected', private_repo_id: null });
  });

  it('an error on one twin leaves that twin not_connected and the others still connect (any error, not only a unique violation)', async () => {
    const ghBad = Math.floor(Math.random() * 1e9) + 8e9;
    const ghGood = ghBad + 1;
    const bad = (await record(a, await repoFor(a), null, ghBad)).o_id!;
    const good = (await record(a, await repoFor(a), null, ghGood)).o_id!;
    await admin.query(`UPDATE repo_twins SET private_name = 'boom-private' WHERE id = $1`, [bad]);
    await repoFor(a, { gh: ghBad });
    const goodRepo = await repoFor(a, { gh: ghGood });
    await admin.query(`CREATE FUNCTION public.zz_boom_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.private_name = 'boom-private' AND NEW.state = 'seeding' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$`);
    await admin.query('CREATE TRIGGER zz_boom BEFORE UPDATE ON repo_twins FOR EACH ROW EXECUTE FUNCTION public.zz_boom_fn()');
    try {
      expect(await connect(a)).toBe(1);
    } finally {
      await admin.query('DROP TRIGGER zz_boom ON repo_twins');
      await admin.query('DROP FUNCTION public.zz_boom_fn()');
    }
    expect((await twin(bad)).state).toBe('not_connected');
    expect(await twin(good)).toMatchObject({ state: 'seeding', private_repo_id: goodRepo });
    // Without the trigger the held-back twin would connect on the next call; the other tests count connects, so it goes.
    await admin.query('DELETE FROM repo_twins WHERE id = $1', [bad]);
  });

  it("does not connect a repo whose owner/name is some pairing's code_repo (the name-based exclusion twin_record has), in any letter case", async () => {
    const gh = Math.floor(Math.random() * 1e9) + 9e9;
    const t = (await record(a, await repoFor(a), null, gh)).o_id!;
    await repoFor(a, { gh, owner: 'acme', name: 'named-private' });
    await pair(a, await repoFor(a), 'ACME/Named-Private');
    expect(await connect(a)).toBe(0);
    expect((await twin(t)).state).toBe('not_connected');
    await admin.query(`DELETE FROM repo_pairing WHERE code_repo = 'ACME/Named-Private'`);
    expect(await connect(a)).toBe(1);
    expect((await twin(t)).state).toBe('seeding');
  });
});
