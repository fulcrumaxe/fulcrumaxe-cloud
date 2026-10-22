import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { createSealedVercelCredentials, createVercelTokenValidator, type KekSource } from '@fx/model-connection';
import { setPendingHooks } from '@fx/core/src/pendingWork.js';
import { runSetupRequestCheck } from '@fx/core/src/setup-requests/checks.js';
import { createVercelEnvSource } from '@fx/core/src/setup-requests/vercelEnvSource.js';
import { createVercelNamesReader } from '@fx/core/src/setup-requests/vercelNames.js';
import { applyCheckOutcome, proposeSetupRequest } from '@fx/core/src/setup-requests/store.js';
import { FakeVercel } from '../../core/test/support/vercelEnvFake.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { vercelConnectionDeps, vercelConnectionDetailsSchema } from '../src/routes/vercel-connection.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

const BASE = 'http://localhost/api/v1/vercel-connection';
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'v1', 'getVercelConnectionDetails');
const TEAM = 'team_p8d3a1';

interface Identity {
  accountId: string;
  userId: string;
}
interface Details {
  state: string;
  names: { status: string; team_name?: string | null; projects?: string[]; truncated?: boolean } | null;
  check: { result: string; reason: string | null; sentence: string; project: string; ran_at: string } | null;
}

/** D#598 P8d-3a: the connection screen's read side, through the real dispatcher against real Postgres; the only fake is the strict Vercel stand-in. */
describe('D#598 P8d-3a: GET /api/v1/vercel-connection/details', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let vercel: FakeVercel;
  let kekSource: KekSource;
  let logged: string[];
  const repos = new Map<string, string>();

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
    setPendingHooks({ store: { get: async () => null, set: async () => undefined, delete: async () => undefined } });
    vercelConnectionDeps.getValidator = () => createVercelTokenValidator({ fetch: vercel.fetchImpl() });
    const credentials = createSealedVercelCredentials({ pool: appUserPool, kek: kekSource, log: () => undefined });
    vercelConnectionDeps.getNames = () => createVercelNamesReader({ credentials, fetch: vercel.fetchImpl(), log: () => undefined });
    logged = [];
    const capture = (chunk: unknown): boolean => {
      logged.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, 'write').mockImplementation(capture as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(capture as never);
  });
  afterEach(() => {
    setPendingHooks(null);
    vi.restoreAllMocks();
    vercelConnectionDeps.getValidator = () => null;
    vercelConnectionDeps.getNames = () => null;
  });

  async function request(identity: Identity, method: string, suffix: string, body?: unknown): Promise<Response> {
    await admin.query("DELETE FROM rate_limit_windows WHERE bucket_key LIKE 'session%'");
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(identity)}` });
    if (body !== undefined) headers.set('content-type', 'application/json');
    return handleApiRequest(new Request(`${BASE}${suffix}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), appUserPool, platformOpsPool, ROUTES);
  }
  async function details(identity: Identity): Promise<Details> {
    const res = await request(identity, 'GET', '/details');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Details;
    expect(vercelConnectionDetailsSchema.safeParse(body).success).toBe(true);
    return body;
  }
  const connect = async (who: Identity, opts: { teamId?: string } = {}): Promise<string> => {
    const token = vercel.connect(who.accountId, opts).tokenOf(who.accountId);
    expect((await request(who, 'POST', '', { token, ...(opts.teamId !== undefined ? { team_id: opts.teamId } : {}) })).status).toBe(201);
    return token;
  };
  async function member(accountId: string, role: 'admin' | 'member'): Promise<Identity> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, userId, role]);
    return { accountId, userId };
  }
  /** One env-var request, checked for real: the real adapter against the stand-in, the result written the way the sweep writes it. */
  async function runCheck(who: Identity, envName: string, opts: { markRejected?: boolean } = {}): Promise<void> {
    if (!repos.has(who.accountId)) repos.set(who.accountId, (await admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, NULL, $2, 'web') RETURNING id`, [who.accountId, Math.floor(Math.random() * 1e9)])).rows[0]!.id);
    const repoId = repos.get(who.accountId)!;
    const sealed = createSealedVercelCredentials({ pool: appUserPool, kek: kekSource, log: () => undefined });
    const credentials = opts.markRejected === false ? { configured: true, resolve: sealed.resolve } : sealed;
    const source = createVercelEnvSource({ credentials, fetch: vercel.fetchImpl(), log: () => undefined });
    const row = await withTenant(appUserPool, who.accountId, who.userId, (c) =>
      proposeSetupRequest(c, { userId: who.userId, repoId, kind: 'env_var', target: 'web-app', envName, reason: 'needed', check: 'env_var_present' }),
    );
    const outcome = (await runSetupRequestCheck(source, who.accountId, row))!;
    await withTenant(appUserPool, who.accountId, who.userId, (c) => applyCheckOutcome(c, { id: row.id, outcome }));
  }
  const pretty = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
  function pin(name: string, actual: Details): void {
    const file = path.join(FIXTURES, `200-${name}.json`);
    const stable = { ...actual, check: actual.check && { ...actual.check, ran_at: '2026-10-22T10:15:30.000Z' } };
    if (process.env.FX_WRITE_FIXTURES === '1') {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, pretty(stable));
    }
    expect(existsSync(file), `${file} is missing: run with FX_WRITE_FIXTURES=1 and read the diff`).toBe(true);
    expect(pretty(stable)).toBe(readFileSync(file, 'utf8'));
  }
  const noLeak = (who: Identity, token: string, body: unknown): void => {
    const text = JSON.stringify(body) + logged.join('\n');
    expect(text).not.toContain(token);
    expect(text).not.toMatch(/prj_|user_fake/);
    expect(text).not.toContain(TEAM);
    expect(who.accountId.length).toBeGreaterThan(0);
  };

  it('not connected: no names, no check', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const body = await details(owner);
    expect(body).toEqual({ state: 'not_connected', names: null, check: null });
    pin('not-connected', body);
  });

  it('a team token: the team name and the project names (not ids), and no check yet', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    vercel.team(TEAM, 'Acme Studio').project('web-app', [], { teamId: TEAM }).project('api', [], { teamId: TEAM }).project('not-ours');
    const token = await connect(owner, { teamId: TEAM });
    const body = await details(owner);
    expect(body).toEqual({ state: 'connected', names: { status: 'ok', team_name: 'Acme Studio', projects: ['api', 'web-app'], truncated: false }, check: null });
    pin('connected-team', body);
    noLeak(owner, token, body);
  });

  it('a personal token has no team name; a plain member can read it', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    vercel.project('solo');
    await connect(owner);
    const plain = await member(owner.accountId, 'member');
    expect(await details(plain)).toEqual({ state: 'connected', names: { status: 'ok', team_name: null, projects: ['solo'], truncated: false }, check: null });
  });

  it('the latest check is reported with a sentence naming the project: set, not set yet', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    vercel.project('web-app', [{ key: 'DATABASE_URL', value: 'postgres://secret', target: ['production'] }]);
    await connect(owner);
    await runCheck(owner, 'DATABASE_URL');
    const passed = await details(owner);
    expect(passed.check).toMatchObject({ result: 'read', reason: null, sentence: 'DATABASE_URL is set on web-app.', project: 'web-app' });
    pin('check-passed', passed);
    await runCheck(owner, 'STRIPE_KEY');
    const notYet = await details(owner);
    expect(notYet.state).toBe('connected');
    expect(notYet.check).toMatchObject({ result: 'read', reason: 'env_var_missing', sentence: "STRIPE_KEY isn't set on web-app yet." });
  });

  it('the token cannot read the project: connected, and the check names which', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    vercel.project('web-app');
    await connect(owner);
    vercel.failNext('http_403');
    await runCheck(owner, 'DATABASE_URL');
    const body = await details(owner);
    expect(body.state).toBe('connected');
    // a valid token that cannot see one project is not a revoked token: the connection is not marked, and the next check still uses it
    expect((await admin.query<{ status: string }>(`SELECT status FROM vercel_connections WHERE account_id = $1`, [owner.accountId])).rows[0]!.status).toBe('ok');
    expect(body.check).toMatchObject({ result: 'cannot_read', reason: 'token_cannot_read', sentence: 'The connected Vercel token cannot read web-app.' });
    pin('check-cannot-read', body);
  });

  it('revoked or expired is DERIVED from the latest check: it holds with no stored stamp, and replacing the token clears it with no write', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    vercel.project('web-app');
    const token = await connect(owner);
    vercel.revoke(vercel.accountOfToken(token)!);
    await runCheck(owner, 'DATABASE_URL', { markRejected: false });
    expect((await admin.query<{ status: string }>(`SELECT status FROM vercel_connections WHERE account_id = $1`, [owner.accountId])).rows[0]!.status).toBe('ok'); // no stamp
    const revoked = await details(owner);
    expect(revoked).toMatchObject({ state: 'revoked_or_expired', names: { status: 'unavailable' }, check: { result: 'token_rejected', reason: 'token_rejected' } });
    pin('revoked-from-check', revoked);
    noLeak(owner, token, revoked);
  });

  it('a revoked token, answered the way the live API does (403 with invalidToken): the connection ends rejected and the details read revoked_or_expired; no further check sends it', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    vercel.project('web-app');
    const token = await connect(owner);
    vercel.revoke(vercel.accountOfToken(token)!);
    await runCheck(owner, 'DATABASE_URL');
    expect((await admin.query<{ status: string }>(`SELECT status FROM vercel_connections WHERE account_id = $1`, [owner.accountId])).rows[0]!.status).toBe('rejected');
    const body = await details(owner);
    expect(body).toMatchObject({ state: 'revoked_or_expired', names: { status: 'unavailable' }, check: { result: 'token_rejected' } });
    const sent = vercel.calls.length;
    await runCheck(owner, 'OTHER_VAR');
    expect(vercel.calls.length).toBe(sent); // the stored token is no longer opened or sent
  });

  it('a check that started on the old token and is refused after a rotation does not mark the new token or read as revoked', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    vercel.project('web-app');
    const token = await connect(owner);
    vercel.revoke(vercel.accountOfToken(token)!);
    const sealed = createSealedVercelCredentials({ pool: appUserPool, kek: kekSource, log: () => undefined });
    const stale = await sealed.resolve(owner.accountId);
    expect(stale.status).toBe('ok');
    const other = randomUUID();
    expect((await request(owner, 'PUT', '', { token: vercel.connect(other).tokenOf(other) })).status).toBe(200);
    // the old token's refusal arrives now, naming the OLD credential
    expect(await sealed.markRejected!(owner.accountId, stale.status === 'ok' ? stale.ref : undefined)).toBe(false);
    expect((await admin.query<{ status: string }>(`SELECT status FROM vercel_connections WHERE account_id = $1`, [owner.accountId])).rows[0]!.status).toBe('ok');
    expect((await details(owner)).state).toBe('connected');
  });

  it('rotating after a revoked check: the old check says nothing about the new token, so it reads connected with names again', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    vercel.project('web-app');
    const token = await connect(owner);
    vercel.revoke(vercel.accountOfToken(token)!);
    await runCheck(owner, 'DATABASE_URL');
    expect((await details(owner)).state).toBe('revoked_or_expired');
    const other = randomUUID();
    const replacement = vercel.connect(other).tokenOf(other);
    vercel.project('after-rotate');
    expect((await request(owner, 'PUT', '', { token: replacement })).status).toBe(200);
    const body = await details(owner);
    expect(body.state).toBe('connected');
    expect(body.check).toBeNull();
    expect(body.names).toMatchObject({ status: 'ok' });
  });

  it('Vercel failing or slow on the names read is "names unavailable", never an error and never ids; the status route is unaffected', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    vercel.project('web-app');
    const token = await connect(owner);
    vercel.failNext('http_429');
    const body = await details(owner);
    expect(body).toEqual({ state: 'connected', names: { status: 'unavailable' }, check: null });
    pin('names-unavailable', body);
    noLeak(owner, token, body);
    expect((await request(owner, 'GET', '')).status).toBe(200);
    vercelConnectionDeps.getNames = () => null; // not wired on this deployment
    expect((await details(owner)).names).toEqual({ status: 'unavailable' });
  });

  it('disconnect removes everything the screen shows; reconnecting with another team shows the new names', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    vercel.team(TEAM, 'First Team').project('first', [], { teamId: TEAM });
    await connect(owner, { teamId: TEAM });
    expect((await details(owner)).names).toMatchObject({ team_name: 'First Team', projects: ['first'] });
    expect((await request(owner, 'DELETE', '')).status).toBe(204);
    expect(await details(owner)).toEqual({ state: 'not_connected', names: null, check: null });
    vercel.team('team_second1', 'Second Team').project('second', [], { teamId: 'team_second1' });
    await connect(owner, { teamId: 'team_second1' });
    expect((await details(owner)).names).toMatchObject({ team_name: 'Second Team', projects: ['second'] });
  });

  it('is session-only and tenant-scoped: an API token is refused, and another account never sees these names', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const stranger = await seedAccountWithMember(admin, { role: 'owner' });
    vercel.project('private-project');
    await connect(owner);
    const plaintext = generateToken();
    await insertApiToken(appUserPool, { accountId: owner.accountId, createdBy: owner.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes: ['read'], expiresAt: new Date(Date.now() + 86_400_000) });
    const viaToken = await handleApiRequest(new Request(`${BASE}/details`, { headers: { authorization: `Bearer ${plaintext}` } }), appUserPool, platformOpsPool, ROUTES);
    expect(viaToken.status).toBe(403);
    expect(((await viaToken.json()) as { error: { code: string } }).error.code).toBe('session_required');
    expect(await details(stranger)).toEqual({ state: 'not_connected', names: null, check: null });
  });
});
