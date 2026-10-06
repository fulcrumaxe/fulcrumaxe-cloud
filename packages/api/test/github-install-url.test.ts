import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { mintInstallState, verifyInstallState } from '../src/github/installUrl.js';
import { seedAccountWithMember } from './helpers/seed.js';

const SECRET = 'install-state-secret-'.padEnd(40, 'x');
const SLUGS = { team: 'fx-team', team_readonly: 'fx-team-ro', sitekit: 'fx-sitekit' } as const;
const ENV_NAMES = [
  'GITHUB_APP_TEAM_SLUG',
  'GITHUB_APP_TEAM_READONLY_SLUG',
  'GITHUB_APP_SITEKIT_SLUG',
  'GITHUB_INSTALL_STATE_SECRET',
] as const;

interface Identity {
  accountId: string;
  userId: string;
}

/** D#31 API-8c: GET /api/v1/github/install-url, through the real handler against real Postgres. */
describe('D#31 API-8c: GitHub App install URL', () => {
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

  beforeEach(() => {
    process.env.GITHUB_APP_TEAM_SLUG = SLUGS.team;
    process.env.GITHUB_APP_TEAM_READONLY_SLUG = SLUGS.team_readonly;
    process.env.GITHUB_APP_SITEKIT_SLUG = SLUGS.sitekit;
    process.env.GITHUB_INSTALL_STATE_SECRET = SECRET;
  });

  afterEach(() => {
    for (const name of ENV_NAMES) delete process.env[name];
  });

  async function get(identity: Identity, query: string, bearer?: string): Promise<Response> {
    const headers = new Headers();
    if (bearer) headers.set('authorization', `Bearer ${bearer}`);
    else headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(identity)}`);
    const req = new Request(`http://localhost/api/v1/github/install-url${query}`, { method: 'GET', headers });
    // These tests check the route's behaviour, not its session cap (session-ratelimit.test.ts does), so every call starts with empty session buckets.
    await admin.query("DELETE FROM rate_limit_windows WHERE bucket_key LIKE 'session%'");
    return handleApiRequest(req, appUserPool, platformOpsPool, ROUTES);
  }

  async function mint(identity: Identity, kind: string): Promise<URL> {
    const res = await get(identity, `?app_kind=${kind}`);
    expect(res.status).toBe(200);
    return new URL(((await res.json()) as { url: string }).url);
  }

  async function addMember(accountId: string, role: 'admin' | 'member'): Promise<Identity> {
    const userId = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, userId, role]);
    return { accountId, userId };
  }

  it('criterion 1: an owner or admin gets only {url} on github.com, no-store, with no secret material', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const admin2 = await addMember(owner.accountId, 'admin');
    for (const who of [owner, admin2]) {
      const res = await get(who, '?app_kind=team_readonly');
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toContain('no-store');
      const text = await res.text();
      const body = JSON.parse(text) as Record<string, string>;
      expect(Object.keys(body)).toEqual(['url']);
      const url = new URL(body.url!);
      expect(url.protocol).toBe('https:');
      expect(url.host).toBe('github.com');
      expect(url.pathname).toBe(`/apps/${SLUGS.team_readonly}/installations/new`);
      const headerText = JSON.stringify([...res.headers.entries()]);
      for (const needle of ['ghs_', 'BEGIN', SECRET]) {
        expect(text).not.toContain(needle);
        expect(headerText).not.toContain(needle);
      }
    }
  });

  it('criterion 2: app_kind missing, empty or unknown is 422 with no url', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    for (const query of ['', '?app_kind=', '?app_kind=Team', '?app_kind=x']) {
      const res = await get(owner, query);
      expect(res.status).toBe(422);
      const body = (await res.json()) as { url?: string; details: { path: string; code: string }[] };
      expect(body.url).toBeUndefined();
      expect(body.details).toEqual([{ path: 'app_kind', code: 'invalid' }]);
    }
  });

  it('criterion 3: a member is 403 insufficient_role and a token is 403 session_required', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const member = await addMember(owner.accountId, 'member');
    const memberRes = await get(member, '?app_kind=team');
    expect(memberRes.status).toBe(403);
    expect(((await memberRes.json()) as { error: { code: string } }).error.code).toBe('insufficient_role');

    const plaintext = generateToken();
    await insertApiToken(appUserPool, {
      accountId: owner.accountId,
      createdBy: owner.userId,
      tokenHash: hashToken(plaintext),
      displayHint: 'fxat_...test',
      scopes: ['read'],
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const tokenRes = await get(owner, '?app_kind=team', plaintext);
    expect(tokenRes.status).toBe(403);
    expect(((await tokenRes.json()) as { error: { code: string } }).error.code).toBe('session_required');
  });

  it('criterion 4: each kind uses its own slug, and an unset slug never falls back to another kind', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const paths = await Promise.all((['team', 'team_readonly', 'sitekit'] as const).map(async (k) => (await mint(owner, k)).pathname));
    expect(paths).toEqual([
      `/apps/${SLUGS.team}/installations/new`,
      `/apps/${SLUGS.team_readonly}/installations/new`,
      `/apps/${SLUGS.sitekit}/installations/new`,
    ]);

    const slugEnv = { team: 'GITHUB_APP_TEAM_SLUG', team_readonly: 'GITHUB_APP_TEAM_READONLY_SLUG', sitekit: 'GITHUB_APP_SITEKIT_SLUG' } as const;
    for (const kind of ['team', 'team_readonly', 'sitekit'] as const) {
      const saved = process.env[slugEnv[kind]];
      delete process.env[slugEnv[kind]];
      const res = await get(owner, `?app_kind=${kind}`);
      expect(res.status).toBe(503);
      expect(await res.text()).not.toContain('github.com');
      process.env[slugEnv[kind]] = saved;
    }
  });

  it('criterion 5: a bad slug or secret is 503 github_app_not_configured, and one bad kind leaves the others working', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    for (const bad of ['', 'Has-Upper', 'has space', 'a/b', 'x'.repeat(65), 'a?b=c']) {
      process.env.GITHUB_APP_TEAM_SLUG = bad;
      const res = await get(owner, '?app_kind=team');
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('github_app_not_configured');
      expect((await mint(owner, 'team_readonly')).pathname).toBe(`/apps/${SLUGS.team_readonly}/installations/new`);
      expect((await mint(owner, 'sitekit')).pathname).toBe(`/apps/${SLUGS.sitekit}/installations/new`);
    }
    process.env.GITHUB_APP_TEAM_SLUG = SLUGS.team;
    for (const badSecret of [undefined, '', 'x'.repeat(31)]) {
      if (badSecret === undefined) delete process.env.GITHUB_INSTALL_STATE_SECRET;
      else process.env.GITHUB_INSTALL_STATE_SECRET = badSecret;
      const res = await get(owner, '?app_kind=team');
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(text).toContain('github_app_not_configured');
      expect(text).not.toContain('github.com');
    }
  });

  it('criterion 6: state differs per call, verifies, and fails when tampered, expired or checked for another kind', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const s1 = (await mint(owner, 'team')).searchParams.get('state')!;
    const s2 = (await mint(owner, 'team')).searchParams.get('state')!;
    expect(s1).not.toBe(s2);

    const claims = verifyInstallState(s1, SECRET, 'team');
    expect(claims).toMatchObject({ account_id: owner.accountId, user_id: owner.userId, app_kind: 'team' });

    const [payload, mac] = s1.split('.') as [string, string];
    const forge = (patch: Record<string, unknown>): string => {
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
      return `${Buffer.from(JSON.stringify({ ...parsed, ...patch })).toString('base64url')}.${mac}`;
    };
    expect(verifyInstallState(forge({ account_id: randomUUID() }), SECRET, 'team')).toBeNull();
    expect(verifyInstallState(forge({ user_id: randomUUID() }), SECRET, 'team')).toBeNull();
    expect(verifyInstallState(forge({ app_kind: 'sitekit' }), SECRET, 'sitekit')).toBeNull();
    expect(verifyInstallState(s1, SECRET, 'team_readonly')).toBeNull();
    expect(verifyInstallState(s1, 'another-secret-'.padEnd(40, 'y'), 'team')).toBeNull();
    expect(verifyInstallState(`${payload}.`, SECRET, 'team')).toBeNull();
    expect(verifyInstallState('garbage', SECRET, 'team')).toBeNull();

    const past = new Date(Date.now() - 11 * 60 * 1000);
    const expired = mintInstallState({ accountId: owner.accountId, userId: owner.userId, appKind: 'team' }, SECRET, past);
    expect(verifyInstallState(expired, SECRET, 'team')).toBeNull();
    const fresh = mintInstallState({ accountId: owner.accountId, userId: owner.userId, appKind: 'team' }, SECRET, new Date(Date.now() - 9 * 60 * 1000));
    expect(verifyInstallState(fresh, SECRET, 'team')).not.toBeNull();
  });

  it('two tenants: each state carries its own caller, and one account cannot mint for another', async () => {
    const a = await seedAccountWithMember(admin, { role: 'owner' });
    const b = await seedAccountWithMember(admin, { role: 'owner' });
    const ca = verifyInstallState((await mint(a, 'team')).searchParams.get('state')!, SECRET, 'team');
    const cb = verifyInstallState((await mint(b, 'team')).searchParams.get('state')!, SECRET, 'team');
    expect(ca).toMatchObject({ account_id: a.accountId, user_id: a.userId });
    expect(cb).toMatchObject({ account_id: b.accountId, user_id: b.userId });
    // A session for A's user on B's account is not a member there: refused, no url.
    const cross = await get({ accountId: b.accountId, userId: a.userId }, '?app_kind=team');
    expect(cross.status).toBeGreaterThanOrEqual(400);
    expect(await cross.text()).not.toContain('github.com');
  });

  it('criterion 8: a repo linked to a team_readonly installation lists as installed with that kind', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO installations (account_id, gh_installation_id, app_kind) VALUES ($1, $2, 'team_readonly') RETURNING id`,
      [owner.accountId, Math.floor(Math.random() * 1e9)],
    );
    await admin.query(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, 'web')`, [
      owner.accountId,
      rows[0]!.id,
      Math.floor(Math.random() * 1e9),
    ]);
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(owner)}` });
    const res = await handleApiRequest(new Request('http://localhost/api/v1/repos', { headers }), appUserPool, platformOpsPool, ROUTES);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data).toMatchObject([{ install_state: 'installed', app_kind: 'team_readonly' }]);
  });
});
