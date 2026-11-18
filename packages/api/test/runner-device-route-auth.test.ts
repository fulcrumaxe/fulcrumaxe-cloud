import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { hashDeviceCode, hashUserCode, newUserCode } from '@fx/runner-cloud';
import { generateToken } from '../src/tokens/format.js';
import { SCOPES, type RouteEntry } from '../src/registry.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { runnerDeviceDeps, runnerDeviceRoutes } from '../src/routes/runnerDevice.js';
import { seedUser } from './helpers/seed.js';

const KEY = Buffer.from('k'.repeat(32));
const ROUTES_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'routes', 'runnerDevice.ts');

/**
 * The pinned role of EVERY device-link route, `operationId -> minRole`. The probes take the role to test from THIS table, never from the route, so a route
 * lowered (or raised) in its own file is a failure here and not a quiet pass. A new route in routes/runnerDevice.ts fails the first test until it is added.
 */
const EXPECTED_ROLES: Record<string, 'member' | 'admin' | 'owner'> = {
  lookupRunnerDeviceCode: 'admin',
  approveRunnerDeviceCode: 'admin',
  denyRunnerDeviceCode: 'admin',
};
const principalsOf = (r: RouteEntry): readonly string[] => r.principals ?? ['session'];

describe('runner device route auth meta-test [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let A: SeedRefs;
  let B: SeedRefs;
  let owner: { accountId: string; userId: string };
  let adminUser: { accountId: string; userId: string };
  let member: { accountId: string; userId: string };
  let bAdmin: { accountId: string; userId: string };
  let readToken: string;
  let everyScopeToken: string;

  const body = (r: RouteEntry, userCode: string) => JSON.stringify(r.operationId === 'approveRunnerDeviceCode' ? { user_code: userCode, confirm: true } : { user_code: userCode });
  const call = async (r: RouteEntry, who: { accountId: string; userId: string } | 'none', userCode: string, bearer?: string) => {
    const headers = new Headers({ accept: 'application/json', 'content-type': 'application/json' });
    if (bearer) headers.set('authorization', `Bearer ${bearer}`);
    else if (who !== 'none') headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(who)}`);
    return (await handleApiRequest(new Request(`http://localhost${r.path}`, { method: r.method, headers, body: body(r, userCode) }), appUserPool, platformOpsPool, ROUTES)).status;
  };
  /** A pending code the way the start route stores it; returns what the person would type. */
  const pending = async (): Promise<string> => {
    const code = newUserCode();
    await appUserPool.query('SELECT runner_device_start($1, $2, $3::jsonb, $4, $5::jsonb, $6, 100000, 100000)', [
      hashDeviceCode(`fxrd_${randomBytes(20).toString('hex')}`),
      hashUserCode(KEY, code),
      JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: randomBytes(32).toString('base64url') }),
      randomBytes(32).toString('base64url'),
      JSON.stringify({ os: 'linux', arch: 'x64', kvm: false }),
      randomBytes(32).toString('hex'),
    ]);
    return code;
  };
  const addMember = async (acct: SeedRefs, role: string) => {
    const who = { accountId: acct.accountId, userId: randomUUID() };
    await seedUser(admin, who.userId);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [who.accountId, who.userId, role]);
    return who;
  };

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
    runnerDeviceDeps.key = () => KEY;
    runnerDeviceDeps.maxRunners = () => 1000;
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
    owner = { accountId: A.accountId, userId: A.userId };
    adminUser = await addMember(A, 'admin');
    member = await addMember(A, 'member');
    bAdmin = await addMember(B, 'admin');
    readToken = generateToken();
    await insertApiToken(appUserPool, { accountId: A.accountId, createdBy: A.userId, tokenHash: hashToken(readToken), displayHint: 'fxat_...test', scopes: ['read'], expiresAt: new Date(Date.now() + 86_400_000) });
    everyScopeToken = generateToken();
    await insertApiToken(appUserPool, { accountId: A.accountId, createdBy: A.userId, tokenHash: hashToken(everyScopeToken), displayHint: 'fxat_...all', scopes: [...SCOPES], expiresAt: new Date(Date.now() + 86_400_000) });
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    delete runnerDeviceDeps.key;
    delete runnerDeviceDeps.maxRunners;
    admin.release();
    await Promise.all([adminPool.end(), appUserPool.end(), platformOpsPool.end()]);
  });

  it('pins the role of every device-link route, declares its principals, and registers it in ROUTES', () => {
    expect(Object.fromEntries(runnerDeviceRoutes.map((r) => [r.operationId, r.minRole]))).toEqual(EXPECTED_ROLES);
    expect(ROUTES.filter((r) => r.path.startsWith('/api/v1/runners/device/')).map((r) => r.operationId).sort()).toEqual(Object.keys(EXPECTED_ROLES).sort());
    for (const r of runnerDeviceRoutes) {
      expect(ROUTES.includes(r), `${r.operationId} is registered in ROUTES`).toBe(true);
      expect(r.method).toBe('POST');
      // Principals are explicit in effect: session only, no token of either class, and not anonymous.
      expect(principalsOf(r), r.path).toEqual(['session']);
      expect(r.tokens, r.path).toBeUndefined();
      expect(r.anonymous, r.path).toBeUndefined();
      expect(r.scope, r.path).toBeUndefined();
    }
    // A route added to the file without a row above is caught by the count; one that lists codes is caught by the paths.
    expect(readFileSync(ROUTES_FILE, 'utf8').match(/^\s+method: "/gm)).toHaveLength(Object.keys(EXPECTED_ROLES).length);
    expect(runnerDeviceRoutes.some((r) => r.method === 'GET')).toBe(false);
  });

  it('unauthenticated is 401 on every route', async () => {
    const code = await pending();
    for (const r of runnerDeviceRoutes) expect(await call(r, 'none', code), r.path).toBe(401);
  });

  it('a member is 403 on every route, and nothing is claimed', async () => {
    const code = await pending();
    for (const r of runnerDeviceRoutes) expect(await call(r, member, code), r.path).toBe(403);
    expect((await admin.query(`SELECT status FROM runner_device_codes WHERE user_code_hash = $1`, [hashUserCode(KEY, code)])).rows).toEqual([{ status: 'pending' }]);
  });

  it('a token is 403 on every route, whatever scopes it holds, and nothing is claimed', async () => {
    const code = await pending();
    for (const bearer of [readToken, everyScopeToken]) for (const r of runnerDeviceRoutes) expect(await call(r, 'none', code, bearer), r.path).toBe(403);
    expect((await admin.query(`SELECT status FROM runner_device_codes WHERE user_code_hash = $1`, [hashUserCode(KEY, code)])).rows).toEqual([{ status: 'pending' }]);
  });

  it('an admin and an owner may look up, and an admin may approve or deny; the account is the session\'s', async () => {
    const [lookup, approve, deny] = ['lookupRunnerDeviceCode', 'approveRunnerDeviceCode', 'denyRunnerDeviceCode'].map((id) => runnerDeviceRoutes.find((r) => r.operationId === id)!);
    const c1 = await pending();
    expect(await call(lookup!, adminUser, c1)).toBe(200);
    expect(await call(lookup!, owner, c1)).toBe(200);
    expect(await call(approve!, adminUser, c1)).toBe(200);
    expect((await admin.query(`SELECT status, account_id, approved_by FROM runner_device_codes WHERE user_code_hash = $1`, [hashUserCode(KEY, c1)])).rows).toEqual([{ status: 'approved', account_id: A.accountId, approved_by: adminUser.userId }]);
    const c2 = await pending();
    expect(await call(deny!, owner, c2)).toBe(200);
    expect((await admin.query(`SELECT status FROM runner_device_codes WHERE user_code_hash = $1`, [hashUserCode(KEY, c2)])).rows).toEqual([{ status: 'denied' }]);
  });

  it('an admin of another account is 404 on a code this account approved, on every route (a second code of the same account stays theirs to find)', async () => {
    const mine = await pending();
    const second = await pending();
    const approve = runnerDeviceRoutes.find((r) => r.operationId === 'approveRunnerDeviceCode')!;
    expect(await call(approve, adminUser, mine)).toBe(200);
    for (const r of runnerDeviceRoutes) expect(await call(r, bAdmin, mine), r.path).toBe(404);
    expect(await call(runnerDeviceRoutes.find((r) => r.operationId === 'lookupRunnerDeviceCode')!, bAdmin, second)).toBe(200);
    expect((await admin.query(`SELECT 1 FROM runner_device_codes WHERE account_id = $1 AND user_code_hash = $2`, [B.accountId, hashUserCode(KEY, mine)])).rows).toHaveLength(0);
  });

  it('a missing server key is 503 on every route', async () => {
    const code = await pending();
    const saved = runnerDeviceDeps.key;
    runnerDeviceDeps.key = () => null;
    try {
      for (const r of runnerDeviceRoutes) expect(await call(r, adminUser, code), r.path).toBe(503);
    } finally {
      runnerDeviceDeps.key = saved;
    }
  });
});
