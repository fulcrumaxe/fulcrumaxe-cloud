import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { verifyCreateRepoState } from '@fx/core/src/github/createRepoState.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { githubRouteDeps } from '../src/routes/github.js';
import { repoPairingDeps, type PairingRepoInspector } from '../src/routes/repoPairing.js';
import { twinRouteDeps } from '../src/routes/repoTwins.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}
type Facts = Awaited<ReturnType<PairingRepoInspector['inspect']>>;
const PUBLIC: Facts = { visibility: 'public', defaultBranch: 'main', appInstalled: true, ownerGhId: 4242 };
const SECRET = 'state-secret-state-secret-state-secret!!';

/**
 * D#845 ON-27a through the real `handleApiRequest` against real Postgres: the create's intent, the read, pause/resume/stop, the kill switch, tenant scoping
 * and the pairing exclusion. GitHub is the recorded `inspect` fake below; no request ever leaves the process.
 */
describe('repo twins API', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  const asked: string[] = [];
  let world: Facts | 'down' = PUBLIC;
  const fake: PairingRepoInspector = {
    async inspect(name) {
      asked.push(name);
      if (world === 'down') throw Object.assign(new Error('boom'), { name: 'PublicRepoInspectError', code: 'github_unavailable' });
      return world;
    },
  };
  const env = { GITHUB_INSTALL_STATE_SECRET: SECRET, GITHUB_APP_TEAM_CLIENT_ID: 'cid', FX_GITHUB_CALLBACK_URL: 'https://cloud.example.test/api/github/callback', FX_SESSION_SECRET: 's'.repeat(32) };
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    for (const [k, v] of Object.entries(env)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    repoPairingDeps.getInspector = () => fake;
    githubRouteDeps.getPlatformOpsPool = () => platformOpsPool;
    twinRouteDeps.enabled = true;
  });
  afterEach(() => {
    world = PUBLIC;
    asked.length = 0;
    twinRouteDeps.enabled = true;
  });
  afterAll(async () => {
    repoPairingDeps.getInspector = () => null;
    twinRouteDeps.enabled = false;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    admin.release();
    await adminPool.end();
    await platformOpsPool.end();
    await appUserPool.end();
  });

  async function call(identity: Identity, method: string, urlPath: string, body?: unknown): Promise<Response> {
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(identity)}` });
    if (body !== undefined) headers.set('content-type', 'application/json');
    return handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), appUserPool, platformOpsPool, ROUTES);
  }
  async function addMember(accountId: string, role: 'admin' | 'member'): Promise<Identity> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [accountId, userId, role]);
    return { accountId, userId };
  }
  /** An account with an owner, an installed team App (the create's quota and install gate read it) and a synced repo. */
  async function account() {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const gh = Math.floor(Math.random() * 1e9) + 1e10;
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team')`, [randomUUID(), owner.accountId, gh]);
    await admin.query(`INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id) VALUES ($1, 'team', 1)`, [gh]);
    return owner;
  }
  async function seedRepo(accountId: string, name = 'widgets'): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO repos (account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, 'web', 'acme', $3) RETURNING id`,
      [accountId, Math.floor(Math.random() * 1e9), name],
    );
    return rows[0]!.id;
  }
  const stateOf = async (id: string) => (await admin.query<{ state: string }>('SELECT state FROM repo_twins WHERE id = $1', [id])).rows[0]?.state;
  const authorize = async (res: Response) => {
    const { authorize_url } = (await res.json()) as { authorize_url: string };
    const url = new URL(authorize_url);
    return { url, claims: verifyCreateRepoState(url.searchParams.get('state')!, SECRET) };
  };
  /** Creates the twin through a real create: the callback's own function (`twin_record`) under the person's session, as `createCustomerRepo` calls it. */
  const makeTwin = async (who: Identity, pub: string, priv: string | null = null): Promise<string> => {
    const c = await appUserPool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)", [who.accountId, who.userId]);
      const { rows } = await c.query<{ o_id: string }>('SELECT o_id FROM twin_record($1, $2, 55, $3)', [pub, priv, 'widgets-private']);
      await c.query('COMMIT');
      return rows[0]!.o_id;
    } finally {
      c.release();
    }
  };

  it('is off until ON-27d: every twin route answers 503 not_configured and writes nothing', async () => {
    twinRouteDeps.enabled = false;
    const owner = await account();
    const repo = await seedRepo(owner.accountId);
    for (const [method, path, body] of [['POST', `/repos/${repo}/twin`, {}], ['GET', `/repos/${repo}/twin`, undefined], ['POST', `/twins/${randomUUID()}/pause`, undefined], ['DELETE', `/twins/${randomUUID()}`, undefined]] as const) {
      const res = await call(owner, method, path, body);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_configured');
    }
    expect(asked).toEqual([]);
  });

  it('the create asks for a state naming the public repo, its owner, private, no auto-init and Discussions only by the twin purpose', async () => {
    const owner = await account();
    const repo = await seedRepo(owner.accountId);
    const res = await call(owner, 'POST', `/repos/${repo}/twin`, {});
    expect(res.status).toBe(200);
    const { url, claims } = await authorize(res);
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('redirect_uri')).toBe('https://cloud.example.test/api/github/create-repo/callback');
    expect(claims).toMatchObject({ account_id: owner.accountId, user_id: owner.userId, owner_gh_id: 4242, name: 'widgets-private', visibility: 'private', auto_init: false, purpose: 'twin', twin_of: repo });
    expect(asked).toEqual(['acme/widgets']);
    const named = await authorize(await call(owner, 'POST', `/repos/${repo}/twin`, { name: 'my.twin_1' }));
    expect(named.claims?.name).toBe('my.twin_1');
    // Nothing is recorded by the intent itself.
    expect((await admin.query('SELECT 1 FROM repo_twins WHERE account_id = $1', [owner.accountId])).rows).toHaveLength(0);
  });

  it('refuses a bad name with 422 before GitHub is asked, and a repo that is not public with the same answer for every non-public case', async () => {
    const owner = await account();
    const repo = await seedRepo(owner.accountId);
    for (const name of ['', 'a b', '../x', '.', 'x'.repeat(101), 'acme/x']) {
      const res = await call(owner, 'POST', `/repos/${repo}/twin`, { name });
      expect(res.status).toBe(422);
    }
    expect((await call(owner, 'POST', `/repos/${repo}/twin`, { name: 'ok', extra: 1 })).status).toBe(422);
    expect(asked).toEqual([]);
    world = { visibility: 'not_public', defaultBranch: null, appInstalled: false, ownerGhId: null };
    const res = await call(owner, 'POST', `/repos/${repo}/twin`, {});
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('twin_repo_not_public');
    world = 'down';
    expect((await call(owner, 'POST', `/repos/${repo}/twin`, {})).status).toBe(503);
    world = { ...PUBLIC, ownerGhId: null };
    expect((await call(owner, 'POST', `/repos/${repo}/twin`, {})).status).toBe(503);
  });

  it('only an owner or admin creates; a member is refused, a stranger sees a 404, and neither reaches GitHub', async () => {
    const owner = await account();
    const other = await account();
    const repo = await seedRepo(owner.accountId);
    const member = await addMember(owner.accountId, 'member');
    expect((await call(member, 'POST', `/repos/${repo}/twin`, {})).status).toBe(403);
    expect((await call(other, 'POST', `/repos/${repo}/twin`, {})).status).toBe(404);
    expect((await call(other, 'GET', `/repos/${repo}/twin`)).status).toBe(404);
    expect(asked).toEqual([]);
    const admin2 = await addMember(owner.accountId, 'admin');
    expect((await call(admin2, 'POST', `/repos/${repo}/twin`, {})).status).toBe(200);
  });

  it('refuses a repo that already has a twin or a pairing, 409, before GitHub is asked', async () => {
    const owner = await account();
    const repo = await seedRepo(owner.accountId);
    const paired = await seedRepo(owner.accountId, 'paired');
    await admin.query(`INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, 'acme/x', ARRAY['p/**'])`, [paired, owner.accountId]);
    const res = await call(owner, 'POST', `/repos/${paired}/twin`, {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('pairing_exists');
    await makeTwin(owner, repo);
    const dup = await call(owner, 'POST', `/repos/${repo}/twin`, {});
    expect(dup.status).toBe(409);
    expect(((await dup.json()) as { error: { code: string } }).error.code).toBe('twin_exists');
    expect(asked).toEqual([]);
  });

  it('reads the live twin as the card needs it, and a removed twin reads as none', async () => {
    const owner = await account();
    const repo = await seedRepo(owner.accountId);
    expect(await (await call(owner, 'GET', `/repos/${repo}/twin`)).json()).toEqual({ twin: null });
    const id = await makeTwin(owner, repo);
    const got = (await (await call(await addMember(owner.accountId, 'member'), 'GET', `/repos/${repo}/twin`)).json()) as { twin: Record<string, unknown> };
    expect(got.twin).toMatchObject({ id, public_repo_id: repo, private_repo_id: null, private_name: 'widgets-private', state: 'not_connected', overlay_globs: [], publish_pr: null, sync_pr: null, failure_code: null });
    await call(owner, 'DELETE', `/twins/${id}`);
    expect(await (await call(owner, 'GET', `/repos/${repo}/twin`)).json()).toEqual({ twin: null });
  });

  it('pause, resume and stop publishing: owner or admin only, each audited, a wrong state is a 409 that changes nothing', async () => {
    const owner = await account();
    const repo = await seedRepo(owner.accountId);
    const priv = await seedRepo(owner.accountId, 'widgets-private');
    const id = await makeTwin(owner, repo, priv);
    const member = await addMember(owner.accountId, 'member');
    for (const [method, path] of [['POST', `/twins/${id}/pause`], ['POST', `/twins/${id}/resume`], ['DELETE', `/twins/${id}`]] as const) expect((await call(member, method, path)).status).toBe(403);
    expect(await stateOf(id)).toBe('seeding');
    const resumeEarly = await call(owner, 'POST', `/twins/${id}/resume`);
    expect(resumeEarly.status).toBe(409);
    expect(await resumeEarly.json()).toMatchObject({ error: { code: 'twin_state' }, data: { state: 'seeding' } });
    expect((await (await call(owner, 'POST', `/twins/${id}/pause`)).json()) as { state: string }).toMatchObject({ state: 'paused' });
    expect((await call(owner, 'POST', `/twins/${id}/pause`)).status).toBe(409);
    expect(await (await call(await addMember(owner.accountId, 'admin'), 'POST', `/twins/${id}/resume`)).json()).toMatchObject({ state: 'seeding' });
    const stopped = await call(owner, 'DELETE', `/twins/${id}`);
    expect(await stopped.json()).toMatchObject({ id, state: 'removed', private_repo_id: priv });
    expect((await call(owner, 'DELETE', `/twins/${id}`)).status).toBe(409);
    const log = await admin.query(`SELECT action FROM audit_log WHERE account_id = $1 AND action LIKE 'twin.%' ORDER BY created_at, id`, [owner.accountId]);
    expect(log.rows.map((r) => r.action)).toEqual(['twin.created', 'twin.paused', 'twin.resumed', 'twin.removed']);
    // We never delete a GitHub repo: the repo row is still there, and the only calls GitHub saw were none.
    expect((await admin.query('SELECT 1 FROM repos WHERE id = $1', [priv])).rows).toHaveLength(1);
    expect(asked).toEqual([]);
  });

  it("a second account cannot pause, resume or stop the first one's twin, or read it", async () => {
    const one = await account();
    const two = await account();
    const id = await makeTwin(one, await seedRepo(one.accountId));
    for (const [method, path] of [['POST', `/twins/${id}/pause`], ['POST', `/twins/${id}/resume`], ['DELETE', `/twins/${id}`]] as const) {
      const res = await call(two, method, path);
      expect(res.status).toBe(404);
    }
    expect(await stateOf(id)).toBe('not_connected');
    expect((await call(two, 'POST', `/twins/${randomUUID()}/pause`)).status).toBe(404);
    expect((await call(two, 'POST', '/twins/not-a-uuid/pause')).status).toBe(404);
  });

  it('a repo of a live twin, either side, cannot be paired (409 twin_exists) and can again after Stop publishing', async () => {
    const owner = await account();
    const pub = await seedRepo(owner.accountId);
    const priv = await seedRepo(owner.accountId, 'widgets-private');
    const id = await makeTwin(owner, pub, priv);
    const body = { code_repo: 'acme/widgets-public', overlay_globs: ['private/**'] };
    for (const repo of [pub, priv]) {
      const res = await call(owner, 'PUT', `/repos/${repo}/pairing`, body);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('twin_exists');
      expect((await admin.query('SELECT 1 FROM repo_pairing WHERE repo_id = $1', [repo])).rows).toHaveLength(0);
    }
    // Another repo of the same account is unaffected.
    expect((await call(owner, 'PUT', `/repos/${await seedRepo(owner.accountId, 'free')}/pairing`, body)).status).toBe(200);
    await call(owner, 'DELETE', `/twins/${id}`);
    expect((await call(owner, 'PUT', `/repos/${pub}/pairing`, body)).status).toBe(200);
  });
});
