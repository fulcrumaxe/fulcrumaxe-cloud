import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertRunner } from '@fx/db/test/helpers/runnerFixtures.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { ApiError } from '../src/errors.js';
import { engineCoverageError, requireEngineCoverage } from '../src/engineCoverage.js';
import { seedAccountWithMember } from './helpers/seed.js';

interface Identity { accountId: string; userId: string }

/** D#845 ON-22: the 402 shapes as the API raises them, and the plan gate on the onboarding read, against real Postgres. */
describe('engine coverage (api)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });
  beforeEach(() => {
    saved.price = process.env.STRIPE_PRICE_ID_ENGINE;
    process.env.STRIPE_PRICE_ID_ENGINE = 'price_test_engine';
  });
  afterEach(() => {
    if (saved.price === undefined) delete process.env.STRIPE_PRICE_ID_ENGINE;
    else process.env.STRIPE_PRICE_ID_ENGINE = saved.price;
  });

  async function owner(quantity?: number): Promise<Identity> {
    const t = await seedAccountWithMember(admin, { role: 'owner' });
    if (quantity !== undefined) await admin.query(`UPDATE accounts SET engine_quantity = $2, stripe_subscription_status = 'active' WHERE id = $1`, [t.accountId, quantity]);
    return t;
  }
  async function place(a: Identity, n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      const repo = randomUUID();
      await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product) VALUES ($1, $2, $3, 'p')`, [repo, a.accountId, randomInt(1, 2_000_000_000)]);
      const runner = await insertRunner(admin, a.accountId, a.userId);
      await admin.query(`INSERT INTO project_placements (repo_id, account_id, runner_id, placed_by) VALUES ($1, $2, $3, 'person')`, [repo, a.accountId, runner]);
    }
  }
  const ctx = (a: Identity) => ({ pool: appUserPool, principal: a });
  const refusal = async (a: Identity): Promise<ApiError | null> => {
    try {
      await requireEngineCoverage(ctx(a));
      return null;
    } catch (e) {
      if (e instanceof ApiError) return e;
      throw e;
    }
  };

  it('ruling 36.4 through the route guard: a platform hold is 402 account_held, a stale past_due (grace ran out) is plan_required, an owner\'s own pause places', async () => {
    const held = await owner();
    await admin.query(`UPDATE accounts SET engine_quantity = 2, stripe_subscription_status = 'active', platform_hold_at = now(), platform_hold_reason = 'dispute' WHERE id = $1`, [held.accountId]);
    const e = await refusal(held);
    expect([e?.status, e?.code]).toEqual([402, 'account_held']);
    const stale = await owner();
    await admin.query(`UPDATE accounts SET engine_quantity = 2, stripe_subscription_status = 'past_due', past_due_since = now() - interval '1 day' WHERE id = $1`, [stale.accountId]);
    expect(await refusal(stale)).toBeNull();
    await admin.query('BEGIN');
    await admin.query(`SET LOCAL session_replication_role = replica`);
    await admin.query(`UPDATE accounts SET past_due_since = now() - interval '9 days' WHERE id = $1`, [stale.accountId]);
    await admin.query('COMMIT');
    expect((await refusal(stale))?.code).toBe('plan_required');
    const paused = await owner();
    await admin.query(`UPDATE accounts SET engine_quantity = 2, stripe_subscription_status = 'active', owner_paused_at = now() WHERE id = $1`, [paused.accountId]);
    expect(await refusal(paused)).toBeNull();
  });

  it('no quantity is 402 plan_required with fixed copy', async () => {
    const e = await refusal(await owner());
    expect([e?.status, e?.code, e?.message]).toEqual([402, 'plan_required', 'Pick the Engine plan to run an engine']);
    expect(e?.data).toBeUndefined();
  });

  it('a quantity with every unit used is 402 engine_quantity and carries the counts and nothing else', async () => {
    const a = await owner(2);
    await place(a, 2);
    const e = await refusal(a);
    expect([e?.status, e?.code, e?.data]).toEqual([402, 'engine_quantity', { quantity: 2, live: 2 }]);
  });

  it('a covered account passes and gets its coverage back; one more unit used flips it to engine_quantity', async () => {
    const a = await owner(2);
    await place(a, 1);
    expect(await requireEngineCoverage(ctx(a))).toEqual({ state: 'covered', quantity: 2, live: 1 });
    await place(a, 1);
    expect((await refusal(a))?.code).toBe('engine_quantity');
  });

  it('the plan not being offered is 503 engine_plan_unavailable for an account that would have to buy; an account already covered still passes', async () => {
    delete process.env.STRIPE_PRICE_ID_ENGINE;
    expect((await refusal(await owner()))).toMatchObject({ status: 503, code: 'engine_plan_unavailable' });
    expect(await refusal(await owner(2))).toBeNull();
  });

  it('engineCoverageError maps every state and returns null when covered', () => {
    expect(engineCoverageError({ state: 'covered', quantity: 1, live: 0 })).toBeNull();
    expect(engineCoverageError({ state: 'plan_ended', quantity: 1, live: 0 })).toMatchObject({ status: 402, code: 'plan_required' });
    expect(engineCoverageError({ state: 'account_held' })).toMatchObject({ status: 402, code: 'account_held', message: expect.stringContaining('on hold') });
  });

  it('GET /api/v1/onboarding carries plan_gate on the open project step, from the real billing fact', async () => {
    const read = async (a: Identity) => {
      const req = new Request('http://localhost/api/v1/onboarding', { headers: { cookie: `${SESSION_COOKIE_NAME}=${await signSession(a)}` } });
      const res = await handleApiRequest(req, appUserPool, platformOpsPool, ROUTES);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tracks: [unknown, { steps: { step: string; plan_gate?: string }[] }] };
      return body.tracks[1].steps.find((s) => s.step === 'project')!.plan_gate;
    };
    const bare = await owner();
    expect(await read(bare)).toBe('plan_required');
    delete process.env.STRIPE_PRICE_ID_ENGINE;
    expect(await read(bare)).toBe('unavailable');
    process.env.STRIPE_PRICE_ID_ENGINE = 'price_test_engine';
    expect(await read(await owner(1))).toBeUndefined();
  });
});
