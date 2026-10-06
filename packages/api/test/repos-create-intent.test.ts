import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { descriptionHash, verifyCreateRepoState } from '@fx/core/src/github/createRepoState.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { githubRouteDeps } from '../src/routes/github.js';
import { seedAccountWithMember } from './helpers/seed.js';

const SECRET = 'create-repo-state-secret-'.padEnd(40, 'x');
const ENV = { GITHUB_INSTALL_STATE_SECRET: SECRET, GITHUB_APP_TEAM_CLIENT_ID: 'Iv1.teamclient', FX_GITHUB_CALLBACK_URL: 'https://app.example.test/api/auth/github/callback' };
const GOOD = { owner_gh_id: 500, name: 'widgets' };

interface Identity {
  accountId: string;
  userId: string;
}

/** D#2 RC-1b: POST /api/v1/repos/create-intent, through the real handler against real Postgres. */
describe('D#2 RC-1b: POST /api/v1/repos/create-intent', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let nextGh = 9_800_000;
  const saved = githubRouteDeps.getPlatformOpsPool;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    githubRouteDeps.getPlatformOpsPool = () => platformOpsPool;
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
  });
  afterAll(async () => {
    githubRouteDeps.getPlatformOpsPool = saved;
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await adminPool.end();
    await platformOpsPool.end();
    await appUserPool.end();
  });
  beforeEach(() => Object.assign(process.env, ENV));
  afterEach(() => {
    for (const k of Object.keys(ENV)) delete process.env[k];
  });

  async function seed(opts: { role?: 'owner' | 'admin' | 'member'; status?: 'active' | 'paused'; installed?: boolean } = {}): Promise<Identity> {
    const who = await seedAccountWithMember(admin, { role: opts.role ?? 'owner', status: opts.status });
    if (opts.installed !== false) {
      const gh = nextGh++;
      await admin.query(`INSERT INTO installations (account_id, gh_installation_id, app_kind) VALUES ($1, $2, 'team')`, [who.accountId, gh]);
      await admin.query(`INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id) VALUES ($1, 'team', 1)`, [gh]);
    }
    return who;
  }

  async function post(identity: Identity, body: unknown, bearer?: string): Promise<Response> {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (bearer) headers.set('authorization', `Bearer ${bearer}`);
    else headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(identity)}`);
    const req = new Request('http://localhost/api/v1/repos/create-intent', { method: 'POST', headers, body: JSON.stringify(body) });
    return handleApiRequest(req, appUserPool, platformOpsPool, ROUTES);
  }
  const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

  it('an owner or admin gets GitHub authorize URL carrying a state bound to them and to the exact request', async () => {
    for (const role of ['owner', 'admin'] as const) {
      const who = await seed({ role });
      const res = await post(who, { ...GOOD, description: '  Our widgets ', visibility: 'private', auto_init: false });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { authorize_url: string };
      expect(Object.keys(body)).toEqual(['authorize_url']);
      const url = new URL(body.authorize_url);
      expect([url.protocol, url.host, url.pathname]).toEqual(['https:', 'github.com', '/login/oauth/authorize']);
      expect(url.searchParams.get('client_id')).toBe('Iv1.teamclient');
      expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.test/api/github/create-repo/callback');
      expect(verifyCreateRepoState(url.searchParams.get('state')!, SECRET)).toMatchObject({
        account_id: who.accountId, user_id: who.userId, owner_gh_id: 500, name: 'widgets', visibility: 'private',
        description: 'Our widgets', description_sha256: descriptionHash('Our widgets'), auto_init: false,
      });
      expect(JSON.stringify([...res.headers.entries()])).not.toContain(SECRET);
    }
  });

  it('defaults to private with a README, and never puts the secret in the URL', async () => {
    const who = await seed();
    const url = new URL(((await (await post(who, GOOD)).json()) as { authorize_url: string }).authorize_url);
    expect(verifyCreateRepoState(url.searchParams.get('state')!, SECRET)).toMatchObject({ visibility: 'private', auto_init: true, description_sha256: descriptionHash(null) });
    expect(url.href).not.toContain(SECRET);
  });

  it('a member is 403 insufficient_role and a token is 403 session_required, each with no state minted', async () => {
    const owner = await seed();
    const member = await seedAccountWithMember(admin, { role: 'member' });
    const memberRes = await post(member, GOOD);
    expect(memberRes.status).toBe(403);
    expect(await code(memberRes)).toBe('insufficient_role');

    const plaintext = generateToken();
    await insertApiToken(appUserPool, {
      accountId: owner.accountId, createdBy: owner.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test',
      scopes: ['read'], expiresAt: new Date(Date.now() + 86_400_000),
    });
    const tokenRes = await post(owner, GOOD, plaintext);
    expect(tokenRes.status).toBe(403);
    const text = await tokenRes.text();
    expect(JSON.parse(text).error.code).toBe('session_required');
    expect(text).not.toContain('authorize');
  });

  it.each([
    ['name', { ...GOOD, name: '..' }],
    ['name', { ...GOOD, name: 'x.GIT' }],
    ['visibility', { ...GOOD, visibility: 'internal' }],
    ['description', { ...GOOD, description: 'x'.repeat(351) }],
    ['auto_init', { ...GOOD, auto_init: 'yes' }],
  ])('a bad %s is 422 naming the field, before any quota is read', async (path, body) => {
    const who = await seed();
    const res = await post(who, body);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { details: unknown }).details).toEqual([{ path, code: 'invalid' }]);
  });

  it.each([{ name: 'widgets' }, { owner_gh_id: 500 }, { ...GOOD, owner_gh_id: 0 }, { ...GOOD, extra: 1 }])('a missing, non-positive or unknown field is 422: %j', async (body) => {
    expect((await post(await seed(), body)).status).toBe(422);
  });

  it('no recorded active team installation is 409 install_first; a paused account is 409 account_not_active', async () => {
    const none = await post(await seed({ installed: false }), GOOD);
    expect(none.status).toBe(409);
    expect(await code(none)).toBe('install_first');
    const gone = await seed();
    await admin.query(`UPDATE installation_installers SET deleted_at = now() WHERE gh_installation_id IN (SELECT gh_installation_id FROM installations WHERE account_id = $1)`, [gone.accountId]);
    expect(await code(await post(gone, GOOD))).toBe('install_first');
    const paused = await post(await seed({ status: 'paused' }), GOOD);
    expect(paused.status).toBe(409);
    expect(await code(paused)).toBe('account_not_active');
  });

  it('the 11th creation in an hour, or the 51st in a day, is 429 rate_limited with Retry-After', async () => {
    const hourly = await seed();
    for (let i = 0; i < 10; i++) await admin.query(`SELECT audit_write_system($1, 'github_install', 'github.repo_create_reserved', '{"nonce":"n"}'::jsonb)`, [hourly.accountId]);
    const res = await post(hourly, GOOD);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('3600');
    expect(await code(res)).toBe('rate_limited');

    const daily = await seed();
    for (let i = 0; i < 50; i++) await admin.query(`SELECT audit_write_system($1, 'github_install', 'github.repo_create_reserved', '{"nonce":"n"}'::jsonb)`, [daily.accountId]);
    await admin.query(`UPDATE audit_log SET created_at = now() - interval '2 hours' WHERE account_id = $1`, [daily.accountId]);
    expect((await post(daily, GOOD)).headers.get('retry-after')).toBe('86400');
  });

  it('an unset or short secret, an unset client id or a missing callback origin is 503 and mints nothing', async () => {
    const who = await seed();
    for (const [k, v] of [['GITHUB_INSTALL_STATE_SECRET', 'x'.repeat(31)], ['GITHUB_APP_TEAM_CLIENT_ID', undefined], ['FX_GITHUB_CALLBACK_URL', 'not a url']] as const) {
      const good = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
      const res = await post(who, GOOD);
      expect(res.status).toBe(503);
      expect(await res.text()).not.toContain('github.com');
      process.env[k] = good;
    }
  });

  it('two tenants: a session for one account cannot start a creation on another', async () => {
    const a = await seed();
    const b = await seed();
    const cross = await post({ accountId: b.accountId, userId: a.userId }, GOOD);
    expect(cross.status).toBeGreaterThanOrEqual(400);
    expect(await cross.text()).not.toContain('authorize');
  });
});
