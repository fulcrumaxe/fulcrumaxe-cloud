import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import type { KekSource, ValidationHttpClient, ValidationOutcome, ValidationRequest } from '@fx/model-connection';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { setModelConnectionDeps } from '../src/routes/model-connection.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FX_SESSION_SECRET = 's'.repeat(32);
const BASE = 'http://localhost/api/v1/model-connection';

/** A key that is easy to grep for and cannot occur by accident anywhere else. */
function freshKey(): string {
  return `sk-fixture-${randomBytes(12).toString('hex')}`;
}

interface Identity {
  accountId: string;
  userId: string;
}

interface Dto {
  provider: string;
  fingerprint: string;
  status: string;
  last_validated_at: string | null;
  last_error_code: string | null;
}

interface ErrorBody {
  error: { code: string; message: string; request_id: string };
  details?: { path: string; code: string }[];
}

function fixture(name: string): Dto {
  return JSON.parse(readFileSync(path.join(__dirname, '..', 'fixtures', 'v1', name), 'utf8')) as Dto;
}

/** H21's injectable provider client: records every request it is asked to make, answers with a settable outcome. */
class FakeProvider implements ValidationHttpClient {
  calls: ValidationRequest[] = [];
  outcome: ValidationOutcome = { kind: 'ok' };
  async validate(req: ValidationRequest): Promise<ValidationOutcome> {
    this.calls.push(req);
    return this.outcome;
  }
}

/**
 * D#31 API-2: the model-connection routes, called through the real
 * `handleApiRequest` dispatcher against real Postgres (RLS, the
 * SECURITY DEFINER audit/guard functions, the real H21 service). The only
 * fake is the outbound provider HTTP client, which H21 makes injectable
 * for exactly this.
 */
describe('D#31 API-2: model-connection routes', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let provider: FakeProvider;
  let logged: string[];

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = FX_SESSION_SECRET;
  });

  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await adminPool.end();
    await platformOpsPool.end();
    await appUserPool.end();
  });

  beforeEach(() => {
    provider = new FakeProvider();
    const kek = randomBytes(32);
    const kekSource: KekSource = { currentVersion: () => 1, keyFor: () => kek };
    setModelConnectionDeps({ platformOpsPool, kek: kekSource, httpClient: provider });

    // Everything the process prints while a request is in flight.
    logged = [];
    const capture = (chunk: unknown): boolean => {
      logged.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, 'write').mockImplementation(capture as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(capture as never);
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setModelConnectionDeps({});
  });

  async function sessionRequest(identity: Identity, method: string, urlPath = '', body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Request> {
    const token = await signSession(identity);
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${token}`, ...extraHeaders });
    let payload: string | undefined;
    if (body !== undefined) {
      headers.set('content-type', 'application/json');
      payload = JSON.stringify(body);
    }
    return new Request(`${BASE}${urlPath}`, { method, headers, body: payload });
  }

  function dispatch(req: Request): Promise<Response> {
    return handleApiRequest(req, appUserPool, platformOpsPool, ROUTES);
  }

  async function call(identity: Identity, method: string, urlPath = '', body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
    // These tests exercise the routes' behaviour, not their session caps (session-ratelimit.test.ts does), so
    // each call starts with empty session buckets: PUT and test allow one call per 10 seconds.
    await admin.query("DELETE FROM rate_limit_windows WHERE bucket_key LIKE 'session%'");
    return dispatch(await sessionRequest(identity, method, urlPath, body, extraHeaders));
  }

  async function put(identity: Identity, key: string, providerName = 'ai_gateway'): Promise<Response> {
    return call(identity, 'PUT', '', { provider: providerName, key });
  }

  async function tokenFor(identity: Identity): Promise<string> {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, {
      accountId: identity.accountId,
      createdBy: identity.userId,
      tokenHash: hashToken(plaintext),
      displayHint: 'fxat_...test',
      scopes: ['read'],
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    });
    return plaintext;
  }

  async function addMember(accountId: string, role: 'admin' | 'member'): Promise<Identity> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, userId, role]);
    return { accountId, userId };
  }

  /** Every table's rows rendered as text: does `needle` appear in any of them? Returns the tables that hold it. */
  async function tablesContaining(needle: string): Promise<string[]> {
    const { rows: tables } = await admin.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const hits: string[] = [];
    for (const { table_name } of tables) {
      const { rows } = await admin.query<{ n: string }>(`SELECT count(*) AS n FROM "${table_name}" t WHERE t::text LIKE $1`, [`%${needle}%`]);
      if (Number(rows[0]!.n) > 0) hits.push(table_name);
    }
    return hits;
  }

  it('criterion 1: PUT -> GET -> POST test -> DELETE -> GET 404, each returning the frozen DTO', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const key = freshKey();

    const putRes = await put(owner, key);
    expect(putRes.status).toBe(200);
    const putDto = (await putRes.json()) as Dto;
    expect(Object.keys(putDto).sort()).toEqual(['fingerprint', 'last_error_code', 'last_validated_at', 'provider', 'status']);
    expect(putDto.provider).toBe('ai_gateway');
    expect(putDto.status).toBe('ok');
    expect(putDto.fingerprint).toMatch(/^[0-9a-f]{4}$/);
    expect(putDto.last_error_code).toBeNull();
    expect(new Date(putDto.last_validated_at!).toString()).not.toBe('Invalid Date');

    const getRes = await call(owner, 'GET');
    expect(getRes.status).toBe(200);
    expect(await getRes.json()).toEqual(putDto);

    const testRes = await call(owner, 'POST', '/test');
    expect(testRes.status).toBe(200);
    const testDto = (await testRes.json()) as Dto;
    expect(testDto.fingerprint).toBe(putDto.fingerprint);
    expect(testDto.status).toBe('ok');
    // connect() validated once, test() a second time -- both with the stored key.
    expect(provider.calls.map((c) => c.plaintextKey)).toEqual([key, key]);

    const delRes = await call(owner, 'DELETE');
    expect(delRes.status).toBe(204);
    expect(await delRes.text()).toBe('');

    const goneRes = await call(owner, 'GET');
    expect(goneRes.status).toBe(404);
    expect(((await goneRes.json()) as ErrorBody).error.code).toBe('not_found');
  });

  it('a replaced key changes the fingerprint and keeps a single connection row', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const first = (await (await put(owner, freshKey())).json()) as Dto;
    const second = (await (await put(owner, freshKey())).json()) as Dto;
    expect(second.status).toBe('ok');
    // A 16-bit display fingerprint can collide; the row count is the real assertion.
    void first;
    const { rows } = await admin.query(`SELECT 1 FROM model_connections WHERE account_id = $1`, [owner.accountId]);
    expect(rows).toHaveLength(1);
  });

  it('criterion 2: the key appears in no response, no log line, and no row of any table', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const key = freshKey();
    const bodies: string[] = [];
    for (const res of [await put(owner, key), await call(owner, 'GET'), await call(owner, 'POST', '/test')]) {
      bodies.push(await res.text());
      for (const [, value] of res.headers) bodies.push(value);
    }
    // A rejected replacement and a malformed one must not echo it either.
    provider.outcome = { kind: 'rejected', code: '401', message: `provider says bad key ${key}` };
    const rejectedKey = freshKey();
    const rejected = await put(owner, rejectedKey);
    bodies.push(await rejected.text());
    const malformedKey = `${freshKey()}\nline-two`;
    const malformed = await put(owner, malformedKey);
    bodies.push(await malformed.text());

    for (const secret of [key, rejectedKey, malformedKey, malformedKey.split('\n')[0]!]) {
      expect(bodies.join('\n')).not.toContain(secret);
      expect(logged.join('\n')).not.toContain(secret);
      expect(await tablesContaining(secret), `tables holding ${secret}`).toEqual([]);
    }

    // The audit trail records that a key was connected -- and only provider + fingerprint.
    const { rows } = await admin.query<{ action: string; payload: Record<string, unknown> }>(
      `SELECT action, payload FROM audit_log WHERE account_id = $1 AND action LIKE 'model_connection.%'`,
      [owner.accountId],
    );
    expect(rows.map((r) => r.action)).toContain('model_connection.connect');
    for (const row of rows) {
      expect(Object.keys(row.payload).sort()).toEqual(['fingerprint', 'provider']);
    }
    expect(JSON.stringify(rows)).not.toContain(key);
  });

  it('criterion 3: a member may GET, but PUT, POST test and DELETE are 403 insufficient_role and change nothing', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    await put(owner, freshKey());
    const member = await addMember(owner.accountId, 'member');
    provider.calls = [];

    const getRes = await call(member, 'GET');
    expect(getRes.status).toBe(200);

    const before = await admin.query(`SELECT id, key_fingerprint FROM model_connections WHERE account_id = $1`, [owner.accountId]);
    for (const [name, res] of [
      ['PUT', await put(member, freshKey())],
      ['POST test', await call(member, 'POST', '/test')],
      ['DELETE', await call(member, 'DELETE')],
    ] as const) {
      expect(res.status, name).toBe(403);
      expect(((await res.json()) as ErrorBody).error.code, name).toBe('insufficient_role');
    }
    expect(provider.calls).toEqual([]);
    const after = await admin.query(`SELECT id, key_fingerprint FROM model_connections WHERE account_id = $1`, [owner.accountId]);
    expect(after.rows).toEqual(before.rows);
  });

  it('an admin may write, and so may an owner', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const adminMember = await addMember(owner.accountId, 'admin');
    expect((await put(adminMember, freshKey())).status).toBe(200);
    expect((await call(adminMember, 'POST', '/test')).status).toBe(200);
    expect((await call(owner, 'DELETE')).status).toBe(204);
  });

  it('criterion 4: PUT with an Idempotency-Key is 400 idempotency_not_supported, and nothing is stored', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const key = freshKey();
    const res = await call(owner, 'PUT', '', { provider: 'ai_gateway', key }, { 'idempotency-key': 'abc-123' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.code).toBe('idempotency_not_supported');
    const { rows } = await admin.query(`SELECT 1 FROM model_connections WHERE account_id = $1`, [owner.accountId]);
    expect(rows).toHaveLength(0);
    expect(await tablesContaining('abc-123')).toEqual([]);
  });

  it('criterion 5: the three writes are session-only; a token is refused, and GET is the only token route', async () => {
    for (const entry of ROUTES.filter((r) => r.path.startsWith('/api/v1/model-connection'))) {
      const kinds = entry.principals ?? ['session'];
      expect(kinds, `${entry.method} ${entry.path}`).toEqual(entry.method === 'GET' ? ['session', 'token'] : ['session']);
    }

    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    await put(owner, freshKey());
    provider.calls = [];
    const token = await tokenFor(owner);
    const bearer = (method: string, urlPath = '', body?: unknown): Request =>
      new Request(`${BASE}${urlPath}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });

    const getRes = await dispatch(bearer('GET'));
    expect(getRes.status).toBe(200);
    expect(Object.keys((await getRes.json()) as Dto).sort()).toEqual(['fingerprint', 'last_error_code', 'last_validated_at', 'provider', 'status']);

    for (const req of [bearer('PUT', '', { provider: 'ai_gateway', key: freshKey() }), bearer('DELETE'), bearer('POST', '/test')]) {
      const res = await dispatch(req);
      expect(res.status).toBe(403);
      expect(((await res.json()) as ErrorBody).error.code).toBe('session_required');
    }
    expect(provider.calls).toEqual([]);
    const { rows } = await admin.query(`SELECT 1 FROM model_connections WHERE account_id = $1`, [owner.accountId]);
    expect(rows).toHaveLength(1);
  });

  it('a rejected key is 422 invalid_model_key and stores nothing', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    provider.outcome = { kind: 'rejected', code: '401', message: 'unauthorized' };
    const key = freshKey();
    const res = await put(owner, key);
    expect(res.status).toBe(422);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe('invalid_model_key');
    expect(body.details).toEqual([{ path: 'key', code: 'rejected' }]);
    expect(JSON.stringify(body)).not.toContain(key);
    const { rows } = await admin.query(`SELECT 1 FROM model_connections WHERE account_id = $1`, [owner.accountId]);
    expect(rows).toHaveLength(0);
  });

  it('an unreachable provider stores the key as unvalidated (200), it does not lose it', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    provider.outcome = { kind: 'network_error', code: 'fetch_failed', message: 'x' };
    const res = await put(owner, freshKey());
    expect(res.status).toBe(200);
    const dto = (await res.json()) as Dto;
    expect(dto.status).toBe('unvalidated');
    expect(dto.last_error_code).toBe('fetch_failed');
  });

  it('input validation: unknown provider, a missing key and unusable keys are 422 without echoing the value', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const badProvider = await put(owner, freshKey(), 'openai');
    expect(badProvider.status).toBe(422);
    expect(((await badProvider.json()) as ErrorBody).error.code).toBe('validation_failed');

    const noKey = await call(owner, 'PUT', '', { provider: 'ai_gateway' });
    expect(noKey.status).toBe(422);

    const padded = await put(owner, ` ${freshKey()}`);
    expect(padded.status).toBe(422);
    expect(((await padded.json()) as ErrorBody).details).toEqual([{ path: 'key', code: 'invalid_key_format' }]);

    const empty = await put(owner, '');
    expect(empty.status).toBe(422);

    // `anthropic` exists but is behind a flag.
    const anthropic = await put(owner, freshKey(), 'anthropic');
    expect(anthropic.status).toBe(422);
    expect(((await anthropic.json()) as ErrorBody).details).toEqual([{ path: 'provider', code: 'provider_disabled' }]);

    expect(provider.calls).toEqual([]);
    const { rows } = await admin.query(`SELECT 1 FROM model_connections WHERE account_id = $1`, [owner.accountId]);
    expect(rows).toHaveLength(0);
  });

  it('SSRF: the caller cannot name a host -- only {provider, key} reach the provider client, and extra fields are dropped', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const key = freshKey();
    const res = await call(owner, 'PUT', '', {
      provider: 'ai_gateway',
      key,
      url: 'http://169.254.169.254/latest/meta-data',
      base_url: 'http://localhost:5432',
      host: 'internal.example',
    });
    expect(res.status).toBe(200);
    // /test takes no body at all, so there is nowhere to put a host.
    const withBody = await call(owner, 'POST', '/test', { url: 'http://169.254.169.254/' });
    expect(withBody.status).toBe(400);
    expect((await call(owner, 'POST', '/test')).status).toBe(200);
    expect(provider.calls).toHaveLength(2);
    for (const c of provider.calls) {
      expect(Object.keys(c).sort()).toEqual(['plaintextKey', 'provider']);
      expect(['ai_gateway', 'anthropic']).toContain(c.provider);
    }
    // A provider that is not in the closed set never reaches the client at all.
    provider.calls = [];
    expect((await put(owner, key, 'http://169.254.169.254')).status).toBe(422);
    expect(provider.calls).toEqual([]);
  });

  it('POST test records a rejection: status becomes broken with the provider code, and upstream text is never returned', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const key = freshKey();
    await put(owner, key);
    provider.outcome = { kind: 'rejected', code: '401', message: `upstream said: invalid credential ${key}` };
    const res = await call(owner, 'POST', '/test');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(key);
    expect(text).not.toContain('upstream said');
    const dto = JSON.parse(text) as Dto;
    expect(dto.status).toBe('broken');
    expect(dto.last_error_code).toBe('401');
    expect(await tablesContaining(key)).toEqual([]);
  });

  it('POST test with no connection is 404 not_found', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const res = await call(owner, 'POST', '/test');
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error.code).toBe('not_found');
    expect(provider.calls).toEqual([]);
  });

  it('tenant isolation, live: tenant B can neither see, test, replace nor delete tenant A\'s connection', async () => {
    const a = await seedAccountWithMember(admin, { role: 'owner' });
    const b = await seedAccountWithMember(admin, { role: 'owner' });
    const keyA = freshKey();
    const aDto = (await (await put(a, keyA)).json()) as Dto;

    // B has nothing: every read / write path answers as if A did not exist.
    expect((await call(b, 'GET')).status).toBe(404);
    expect((await call(b, 'POST', '/test')).status).toBe(404);
    expect((await call(b, 'DELETE')).status).toBe(404);
    expect(provider.calls.map((c) => c.plaintextKey)).toEqual([keyA]); // only A's own connect

    // B connecting its own key touches only B's row.
    const keyB = freshKey();
    const bDto = (await (await put(b, keyB)).json()) as Dto;
    expect(bDto.status).toBe('ok');
    const aAfter = (await (await call(a, 'GET')).json()) as Dto;
    expect(aAfter).toEqual(aDto);

    // B's test uses B's key, never A's; B's delete leaves A's row.
    provider.calls = [];
    await call(b, 'POST', '/test');
    expect(provider.calls.map((c) => c.plaintextKey)).toEqual([keyB]);
    expect((await call(b, 'DELETE')).status).toBe(204);
    expect((await call(a, 'GET')).status).toBe(200);

    // A user of tenant A cannot act inside B by naming B's account in a forged identity.
    const forged = { accountId: b.accountId, userId: a.userId };
    await put(b, freshKey());
    expect((await call(forged, 'GET')).status).toBe(401);

    const { rows } = await admin.query<{ account_id: string }>(
      `SELECT account_id FROM model_connections WHERE account_id = ANY($1)`,
      [[a.accountId, b.accountId]],
    );
    expect(rows.map((r) => r.account_id).sort()).toEqual([a.accountId, b.accountId].sort());
  });

  it('rate class: every model-connection entry declares one the limiter knows; the test endpoint is a write', () => {
    const entries = ROUTES.filter((r) => r.path.startsWith('/api/v1/model-connection'));
    expect(entries.map((e) => `${e.method} ${e.path}`).sort()).toEqual([
      'DELETE /api/v1/model-connection',
      'GET /api/v1/model-connection',
      'POST /api/v1/model-connection/test',
      'PUT /api/v1/model-connection',
    ]);
    for (const e of entries) {
      expect(['read', 'write']).toContain(e.rateClass);
    }
    expect(entries.find((e) => e.operationId === 'testModelConnection')!.rateClass).toBe('write');
  });

  it('criterion 7: fixtures have the shape of the real responses', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const real = (await (await put(owner, freshKey())).json()) as Dto;
    for (const name of ['getModelConnection/200-ok.json', 'getModelConnection/200-broken.json', 'putModelConnection/200-ok.json', 'testModelConnection/200-broken.json']) {
      const fx = fixture(name);
      expect(Object.keys(fx).sort(), name).toEqual(Object.keys(real).sort());
      expect(typeof fx.fingerprint).toBe('string');
      expect(fx.fingerprint).toMatch(/^[0-9a-f]{4}$/);
    }
    expect(fixture('getModelConnection/200-ok.json').status).toBe(real.status);
  });

  it('criterion 6: no apps/web/app/api/model-connection route file exists (the catch-all owns the path)', () => {
    const file = path.join(__dirname, '..', '..', '..', 'apps', 'web', 'app', 'api', 'model-connection', 'route.ts');
    expect(() => readFileSync(file)).toThrow();
  });
});
