import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { loadPlanData, resetPlanDataCache } from '@fx/plan-data';
import { insertApiToken, type Scope } from '@fx/core/src/tokens/service.js';
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
interface Entry {
  role: string;
  stored: Record<string, number | boolean | null>;
  resolved: Record<string, number | boolean>;
}
interface ListBody {
  default: Entry;
  roles: Entry[];
  bounds: Record<string, { default: number; floor?: number; ceiling?: number }>;
}
interface ErrorBody {
  error: { code: string };
  details?: { path: string; code: string }[];
}

/**
 * D#31 API-8d: GET /run-limits and PUT /run-limits/{role}, called through the
 * real `handleApiRequest` against real Postgres (RLS, the audit function, the
 * real setRunLimits service).
 */
describe('D#31 API-8d: run limits', () => {
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

  async function call(identity: Identity, method: string, urlPath: string, body?: unknown, bearer?: string): Promise<Response> {
    const headers = new Headers();
    if (bearer) headers.set('authorization', `Bearer ${bearer}`);
    else headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(identity)}`);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const req = new Request(`http://localhost/api/v1${urlPath}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return handleApiRequest(req, appUserPool, platformOpsPool, ROUTES);
  }

  async function addMember(accountId: string, role: 'admin' | 'member'): Promise<Identity> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, userId, role]);
    return { accountId, userId };
  }

  async function tokenFor(identity: Identity, scopes: Scope[]): Promise<string> {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, {
      accountId: identity.accountId,
      createdBy: identity.userId,
      tokenHash: hashToken(plaintext),
      displayHint: 'fxat_...test',
      scopes,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    return plaintext;
  }

  async function auditCount(accountId: string): Promise<number> {
    const { rows } = await admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE account_id = $1 AND action = 'run_limits.changed'`,
      [accountId],
    );
    return Number(rows[0]!.n);
  }

  async function list(identity: Identity): Promise<ListBody> {
    const res = await call(identity, 'GET', '/run-limits');
    expect(res.status).toBe(200);
    return (await res.json()) as ListBody;
  }

  it('with the plan data unavailable GET /run-limits is 503 plan_data_unavailable and carries no figure', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const saved = process.env.FX_PLAN_DATA;
    try {
      delete process.env.FX_PLAN_DATA;
      resetPlanDataCache();
      const res = await call(owner, 'GET', '/run-limits');
      expect(res.status).toBe(503);
      const text = await res.text();
      expect((JSON.parse(text) as ErrorBody).error.code).toBe('plan_data_unavailable');
      expect(text).not.toMatch(/undefined|null|NaN|per_run_usd/);
    } finally {
      if (saved !== undefined) process.env.FX_PLAN_DATA = saved;
      resetPlanDataCache();
    }
  });

  it('GET on a fresh account returns the built-in defaults, no overrides, and the floors and ceilings', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const body = await list(owner);
    expect(body.roles).toEqual([]);
    expect(body.default.role).toBe('default');
    expect(body.default.resolved).toMatchObject({ max_run_minutes: 60, per_run_usd: loadPlanData().caps.perSpawnUsd, silence_minutes: 15, auto_resume: true });
    expect(body.default.stored.max_run_minutes).toBeNull();
    expect(body.bounds.max_run_minutes).toEqual({ default: 60, floor: 5, ceiling: 240 });
    expect(body.bounds.silence_minutes).toEqual({ default: 15, floor: 11, ceiling: 30 });
    expect(body.bounds.auto_resume).toEqual({ default: true });
  });

  it('GET is open to a member and to a read-scoped token, and never leaks another account', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const other = await seedAccountWithMember(admin, { role: 'owner' });
    expect((await call(owner, 'PUT', '/run-limits/default', { max_turns: 200 })).status).toBe(200);

    const member = await addMember(owner.accountId, 'member');
    expect((await list(member)).default.resolved.max_turns).toBe(200);
    const token = await tokenFor(owner, ['read']);
    const viaToken = await call(owner, 'GET', '/run-limits', undefined, token);
    expect(viaToken.status).toBe(200);
    expect(((await viaToken.json()) as ListBody).default.resolved.max_turns).toBe(200);

    expect((await list(other)).default.resolved.max_turns).toBe(100);
  });

  it('PUT on the default writes it, resolves per-role rows over it, and writes one audit row each', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const res = await call(owner, 'PUT', '/run-limits/default', { max_run_minutes: 120, auto_resume: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      role: 'default',
      stored: { max_run_minutes: 120, auto_resume: false, per_run_usd: null },
      resolved: { max_run_minutes: 120, auto_resume: false, per_run_usd: loadPlanData().caps.perSpawnUsd },
    });
    expect(await auditCount(owner.accountId)).toBe(1);

    const roleRes = await call(owner, 'PUT', '/run-limits/executor', { per_run_usd: 75.5 });
    expect(roleRes.status).toBe(200);
    expect(await roleRes.json()).toMatchObject({
      role: 'executor',
      stored: { per_run_usd: 75.5, max_run_minutes: null },
      resolved: { per_run_usd: 75.5, max_run_minutes: 120, auto_resume: false },
    });
    expect(await auditCount(owner.accountId)).toBe(2);

    const body = await list(owner);
    expect(body.roles.map((r) => r.role)).toEqual(['executor']);
    expect(body.default.resolved.per_run_usd).toBe(loadPlanData().caps.perSpawnUsd);
  });

  it('PUT merges: an omitted key is unchanged and null returns it to inheriting', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    await call(owner, 'PUT', '/run-limits/default', { max_turns: 300, max_resumes: 4 });
    await call(owner, 'PUT', '/run-limits/default', { max_resumes: 1 });
    let body = await list(owner);
    expect(body.default.stored).toMatchObject({ max_turns: 300, max_resumes: 1 });

    const cleared = await call(owner, 'PUT', '/run-limits/default', { max_turns: null });
    expect(cleared.status).toBe(200);
    body = await list(owner);
    expect(body.default.stored).toMatchObject({ max_turns: null, max_resumes: 1 });
    expect(body.default.resolved.max_turns).toBe(100);
  });

  it('PUT refuses a value outside its floor or ceiling with 422 and the key as path, writing nothing', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    for (const [key, value] of [
      ['max_run_minutes', 4],
      ['max_run_minutes', 241],
      ['silence_minutes', 10],
      ['max_extensions', 5],
      ['max_model_calls', 20.5],
      ['per_run_usd', 200.01],
    ] as const) {
      const res = await call(owner, 'PUT', '/run-limits/default', { [key]: value });
      expect(res.status, `${key}=${value}`).toBe(422);
      const body = (await res.json()) as ErrorBody;
      expect(body.details).toEqual([{ path: key, code: 'out_of_range' }]);
    }
    // Boundary values are accepted.
    expect((await call(owner, 'PUT', '/run-limits/default', { max_run_minutes: 5, per_run_usd: 200 })).status).toBe(200);
    expect(await auditCount(owner.accountId)).toBe(1);
  });

  it('PUT refuses unknown keys and wrong types with 422, and an unknown role with 404', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    expect((await call(owner, 'PUT', '/run-limits/default', { nope: 1 })).status).toBe(422);
    expect((await call(owner, 'PUT', '/run-limits/default', { max_turns: '100' })).status).toBe(422);
    expect((await call(owner, 'PUT', '/run-limits/no-such-role', { max_turns: 100 })).status).toBe(404);
    expect((await call(owner, 'PUT', '/run-limits/*', { max_turns: 100 })).status).toBe(404);
    expect(await auditCount(owner.accountId)).toBe(0);
  });

  it('PUT refuses a wrong-typed value with 422, the key as path and the zod code, writing nothing', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const res = await call(owner, 'PUT', '/run-limits/default', { max_turns: '100' });
    expect(res.status).toBe(422);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('validation_failed');
    expect(body.details).toEqual([{ path: 'max_turns', code: 'invalid_type' }]);
    expect(await auditCount(owner.accountId)).toBe(0);
  });

  it('PUT refuses per_run_usd with more than 2 decimals rather than letting the column round it', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    for (const value of [1.005, 40.001, 12.345]) {
      const res = await call(owner, 'PUT', '/run-limits/default', { per_run_usd: value });
      expect(res.status, `per_run_usd=${value}`).toBe(422);
      expect(((await res.json()) as ErrorBody).details).toEqual([{ path: 'per_run_usd', code: 'custom' }]);
    }
    expect(await auditCount(owner.accountId)).toBe(0);
    // Two decimals (and whole dollars) are still accepted, and stored as given.
    for (const value of [12.34, 1.01, 75.5, 40]) {
      const ok = await call(owner, 'PUT', '/run-limits/default', { per_run_usd: value });
      expect(ok.status, `per_run_usd=${value}`).toBe(200);
      expect(((await ok.json()) as Entry).stored.per_run_usd).toBe(value);
    }
  });

  it('PUT is for owners and admins: a member gets 403, an admin succeeds', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const member = await addMember(owner.accountId, 'member');
    const adminUser = await addMember(owner.accountId, 'admin');
    expect((await call(member, 'PUT', '/run-limits/default', { max_turns: 50 })).status).toBe(403);
    expect((await call(adminUser, 'PUT', '/run-limits/default', { max_turns: 50 })).status).toBe(200);
    expect(await auditCount(owner.accountId)).toBe(1);
  });

  it('PUT refuses every API token, whatever its scopes, and changes nothing', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    for (const scopes of [['read'], ['read', 'runs:cancel', 'audit:read']] as Scope[][]) {
      const token = await tokenFor(owner, scopes);
      const res = await call(owner, 'PUT', '/run-limits/default', { max_turns: 50 }, token);
      expect(res.status).toBe(403);
      expect(((await res.json()) as ErrorBody).error.code).toBe('session_required');
    }
    expect(await auditCount(owner.accountId)).toBe(0);
    expect((await list(owner)).default.stored.max_turns).toBeNull();
  });
});
