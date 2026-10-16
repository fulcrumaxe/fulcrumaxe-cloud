import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}
interface Preview {
  scope: string;
  repo_id: string | null;
  kind: string;
  from: number;
  to: number;
  items: number;
  unpriced_items: number;
  effective_limit_old: number;
  effective_limit_new: number;
  clear_minutes_old: number;
  clear_minutes_new: number;
  extra_per_hour_cents?: number;
  extra_per_day_cents?: number;
  queue_total_cents?: number;
  basis: string;
  notes: { code: string; text: string }[];
  preview_hash: string;
}
interface ErrorBody {
  error: { code: string; message: string };
  data?: { preview: Preview };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * D#483 S5-c2: the six build-concurrency routes through the real handler against real Postgres (RLS, the table's owner-or-admin policy,
 * audit_write and its row). The prices come from the real S5-p estimate over the seeded rows.
 */
describe('D#483 S5-c2: build concurrency routes', () => {
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

  async function call(identity: Identity, method: string, urlPath: string, body?: unknown, bearer?: string): Promise<Response> {
    const headers = new Headers();
    if (bearer) headers.set('authorization', `Bearer ${bearer}`);
    else headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(identity)}`);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const req = new Request(`http://localhost/api/v1${urlPath}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return handleApiRequest(req, appUserPool, platformOpsPool, ROUTES);
  }
  async function addMember(accountId: string, role: 'admin' | 'member'): Promise<Identity> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, userId, role]);
    return { accountId, userId };
  }
  async function seedRepo(accountId: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, NULL, $2, 'web') RETURNING id`, [accountId, Math.floor(Math.random() * 1e9)]);
    return rows[0]!.id;
  }
  async function waitingItem(accountId: string, repoId: string): Promise<void> {
    const id = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, state, provenance, gh_number, stage) VALUES ($1, $2, $3, 'small', 'running', 'internal', $4, 'spec_ready')`, [id, accountId, repoId, Math.floor(Math.random() * 1e6) + 1]);
    await admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, dedupe_key) VALUES ($1, $2, 'build_waiting', 'waiting_for_build_slot_repo', $3)`, [accountId, id, randomUUID()]);
  }
  async function tokenFor(who: Identity, scopes: ('read' | 'work_items:write')[] = ['read']): Promise<string> {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, { accountId: who.accountId, createdBy: who.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes, expiresAt: new Date(Date.now() + 86_400_000) });
    return plaintext;
  }
  /** An owner, an admin and a plain member on one account that has four hosted repos with one waiting item each. */
  async function fixture() {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const adminUser = await addMember(owner.accountId, 'admin');
    const member = await addMember(owner.accountId, 'member');
    const repos: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await seedRepo(owner.accountId);
      repos.push(r);
      await waitingItem(owner.accountId, r);
    }
    return { owner, adminUser, member, repos };
  }
  const versions = async (accountId: string, repoId: string | null) =>
    (await admin.query<{ max_builds: number; version: number; changed_by: string; preview: Record<string, unknown> }>(`SELECT max_builds, version, changed_by, preview FROM build_concurrency_settings WHERE account_id = $1 AND repo_id IS NOT DISTINCT FROM $2::uuid ORDER BY version`, [accountId, repoId])).rows;
  const audits = async (accountId: string) =>
    (await admin.query<{ actor: string; payload: Record<string, unknown> }>(`SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'build_concurrency.changed' ORDER BY created_at, id`, [accountId])).rows;
  const receipts = async (accountId: string) => Number((await admin.query<{ n: string }>(`SELECT count(*) AS n FROM decision_receipts WHERE account_id = $1`, [accountId])).rows[0]!.n);
  const errOf = async (res: Response): Promise<ErrorBody> => (await res.json()) as ErrorBody;

  it('S5c2-3: the reads are open to a member, and a read token; the starting values show', async () => {
    const f = await fixture();
    for (const who of [f.owner, f.member]) {
      const res = await call(who, 'GET', '/account/build-concurrency');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ value: 4, start_value: 4, history_count: 0 });
    }
    const repoRes = await call(f.member, 'GET', `/repos/${f.repos[0]}/build-concurrency`);
    expect(repoRes.status).toBe(200);
    expect(await repoRes.json()).toEqual({ value: 2, start_value: 2, applied_limit: 1, clamp_reason: 'one_build_per_repo_until_d598' });
    const token = await tokenFor(f.owner);
    expect((await call(f.owner, 'GET', '/account/build-concurrency', undefined, token)).status).toBe(200);
    expect((await call(f.owner, 'GET', `/repos/${f.repos[0]}/build-concurrency`, undefined, token)).status).toBe(200);
  });

  it('S5c2-3: a plain member gets 403 on every preview and write, and a token gets session_required', async () => {
    const f = await fixture();
    const repo = f.repos[0];
    const token = await tokenFor(f.owner, ['read', 'work_items:write']);
    const writes: [string, string, unknown][] = [
      ['POST', '/account/build-concurrency/preview', { max_builds: 8 }],
      ['PUT', '/account/build-concurrency', { max_builds: 1 }],
      ['POST', `/repos/${repo}/build-concurrency/preview`, { max_builds: 8 }],
      ['PUT', `/repos/${repo}/build-concurrency`, { max_builds: 1 }],
    ];
    for (const [method, url, body] of writes) {
      const asMember = await call(f.member, method, url, body);
      expect(asMember.status, `${method} ${url}`).toBe(403);
      expect((await errOf(asMember)).error.code).toBe('insufficient_role');
      const asToken = await call(f.owner, method, url, body, token);
      expect(asToken.status, `${method} ${url}`).toBe(403);
      expect((await errOf(asToken)).error.code).toBe('session_required');
    }
    expect(await versions(f.owner.accountId, null)).toEqual([]);
    expect(await versions(f.owner.accountId, repo!)).toEqual([]);
    expect(await audits(f.owner.accountId)).toEqual([]);
  });

  it('S5c2-1: the preview prices the queue, changes no setting row, and an admin may ask for it', async () => {
    const f = await fixture();
    await admin.query(`INSERT INTO build_concurrency_settings (account_id, repo_id, max_builds, version, changed_by) VALUES ($1, NULL, 2, 1, $2)`, [f.owner.accountId, f.owner.userId]);
    const res = await call(f.adminUser, 'POST', '/account/build-concurrency/preview', { max_builds: 10 });
    expect(res.status).toBe(200);
    const p = (await res.json()) as Preview;
    expect(p).toMatchObject({ scope: 'account', repo_id: null, kind: 'raise', from: 2, to: 10, items: 4, effective_limit_old: 2, effective_limit_new: 4, clear_minutes_old: 120, clear_minutes_new: 60 });
    expect(p.extra_per_day_cents).toBeGreaterThan(0);
    expect(p.extra_per_hour_cents! * 24).toBeGreaterThanOrEqual(p.extra_per_day_cents! - 12);
    expect(p.preview_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await versions(f.owner.accountId, null)).toHaveLength(1);
    expect(await audits(f.owner.accountId)).toEqual([]);
  });

  it('S5c2-2: a raise without accept answers 409 preview_required with the fresh preview, and the counts are unchanged', async () => {
    const f = await fixture();
    for (const body of [{ max_builds: 10 }, { max_builds: 10, accept: true }, { max_builds: 10, preview_hash: 'a'.repeat(64) }]) {
      const res = await call(f.owner, 'PUT', '/account/build-concurrency', body);
      expect(res.status).toBe(409);
      const e = await errOf(res);
      expect(e.error.code).toBe('preview_required');
      expect(e.data!.preview).toMatchObject({ from: 4, to: 10, kind: 'raise' });
      expect(e.data!.preview.preview_hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(await versions(f.owner.accountId, null)).toEqual([]);
    expect(await audits(f.owner.accountId)).toEqual([]);
  });

  it('S5c2-2: the matching hash writes one version with the server-computed preview, one audit row, and no receipt; a stale hash writes nothing', async () => {
    const f = await fixture();
    const shown = (await (await call(f.owner, 'POST', '/account/build-concurrency/preview', { max_builds: 10 })).json()) as Preview;

    const stale = await call(f.owner, 'PUT', '/account/build-concurrency', { max_builds: 10, accept: true, preview_hash: '0'.repeat(64) });
    expect(stale.status).toBe(409);
    const staleBody = await errOf(stale);
    expect(staleBody.error.code).toBe('preview_stale');
    expect(staleBody.data!.preview.preview_hash).toBe(shown.preview_hash);
    expect(await versions(f.owner.accountId, null)).toEqual([]);
    expect(await audits(f.owner.accountId)).toEqual([]);

    const ok = await call(f.adminUser, 'PUT', '/account/build-concurrency', { max_builds: 10, accept: true, preview_hash: shown.preview_hash });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ value: 10, start_value: 4, history_count: 1, changed: true });
    const rows = await versions(f.owner.accountId, null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ max_builds: 10, version: 1, changed_by: f.adminUser.userId });
    expect(rows[0]!.preview).toEqual({ ...shown, kind: 'raise', from: 4, to: 10, preview_hash: shown.preview_hash });
    expect(await audits(f.owner.accountId)).toEqual([{ actor: f.adminUser.userId, payload: { scope: 'account', repo_id: null, from: 4, to: 10, preview_hash: shown.preview_hash } }]);
    expect(await receipts(f.owner.accountId)).toBe(0);
  });

  it('a lowering and an equal value need no accept; an equal value writes nothing; the undo is a new version', async () => {
    const f = await fixture();
    const lower = await call(f.owner, 'PUT', '/account/build-concurrency', { max_builds: 1 });
    expect(lower.status).toBe(200);
    expect(await lower.json()).toEqual({ value: 1, start_value: 4, history_count: 1, changed: true });
    expect((await versions(f.owner.accountId, null))[0]!.preview).toEqual({ kind: 'lower', from: 4, to: 1 });
    const same = await call(f.owner, 'PUT', '/account/build-concurrency', { max_builds: 1 });
    expect(await same.json()).toEqual({ value: 1, start_value: 4, history_count: 1, changed: false });
    expect(await versions(f.owner.accountId, null)).toHaveLength(1);
    expect(await audits(f.owner.accountId)).toHaveLength(1);
    // back up to the starting value is a raise: it needs the preview like any other
    expect((await call(f.owner, 'PUT', '/account/build-concurrency', { max_builds: 4 })).status).toBe(409);
  });

  it('the repo routes: a raise is previewed with no speed-up, accepted, recorded for that repo, and the applied limit stays 1', async () => {
    const f = await fixture();
    const repo = f.repos[0]!;
    const res = await call(f.owner, 'POST', `/repos/${repo}/build-concurrency/preview`, { max_builds: 5 });
    expect(res.status).toBe(200);
    const p = (await res.json()) as Preview;
    expect(p).toMatchObject({ scope: 'repo', repo_id: repo, from: 2, to: 5, items: 1, extra_per_hour_cents: 0, extra_per_day_cents: 0 });
    expect(p.notes.map((n) => n.code)).toContain('one_build_per_repo_until_d598');

    expect((await call(f.owner, 'PUT', `/repos/${repo}/build-concurrency`, { max_builds: 5 })).status).toBe(409);
    const ok = await call(f.owner, 'PUT', `/repos/${repo}/build-concurrency`, { max_builds: 5, accept: true, preview_hash: p.preview_hash });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ value: 5, start_value: 2, applied_limit: 1, clamp_reason: 'one_build_per_repo_until_d598', changed: true });
    expect(await versions(f.owner.accountId, repo)).toHaveLength(1);
    expect(await versions(f.owner.accountId, null)).toEqual([]);
    expect(await audits(f.owner.accountId)).toEqual([{ actor: f.owner.userId, payload: { scope: 'repo', repo_id: repo, from: 2, to: 5, preview_hash: p.preview_hash } }]);
    // another repo is untouched
    expect(await (await call(f.owner, 'GET', `/repos/${f.repos[1]}/build-concurrency`)).json()).toMatchObject({ value: 2 });
  });

  it("a repo of another account, or a malformed id, is a 404 on all three repo routes; nothing is written", async () => {
    const f = await fixture();
    const other = await fixture();
    for (const id of [other.repos[0]!, 'not-a-uuid', randomUUID()]) {
      expect((await call(f.owner, 'GET', `/repos/${id}/build-concurrency`)).status, id).toBe(404);
      expect((await call(f.owner, 'POST', `/repos/${id}/build-concurrency/preview`, { max_builds: 3 })).status, id).toBe(404);
      expect((await call(f.owner, 'PUT', `/repos/${id}/build-concurrency`, { max_builds: 1 })).status, id).toBe(404);
    }
    expect(await versions(other.owner.accountId, other.repos[0]!)).toEqual([]);
    expect(await versions(f.owner.accountId, other.repos[0]!)).toEqual([]);
  });

  it('input shape: any integer from 1 to the integer maximum is accepted; zero, negative, fractional, a string, an extra key or more than the column holds is a 4xx', async () => {
    const f = await fixture();
    const big = await call(f.owner, 'POST', '/account/build-concurrency/preview', { max_builds: 2_147_483_647 });
    expect(big.status).toBe(200);
    for (const body of [{ max_builds: 0 }, { max_builds: -3 }, { max_builds: 2.5 }, { max_builds: '5' }, { max_builds: 2_147_483_648 }, { max_builds: 5, extra: 1 }, {}]) {
      const res = await call(f.owner, 'POST', '/account/build-concurrency/preview', body);
      expect(res.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      const put = await call(f.owner, 'PUT', '/account/build-concurrency', body);
      expect(put.status, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
      expect(put.status).toBeLessThan(500);
    }
    expect(await versions(f.owner.accountId, null)).toEqual([]);
  });

  it('the account value in another account never shows here, and the runner-job ceiling is a separate setting', async () => {
    const f = await fixture();
    const other = await fixture();
    await call(other.owner, 'PUT', '/account/build-concurrency', { max_builds: 1 });
    expect(await (await call(f.owner, 'GET', '/account/build-concurrency')).json()).toMatchObject({ value: 4, history_count: 0 });
    const runner = await call(f.owner, 'GET', '/account/runner-concurrency');
    expect(runner.status).toBe(200);
    expect(await runner.json()).toMatchObject({ total: 4, per_repo: 2, accepted: false });
    expect((await admin.query(`SELECT 1 FROM account_runner_concurrency WHERE account_id = $1`, [f.owner.accountId])).rowCount).toBe(0);
  });

  it('S5c2-4: the registry lists all six routes with their principals, and OpenAPI documents the preview shape and the 409s', () => {
    const ours = ROUTES.filter((r) => r.path.includes('build-concurrency')).map((r) => `${r.method} ${r.path} ${(r.principals ?? ['session']).join('+')} ${r.minRole}`);
    expect(ours.sort()).toEqual(
      [
        'GET /api/v1/account/build-concurrency session+token member',
        'POST /api/v1/account/build-concurrency/preview session admin',
        'PUT /api/v1/account/build-concurrency session admin',
        'GET /api/v1/repos/{id}/build-concurrency session+token member',
        'POST /api/v1/repos/{id}/build-concurrency/preview session admin',
        'PUT /api/v1/repos/{id}/build-concurrency session admin',
      ].sort(),
    );
    const doc = JSON.parse(readFileSync(path.join(__dirname, '..', 'openapi.json'), 'utf8')) as {
      paths: Record<string, Record<string, { operationId: string; responses: Record<string, { description?: string; content?: { 'application/json': { schema: { properties?: Record<string, unknown>; required?: string[] } } } }> }>>;
    };
    const preview = doc.paths['/api/v1/account/build-concurrency/preview']!.post!;
    const schema = preview.responses['200']!.content!['application/json'].schema;
    for (const key of ['preview_hash', 'clear_minutes_old', 'clear_minutes_new', 'extra_per_hour_cents', 'extra_per_day_cents', 'queue_total_cents', 'unpriced_items', 'basis', 'notes']) {
      expect(Object.keys(schema.properties ?? {}), key).toContain(key);
    }
    // the spend figures are absent when nothing can be priced, so they are not required
    expect(schema.required ?? []).not.toContain('extra_per_day_cents');
    expect(schema.required ?? []).toContain('preview_hash');
    const put = doc.paths['/api/v1/account/build-concurrency']!.put!;
    expect(put.responses['409']!.description).toMatch(/preview_required/);
    expect(put.responses['409']!.description).toMatch(/preview_stale/);
    expect(doc.paths['/api/v1/repos/{id}/build-concurrency/preview']!.post!.operationId).toBe('previewRepoBuildConcurrency');
  });
});
