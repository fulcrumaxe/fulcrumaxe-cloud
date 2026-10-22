import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { createVercelTokenValidator, type KekSource } from '@fx/model-connection';
import { setPendingHooks } from '@fx/core/src/pendingWork.js';
import { FakeVercel } from '../../core/test/support/vercelEnvFake.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { vercelConnectionDeps, vercelConnectionResponseSchema } from '../src/routes/vercel-connection.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

const BASE = 'http://localhost/api/v1/vercel-connection';
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'v1');
// This file's own ids (P8d-3b); the details suite (P8d-3a) uses team_p8d3a1.
const TEAM = 'team_p8d3b1';

interface Identity {
  accountId: string;
  userId: string;
}

/**
 * D#598 P8d-3b: the bodies the connection screen's page tests are served, written by the real routes against the strict Vercel stand-in.
 * The screen's refusals are anchored here too: the page test mocks a 422 inline, and this pins the envelope shape that mock must keep.
 */
describe('D#598 P8d-3b: connect and replace answer what the Vercel screen reads', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let vercel: FakeVercel;

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
  beforeEach(() => {
    vercel = new FakeVercel();
    const key = randomBytes(32);
    const kek: KekSource = { currentVersion: () => 1, keyFor: () => key };
    vercelConnectionDeps.getKek = () => kek;
    setPendingHooks({ store: { get: async () => null, set: async () => undefined, delete: async () => undefined } });
    vercelConnectionDeps.getValidator = () => createVercelTokenValidator({ fetch: vercel.fetchImpl() });
  });
  afterEach(() => {
    setPendingHooks(null);
    vercelConnectionDeps.getValidator = () => null;
  });

  async function request(who: Identity, method: string, body?: unknown): Promise<Response> {
    await admin.query("DELETE FROM rate_limit_windows WHERE bucket_key LIKE 'session%'");
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(who)}` });
    if (body !== undefined) headers.set('content-type', 'application/json');
    return handleApiRequest(new Request(BASE, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), appUserPool, platformOpsPool, ROUTES);
  }
  const pretty = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
  function pin(operationId: string, name: string, actual: Record<string, unknown>): void {
    const file = path.join(FIXTURES, operationId, `${name}.json`);
    // The times and the fingerprint (keyed per account) are the only unstable fields; the sentence that carries it is rewritten with it.
    const copy = actual.copy as { detail: string };
    const stable = {
      ...actual,
      fingerprint: 'a3f9',
      connected_at: actual.connected_at && '2026-10-22T10:15:30.000Z',
      rotated_at: actual.rotated_at && '2026-10-22T10:20:30.000Z',
      copy: { ...copy, detail: copy.detail.replace(String(actual.fingerprint), 'a3f9') },
    };
    if (process.env.FX_WRITE_FIXTURES === '1') {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, pretty(stable));
    }
    expect(existsSync(file), `${file} is missing: run with FX_WRITE_FIXTURES=1 and read the diff`).toBe(true);
    expect(pretty(stable)).toBe(readFileSync(file, 'utf8'));
  }

  it('connect answers 201 with the status body, and replace answers 200 with rotated_at set', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const token = vercel.connect(owner.accountId).tokenOf(owner.accountId);
    const connected = await request(owner, 'POST', { token });
    expect(connected.status).toBe(201);
    const first = (await connected.json()) as Record<string, unknown>;
    expect(vercelConnectionResponseSchema.safeParse(first).success).toBe(true);
    expect(first).toMatchObject({ state: 'connected', rotated_at: null });
    expect(JSON.stringify(first)).not.toContain(token);
    pin('connectVercel', '201-connected', first);

    const second = vercel.connect(owner.accountId).tokenOf(owner.accountId);
    const replaced = await request(owner, 'PUT', { token: second });
    expect(replaced.status).toBe(200);
    const rotated = (await replaced.json()) as Record<string, unknown>;
    expect(vercelConnectionResponseSchema.safeParse(rotated).success).toBe(true);
    expect(rotated.rotated_at).not.toBeNull();
    pin('rotateVercelConnection', '200-rotated', rotated);
  });

  it('the refusals the screen words: a refused token and a bad team id name their field and a closed code; a second connect is 409', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const refused = await request(owner, 'POST', { token: 'vtok_not_a_real_token_p8d3b' });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ error: { code: 'token_rejected' }, details: [{ path: 'token', code: 'token_rejected' }] });

    const badTeam = await request(owner, 'POST', { token: vercel.connect(owner.accountId).tokenOf(owner.accountId), team_id: 'not-a-team' });
    expect(badTeam.status).toBe(422);
    expect(await badTeam.json()).toMatchObject({ details: [{ path: 'team_id', code: 'invalid_team_id' }] });

    vercel.team(TEAM, 'Acme Studio');
    expect((await request(owner, 'POST', { token: vercel.tokenOf(owner.accountId), team_id: TEAM })).status).toBe(201);
    const again = await request(owner, 'POST', { token: vercel.tokenOf(owner.accountId) });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: 'already_connected' } });
  });

  it('a plain member may read but not write', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const userId = randomUUID();
    await seedUser(admin, userId);
    const plain = { accountId: owner.accountId, userId };
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [plain.accountId, plain.userId]);
    expect((await request(plain, 'POST', { token: vercel.tokenOf(owner.accountId) })).status).toBe(403);
    expect((await request(plain, 'PUT', { token: vercel.tokenOf(owner.accountId) })).status).toBe(403);
    const res = await request(plain, 'DELETE');
    expect(res.status).toBe(403);
  });
});
