import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { machineKekSource } from '@fx/model-connection';
import { createHetznerCredentialProbe } from '../../hetzner/src/index.js';
import { newWorld, startStrictHetzner, type FakeWorld, type StrictHetzner } from '../../hetzner/test/helpers/strictHetzner.js';
import { handleApiRequest } from '../src/handler.js';
import { effectivePrincipals } from '../src/registry.js';
import { ROUTES } from '../src/routes/index.js';
import { hetznerCredentialResponseSchema, machineCredentialDeps } from '../src/routes/machine-credential.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

const URL_ = 'http://localhost/api/v1/machine-credentials/hetzner';
const newToken = (): string => randomBytes(48).toString('base64').replace(/[^A-Za-z0-9]/g, '').padEnd(64, 'x').slice(0, 64);

/** D#845 MC-2: the two credential routes, through the real handler, against the strict Hetzner fake and a real database. */
describe('machine credential routes', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let fake: StrictHetzner;
  let world: FakeWorld;
  let token: string;
  const defaults = { ...machineCredentialDeps };

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
  beforeEach(async () => {
    token = newToken();
    world = newWorld([token]);
    fake = await startStrictHetzner(world);
    const kek = machineKekSource({ FX_MACHINE_KEK_V1: randomBytes(32).toString('base64') });
    machineCredentialDeps.getKek = () => kek;
    machineCredentialDeps.getProbe = () => createHetznerCredentialProbe({ maxRetries: 0, timeoutMs: 2000, testTarget: { lookup: fake.lookup, port: fake.port, ca: fake.ca } });
  });
  afterEach(async () => {
    Object.assign(machineCredentialDeps, defaults);
    await fake.close();
  });

  async function call(who: { accountId: string; userId: string } | null, method: string, body?: unknown): Promise<Response> {
    await admin.query("DELETE FROM rate_limit_windows WHERE bucket_key LIKE 'session%'");
    const headers = new Headers(who ? { cookie: `${SESSION_COOKIE_NAME}=${await signSession(who)}` } : {});
    if (body !== undefined) headers.set('content-type', 'application/json');
    return handleApiRequest(new Request(URL_, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), appUserPool, platformOpsPool, ROUTES);
  }

  it('the three routes are session-only and owner-or-admin in the registry, and the connect route has its own session limit', () => {
    const mine = ROUTES.filter((r) => r.path === '/api/v1/machine-credentials/hetzner');
    expect(mine.map((r) => r.method).sort()).toEqual(['DELETE', 'GET', 'POST']);
    for (const r of mine) { expect(effectivePrincipals(r), r.method).toEqual(['session']); expect(r, r.method).toMatchObject({ minRole: 'admin', idempotency: 'never' }); }
    expect(mine.find((r) => r.method === 'POST')!.sessionLimit?.name).toBe('machine-credential-put');
  });

  it('connect answers 201 with a tail and the foreign-server count, never the token; remove answers 204; a second remove is 404', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const res = await call(owner, 'POST', { token });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain(token);
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(hetznerCredentialResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ status: 'ok', token_hint: token.slice(-4), unlabelled_server_count: 0 });
    expect((await call(owner, 'DELETE')).status).toBe(204);
    const gone = await call(owner, 'DELETE');
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({ error: { code: 'not_connected' } });
  });

  it('refusals use fixed codes: a refused token, a read-only token, a bad format, a second connect, a missing machine key, an unwired probe', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    expect((await call(owner, 'POST', { token: 'not-a-hetzner-token' })).status).toBe(422);
    world.tokens.clear();
    const refused = await call(owner, 'POST', { token });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ error: { code: 'token_invalid' }, details: [{ path: 'token', code: 'token_invalid' }] });
    world.tokens.add(token);
    world.readOnlyTokens = new Set([token]);
    expect(await (await call(owner, 'POST', { token })).json()).toMatchObject({ error: { code: 'token_read_only' } });
    world.readOnlyTokens = undefined;
    machineCredentialDeps.getKek = () => machineKekSource({});
    const off = await call(owner, 'POST', { token });
    expect(off.status).toBe(503);
    expect(await off.json()).toMatchObject({ error: { code: 'machine_kek_unset' } });
    machineCredentialDeps.getKek = defaults.getKek;
    machineCredentialDeps.getProbe = () => null;
    expect(await (await call(owner, 'POST', { token })).json()).toMatchObject({ error: { code: 'not_configured' } });
    machineCredentialDeps.getKek = () => machineKekSource({ FX_MACHINE_KEK_V1: randomBytes(32).toString('base64') });
    machineCredentialDeps.getProbe = () => createHetznerCredentialProbe({ maxRetries: 0, testTarget: { lookup: fake.lookup, port: fake.port, ca: fake.ca } });
    expect((await call(owner, 'POST', { token })).status).toBe(201);
    expect((await call(owner, 'POST', { token })).status).toBe(409);
    expect(world.sshKeys).toEqual([]);
  });

  it('no session is 401; a plain member is 403 on both and nothing reaches Hetzner', async () => {
    expect((await call(null, 'POST', { token })).status).toBe(401);
    expect((await call(null, 'DELETE')).status).toBe(401);
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [owner.accountId, userId]);
    const plain = { accountId: owner.accountId, userId };
    expect((await call(plain, 'POST', { token })).status).toBe(403);
    expect((await call(plain, 'DELETE')).status).toBe(403);
    expect(world.requests).toEqual([]);
  });
});
