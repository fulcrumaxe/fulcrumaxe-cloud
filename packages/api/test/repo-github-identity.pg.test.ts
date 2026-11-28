import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { writeEngineAudit } from '@fx/db/src/engineAudit.js';
import { readPersonalRepoIds, readRepoGithubIdentity, readRepoIdentityView } from '@fx/db/src/repoGithubIdentity.js';
import { readEngineRepos } from '@fx/core/src/engine/panels.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { insertRunner } from '@fx/db/test/helpers/runnerFixtures.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { engineSettingsDeps } from '../src/routes/engine.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}
interface Body {
  error?: { code: string };
  [k: string]: unknown;
}

/**
 * D#845 ON-19a: the per-project GitHub identity through the real handler against real Postgres (RLS, the definer function of 1121, audit_write).
 * Fences under test: the role (owner or admin; a member 403), the credential (an API token 403, nothing 401), the repo's account (another account's repo 404),
 * the public-repo refusal (409) and the audit row (exactly one per real change, none for a repeat or a refusal).
 */
describe('ON-19a: GitHub identity setting', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let seen: Map<string, 'private' | 'public' | 'unknown'>;
  let asked: string[];

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
  });
  beforeEach(() => {
    seen = new Map();
    asked = [];
    engineSettingsDeps.getVisibility = () => async (_account, repoId) => {
      asked.push(repoId);
      return seen.get(repoId) ?? 'private';
    };
  });
  afterAll(async () => {
    engineSettingsDeps.getVisibility = null;
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await Promise.all([adminPool.end(), platformOpsPool.end(), appUserPool.end()]);
  });

  async function call(identity: Identity | null, method: string, urlPath: string, body?: unknown, bearer?: string): Promise<Response> {
    const h = new Headers({ 'content-type': 'application/json' });
    if (bearer) h.set('authorization', `Bearer ${bearer}`);
    else if (identity) h.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(identity)}`);
    const req = new Request(`http://localhost/api/v1${urlPath}`, { method, headers: h, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    return handleApiRequest(req, appUserPool, platformOpsPool, ROUTES);
  }
  const put = (who: Identity | null, repoId: string, github_identity: string, bearer?: string) => call(who, 'PUT', `/repos/${repoId}/github-identity`, { github_identity }, bearer);
  const json = async (res: Response): Promise<Body> => (await res.json()) as Body;
  async function addMember(accountId: string, role: 'admin' | 'member'): Promise<Identity> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, userId, role]);
    return { accountId, userId };
  }
  async function seedRepo(accountId: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, NULL, $2, 'web') RETURNING id`, [accountId, Math.floor(Math.random() * 1e12)]);
    return rows[0]!.id;
  }
  async function fixture() {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const adminUser = await addMember(owner.accountId, 'admin');
    const member = await addMember(owner.accountId, 'member');
    const repoId = await seedRepo(owner.accountId);
    const other = await seedAccountWithMember(admin, { role: 'owner' });
    return { owner, adminUser, member, repoId, other };
  }
  const stored = async (repoId: string) => (await admin.query<{ identity: string }>(`SELECT identity FROM repo_github_identity WHERE repo_id = $1`, [repoId])).rows[0]?.identity;
  const audits = async (accountId: string) =>
    (await admin.query<{ actor: string; payload: Record<string, unknown> }>(`SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'project.github_identity_changed' ORDER BY created_at, id`, [accountId])).rows;

  it('reads app by default; an owner and an admin switch to personal and back, one audit row per real change and none for a repeat', async () => {
    const f = await fixture();
    const first = await call(f.member, 'GET', `/repos/${f.repoId}/github-identity`);
    expect(first.status).toBe(200);
    expect(await json(first)).toEqual({ github_identity: 'app', machine: null });

    expect((await put(f.owner, f.repoId, 'personal')).status).toBe(200);
    expect(await stored(f.repoId)).toBe('personal');
    expect((await put(f.owner, f.repoId, 'personal')).status).toBe(200);
    expect(await audits(f.owner.accountId)).toHaveLength(1);

    const back = await put(f.adminUser, f.repoId, 'app');
    expect(await json(back)).toEqual({ github_identity: 'app', machine: null });
    expect(await stored(f.repoId)).toBe('app');
    const rows = await audits(f.owner.accountId);
    expect(rows.map((r) => r.payload)).toEqual([
      { repo_id: f.repoId, github_identity: 'personal' },
      { repo_id: f.repoId, github_identity: 'app' },
    ]);
    expect(rows[1]!.actor).toContain(f.adminUser.userId);
  });

  it('a plain member gets 403 insufficient_role, and nothing is written', async () => {
    const f = await fixture();
    const res = await put(f.member, f.repoId, 'personal');
    expect(res.status).toBe(403);
    expect((await json(res)).error?.code).toBe('insufficient_role');
    expect(asked, 'refused before GitHub is asked anything').toEqual([]);
    expect(await stored(f.repoId)).toBeUndefined();
    expect(await audits(f.owner.accountId)).toHaveLength(0);
  });

  it('an API token (any owner token) gets 403 session_required, and nothing is written; no credential is 401', async () => {
    const f = await fixture();
    const plaintext = generateToken();
    await insertApiToken(appUserPool, { accountId: f.owner.accountId, createdBy: f.owner.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes: ['read', 'work_items:write'], expiresAt: new Date(Date.now() + 86_400_000) });
    const res = await put(f.owner, f.repoId, 'personal', plaintext);
    expect(res.status).toBe(403);
    expect((await json(res)).error?.code).toBe('session_required');
    expect((await put(null, f.repoId, 'personal')).status).toBe(401);
    expect(await stored(f.repoId)).toBeUndefined();
    expect(await audits(f.owner.accountId)).toHaveLength(0);
    expect((await call(f.owner, 'GET', `/repos/${f.repoId}/github-identity`, undefined, plaintext)).status).toBe(200);
  });

  it('a public repo answers 409 personal_identity_public_repo; so does a repeat on a repo that turned public; going back to app is never refused', async () => {
    const f = await fixture();
    seen.set(f.repoId, 'public');
    const res = await put(f.owner, f.repoId, 'personal');
    expect(res.status).toBe(409);
    expect((await json(res)).error?.code).toBe('personal_identity_public_repo');
    expect(await stored(f.repoId)).toBeUndefined();
    expect(await audits(f.owner.accountId)).toHaveLength(0);

    seen.set(f.repoId, 'private');
    expect((await put(f.owner, f.repoId, 'personal')).status).toBe(200);
    seen.set(f.repoId, 'public');
    expect((await put(f.owner, f.repoId, 'personal')).status).toBe(409);
    expect((await put(f.owner, f.repoId, 'app')).status).toBe(200);
    expect(await stored(f.repoId)).toBe('app');
  });

  it('when GitHub does not say, personal is refused with 409 repo_visibility_unknown (fail closed)', async () => {
    const f = await fixture();
    seen.set(f.repoId, 'unknown');
    const res = await put(f.owner, f.repoId, 'personal');
    expect(res.status).toBe(409);
    expect((await json(res)).error?.code).toBe('repo_visibility_unknown');
    engineSettingsDeps.getVisibility = null;
    expect((await put(f.owner, f.repoId, 'personal')).status).toBe(409);
    expect(await stored(f.repoId)).toBeUndefined();
  });

  it("another account's repo is 404 on both routes, and GitHub is never asked about it", async () => {
    const f = await fixture();
    expect((await put(f.other, f.repoId, 'personal')).status).toBe(404);
    expect((await call(f.other, 'GET', `/repos/${f.repoId}/github-identity`)).status).toBe(404);
    expect((await put(f.other, 'not-a-uuid', 'personal')).status).toBe(404);
    expect(asked).toEqual([]);
    expect(await stored(f.repoId)).toBeUndefined();
  });

  it('a value that is not app or personal is a 422, and an extra key is refused', async () => {
    const f = await fixture();
    expect((await put(f.owner, f.repoId, 'both')).status).toBe(422);
    expect((await call(f.owner, 'PUT', `/repos/${f.repoId}/github-identity`, { github_identity: 'app', token: 'x' })).status).toBe(422);
  });

  it('the definer itself refuses a member, a platform_ops login and another account (a path that skipped the route still could not write)', async () => {
    const f = await fixture();
    const ask = (who: Identity, repo: string) => withTenant(appUserPool, who.accountId, who.userId, (c) => c.query(`SELECT * FROM repo_github_identity_set($1::uuid, 'personal')`, [repo]));
    await expect(ask(f.member, f.repoId)).rejects.toMatchObject({ code: '42501' });
    await expect(ask({ accountId: f.owner.accountId, userId: randomUUID() }, f.repoId)).rejects.toMatchObject({ code: '42501' });
    await expect(ask(f.other, f.repoId)).rejects.toMatchObject({ code: 'P0002' });
    await expect(platformOpsPool.query(`SELECT * FROM repo_github_identity_set($1::uuid, 'personal')`, [f.repoId])).rejects.toMatchObject({ code: '42501' }); // a plain platform_ops login holds no EXECUTE at all
    await expect(withTenant(appUserPool, f.owner.accountId, f.owner.userId, (c) => c.query(`INSERT INTO repo_github_identity (account_id, repo_id, identity) VALUES ($1, $2, 'personal')`, [f.owner.accountId, f.repoId]))).rejects.toBeTruthy();
    await expect(withTenant(appUserPool, f.owner.accountId, f.owner.userId, (c) => c.query(`SELECT * FROM repo_github_identity_set($1::uuid, 'root')`, [f.repoId]))).rejects.toMatchObject({ code: '22023' });
    // A session that names a runner is never a person, even for an owner of the account.
    await expect(
      withTenant(appUserPool, f.owner.accountId, f.owner.userId, async (c) => {
        await c.query(`SELECT set_config('app.runner_id', $1, true)`, [randomUUID()]);
        await c.query(`SELECT * FROM repo_github_identity_set($1::uuid, 'personal')`, [f.repoId]);
      }),
    ).rejects.toMatchObject({ code: '42501' });
    expect(await stored(f.repoId)).toBeUndefined();
  });

  it('the in-function fences each hold on their own: a platform_ops or agent_run_writer login that can run the function, and an inactive account', async () => {
    const f = await fixture();
    const asLogin = async (suffix: string, extraRole: string) => {
      const name = `fx_t_ident_${suffix}_${randomUUID().slice(0, 8)}`;
      await admin.query(`CREATE ROLE ${name} LOGIN IN ROLE app_user, ${extraRole}`);
      const url = new URL(process.env.API_DATABASE_URL_APP_USER!);
      url.username = name;
      const pool = createPool(url.toString());
      try {
        // A tenant is set, the owner is the person, and the function is executable (app_user): only the login's own membership can refuse.
        return await withTenant(pool, f.owner.accountId, f.owner.userId, (c) => c.query(`SELECT * FROM repo_github_identity_set($1::uuid, 'personal')`, [f.repoId])).then(
          () => null,
          (e: { code?: string; message?: string }) => e,
        );
      } finally {
        await pool.end();
        await admin.query(`DROP OWNED BY ${name}`);
        await admin.query(`DROP ROLE ${name}`);
      }
    };
    for (const [suffix, role] of [['ops', 'platform_ops'], ['writer', 'agent_run_writer']] as const) {
      const e = await asLogin(suffix, role);
      expect(e, role).toMatchObject({ code: '42501', message: expect.stringContaining('refused for a platform or runner session') });
    }
    await admin.query(`UPDATE accounts SET deleted_at = now() WHERE id = $1`, [f.owner.accountId]);
    try {
      await expect(withTenant(appUserPool, f.owner.accountId, f.owner.userId, (c) => c.query(`SELECT * FROM repo_github_identity_set($1::uuid, 'personal')`, [f.repoId]))).rejects.toMatchObject({
        code: '42501',
        message: expect.stringContaining('not an owner or admin of an active account'),
      });
    } finally {
      await admin.query(`UPDATE accounts SET deleted_at = NULL WHERE id = $1`, [f.owner.accountId]);
    }
    expect(await stored(f.repoId)).toBeUndefined();
  });

  it('the admin client with a foreign account id reads no row of the repo, and the second repo of the same account stays app', async () => {
    const f = await fixture();
    const second = await seedRepo(f.owner.accountId);
    await put(f.owner, f.repoId, 'personal');
    expect((await admin.query(`SELECT 1 FROM repo_github_identity WHERE account_id = $1 AND repo_id = $2`, [f.other.accountId, f.repoId])).rowCount).toBe(0);
    const seenByOther = await withTenant(appUserPool, f.other.accountId, f.other.userId, (c) => c.query(`SELECT 1 FROM repo_github_identity WHERE repo_id = $1`, [f.repoId]));
    expect(seenByOther.rowCount).toBe(0);
    expect(await json(await call(f.owner, 'GET', `/repos/${second}/github-identity`))).toEqual({ github_identity: 'app', machine: null });
    const list = (await json(await call(f.owner, 'GET', '/repos'))) as unknown as { data: Array<{ id: string; github_identity: string }> };
    expect(Object.fromEntries(list.data.map((r) => [r.id, r.github_identity]))).toEqual({ [f.repoId]: 'personal', [second]: 'app' });
    expect((await json(await call(f.owner, 'GET', `/repos/${f.repoId}`))).github_identity).toBe('personal');
  });

  it('every reader names the account on top of row security: through the RLS-bypassing client a foreign account id sees nothing', async () => {
    const f = await fixture();
    const second = await seedRepo(f.owner.accountId);
    await put(f.owner, f.repoId, 'personal');
    expect(await readRepoIdentityView(admin, f.other.accountId, f.repoId)).toBeNull();
    expect(await readRepoGithubIdentity(admin, f.other.accountId, f.repoId)).toBe('app');
    expect([...(await readPersonalRepoIds(admin, f.other.accountId, [f.repoId, second]))]).toEqual([]);
    expect(await readRepoGithubIdentity(admin, f.owner.accountId, f.repoId)).toBe('personal');
    expect([...(await readPersonalRepoIds(admin, f.owner.accountId, [f.repoId, second]))]).toEqual([f.repoId]);
    expect(await readRepoIdentityView(admin, f.owner.accountId, second)).toEqual({ github_identity: 'app', machine: null });
  });

  it('a failed audit write rolls the change back, and the machine name is the one the person gave the repo\'s runner', async () => {
    const f = await fixture();
    await expect(
      withTenant(appUserPool, f.owner.accountId, f.owner.userId, async (c) => {
        await c.query(`SELECT * FROM repo_github_identity_set($1::uuid, 'personal')`, [f.repoId]);
        await writeEngineAudit(c, 'project.github_identity_changed', { repo_id: f.repoId, github_identity: 'personal', note: 'x' } as never);
      }),
    ).rejects.toBeTruthy();
    expect(await stored(f.repoId)).toBeUndefined();

    const runnerId = await insertRunner(admin, f.owner.accountId, f.owner.userId);
    await admin.query(`INSERT INTO runner_settings (runner_id, account_id, name) VALUES ($1, $2, 'Studio laptop')`, [runnerId, f.owner.accountId]);
    await admin.query(`INSERT INTO engine_sessions (id, account_id, runner_id, repo_id, engine_instance_id, engine_version) VALUES ($1, $2, $3, $4, $5, '1.0.0')`, [randomUUID(), f.owner.accountId, runnerId, f.repoId, randomUUID()]);
    expect(await json(await call(f.owner, 'GET', `/repos/${f.repoId}/github-identity`))).toEqual({ github_identity: 'app', machine: 'Studio laptop' });
  });

  it('the engine repo list carries the identity for the Team chip', async () => {
    const f = await fixture();
    await admin.query(`INSERT INTO engine_bridge_settings (account_id, watch_enabled) VALUES ($1, true) ON CONFLICT (account_id) DO UPDATE SET watch_enabled = true`, [f.owner.accountId]);
    await admin.query(`INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)`, [f.owner.accountId, f.repoId]);
    const read = () => withTenant(appUserPool, f.owner.accountId, f.owner.userId, (c) => readEngineRepos(c, f.owner.accountId));
    expect((await read())[0]!.github_identity).toBe('app');
    await put(f.owner, f.repoId, 'personal');
    expect((await read())[0]!.github_identity).toBe('personal');
  });
});
