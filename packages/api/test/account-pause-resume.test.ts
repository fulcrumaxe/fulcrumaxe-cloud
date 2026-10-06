import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { accountDeps } from '../src/routes/account.js';
import { generateToken, displayHint } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { seedAccountWithMember } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}

/** D#31 API-7c-2: `POST /account/pause` and `/resume` through the real dispatcher against real Postgres. */
describe('D#31 API-7c-2: account pause and resume routes', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
    accountDeps.getPlatformOpsPool = () => platformOpsPool;
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  async function post(who: Identity | string, action: 'pause' | 'resume', headers: Record<string, string> = {}): Promise<Response> {
    const h = new Headers(headers);
    if (typeof who === 'string') h.set('authorization', `Bearer ${who}`);
    else h.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(who)}`);
    return handleApiRequest(new Request(`http://localhost/api/v1/account/${action}`, { method: 'POST', headers: h }), appUserPool, platformOpsPool, ROUTES);
  }
  async function statusOf(accountId: string): Promise<string> {
    return (await admin.query<{ status: string }>('SELECT status FROM accounts WHERE id = $1', [accountId])).rows[0]!.status;
  }
  async function audits(accountId: string): Promise<{ action: string; actor: string; payload: Record<string, unknown> }[]> {
    const { rows } = await admin.query(
      `SELECT action, actor, payload FROM audit_log WHERE account_id = $1 AND action LIKE 'account.%' ORDER BY created_at`,
      [accountId],
    );
    return rows;
  }
  async function tokenFor(who: Identity): Promise<string> {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, {
      accountId: who.accountId,
      createdBy: who.userId,
      tokenHash: hashToken(plaintext),
      displayHint: displayHint(plaintext),
      scopes: ['read'],
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    return plaintext;
  }
  const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

  it('an owner pauses then resumes: 200 { status }, one audit row each, actor is the session user, never cached', async () => {
    const o = await seedAccountWithMember(admin, { role: 'owner' });
    const paused = await post(o, 'pause');
    expect(paused.status).toBe(200);
    expect(paused.headers.get('cache-control')).toBe('private, no-store');
    expect(await paused.json()).toEqual({ status: 'paused' });
    expect(await statusOf(o.accountId)).toBe('paused');

    const resumed = await post(o, 'resume');
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toEqual({ status: 'active' });

    const rows = await audits(o.accountId);
    expect(rows.map((r) => r.action)).toEqual(['account.paused', 'account.resumed']);
    expect(rows.every((r) => r.actor === o.userId)).toBe(true);
    expect(rows[0]!.payload).toMatchObject({ before_status: 'active', after_status: 'paused' });
  });

  it('an admin may pause and resume too', async () => {
    const a = await seedAccountWithMember(admin, { role: 'admin' });
    expect((await post(a, 'pause')).status).toBe(200);
    expect((await post(a, 'resume')).status).toBe(200);
    expect(await audits(a.accountId)).toHaveLength(2);
  });

  it('pausing an already-paused account is 200 and writes no new audit row', async () => {
    const o = await seedAccountWithMember(admin, { role: 'owner', status: 'paused' });
    const res = await post(o, 'pause');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'paused' });
    expect(await audits(o.accountId)).toHaveLength(0);
  });

  it('a member session is 403 insufficient_role at the route, before any platform_ops pool is touched, and changes nothing', async () => {
    const m = await seedAccountWithMember(admin, { role: 'member' });
    accountDeps.getPlatformOpsPool = () => {
      throw new Error('platform_ops pool must not be reached for a member');
    };
    let res: Response;
    try {
      res = await post(m, 'pause');
    } finally {
      accountDeps.getPlatformOpsPool = () => platformOpsPool;
    }
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('insufficient_role');
    expect(await statusOf(m.accountId)).toBe('active');

    const p = await seedAccountWithMember(admin, { role: 'member', status: 'paused' });
    expect((await post(p, 'resume')).status).toBe(403);
    expect(await statusOf(p.accountId)).toBe('paused');
    expect(await audits(m.accountId)).toHaveLength(0);
    expect(await audits(p.accountId)).toHaveLength(0);
  });

  it('a token is 403 session_required on both routes and changes nothing', async () => {
    const o = await seedAccountWithMember(admin, { role: 'owner' });
    const token = await tokenFor(o);
    for (const action of ['pause', 'resume'] as const) {
      const res = await post(token, action);
      expect(res.status).toBe(403);
      expect(await code(res)).toBe('session_required');
    }
    expect(await statusOf(o.accountId)).toBe('active');
    expect(await audits(o.accountId)).toHaveLength(0);
  });

  it('two tenants: one owner pausing leaves the other account and its audit trail untouched', async () => {
    const a = await seedAccountWithMember(admin, { role: 'owner' });
    const b = await seedAccountWithMember(admin, { role: 'owner' });
    expect((await post(a, 'pause')).status).toBe(200);
    expect(await statusOf(a.accountId)).toBe('paused');
    expect(await statusOf(b.accountId)).toBe('active');
    expect(await audits(b.accountId)).toHaveLength(0);
    // A's owner presented against B's account is not a member there, so nothing may change.
    const res = await post({ accountId: b.accountId, userId: a.userId }, 'pause');
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(500);
    expect(await statusOf(b.accountId)).toBe('active');
    expect(await audits(b.accountId)).toHaveLength(0);
  });

  it('refusals: resume when active -> not_paused; resume when past due -> payment_not_settled; pause when the model key is broken -> not_pausable', async () => {
    const active = await seedAccountWithMember(admin, { role: 'owner' });
    const res1 = await post(active, 'resume');
    expect(res1.status).toBe(409);
    expect(await code(res1)).toBe('not_paused');

    const pastDue = await seedAccountWithMember(admin, { role: 'owner', status: 'past_due' });
    const res2 = await post(pastDue, 'resume');
    expect(res2.status).toBe(409);
    expect(await code(res2)).toBe('payment_not_settled');

    const cancelled = await seedAccountWithMember(admin, { role: 'owner', status: 'model_key_broken' });
    const res3 = await post(cancelled, 'pause');
    expect(res3.status).toBe(409);
    expect(await code(res3)).toBe('not_pausable');

    for (const a of [active, pastDue, cancelled]) expect(await audits(a.accountId)).toHaveLength(0);
  });

  it('resuming an account that is paused and also past due is 200 { status: past_due }', async () => {
    const o = await seedAccountWithMember(admin, { role: 'owner', status: 'paused' });
    await admin.query('UPDATE accounts SET past_due_since = now() WHERE id = $1', [o.accountId]);
    expect(await statusOf(o.accountId)).toBe('paused');
    const res = await post(o, 'resume');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'past_due' });
    expect(await audits(o.accountId)).toHaveLength(1);
  });

  it('a repeated Idempotency-Key replays the first answer and writes one audit row', async () => {
    const o = await seedAccountWithMember(admin, { role: 'owner' });
    const headers = { 'idempotency-key': 'k-pause-1' };
    const first = await post(o, 'pause', headers);
    const second = await post(o, 'pause', headers);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(await second.json()).toEqual({ status: 'paused' });
    expect(await audits(o.accountId)).toHaveLength(1);
  });
});
