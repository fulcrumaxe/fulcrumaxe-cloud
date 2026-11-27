import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../../src/tenancy/withTenant.js';
import { findTwinsForPush } from '../../src/repos/twinParityDue.js';

/**
 * [pg] D#845 ON-27d1: which twins a push to a default branch concerns, as the real app_user role with row security forced. The rows are the migrations' own (`twin_record` makes the twin; the test moves its state as the
 * platform would). Names are fictional.
 */
describe('twins a push concerns [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let A: SeedRefs;
  let B: SeedRefs;

  const repoFor = async (acct: SeedRefs, owner: string, name: string): Promise<string> => {
    const id = randomUUID();
    await admin.query('INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, $4, $5, $6, $7)', [id, acct.accountId, acct.installationId, Math.floor(Math.random() * 1e9) + 10, 'team', owner, name]);
    return id;
  };
  /** A twin of a public repo `owner/name` with its private repo `owner/name-private`, in the given state. */
  const twinFor = async (acct: SeedRefs, owner: string, name: string, state = 'ready') => {
    const pub = await repoFor(acct, owner, name);
    const priv = await repoFor(acct, owner, `${name}-private`);
    const r = await withTenant(appPool, acct.accountId, acct.userId, async (c: PoolClient) => (await c.query<{ o_id: string }>('SELECT o_id FROM twin_record($1, $2, 888, $3)', [pub, priv, `${name}-private`])).rows[0]!);
    await admin.query('UPDATE repo_twins SET state = $2 WHERE id = $1', [r.o_id, state]);
    return { id: r.o_id, pub, priv };
  };
  const find = (acct: SeedRefs, repoId: string | null, fullName: string) => withTenant(appPool, acct.accountId, (c: PoolClient) => findTwinsForPush(c, { accountId: acct.accountId, repoId, fullName }));

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
  });

  it('a push to the public repo (by its row, or by its name in any case) and a push to the private repo (by its row, or by name) each find the twin', async () => {
    const t = await twinFor(A, 'acme', 'widgets');
    expect(await find(A, t.pub, 'acme/widgets')).toEqual([t.id]);
    expect(await find(A, null, 'Acme/Widgets')).toEqual([t.id]);
    expect(await find(A, t.priv, 'acme/widgets-private')).toEqual([t.id]);
    expect(await find(A, null, 'ACME/WIDGETS-PRIVATE')).toEqual([t.id]);
    // each row alone, with a name that matches nothing
    expect(await find(A, t.pub, 'nobody/else')).toEqual([t.id]);
    expect(await find(A, t.priv, 'nobody/else')).toEqual([t.id]);
    expect(await find(A, null, 'nobody/else')).toEqual([]);
  });

  it('a conflict is looked at again by a push to either side; a paused, refused, failed, seeding or removed twin is not', async () => {
    const t = await twinFor(A, 'acme', 'gadgets', 'conflict');
    expect(await find(A, t.pub, 'acme/gadgets')).toEqual([t.id]);
    for (const state of ['paused', 'refused', 'failed', 'seeding', 'creating', 'not_connected']) {
      await admin.query('UPDATE repo_twins SET state = $2 WHERE id = $1', [t.id, state]);
      expect(await find(A, t.pub, 'acme/gadgets'), state).toEqual([]);
    }
    await admin.query(`UPDATE repo_twins SET state = 'removed', removed_at = now() WHERE id = $1`, [t.id]);
    expect(await find(A, t.pub, 'acme/gadgets')).toEqual([]);
  });

  it("the same account's other twin is not marked by a push to this one's repos, and a push to a repo no twin has marks nothing", async () => {
    const one = await twinFor(A, 'acme', 'alpha');
    const two = await twinFor(A, 'acme', 'beta');
    expect(await find(A, one.pub, 'acme/alpha')).toEqual([one.id]);
    expect(await find(A, two.priv, 'acme/beta-private')).toEqual([two.id]);
    expect(await find(A, await repoFor(A, 'acme', 'unrelated'), 'acme/unrelated')).toEqual([]);
    expect(await find(A, null, 'acme/alp')).toEqual([]);
  });

  it("another account's twin of a repo with the same name is never found, by row or by name, and the lookup through the admin client with a foreign account id finds none", async () => {
    const mine = await twinFor(A, 'shared', 'thing');
    const theirs = await twinFor(B, 'shared', 'thing');
    expect(await find(A, mine.pub, 'shared/thing')).toEqual([mine.id]);
    expect(await find(B, theirs.pub, 'shared/thing')).toEqual([theirs.id]);
    // A's repo row with B's account id, and B's row with A's: the account predicate holds on its own
    expect(await find(B, mine.pub, 'nobody/else')).toEqual([]);
    expect(await find(A, theirs.priv, 'nobody/else')).toEqual([]);
    // The RLS-bypassing client, with a foreign account id: the explicit predicate alone must give no row.
    const foreign = await findTwinsForPush(admin, { accountId: B.accountId, repoId: mine.pub, fullName: 'nobody/else' });
    expect(foreign).toEqual([]);
    expect(await findTwinsForPush(admin, { accountId: B.accountId, repoId: null, fullName: 'shared/thing' })).toEqual([theirs.id]);
  });
});
