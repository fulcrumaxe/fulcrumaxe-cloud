import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertRunner } from '@fx/db/test/helpers/runnerFixtures.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { buildOpenApiDocument } from '../src/openapi.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
interface Identity { accountId: string; userId: string }

/** Engine bridge EB-7: GET /api/v1/engine/repos/{id}/plan through the real handler against real Postgres (migration 1032): auth, tenancy, 204, the age fields. */
describe('engine plan route', () => {
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
    await Promise.all([adminPool.end(), platformOpsPool.end(), appUserPool.end()]);
  });

  async function call(urlPath: string, who?: Identity, bearer?: string): Promise<Response> {
    const headers = new Headers();
    if (bearer) headers.set('authorization', `Bearer ${bearer}`);
    else if (who) headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(who)}`);
    return handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { method: 'GET', headers }), appUserPool, platformOpsPool, ROUTES);
  }
  async function world() {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const memberId = randomUUID();
    await seedUser(admin, memberId);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [owner.accountId, memberId]);
    const gh = Math.floor(Math.random() * 1e9);
    const repo = (await admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product, execution_mode) VALUES ($1, NULL, $2, 'web', 'runner_local') RETURNING id`, [owner.accountId, gh])).rows[0]!.id;
    const runner = await insertRunner(admin, owner.accountId, owner.userId);
    // The runner fixture puts the account on the runner plan, which the token rate limiter has no limits for; a token principal needs a plan it knows.
    await admin.query(`UPDATE accounts SET plan = 'starter' WHERE id = $1`, [owner.accountId]);
    const session = randomUUID();
    await admin.query(`INSERT INTO engine_bridge_settings (account_id, watch_enabled) VALUES ($1, true)`, [owner.accountId]);
    await admin.query(`INSERT INTO engine_bridge_repos (account_id, repo_id) VALUES ($1, $2)`, [owner.accountId, repo]);
    await admin.query(`INSERT INTO engine_sessions (id, account_id, runner_id, repo_id, engine_instance_id, engine_version, last_seq, last_event_at, last_heard_at, source_ages_s) VALUES ($1, $2, $3, $4, $5, '1.2.3', 0, now(), now(), '{"plan": 40}')`, [session, owner.accountId, runner, repo, randomUUID()]);
    return { owner, member: { accountId: owner.accountId, userId: memberId }, repo, session };
  }
  const snapshot = (w: { owner: Identity; repo: string; session: string }) =>
    admin.query(
      `INSERT INTO engine_plan_snapshots (account_id, session_id, repo_id, plan_date, snapshot_id, chunk_count, items, roadmap, started_seq, completed_seq, snapshot_at)
       VALUES ($1, $2, $3, '2026-11-16', 'snap-1', 1, $4, $5, 0, 0, now() - interval '90 seconds')`,
      [w.owner.accountId, w.session, w.repo, JSON.stringify([{ discussion: 842, ordinal: 1, state: 'in_progress' }]), JSON.stringify([{ row_key: '', discussion: 842, status: 'in_progress' }, { row_key: 'EB-7', status: 'done', planned_prs: 1 }])],
    );
  const tokenFor = async (who: Identity, scopes: string[]) => {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, { accountId: who.accountId, createdBy: who.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes: scopes as never, expiresAt: new Date(Date.now() + 86_400_000) });
    return plaintext;
  };
  const url = (repo: string) => `/engine/repos/${repo}/plan`;

  it('answers the newest complete snapshot to a member, with the age fields and the L1 fields, and no null-looking strings', async () => {
    const w = await world();
    await snapshot(w);
    const res = await call(url(w.repo), w.member);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      plan_date: '2026-11-16',
      items: [{ discussion: 842, ordinal: 1, state: 'in_progress' }],
      roadmap: [{ row_key: '', discussion: 842, status: 'in_progress', planned_prs: null }, { row_key: 'EB-7', discussion: null, status: 'done', planned_prs: 1 }],
      newer_partial: null,
      source_ages_s: { plan: 40 },
      gaps: [],
      missing_events: 0,
    });
    expect(body.age_s as number).toBeGreaterThanOrEqual(90);
    expect(body.age_s as number).toBeLessThan(120);
    expect(typeof body.as_of).toBe('string');
    expect(typeof body.heard_age_s).toBe('number');
    expect(JSON.stringify(body)).not.toMatch(/undefined|NaN/);
    const fx = JSON.parse(readFileSync(path.join(__dirname, '..', 'fixtures', 'v1', 'getEngineRepoPlan', '200-ok.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(fx).sort()).toEqual(Object.keys(body).sort());
  });

  it('is 204 with no body when the repo has no complete snapshot', async () => {
    const w = await world();
    const res = await call(url(w.repo), w.member);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('is 401 without credentials, 404 for another account\'s repo, an unticked repo and a malformed id', async () => {
    const w = await world();
    const other = await world();
    await snapshot(other);
    expect((await call(url(w.repo))).status).toBe(401);
    expect((await call(url(other.repo), w.member)).status).toBe(404);
    await admin.query(`DELETE FROM engine_bridge_repos WHERE repo_id = $1`, [w.repo]);
    expect((await call(url(w.repo), w.member)).status).toBe(404);
    expect((await call(url('not-a-uuid'), w.member)).status).toBe(404);
    expect((await call(url(randomUUID()), w.member)).status).toBe(404);
  });

  it('admits a token with the read scope, and refuses one without it', async () => {
    const w = await world();
    await snapshot(w);
    expect((await call(url(w.repo), undefined, await tokenFor(w.owner, ['read']))).status).toBe(200);
    const noRead = await call(url(w.repo), undefined, await tokenFor(w.owner, ['audit:read']));
    expect(noRead.status).toBe(403);
    expect(((await noRead.json()) as { error: { code: string } }).error.code).toBe('insufficient_scope');
  });

  it('is documented, with the 204', () => {
    const doc = buildOpenApiDocument(ROUTES) as unknown as { paths: Record<string, { get: { responses: Record<string, { description: string }> } }> };
    const op = doc.paths['/api/v1/engine/repos/{id}/plan']!.get;
    expect(Object.keys(op.responses)).toEqual(expect.arrayContaining(['200', '204', '401', '404']));
    expect(op.responses['204']!.description).toMatch(/no complete plan snapshot/);
  });
});
