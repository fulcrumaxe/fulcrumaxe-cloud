import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { twinRouteDeps } from '../src/routes/repoTwins.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}
const STATES = ['creating', 'not_connected', 'seeding', 'ready', 'paused', 'conflict', 'refused', 'failed'] as const;

/**
 * D#845 ON-27e through the real `handleApiRequest` against real Postgres: the Private paths read and write, and "Use my approved plan", which the route refuses unless the twin is ready or paused
 * (Ruling 107.1). Every route is auth-tested: a member is refused, another account's twin is a 404, and with the kill switch off all three answer 503.
 */
describe('repo twin paths and plan adoption API', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  const savedSecret = process.env.FX_SESSION_SECRET;

  beforeAll(async () => {
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    twinRouteDeps.enabled = true;
  });
  afterEach(() => {
    twinRouteDeps.enabled = true;
  });
  afterAll(async () => {
    twinRouteDeps.enabled = false;
    if (savedSecret === undefined) delete process.env.FX_SESSION_SECRET;
    else process.env.FX_SESSION_SECRET = savedSecret;
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
  const code = async (res: Response): Promise<string> => ((await res.json()) as { error: { code: string } }).error.code;
  async function member(accountId: string): Promise<Identity> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [accountId, userId]);
    return { accountId, userId };
  }
  const seedRepo = async (accountId: string): Promise<string> =>
    (await admin.query<{ id: string }>(`INSERT INTO repos (account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, 'web', 'acme', 'w') RETURNING id`, [accountId, Math.floor(Math.random() * 1e9)])).rows[0]!.id;
  /** A twin made by the callback's own function (`twin_record`), then put in `state` by the admin connection (the states after `seeding` belong to later rows). */
  async function twinOf(who: Identity, state: string = 'ready'): Promise<{ id: string; pub: string; priv: string }> {
    const pub = await seedRepo(who.accountId);
    const priv = await seedRepo(who.accountId);
    const c = await appUserPool.connect();
    let id: string;
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)", [who.accountId, who.userId]);
      id = (await c.query<{ o_id: string }>('SELECT o_id FROM twin_record($1, $2, 55, $3)', [pub, priv, 'w-private'])).rows[0]!.o_id;
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    if (state === 'removed') expect((await call(who, 'DELETE', `/twins/${id}`)).status).toBe(200); // the real undo route, which also stamps what a removed row needs
    else await admin.query('UPDATE repo_twins SET state = $2 WHERE id = $1', [id, state]);
    return { id, pub, priv };
  }
  const setupFor = async (who: Identity, repoId: string): Promise<string> => {
    const id = randomUUID();
    await admin.query(`INSERT INTO project_setups (id, account_id, repo_id, kind, phase, created_by) VALUES ($1, $2, $3, 'existing', 'survey', $4)`, [id, who.accountId, repoId, who.userId]);
    return id;
  };
  const approvedPlan = (who: Identity, repoId: string) =>
    admin.query(`INSERT INTO project_drafts (account_id, repo_id, source, prd_md, roadmap, version) VALUES ($1, $2, 'interview', '# Plan', $3::jsonb, 1)`, [who.accountId, repoId,
      JSON.stringify([{ row_key: 'A', title: 'Row A', summary: 'Does a thing.', size: 'M', depends_on: [], keep: true }])]);

  it('is off until ON-27d: all three routes answer 503 not_configured', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    twinRouteDeps.enabled = false;
    for (const [method, path, body] of [['GET', `/twins/${randomUUID()}/paths`, undefined], ['PUT', `/twins/${randomUUID()}/paths`, { revision: 'x' }], ['POST', `/twins/${randomUUID()}/adopt-plan`, { setup_id: randomUUID() }]] as const) {
      const res = await call(owner, method, path, body);
      expect([res.status, await code(res)]).toEqual([503, 'not_configured']);
    }
  });

  it('reads the private paths with the fixed roots and a revision; a member is refused and another account sees a 404', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const other = await seedAccountWithMember(admin, { role: 'owner' });
    const t = await twinOf(owner);
    const res = await call(owner, 'GET', `/twins/${t.id}/paths`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { overlay_globs: string[]; fixed_roots: string[]; revision: string; install_paths: string[] };
    expect(body.overlay_globs).toEqual([]);
    expect(body.install_paths).toEqual([]);
    expect(body.fixed_roots).toEqual(expect.arrayContaining(['.autonomous-team/**', '.env', '**/*.pem']));
    expect(typeof body.revision).toBe('string');
    expect((await call(await member(owner.accountId), 'GET', `/twins/${t.id}/paths`)).status).toBe(403);
    expect((await call(other, 'GET', `/twins/${t.id}/paths`)).status).toBe(404);
  });

  it('writes the person paths against the revision it read: a stale revision is 409 twin_paths_changed, a bad path 422, a removed twin 409 twin_state, and nothing else changes', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const other = await seedAccountWithMember(admin, { role: 'owner' });
    const t = await twinOf(owner);
    const first = (await (await call(owner, 'GET', `/twins/${t.id}/paths`)).json()) as { revision: string };
    const put = await call(owner, 'PUT', `/twins/${t.id}/paths`, { revision: first.revision, overlay_globs: ['internal/**'], binary_globs: ['assets/*.png'] });
    expect(put.status).toBe(200);
    const after = (await put.json()) as { overlay_globs: string[]; binary_globs: string[]; revision: string };
    expect(after).toMatchObject({ overlay_globs: ['internal/**'], binary_globs: ['assets/*.png'] });
    expect(after.revision).not.toBe(first.revision);
    const stale = await call(owner, 'PUT', `/twins/${t.id}/paths`, { revision: first.revision, overlay_globs: ['other/**'] });
    expect([stale.status, await code(stale)]).toEqual([409, 'twin_paths_changed']);
    const bad = await call(owner, 'PUT', `/twins/${t.id}/paths`, { revision: after.revision, overlay_globs: ['/etc/passwd'] });
    expect(bad.status).toBe(422);
    expect((await call(owner, 'PUT', `/twins/${t.id}/paths`, { revision: after.revision, extra: 1 })).status).toBe(422);
    expect((await call(await member(owner.accountId), 'PUT', `/twins/${t.id}/paths`, { revision: after.revision })).status).toBe(403);
    expect((await call(other, 'PUT', `/twins/${t.id}/paths`, { revision: after.revision, overlay_globs: ['x/**'] })).status).toBe(404);
    expect((await admin.query<{ overlay_globs: string[] }>('SELECT overlay_globs FROM repo_twins WHERE id = $1', [t.id])).rows[0]!.overlay_globs).toEqual(['internal/**']);
    expect((await call(owner, 'DELETE', `/twins/${t.id}`)).status).toBe(200);
    const gone = await call(owner, 'PUT', `/twins/${t.id}/paths`, { revision: after.revision, overlay_globs: ['x/**'] });
    expect([gone.status, await code(gone)]).toEqual([409, 'twin_state']);
  });

  it('Use my approved plan is refused with 409 twin_not_ready in every state but ready and paused, and writes nothing', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    for (const state of [...STATES, 'removed']) {
      if (state === 'ready' || state === 'paused') continue;
      const t = await twinOf(owner, state);
      await approvedPlan(owner, t.pub);
      const setup = await setupFor(owner, t.priv);
      const res = await call(owner, 'POST', `/twins/${t.id}/adopt-plan`, { setup_id: setup });
      expect([state, res.status, await code(res)]).toEqual([state, 409, 'twin_not_ready']);
      expect((await admin.query('SELECT 1 FROM project_drafts WHERE repo_id = $1', [t.priv])).rowCount).toBe(0);
      expect((await admin.query<{ phase: string }>('SELECT phase FROM project_setups WHERE id = $1', [setup])).rows[0]!.phase).toBe('survey');
    }
  });

  it('a ready or paused twin carries the plan: the setup moves to the plan step with a new draft; the same call again, or no plan on the public repo, is adopted:false with the reason', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    for (const state of ['ready', 'paused']) {
      const t = await twinOf(owner, state);
      const setup = await setupFor(owner, t.priv);
      const none = await call(owner, 'POST', `/twins/${t.id}/adopt-plan`, { setup_id: setup });
      expect([none.status, await none.json()]).toEqual([200, { adopted: false, draft_id: null, reason: 'no_draft' }]);
      await approvedPlan(owner, t.pub);
      const res = await call(owner, 'POST', `/twins/${t.id}/adopt-plan`, { setup_id: setup });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ adopted: true, draft_id: expect.any(String), reason: null });
      expect((await admin.query<{ phase: string }>('SELECT phase FROM project_setups WHERE id = $1', [setup])).rows[0]!.phase).toBe('plan');
      expect(await (await call(owner, 'POST', `/twins/${t.id}/adopt-plan`, { setup_id: setup })).json()).toEqual({ adopted: false, draft_id: null, reason: 'bad_state' });
    }
  });

  it('adopt-plan is owner or admin only, a stranger gets 404, a setup of another repo is 404, and the body is strict', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const other = await seedAccountWithMember(admin, { role: 'owner' });
    const t = await twinOf(owner);
    await approvedPlan(owner, t.pub);
    const setup = await setupFor(owner, t.priv);
    expect((await call(await member(owner.accountId), 'POST', `/twins/${t.id}/adopt-plan`, { setup_id: setup })).status).toBe(403);
    expect((await call(other, 'POST', `/twins/${t.id}/adopt-plan`, { setup_id: setup })).status).toBe(404);
    expect((await call(owner, 'POST', `/twins/${t.id}/adopt-plan`, { setup_id: await setupFor(owner, t.pub) })).status).toBe(404);
    expect((await call(owner, 'POST', `/twins/${t.id}/adopt-plan`, { setup_id: 'nope' })).status).toBe(422);
    expect((await call(owner, 'POST', `/twins/${t.id}/adopt-plan`, { setup_id: setup, extra: 1 })).status).toBe(422);
    expect((await admin.query<{ phase: string }>('SELECT phase FROM project_setups WHERE id = $1', [setup])).rows[0]!.phase).toBe('survey');
  });

  it('the twin read answers for either repo of the pair, and another account asking with the private repo id gets a 404', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const other = await seedAccountWithMember(admin, { role: 'owner' });
    const t = await twinOf(owner);
    for (const id of [t.pub, t.priv]) expect(await (await call(owner, 'GET', `/repos/${id}/twin`)).json()).toMatchObject({ twin: { id: t.id, public_repo_id: t.pub, private_repo_id: t.priv } });
    expect((await call(other, 'GET', `/repos/${t.priv}/twin`)).status).toBe(404);
    expect(await (await call(owner, 'GET', `/repos/${await seedRepo(owner.accountId)}/twin`)).json()).toEqual({ twin: null });
  });
});
