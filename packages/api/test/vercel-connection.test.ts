import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { createSealedVercelCredentials, createVercelTokenValidator, type KekSource } from '@fx/model-connection';
import { setPendingHooks } from '@fx/core/src/pendingWork.js';
import { runSetupRequestCheck } from '@fx/core/src/setup-requests/checks.js';
import { createVercelEnvSource } from '@fx/core/src/setup-requests/vercelEnvSource.js';
import { FakeVercel } from '../../core/test/support/vercelEnvFake.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { vercelConnectionDeps } from '../src/routes/vercel-connection.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

const BASE = 'http://localhost/api/v1/vercel-connection';

interface Identity {
  accountId: string;
  userId: string;
}
interface Dto {
  state: string;
  fingerprint: string | null;
  team_id: string | null;
  connected_at: string | null;
  rotated_at: string | null;
  rejected_at: string | null;
  copy: { headline: string; detail: string; action: string | null; secondary_action: string | null };
}
interface ErrorBody {
  error: { code: string; message: string };
  details?: { path: string; code: string }[];
}

/** D#598 P8d-2: the Vercel connection routes through the real dispatcher against real Postgres; the only fake is the strict Vercel stand-in. */
describe('D#598 P8d-2: vercel-connection routes', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let vercel: FakeVercel;
  let kekSource: KekSource;
  const markers = new Map<string, number>();
  let logged: string[];

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
    kekSource = { currentVersion: () => 1, keyFor: () => key };
    vercelConnectionDeps.getKek = () => kekSource;
    markers.clear();
    setPendingHooks({ store: { get: async (k) => markers.get(k) ?? null, set: async (k, v) => void markers.set(k, v), delete: async (k) => void markers.delete(k) } });
    vercelConnectionDeps.getValidator = () => createVercelTokenValidator({ fetch: vercel.fetchImpl() });
    logged = [];
    const capture = (chunk: unknown): boolean => {
      logged.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, 'write').mockImplementation(capture as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(capture as never);
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void logged.push(a.map(String).join(' ')));
  });
  afterEach(() => {
    setPendingHooks(null);
    vi.restoreAllMocks();
    vercelConnectionDeps.getValidator = () => null;
  });

  async function call(identity: Identity, method: string, body?: unknown, extra: Record<string, string> = {}): Promise<Response> {
    await admin.query("DELETE FROM rate_limit_windows WHERE bucket_key LIKE 'session%'");
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(identity)}`, ...extra });
    if (body !== undefined) headers.set('content-type', 'application/json');
    return handleApiRequest(new Request(BASE, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), appUserPool, platformOpsPool, ROUTES);
  }
  /** A token Vercel knows, as the person would paste it. */
  const vercelToken = (accountId: string, opts: { teamId?: string } = {}): string => vercel.connect(accountId, opts).tokenOf(accountId);
  async function addMember(accountId: string, role: 'admin' | 'member'): Promise<Identity> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, userId, role]);
    return { accountId, userId };
  }
  async function tablesContaining(needle: string): Promise<string[]> {
    const { rows: tables } = await admin.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`);
    const hits: string[] = [];
    for (const { table_name } of tables) {
      const { rows } = await admin.query<{ n: string }>(`SELECT count(*) AS n FROM "${table_name}" t WHERE t::text LIKE $1`, [`%${needle}%`]);
      if (Number(rows[0]!.n) > 0) hits.push(table_name);
    }
    return hits;
  }

  it('GET -> POST -> GET -> PUT -> DELETE -> GET: each answer is the status DTO with the right copy, and the token is nowhere afterwards', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const first = await call(owner, 'GET');
    expect(first.status).toBe(200);
    const none = (await first.json()) as Dto;
    expect(none).toMatchObject({ state: 'not_connected', fingerprint: null, copy: { headline: 'Vercel is not connected', action: 'Connect Vercel', secondary_action: null } });

    const token = vercelToken(owner.accountId);
    const posted = await call(owner, 'POST', { token });
    expect(posted.status).toBe(201);
    const dto = (await posted.json()) as Dto;
    expect(Object.keys(dto).sort()).toEqual(['connected_at', 'copy', 'fingerprint', 'rejected_at', 'rotated_at', 'state', 'team_id']);
    expect(dto).toMatchObject({ state: 'connected', team_id: null, rotated_at: null, copy: { headline: 'Vercel is connected', action: 'Replace token', secondary_action: 'Disconnect' } });
    expect(dto.copy.detail).toContain(dto.fingerprint!);
    expect(await (await call(owner, 'GET')).json()).toEqual(dto);

    const second = vercelToken(randomUUID());
    const put = await call(owner, 'PUT', { token: second });
    expect(put.status).toBe(200);
    const rotated = (await put.json()) as Dto;
    expect(rotated.state).toBe('connected');
    expect(rotated.rotated_at).not.toBeNull();

    const del = await call(owner, 'DELETE');
    expect(del.status).toBe(204);
    expect(await del.text()).toBe('');
    expect(((await (await call(owner, 'GET')).json()) as Dto).state).toBe('not_connected');

    for (const secret of [token, second]) {
      expect(await tablesContaining(secret)).toEqual([]);
      expect(logged.join('\n')).not.toContain(secret);
    }
    const audit = await admin.query<{ action: string; payload: object }>(`SELECT action, payload FROM audit_log WHERE account_id = $1 AND action LIKE 'vercel_connection.%' ORDER BY created_at`, [owner.accountId]);
    expect(audit.rows.map((r) => r.action)).toEqual(['vercel_connection.connect', 'vercel_connection.rotate', 'vercel_connection.remove']);
    expect(JSON.stringify(audit.rows)).not.toContain(token);
  });

  it('a team-scoped connect keeps the team id; a token Vercel does not accept for that team is 422 token_rejected with nothing stored and nothing echoed', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const scoped = vercelToken(owner.accountId, { teamId: 'team_abc1' });
    const wrongTeam = await call(owner, 'POST', { token: scoped, team_id: 'team_other' });
    expect(wrongTeam.status).toBe(422);
    const body = (await wrongTeam.json()) as ErrorBody;
    expect(body.error.code).toBe('token_rejected');
    expect(JSON.stringify(body)).not.toContain(scoped);
    expect((await admin.query('SELECT 1 FROM vercel_connections WHERE account_id = $1', [owner.accountId])).rowCount).toBe(0);
    const ok = await call(owner, 'POST', { token: scoped, team_id: 'team_abc1' });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as Dto).team_id).toBe('team_abc1');
  });

  it('closed error codes: unknown token 422, bad format 422, bad team id 422, second connect 409, replace with none 404, Vercel down 503, not configured 503', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const code = async (res: Response): Promise<[number, string]> => [res.status, ((await res.json()) as ErrorBody).error.code];
    expect(await code(await call(owner, 'POST', { token: 'vtok_unknown' }))).toEqual([422, 'token_rejected']);
    expect(await code(await call(owner, 'POST', { token: 'has space' }))).toEqual([422, 'invalid_token_format']);
    expect(await code(await call(owner, 'POST', { token: 'tok', team_id: 'nope' }))).toEqual([422, 'invalid_team_id']);
    expect(await code(await call(owner, 'PUT', { token: vercelToken(owner.accountId) }))).toEqual([404, 'not_connected']);
    expect(await code(await call(owner, 'DELETE'))).toEqual([404, 'not_found']);
    vercel.failNext('http_500');
    expect(await code(await call(owner, 'POST', { token: vercelToken(owner.accountId) }))).toEqual([503, 'provider_unreachable']);
    expect((await call(owner, 'POST', { token: vercelToken(owner.accountId) })).status).toBe(201);
    expect(await code(await call(owner, 'POST', { token: vercelToken(owner.accountId) }))).toEqual([409, 'already_connected']);
    vercelConnectionDeps.getValidator = () => null;
    expect(await code(await call(owner, 'PUT', { token: 'x' }))).toEqual([503, 'vercel_connection_not_configured']);
  });

  it('a member may GET but not write; nothing changes and Vercel is not asked', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    await call(owner, 'POST', { token: vercelToken(owner.accountId) });
    const member = await addMember(owner.accountId, 'member');
    expect((await call(member, 'GET')).status).toBe(200);
    const before = await admin.query('SELECT id, token_fingerprint FROM vercel_connections WHERE account_id = $1', [owner.accountId]);
    const callsBefore = vercel.calls.length;
    for (const [m, b] of [['POST', { token: 'x' }], ['PUT', { token: 'x' }], ['DELETE', undefined]] as const) {
      const res = await call(member, m, b);
      expect(res.status, m).toBe(403);
      expect(((await res.json()) as ErrorBody).error.code, m).toBe('insufficient_role');
    }
    expect(vercel.calls.length).toBe(callsBefore);
    expect((await admin.query('SELECT id, token_fingerprint FROM vercel_connections WHERE account_id = $1', [owner.accountId])).rows).toEqual(before.rows);
    const adminMember = await addMember(owner.accountId, 'admin');
    expect((await call(adminMember, 'PUT', { token: vercelToken(owner.accountId) })).status).toBe(200);
  });

  it('the three writes are session-only and refuse an Idempotency-Key; an API token may only GET', async () => {
    for (const entry of ROUTES.filter((r) => r.path === '/api/v1/vercel-connection')) {
      expect(entry.principals ?? ['session'], `${entry.method}`).toEqual(entry.method === 'GET' ? ['session', 'token'] : ['session']);
    }
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const withKey = await call(owner, 'POST', { token: vercelToken(owner.accountId) }, { 'idempotency-key': 'abc-123' });
    expect(withKey.status).toBe(400);
    expect(((await withKey.json()) as ErrorBody).error.code).toBe('idempotency_not_supported');
    expect((await admin.query('SELECT 1 FROM vercel_connections WHERE account_id = $1', [owner.accountId])).rowCount).toBe(0);

    const plaintext = generateToken();
    await insertApiToken(appUserPool, { accountId: owner.accountId, createdBy: owner.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes: ['read'], expiresAt: new Date(Date.now() + 86_400_000) });
    const bearer = (method: string, body?: unknown) =>
      handleApiRequest(new Request(BASE, { method, headers: { authorization: `Bearer ${plaintext}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }), appUserPool, platformOpsPool, ROUTES);
    expect((await bearer('GET')).status).toBe(200);
    for (const res of [await bearer('POST', { token: 'x' }), await bearer('PUT', { token: 'x' }), await bearer('DELETE')]) {
      expect(res.status).toBe(403);
      expect(((await res.json()) as ErrorBody).error.code).toBe('session_required');
    }
  });

  const marked = async (): Promise<boolean> => {
    await new Promise((r) => setTimeout(r, 50)); // the marker write is fire-and-forget
    return markers.has('pending:setup-request-check');
  };

  it('connect and replace each mark the setup-request check sweep pending; a refused one does not', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    expect((await call(owner, 'POST', { token: 'vtok_unknown' })).status).toBe(422);
    expect(await marked()).toBe(false);
    expect((await call(owner, 'POST', { token: vercelToken(randomUUID()) })).status).toBe(201);
    expect(await marked()).toBe(true);
    markers.clear();
    expect((await call(owner, 'PUT', { token: 'vtok_unknown' })).status).toBe(422);
    expect(await marked()).toBe(false);
    expect((await call(owner, 'PUT', { token: vercelToken(randomUUID()) })).status).toBe(200);
    expect(await marked()).toBe(true);
  });

  it('end to end: connect, then the env-var check resolves names with the stored token; after disconnect it says it cannot check', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    vercel.project('cloud-staging', [{ key: 'DATABASE_URL', value: 'postgres://secret', target: ['production'] }]);
    const source = createVercelEnvSource({ credentials: createSealedVercelCredentials({ pool: appUserPool, kek: kekSource, log: () => undefined }), fetch: vercel.fetchImpl(), log: () => undefined });
    const request = { kind: 'env_var', checkKind: 'env_var_present', target: 'cloud-staging', envName: 'DATABASE_URL', targetEnvironment: 'production' } as const;
    const ask = () => runSetupRequestCheck(source, owner.accountId, request);

    expect(await ask()).toEqual({ pass: false, reason: 'check_unavailable' }); // nothing connected yet
    const token = vercelToken(randomUUID());
    expect((await call(owner, 'POST', { token })).status).toBe(201);
    expect(await source.listEnvNames({ accountId: owner.accountId, project: 'cloud-staging' })).toMatchObject({ ok: true, entries: [{ name: 'DATABASE_URL' }] });
    expect(await ask()).toEqual({ pass: true });
    expect(vercel.calls.at(-1)!.userAgent).not.toBeNull();

    // Vercel revokes the token: the next check is told it cannot check, and the connection reads rejected
    vercel.revoke(vercel.accountOfToken(token)!);
    expect(await ask()).toEqual({ pass: false, reason: 'check_unavailable' });
    expect(((await (await call(owner, 'GET')).json()) as Dto).state).toBe('rejected');

    expect((await call(owner, 'DELETE')).status).toBe(204);
    const calls = vercel.calls.length;
    expect(await ask()).toEqual({ pass: false, reason: 'check_unavailable' });
    expect(vercel.calls.length).toBe(calls); // no credential, so Vercel is not asked at all
  });
});
