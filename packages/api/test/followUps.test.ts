import { randomUUID } from 'node:crypto';
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

/**
 * [api] D#483 S5-b2d-1, C27-b2d1-6: the follow-up switch and an item's follow-up list, through the real `handleApiRequest` against real Postgres (RLS, the
 * owner/admin definer and its audit row). Nothing stubs a database answer.
 */
describe('D#483 S5-b2d-1: follow-up routes', () => {
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

  async function call(who: Identity, method: string, urlPath: string, opts: { body?: unknown; bearer?: string; key?: string } = {}): Promise<Response> {
    const headers = new Headers();
    if (opts.bearer) headers.set('authorization', `Bearer ${opts.bearer}`);
    else headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(who)}`);
    if (opts.body !== undefined) headers.set('content-type', 'application/json');
    if (opts.key) headers.set('idempotency-key', opts.key);
    const req = new Request(`http://localhost/api/v1${urlPath}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
    return handleApiRequest(req, appUserPool, platformOpsPool, ROUTES);
  }
  async function addMember(accountId: string, role: 'admin' | 'member'): Promise<Identity> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, userId, role]);
    return { accountId, userId };
  }
  async function fixture() {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const repoId = (await admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, NULL, $2, 'web') RETURNING id`, [owner.accountId, Math.floor(Math.random() * 1e9)])).rows[0]!.id;
    return { owner, admin: await addMember(owner.accountId, 'admin'), member: await addMember(owner.accountId, 'member'), repoId };
  }
  const put = (who: Identity, repoId: string, children: unknown, key: string | undefined = randomUUID()) => call(who, 'PUT', `/repos/${repoId}/follow-ups/setting`, { body: { children }, key });
  const audit = async (accountId: string) =>
    (await admin.query(`SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'follow_up_setting.changed' ORDER BY created_at, id`, [accountId])).rows;
  const versions = async (accountId: string) => (await admin.query(`SELECT children, version, changed_by FROM follow_up_settings WHERE account_id = $1 ORDER BY version`, [accountId])).rows;

  it('GET with no stored value answers on, as the default; any member and a read token may read it', async () => {
    const f = await fixture();
    for (const who of [f.owner, f.member]) {
      const res = await call(who, 'GET', `/repos/${f.repoId}/follow-ups/setting`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ children: true, default: true });
    }
    const plaintext = generateToken();
    await insertApiToken(appUserPool, { accountId: f.owner.accountId, createdBy: f.owner.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes: ['read'], expiresAt: new Date(Date.now() + 86_400_000) });
    const viaToken = await call(f.owner, 'GET', `/repos/${f.repoId}/follow-ups/setting`, { bearer: plaintext });
    expect(viaToken.status).toBe(200);
    // A token can never write it.
    expect((await call(f.owner, 'PUT', `/repos/${f.repoId}/follow-ups/setting`, { body: { children: false }, key: randomUUID(), bearer: plaintext })).status).toBe(403);
  });

  it('PUT by a member is 403 and writes nothing; by an admin it writes a version and an audit row naming the actor and both values', async () => {
    const f = await fixture();
    expect((await put(f.member, f.repoId, false)).status).toBe(403);
    expect(await versions(f.owner.accountId)).toEqual([]);
    const res = await put(f.admin, f.repoId, false);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ children: false, default: false });
    expect(await versions(f.owner.accountId)).toEqual([{ children: false, version: 1, changed_by: f.admin.userId }]);
    expect(await audit(f.owner.accountId)).toEqual([{ actor: f.admin.userId, payload: { repo_id: f.repoId, previous: true, children: false, version: 1 } }]);
    // The value in force again writes nothing; switching back is the undo and is its own version.
    expect((await put(f.owner, f.repoId, false)).status).toBe(200);
    expect(await versions(f.owner.accountId)).toHaveLength(1);
    expect(await (await put(f.owner, f.repoId, true)).json()).toEqual({ children: true, default: false });
    expect((await audit(f.owner.accountId)).map((r) => r.payload)).toEqual([
      { repo_id: f.repoId, previous: true, children: false, version: 1 },
      { repo_id: f.repoId, previous: false, children: true, version: 2 },
    ]);
  });

  it('the route itself is owner or admin and session only (the definer refusing a member is the second gate, not the only one)', () => {
    const put = ROUTES.find((r) => r.operationId === 'setFollowUpSetting')!;
    expect({ minRole: put.minRole, principals: put.principals, idempotency: put.idempotency }).toEqual({ minRole: 'admin', principals: ['session'], idempotency: 'required' });
    for (const id of ['getFollowUpSetting', 'listWorkItemFollowUps']) {
      const r = ROUTES.find((x) => x.operationId === id)!;
      expect({ minRole: r.minRole, scope: r.scope }).toEqual({ minRole: 'member', scope: 'read' });
    }
  });

  it('PUT needs an Idempotency-Key, a boolean body, and a repo of the account', async () => {
    const f = await fixture();
    expect((await put(f.admin, f.repoId, false, '')).status).toBe(400);
    expect((await put(f.admin, f.repoId, 'no')).status).toBe(422);
    const other = await fixture();
    expect((await put(f.admin, other.repoId, false)).status).toBe(404);
    expect(await versions(f.owner.accountId)).toEqual([]);
  });

  it('the work item list: oldest first, text and fixed words only, no run id and never null or undefined', async () => {
    const f = await fixture();
    const item = (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, title, provenance) VALUES ($1, $2, 'feature', 'parent', 'internal') RETURNING id`, [f.owner.accountId, f.repoId])).rows[0]!.id;
    const run = (await admin.query<{ id: string }>(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status) VALUES ($1, $2, 'code-reviewer', 'local', 'succeeded') RETURNING id`, [f.owner.accountId, item])).rows[0]!.id;
    for (const [title, why, disposition, at] of [['Add a retry', 'flaky network', 'child', '2026-11-01T10:00:00Z'], ['Log it', '', 'note', '2026-11-01T11:00:00Z']] as const) {
      await admin.query(
        `INSERT INTO work_item_follow_ups (account_id, work_item_id, source_run_id, source_role, title, why, title_key, disposition, created_at) VALUES ($1, $2, $3, 'code-reviewer', $4, $5, encode(sha256(convert_to($4, 'UTF8')), 'hex'), $6, $7)`,
        [f.owner.accountId, item, run, title, why, disposition, at],
      );
    }
    // A second item of the same account with a follow-up of its own: it must not appear in the first item's list.
    const sibling = (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, title, provenance) VALUES ($1, $2, 'feature', 'sibling', 'internal') RETURNING id`, [f.owner.accountId, f.repoId])).rows[0]!.id;
    await admin.query(
      `INSERT INTO work_item_follow_ups (account_id, work_item_id, source_role, title, why, title_key, disposition) VALUES ($1, $2, 'executor', 'Belongs to the sibling', '', repeat('b', 64), 'note')`,
      [f.owner.accountId, sibling],
    );
    const siblingRes = await call(f.member, 'GET', `/work-items/${sibling}/follow-ups`);
    expect(((await siblingRes.json()) as { follow_ups: { title: string }[] }).follow_ups.map((x) => x.title)).toEqual(['Belongs to the sibling']);
    const res = await call(f.member, 'GET', `/work-items/${item}/follow-ups`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      work_item_id: item,
      follow_ups: [
        { title: 'Add a retry', why: 'flaky network', disposition: 'child', source_role: 'code-reviewer', source_label: 'Code reviewer', created_at: '2026-11-01T10:00:00.000Z' },
        { title: 'Log it', why: '', disposition: 'note', source_role: 'code-reviewer', source_label: 'Code reviewer', created_at: '2026-11-01T11:00:00.000Z' },
      ],
    });
    expect(text).not.toContain(run);
    expect(text).not.toMatch(/null|undefined|NaN/);
    // Another account's member sees nothing of it.
    const stranger = await seedAccountWithMember(admin, { role: 'owner' });
    expect((await call(stranger, 'GET', `/work-items/${item}/follow-ups`)).status).toBe(404);
    expect((await call(f.member, 'GET', `/work-items/not-a-uuid/follow-ups`)).status).toBe(404);
  });
});
