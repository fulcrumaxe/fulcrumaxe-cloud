import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { NotFoundError } from '../../src/tenancy/errors.js';
import { withTenant } from '../../src/tenancy/withTenant.js';
import { adoptTwinPlanWhenReady } from '../../src/repos/twinAdopt.js';
import { getRepoTwin } from '../../src/repos/twins.js';

/**
 * [pg] D#845 ON-27e: the guarded adopt (the twin must be ready or paused, read in the same transaction as the copy) and the twin read that answers for either repo of the pair. Each query
 * carries its own account predicate on top of RLS, so the foreign-account cases also run through the RLS-bypassing admin pool, where only the predicate stands between accounts.
 */
describe('guarded plan adoption and the twin read (core) [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let A: SeedRefs;
  let B: SeedRefs;

  const repoFor = async (acct: SeedRefs): Promise<string> => {
    const id = randomUUID();
    await admin.query('INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, $4, $5)', [id, acct.accountId, acct.installationId, Math.floor(Math.random() * 1e9) + 10, 'team']);
    return id;
  };
  const twinFor = async (acct: SeedRefs, state = 'ready') => {
    const pub = await repoFor(acct);
    const priv = await repoFor(acct);
    const r = await withTenant(appPool, acct.accountId, acct.userId, async (c: PoolClient) => (await c.query<{ o_id: string }>('SELECT o_id FROM twin_record($1, $2, 777, $3)', [pub, priv, 'w-private'])).rows[0]!);
    await admin.query('UPDATE repo_twins SET state = $2 WHERE id = $1', [r.o_id, state]);
    const setup = randomUUID();
    await admin.query(`INSERT INTO project_setups (id, account_id, repo_id, kind, phase, created_by) VALUES ($1, $2, $3, 'existing', 'survey', $4)`, [setup, acct.accountId, priv, acct.userId]);
    await admin.query(`INSERT INTO project_drafts (account_id, repo_id, source, prd_md, roadmap, version) VALUES ($1, $2, 'interview', '# Plan', $3::jsonb, 1)`, [acct.accountId, pub,
      JSON.stringify([{ row_key: 'A', title: 'Row A', summary: 'Does a thing.', size: 'M', depends_on: [], keep: true }])]);
    return { id: r.o_id, pub, priv, setup };
  };
  const as = (pool: Pool, acct: SeedRefs) => ({ pool, principal: { accountId: acct.accountId, userId: acct.userId } });

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

  it('refuses every state but ready and paused as twin_not_ready and copies nothing; ready and paused copy the plan', async () => {
    for (const state of ['creating', 'not_connected', 'seeding', 'conflict', 'refused', 'failed']) {
      const t = await twinFor(A, state);
      expect(await adoptTwinPlanWhenReady(as(appPool, A), t.id, t.setup), state).toEqual({ ok: false, reason: 'twin_not_ready' });
      expect((await admin.query('SELECT 1 FROM project_drafts WHERE repo_id = $1', [t.priv])).rowCount).toBe(0);
    }
    for (const state of ['ready', 'paused']) {
      const t = await twinFor(A, state);
      expect(await adoptTwinPlanWhenReady(as(appPool, A), t.id, t.setup), state).toEqual({ ok: true, draftId: expect.any(String) });
      expect((await admin.query<{ phase: string }>('SELECT phase FROM project_setups WHERE id = $1', [t.setup])).rows[0]!.phase).toBe('plan');
    }
  });

  it("another account's twin is NotFound for the adopt, with RLS (the app pool) and without it (the admin pool, where the account predicate alone decides)", async () => {
    const t = await twinFor(A);
    for (const pool of [appPool, adminPool]) await expect(adoptTwinPlanWhenReady(as(pool, B), t.id, t.setup)).rejects.toBeInstanceOf(NotFoundError);
    expect((await admin.query<{ phase: string }>('SELECT phase FROM project_setups WHERE id = $1', [t.setup])).rows[0]!.phase).toBe('survey');
    // a twin in a state the adopt refuses must not tell a stranger it exists: it is NotFound, not twin_not_ready
    const held = await twinFor(A, 'seeding');
    for (const pool of [appPool, adminPool]) await expect(adoptTwinPlanWhenReady(as(pool, B), held.id, held.setup)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("the same account's other twin cannot lend its setup: a setup of another twin's repo is NotFound, and nothing is copied", async () => {
    const one = await twinFor(A);
    const two = await twinFor(A);
    await expect(adoptTwinPlanWhenReady(as(appPool, A), one.id, two.setup)).rejects.toBeInstanceOf(NotFoundError);
    expect((await admin.query<{ phase: string }>('SELECT phase FROM project_setups WHERE id = $1', [two.setup])).rows[0]!.phase).toBe('survey');
  });

  it('a member is refused by the definer, and a malformed id is refused before any query', async () => {
    const t = await twinFor(A);
    const member = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [member, `${member}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [A.accountId, member]);
    await expect(adoptTwinPlanWhenReady({ pool: appPool, principal: { accountId: A.accountId, userId: member } }, t.id, t.setup)).rejects.toMatchObject({ code: '42501' });
    await expect(adoptTwinPlanWhenReady(as(appPool, A), 'not-an-id', t.setup)).rejects.toThrow();
  });

  it('the twin read answers for either repo of the pair, never for the account\'s other pair, and a foreign account (with or without RLS) is NotFound', async () => {
    const one = await twinFor(A);
    const two = await twinFor(A);
    for (const id of [one.pub, one.priv]) expect((await getRepoTwin(as(appPool, A), id))?.id).toBe(one.id);
    for (const id of [two.pub, two.priv]) expect((await getRepoTwin(as(appPool, A), id))?.id).toBe(two.id);
    expect(await getRepoTwin(as(appPool, A), await repoFor(A))).toBeNull();
    for (const pool of [appPool, adminPool]) {
      await expect(getRepoTwin(as(pool, B), one.priv)).rejects.toBeInstanceOf(NotFoundError);
      await expect(getRepoTwin(as(pool, B), one.pub)).rejects.toBeInstanceOf(NotFoundError);
    }
  });
});
