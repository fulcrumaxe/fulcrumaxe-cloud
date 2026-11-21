import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { nextGhInstallationId } from '@fx/db/test/helpers/seed.js';
import { insertRunner } from '@fx/db/test/helpers/runnerFixtures.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { countLiveEngines, countLiveEnginesInTx, getOnboarding, readEngineCoverage } from '../src/onboarding/index.js';

/** D#845 ON-22 against the real schema with row security forced: the live count, the coverage read, and the plan gate on the onboarding read. */
describe('engine coverage (pg)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
  });

  interface Acct { accountId: string; userId: string }
  async function account(o: { status?: 'cancelled'; quantity?: number; subscription?: string | null } = {}): Promise<Acct> {
    const accountId = randomUUID();
    const userId = randomUUID();
    await admin.query(`INSERT INTO accounts (id) VALUES ($1)`, [accountId]);
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'owner')`, [accountId, userId]);
    // An account that bought engines has a billing customer (without one it derives to unsubscribed, which a quantity cannot outlive).
    if (o.quantity !== undefined) await admin.query(`UPDATE accounts SET engine_quantity = $2, stripe_customer_id = $3, stripe_subscription_status = $4 WHERE id = $1`, [accountId, o.quantity, `cus_${accountId}`, o.subscription === undefined ? 'active' : o.subscription]);
    if (o.status === 'cancelled') await admin.query(`UPDATE accounts SET subscription_ended_at = now() WHERE id = $1`, [accountId]);
    return { accountId, userId };
  }
  async function place(a: Acct, n: number): Promise<void> {
    const inst = randomUUID();
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team')`, [inst, a.accountId, nextGhInstallationId()]);
    for (let i = 0; i < n; i += 1) {
      const repo = randomUUID();
      await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, $4, 'team')`, [repo, a.accountId, inst, randomInt(1, 2_000_000_000)]);
      const runner = await insertRunner(admin, a.accountId, a.userId);
      await admin.query(`INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'person')`, [repo, a.accountId, runner]);
    }
  }
  const coverage = (a: Acct, offered = true) => withTenant(appPool, a.accountId, a.userId, (c) => readEngineCoverage(c, a.accountId, offered));
  const gate = async (a: Acct, offered?: boolean) => {
    const p = await getOnboarding({ pool: appPool, principal: { accountId: a.accountId, userId: a.userId } }, offered === undefined ? {} : { enginePlanOffered: offered });
    return p.tracks[1].steps.find((s) => s.step === 'project')!.plan_gate;
  };

  it('derives every state from the rows: a bare account, a bought quantity, all used, a lowered plan, an ended plan', async () => {
    const bare = await account();
    expect(await coverage(bare)).toEqual({ state: 'plan_required' });
    const paid = await account({ quantity: 2 });
    expect(await coverage(paid)).toEqual({ state: 'covered', quantity: 2, live: 0 });
    await place(paid, 1);
    expect(await coverage(paid)).toEqual({ state: 'covered', quantity: 2, live: 1 });
    await place(paid, 1);
    expect(await coverage(paid)).toEqual({ state: 'engine_quantity', quantity: 2, live: 2 });
    await admin.query(`UPDATE accounts SET engine_quantity = 1 WHERE id = $1`, [paid.accountId]);
    expect(await coverage(paid)).toEqual({ state: 'engine_quantity', quantity: 1, live: 2 });
    await admin.query(`UPDATE accounts SET engine_quantity = 5 WHERE id = $1`, [paid.accountId]);
    expect(await coverage(paid)).toEqual({ state: 'covered', quantity: 5, live: 2 });
    const ended = await account({ quantity: 2, status: 'cancelled' });
    expect(await coverage(ended)).toEqual({ state: 'plan_ended', quantity: 2, live: 0 });
    expect((await admin.query(`SELECT status FROM accounts WHERE id = $1`, [ended.accountId])).rows[0].status).toBe('cancelled');
  });

  it('the plan ended is derived on every read: renewing (the ended marker cleared) covers again, with nothing stamped', async () => {
    const a = await account({ quantity: 2, status: 'cancelled' });
    expect((await coverage(a)).state).toBe('plan_ended');
    await admin.query(`UPDATE accounts SET subscription_ended_at = NULL WHERE id = $1`, [a.accountId]);
    expect((await coverage(a)).state).toBe('covered');
  });

  /** A row whose stored `status` is stale: the markers say what they say, but the trigger that derives `status` did not run (a clock moving is not a write). */
  async function staleStatus(a: Acct, sql: string): Promise<void> {
    await admin.query('BEGIN');
    try {
      await admin.query(`SET LOCAL session_replication_role = replica`);
      await admin.query(sql, [a.accountId]);
      await admin.query('COMMIT');
    } catch (err) {
      await admin.query('ROLLBACK');
      throw err;
    }
  }

  it('ruling 36.1: the grace is checked at read time; a stored past_due whose seven days ran out is plan_ended, and one inside the grace is covered', async () => {
    const stale = await account({ quantity: 2, subscription: 'past_due' });
    await admin.query(`UPDATE accounts SET past_due_since = now() - interval '1 day' WHERE id = $1`, [stale.accountId]);
    expect((await admin.query(`SELECT status FROM accounts WHERE id = $1`, [stale.accountId])).rows[0].status).toBe('past_due');
    expect(await coverage(stale)).toMatchObject({ state: 'covered' });
    await staleStatus(stale, `UPDATE accounts SET past_due_since = now() - interval '8 days' WHERE id = $1`);
    // The stored status still says past_due: only the read-time computation can tell it ended.
    expect((await admin.query(`SELECT status FROM accounts WHERE id = $1`, [stale.accountId])).rows[0].status).toBe('past_due');
    expect(await coverage(stale)).toEqual({ state: 'plan_ended', quantity: 2, live: 0 });
    expect(await gate(stale, true)).toBe('plan_ended');
    // The boundary is the database's own: six days and twenty-three hours is still inside.
    await staleStatus(stale, `UPDATE accounts SET past_due_since = now() - interval '6 days 23 hours' WHERE id = $1`);
    expect((await coverage(stale)).state).toBe('covered');
  });

  it('ruling 36.1: the grace is judged on `past_due_since` itself, whatever the stored subscription standing says (an active standing not yet re-synced does not extend it)', async () => {
    const a = await account({ quantity: 2, subscription: 'active' });
    await staleStatus(a, `UPDATE accounts SET past_due_since = now() - interval '8 days' WHERE id = $1`);
    expect(await coverage(a)).toEqual({ state: 'plan_ended', quantity: 2, live: 0 });
  });

  it('ruling 36.1: an ended marker alone ends the plan whatever the stored standing says, and a placed project still shows the ended gate', async () => {
    const a = await account({ quantity: 1 });
    await place(a, 1);
    await staleStatus(a, `UPDATE accounts SET subscription_ended_at = now() WHERE id = $1`);
    expect((await admin.query(`SELECT status FROM accounts WHERE id = $1`, [a.accountId])).rows[0].status).toBe('active');
    expect(await coverage(a)).toEqual({ state: 'plan_ended', quantity: 1, live: 1 });
    expect(await gate(a, true)).toBe('plan_ended');
  });

  it('ruling 35.7: a quantity that survived a cancellation, or sits on a subscription that is not paying, covers nothing; trialing and active do', async () => {
    for (const subscription of ['canceled', 'paused', 'incomplete', 'unpaid', null]) {
      const a = await account({ quantity: 2, subscription });
      expect((await coverage(a)).state, String(subscription)).toBe('plan_ended');
    }
    for (const subscription of ['active', 'trialing']) expect((await coverage(await account({ quantity: 2, subscription }))).state, subscription).toBe('covered');
    const noSubscription = await account({ quantity: 2 });
    await admin.query(`UPDATE accounts SET stripe_subscription_status = NULL WHERE id = $1`, [noSubscription.accountId]);
    expect((await coverage(noSubscription)).state).toBe('plan_ended');
  });

  it('ruling 36.4: a platform hold or a partner suspension is account_held (not covered); an owner\'s own pause stays covered', async () => {
    const hold = await account({ quantity: 2 });
    await admin.query(`UPDATE accounts SET platform_hold_at = now(), platform_hold_reason = 'dispute' WHERE id = $1`, [hold.accountId]);
    expect(await coverage(hold)).toEqual({ state: 'account_held' });
    expect(await gate(hold, true)).toBe('account_held');
    const suspended = await account({ quantity: 2 });
    const partner = randomUUID();
    await admin.query(`INSERT INTO partners (id, kind, status, name) VALUES ($1, 'reseller', 'active', 'Acme')`, [partner]);
    await admin.query(`UPDATE accounts SET partner_id = $2, partner_suspended_at = now() WHERE id = $1`, [suspended.accountId, partner]);
    expect(await coverage(suspended)).toEqual({ state: 'account_held' });
    const paused = await account({ quantity: 2 });
    await admin.query(`UPDATE accounts SET owner_paused_at = now() WHERE id = $1`, [paused.accountId]);
    expect((await admin.query(`SELECT status FROM accounts WHERE id = $1`, [paused.accountId])).rows[0].status).toBe('paused');
    expect(await coverage(paused)).toEqual({ state: 'covered', quantity: 2, live: 0 });
    // A hold on a bare account is still a hold, not plan_required.
    const bareHold = await account();
    await admin.query(`UPDATE accounts SET platform_hold_at = now(), platform_hold_reason = 'dispute' WHERE id = $1`, [bareHold.accountId]);
    expect(await coverage(bareHold)).toEqual({ state: 'account_held' });
  });

  it('another account\'s placements and quantity never count, in the live count or the coverage', async () => {
    const mine = await account({ quantity: 1 });
    const other = await account({ quantity: 9 });
    await place(other, 3);
    expect(await countLiveEngines({ pool: appPool, principal: mine })).toBe(0);
    expect(await coverage(mine)).toEqual({ state: 'covered', quantity: 1, live: 0 });
    // Reading through the caller's tenant connection with a foreign account id sees no rows at all.
    expect(await withTenant(appPool, mine.accountId, mine.userId, (c) => readEngineCoverage(c, other.accountId, true))).toEqual({ state: 'unavailable' });
    expect(await withTenant(appPool, mine.accountId, mine.userId, async (c) => (await c.query('SELECT count(*)::int AS n FROM project_placements WHERE account_id = $1', [other.accountId])).rows[0].n)).toBe(0);
  });

  it('the account predicate holds without row security: the admin connection with each account id counts only that account', async () => {
    const mine = await account({ quantity: 1 });
    const other = await account({ quantity: 9 });
    await place(mine, 1);
    await place(other, 3);
    expect(await countLiveEnginesInTx(admin, mine.accountId)).toBe(1);
    expect(await countLiveEnginesInTx(admin, other.accountId)).toBe(3);
    expect(await readEngineCoverage(admin, mine.accountId, true)).toEqual({ state: 'engine_quantity', quantity: 1, live: 1 });
    expect(await readEngineCoverage(admin, other.accountId, true)).toEqual({ state: 'covered', quantity: 9, live: 3 });
    expect(await countLiveEnginesInTx(admin, randomUUID())).toBe(0);
  });

  it('the onboarding read carries the gate on the open project step only when the caller says whether the plan is offered', async () => {
    const bare = await account();
    expect(await gate(bare)).toBeUndefined();
    expect(await gate(bare, true)).toBe('plan_required');
    expect(await gate(bare, false)).toBe('unavailable');
    const paid = await account({ quantity: 1 });
    expect(await gate(paid, true)).toBeUndefined();
    await place(paid, 1);
    // Placed and all used: no purchase prompt on a project step that is done.
    expect(await gate(paid, true)).toBeUndefined();
    const ended = await account({ quantity: 1, status: 'cancelled' });
    await place(ended, 1);
    expect(await gate(ended, true)).toBe('plan_ended');
  });
});
