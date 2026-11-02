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
import { followUpItemDeps } from '../src/routes/followUps.js';
import { FOLLOW_UP_CHILD_START_SUPPORTED } from '@fx/pipeline';

// Read at module load, before any beforeAll injects a value: this is the route's own default.
const ROUTE_DEFAULT_START_SUPPORTED = followUpItemDeps.startSupported;
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
    followUpItemDeps.startSupported = true; // C29: the make-item tests run with the flag injected true; the flag-false test sets it back
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
  });
  afterAll(async () => {
    followUpItemDeps.startSupported = false;
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
    for (const id of ['setFollowUpSetting', 'makeFollowUpItem']) {
      const w = ROUTES.find((r) => r.operationId === id)!;
      expect({ minRole: w.minRole, principals: w.principals, idempotency: w.idempotency }).toEqual({ minRole: 'admin', principals: ['session'], idempotency: 'required' });
    }
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
    const ids: string[] = [];
    for (const [title, why, disposition, at] of [['Add a retry', 'flaky network', 'child', '2026-11-01T10:00:00Z'], ['Log it', '', 'note', '2026-11-01T11:00:00Z']] as const) {
      const made = await admin.query<{ id: string }>(
        `INSERT INTO work_item_follow_ups (account_id, work_item_id, source_run_id, source_role, title, why, title_key, disposition, created_at) VALUES ($1, $2, $3, 'code-reviewer', $4, $5, encode(sha256(convert_to($4, 'UTF8')), 'hex'), $6, $7) RETURNING id`,
        [f.owner.accountId, item, run, title, why, disposition, at],
      );
      ids.push(made.rows[0]!.id);
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
      can_make_item: false,
      make_item_available: true,
      follow_ups: [
        { id: ids[0], title: 'Add a retry', why: 'flaky network', disposition: 'child', source_role: 'code-reviewer', source_label: 'Code reviewer', created_at: '2026-11-01T10:00:00.000Z', state: 'pending' },
        { id: ids[1], title: 'Log it', why: '', disposition: 'note', source_role: 'code-reviewer', source_label: 'Code reviewer', created_at: '2026-11-01T11:00:00.000Z', state: 'note' },
      ],
    });
    expect(text).not.toContain(run);
    expect(text).not.toMatch(/null|undefined|NaN/);
    // Another account's member sees nothing of it.
    const stranger = await seedAccountWithMember(admin, { role: 'owner' });
    expect((await call(stranger, 'GET', `/work-items/${item}/follow-ups`)).status).toBe(404);
    expect((await call(f.member, 'GET', `/work-items/not-a-uuid/follow-ups`)).status).toBe(404);
  });

  // ---- D#483 S5-b2d-2c (C28-2c-1): "Make it an item" ----
  async function parentWithNote(f: Awaited<ReturnType<typeof fixture>>, stage = 'triaged') {
    const parent = (await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, title, provenance, stage) VALUES ($1, $2, 'feature', 'parent', 'internal', $3) RETURNING id`, [f.owner.accountId, f.repoId, stage])).rows[0]!.id;
    const fu = (
      await admin.query<{ id: string }>(
        `INSERT INTO work_item_follow_ups (account_id, work_item_id, source_role, title, why, title_key, disposition) VALUES ($1, $2, 'executor', 'Log the timeout', 'why', repeat('c', 64), 'note') RETURNING id`,
        [f.owner.accountId, parent],
      )
    ).rows[0]!.id;
    return { parent, fu };
  }
  const make = (who: Identity, parent: string, fu: string, key: string | undefined = randomUUID(), bearer?: string) => call(who, 'POST', `/work-items/${parent}/follow-ups/${fu}/make-item`, { key, bearer });
  const childrenOf = async (fu: string) => (await admin.query(`SELECT id, parent_id, kind FROM work_items WHERE follow_up_id = $1`, [fu])).rows;

  it('make-item by an admin creates one child and records the actor; a repeat with the same key or another answers the same child', async () => {
    const f = await fixture();
    const { parent, fu } = await parentWithNote(f);
    const key = randomUUID();
    const first = await make(f.admin, parent, fu, key);
    expect(first.status).toBe(200);
    const body = (await first.json()) as { child_id: string; created: boolean; work_item_id: string; follow_up_id: string };
    expect(body).toMatchObject({ work_item_id: parent, follow_up_id: fu, created: true });
    expect(await childrenOf(fu)).toEqual([{ id: body.child_id, parent_id: parent, kind: 'small' }]);
    const audit = await admin.query(`SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'follow_up.made_item'`, [f.owner.accountId]);
    expect(audit.rows).toEqual([{ actor: f.admin.userId, payload: { follow_up_id: fu, child_id: body.child_id } }]);
    const again = await make(f.admin, parent, fu, key);
    expect(await again.json()).toEqual(body);
    const fresh = await make(f.owner, parent, fu);
    expect(((await fresh.json()) as { child_id: string; created: boolean })).toEqual({ ...body, created: false });
    expect(await childrenOf(fu)).toHaveLength(1);
    // The list now links the child.
    const list = (await (await call(f.admin, 'GET', `/work-items/${parent}/follow-ups`)).json()) as { can_make_item: boolean; follow_ups: { state: string; child_id: string; child_stage: string }[] };
    expect(list.can_make_item).toBe(true);
    expect(list.follow_ups[0]).toMatchObject({ state: 'item', child_id: body.child_id, child_stage: 'triaged' });
  });

  it('make-item by a member is 403 and creates nothing; a token is refused; a missing key is 400', async () => {
    const f = await fixture();
    const { parent, fu } = await parentWithNote(f);
    expect((await make(f.member, parent, fu)).status).toBe(403);
    const plaintext = generateToken();
    await insertApiToken(appUserPool, { accountId: f.owner.accountId, createdBy: f.owner.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...mk', scopes: ['read'], expiresAt: new Date(Date.now() + 86_400_000) });
    expect((await make(f.owner, parent, fu, randomUUID(), plaintext)).status).toBe(403);
    expect((await make(f.admin, parent, fu, '')).status).toBe(400);
    expect(await childrenOf(fu)).toEqual([]);
  });

  it('C29: the route\'s default is exactly pipeline\'s flag, not a value of its own (the tests inject true, so this is the only check of the default)', () => {
    expect(ROUTE_DEFAULT_START_SUPPORTED).toBe(FOLLOW_UP_CHILD_START_SUPPORTED);
  });

  it('C29-2c-1: with the flag false make-item answers 409 follow_up_items_unavailable, calls no definer and writes nothing; the list says so', async () => {
    const f = await fixture();
    const { parent, fu } = await parentWithNote(f);
    followUpItemDeps.startSupported = false;
    try {
      const res = await make(f.admin, parent, fu);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: { code: string; message: string } }).error).toMatchObject({ code: 'follow_up_items_unavailable', message: 'Follow-ups become items in a later release.' });
      expect(await childrenOf(fu)).toEqual([]);
      expect((await admin.query(`SELECT 1 FROM audit_log WHERE account_id = $1 AND action = 'follow_up.made_item'`, [f.owner.accountId])).rowCount).toBe(0);
      const list = (await (await call(f.admin, 'GET', `/work-items/${parent}/follow-ups`)).json()) as { make_item_available: boolean };
      expect(list.make_item_available).toBe(false);
    } finally {
      followUpItemDeps.startSupported = true;
    }
  });

  it('make-item from another account answers 404 not_found, the same as an unknown id, and creates nothing', async () => {
    const f = await fixture();
    const { parent, fu } = await parentWithNote(f);
    const stranger = await seedAccountWithMember(admin, { role: 'owner' });
    const cross = await make(stranger, parent, fu);
    const unknown = await make(stranger, parent, randomUUID());
    expect(cross.status).toBe(404);
    const strip = (b: { error: Record<string, unknown> }) => ({ ...b.error, request_id: undefined });
    expect(strip((await cross.json()) as { error: Record<string, unknown> })).toEqual(strip((await unknown.json()) as { error: Record<string, unknown> }));
    expect(((await (await make(stranger, parent, fu)).json()) as { error: { code: string } }).error.code).toBe('not_found');
    expect(await childrenOf(fu)).toEqual([]);
  });

  it('make-item: unknown ids and another item\'s follow-up are 404, a closed parent is 409 and makes nothing', async () => {
    const f = await fixture();
    const { parent, fu } = await parentWithNote(f);
    const other = await parentWithNote(f);
    expect((await make(f.admin, parent, other.fu)).status).toBe(404);
    expect((await make(f.admin, parent, randomUUID())).status).toBe(404);
    expect((await make(f.admin, 'nope', fu)).status).toBe(404);
    const closed = await parentWithNote(f, 'closed');
    const res = await make(f.admin, closed.parent, closed.fu);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('parent_closed');
    expect(await childrenOf(closed.fu)).toEqual([]);
    const list = (await (await call(f.admin, 'GET', `/work-items/${closed.parent}/follow-ups`)).json()) as { follow_ups: { state: string }[] };
    expect(list.follow_ups[0]!.state).toBe('parent_closed');
  });
});
