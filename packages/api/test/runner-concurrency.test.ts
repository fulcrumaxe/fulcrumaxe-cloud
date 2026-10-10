import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}
interface Setting {
  applies: boolean;
  total: number;
  per_repo: number;
  default_total: number;
  default_per_repo: number;
  accepted: boolean;
}

/**
 * D#605 FL-12a: GET and PUT /account/runner-concurrency through the real handler against real Postgres (RLS, the definer function and its
 * audit row). The plan's defaults (4 and 2) are the public fixture's.
 */
describe('D#605 FL-12a: the account runner concurrency setting', () => {
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
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await adminPool.end();
    await platformOpsPool.end();
    await appUserPool.end();
  });

  async function call(identity: Identity, method: string, body?: unknown, bearer?: string): Promise<Response> {
    const headers = new Headers();
    if (bearer) headers.set('authorization', `Bearer ${bearer}`);
    else headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(identity)}`);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const req = new Request('http://localhost/api/v1/account/runner-concurrency', { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return handleApiRequest(req, appUserPool, platformOpsPool, ROUTES);
  }
  async function addMember(accountId: string, role: 'admin' | 'member'): Promise<Identity> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, userId, role]);
    return { accountId, userId };
  }
  const audits = async (accountId: string) =>
    (await admin.query<{ actor: string; payload: Record<string, unknown> }>(`SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'account.runner_concurrency.accepted' ORDER BY created_at`, [accountId])).rows;
  const stored = async (accountId: string) => (await admin.query(`SELECT total_jobs, per_repo_jobs FROM account_runner_concurrency WHERE account_id = $1`, [accountId])).rows;

  it('a fresh hosted account reads the plan defaults, not accepted, to every member', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const member = await addMember(owner.accountId, 'member');
    for (const who of [owner, member]) {
      const res = await call(who, 'GET');
      expect(res.status).toBe(200);
      expect((await res.json()) as Setting).toEqual({ applies: true, total: 4, per_repo: 2, default_total: 4, default_per_repo: 2, accepted: false });
    }
  });

  it('a raise without accept: true answers 400 and writes nothing; a member gets 403; a token cannot change it', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const member = await addMember(owner.accountId, 'member');
    for (const body of [{ total: 12, per_repo: 6 }, { total: 12, per_repo: 6, accept: false }]) {
      const res = await call(owner, 'PUT', body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('accept_required');
    }
    expect((await call(member, 'PUT', { total: 12, per_repo: 6, accept: true })).status).toBe(403);
    const plaintext = generateToken();
    await insertApiToken(appUserPool, { accountId: owner.accountId, createdBy: owner.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes: ['read', 'work_items:write'], expiresAt: new Date(Date.now() + 86_400_000) });
    expect((await call(owner, 'PUT', { total: 12, per_repo: 6, accept: true }, plaintext)).status).toBeGreaterThanOrEqual(400);
    expect(await stored(owner.accountId)).toEqual([]);
    expect(await audits(owner.accountId)).toEqual([]);
  });

  it('an accepted raise by an owner or an admin is stored, read back, and writes one audit row with the old and new figures', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const adminUser = await addMember(owner.accountId, 'admin');
    const res = await call(owner, 'PUT', { total: 12, per_repo: 6, accept: true });
    expect(res.status).toBe(200);
    expect((await res.json()) as Setting).toEqual({ applies: true, total: 12, per_repo: 6, default_total: 4, default_per_repo: 2, accepted: true });
    expect(await stored(owner.accountId)).toEqual([{ total_jobs: 12, per_repo_jobs: 6 }]);
    expect(await audits(owner.accountId)).toEqual([{ actor: owner.userId, payload: { total_jobs: 12, per_repo_jobs: 6, previous_total_jobs: null, previous_per_repo_jobs: null } }]);

    // The same figures again change nothing and write nothing; an admin's later change is audited with the figures it replaced.
    expect((await call(adminUser, 'PUT', { total: 12, per_repo: 6, accept: true })).status).toBe(200);
    expect(await audits(owner.accountId)).toHaveLength(1);
    expect((await call(adminUser, 'PUT', { total: 3, per_repo: 1, accept: true })).status).toBe(200);
    const rows = await audits(owner.accountId);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({ actor: adminUser.userId, payload: { total_jobs: 3, per_repo_jobs: 1, previous_total_jobs: 12, previous_per_repo_jobs: 6 } });
    expect(((await (await call(owner, 'GET')).json()) as Setting).total).toBe(3);
  });

  it('refuses figures that make no sense, and the other account never sees or shares the row', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const other = await seedAccountWithMember(admin, { role: 'owner' });
    for (const body of [{ total: 2, per_repo: 3, accept: true }, { total: 0, per_repo: 0, accept: true }, { total: 101, per_repo: 1, accept: true }, { total: 4, per_repo: 2, accept: true, extra: 1 }]) {
      const res = await call(owner, 'PUT', body);
      expect(res.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    }
    expect((await call(owner, 'PUT', { total: 9, per_repo: 3, accept: true })).status).toBe(200);
    expect(((await (await call(other, 'GET')).json()) as Setting)).toMatchObject({ total: 4, per_repo: 2, accepted: false });
  });

  it('the runner plan has a flat account figure from the plan, so there is nothing to set', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    await admin.query(`UPDATE accounts SET plan = 'runner' WHERE id = $1`, [owner.accountId]);
    expect(((await (await call(owner, 'GET')).json()) as Setting).applies).toBe(false);
    const res = await call(owner, 'PUT', { total: 12, per_repo: 6, accept: true });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_applicable');
    expect(await stored(owner.accountId)).toEqual([]);
  });

  it('a member cannot write the row or the audit entry directly, and platform_ops cannot call the function', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    await expect(appUserPool.query(`INSERT INTO account_runner_concurrency (account_id, total_jobs, per_repo_jobs, updated_by) VALUES ($1, 99, 99, $2)`, [owner.accountId, owner.userId])).rejects.toMatchObject({ code: '42501' });
    await expect(platformOpsPool.query(`SELECT account_runner_concurrency_set(99, 99, true)`)).rejects.toMatchObject({ code: '42501' });
    expect(await stored(owner.accountId)).toEqual([]);
  });
});
