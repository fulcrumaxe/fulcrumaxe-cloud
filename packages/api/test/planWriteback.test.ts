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
 * [api] D#598 P5c-a: the plan-update merge switch through the real `handleApiRequest` against real Postgres (RLS, the owner/admin insert policy and
 * the audit row). Nothing stubs a database answer.
 */
describe('D#598 P5c-a: plan write-back setting routes', () => {
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
  const path = (repoId: string) => `/repos/${repoId}/plan-writeback/setting`;
  const get = (who: Identity, repoId: string) => call(who, 'GET', path(repoId));
  const put = (who: Identity, repoId: string, autoMerge: unknown, key: string | undefined = randomUUID()) => call(who, 'PUT', path(repoId), { body: { auto_merge: autoMerge }, key });
  const audit = async (accountId: string) =>
    (await admin.query(`SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'plan_writeback_setting.changed' ORDER BY created_at, id`, [accountId])).rows;
  const versions = async (accountId: string) => (await admin.query(`SELECT auto_merge, version, changed_by FROM plan_writeback_settings WHERE account_id = $1 ORDER BY version`, [accountId])).rows;

  it('P5c-a-2: GET with no stored value answers off as the default, with no null or undefined; any member and a read token may read it', async () => {
    const f = await fixture();
    for (const who of [f.owner, f.member]) {
      const res = await get(who, f.repoId);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ auto_merge: false, default: true });
      expect(text).not.toMatch(/null|undefined/);
    }
    const plaintext = generateToken();
    await insertApiToken(appUserPool, { accountId: f.owner.accountId, createdBy: f.owner.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes: ['read'], expiresAt: new Date(Date.now() + 86_400_000) });
    expect((await call(f.owner, 'GET', path(f.repoId), { bearer: plaintext })).status).toBe(200);
    // A token can never write it, and neither can a plain member.
    expect((await call(f.owner, 'PUT', path(f.repoId), { body: { auto_merge: true }, key: randomUUID(), bearer: plaintext })).status).toBe(403);
    expect((await put(f.member, f.repoId, true)).status).toBe(403);
    expect(await versions(f.owner.accountId)).toEqual([]);
  });

  it('P5c-a-1: an admin write makes version 1 and an audit row naming the actor and both values; the owner turning it off is version 2', async () => {
    const f = await fixture();
    const res = await put(f.admin, f.repoId, true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ auto_merge: true, default: false });
    expect(await versions(f.owner.accountId)).toEqual([{ auto_merge: true, version: 1, changed_by: f.admin.userId }]);
    expect(await (await put(f.owner, f.repoId, false)).json()).toEqual({ auto_merge: false, default: false });
    expect(await (await get(f.member, f.repoId)).json()).toEqual({ auto_merge: false, default: false });
    expect((await audit(f.owner.accountId)).map((r) => [r.actor, r.payload])).toEqual([
      [f.admin.userId, { actor: f.admin.userId, repo_id: f.repoId, version: 1, previous: false, new: true }],
      [f.owner.userId, { actor: f.owner.userId, repo_id: f.repoId, version: 2, previous: true, new: false }],
    ]);
  });

  it('P5c-a-2: the same Idempotency-Key replays the first answer and writes once; the value already in force writes nothing', async () => {
    const f = await fixture();
    const key = randomUUID();
    const first = await put(f.admin, f.repoId, true, key);
    const again = await put(f.admin, f.repoId, true, key);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect(await again.json()).toEqual(await first.json());
    // The key is bound to its first body: a different body under the same key is refused, not written.
    const reused = await put(f.admin, f.repoId, false, key);
    expect(reused.status).toBe(422);
    expect(await versions(f.owner.accountId)).toHaveLength(1);
    // A fresh key with the value in force answers the current row and adds no version and no audit row.
    const same = await put(f.owner, f.repoId, true);
    expect(same.status).toBe(200);
    expect(await same.json()).toEqual({ auto_merge: true, default: false });
    expect(await versions(f.owner.accountId)).toHaveLength(1);
    expect(await audit(f.owner.accountId)).toHaveLength(1);
  });

  it('the route itself is owner or admin and session only, with a required key; the read is member', () => {
    const w = ROUTES.find((r) => r.operationId === 'setPlanWritebackSetting')!;
    expect({ minRole: w.minRole, principals: w.principals, idempotency: w.idempotency }).toEqual({ minRole: 'admin', principals: ['session'], idempotency: 'required' });
    const r = ROUTES.find((x) => x.operationId === 'getPlanWritebackSetting')!;
    expect({ minRole: r.minRole, scope: r.scope }).toEqual({ minRole: 'member', scope: 'read' });
  });

  it('PUT needs an Idempotency-Key, a boolean body with no extra field, and a repo of the account; a malformed id is a 404', async () => {
    const f = await fixture();
    expect((await put(f.admin, f.repoId, true, '')).status).toBe(400);
    for (const bad of ['yes', null, 1]) expect((await put(f.admin, f.repoId, bad)).status, JSON.stringify(bad)).toBe(422);
    expect((await call(f.admin, 'PUT', path(f.repoId), { body: { auto_merge: true, extra: 1 }, key: randomUUID() })).status).toBe(422);
    const other = await fixture();
    expect((await put(f.admin, other.repoId, true)).status).toBe(404);
    expect((await get(f.admin, other.repoId)).status).toBe(404);
    expect((await get(f.admin, 'not-a-uuid')).status).toBe(404);
    expect(await versions(f.owner.accountId)).toEqual([]);
  });
});
