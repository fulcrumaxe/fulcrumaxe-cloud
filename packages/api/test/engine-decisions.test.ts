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

/** [pg] EB-9a: POST /api/v1/engine/decisions/{id}/answer through the real handler, RLS and audit function. */
describe('EB-9a: answering an engine decision', () => {
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
    await Promise.all([adminPool.end(), appUserPool.end(), platformOpsPool.end()]);
  });

  async function call(identity: Identity, urlPath: string, body: unknown, bearer?: string): Promise<Response> {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (bearer) headers.set('authorization', `Bearer ${bearer}`);
    else headers.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(identity)}`);
    return handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { method: 'POST', headers, body: JSON.stringify(body) }), appUserPool, platformOpsPool, ROUTES);
  }

  async function member(accountId: string, role: 'admin' | 'member'): Promise<Identity> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [accountId, userId, role]);
    return { accountId, userId };
  }

  async function fixture() {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const repo = (await admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, NULL, $2, 'web') RETURNING id`, [owner.accountId, Math.floor(Math.random() * 1e9)])).rows[0]!.id;
    return { owner, admin: await member(owner.accountId, 'admin'), member: await member(owner.accountId, 'member'), repo };
  }
  const decision = async (accountId: string, repo: string, disposition = 'ask') =>
    (await admin.query<{ id: string }>(
      `INSERT INTO engine_decisions (account_id, repo_id, decision_type, request_key, subject, disposition, catalogue_version, preset)
       VALUES ($1, $2, 'engine_merge', $3, '{"pr":1}'::jsonb, $4, 11, 'default') RETURNING id`,
      [accountId, repo, `k:${randomUUID().slice(0, 8)}`, disposition],
    )).rows[0]!.id;
  const answers = async (id: string) => (await admin.query('SELECT choice, answered_by FROM engine_decision_answers WHERE decision_id = $1', [id])).rows;
  const audits = async (accountId: string) => (await admin.query("SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'engine_decision.answered'", [accountId])).rows;
  const path = (id: string) => `/engine/decisions/${id}/answer`;

  it('no login is 401 and nothing is stored', async () => {
    const f = await fixture();
    const a = await decision(f.owner.accountId, f.repo);
    const res = await handleApiRequest(new Request(`http://localhost/api/v1${path(a)}`, { method: 'POST', headers: new Headers({ 'content-type': 'application/json' }), body: JSON.stringify({ choice: 'approve' }) }), appUserPool, platformOpsPool, ROUTES);
    expect(res.status).toBe(401);
    expect(await answers(a)).toEqual([]);
  });

  it('an owner and an admin answer once, in their own name, with one audit row of ids and enums', async () => {
    const f = await fixture();
    const a = await decision(f.owner.accountId, f.repo);
    const res = await call(f.admin, path(a), { choice: 'approve' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ decision_id: a, choice: 'approve' });
    expect(await answers(a)).toEqual([{ choice: 'approve', answered_by: f.admin.userId }]);
    const rows = await audits(f.owner.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: f.admin.userId, payload: { repo_id: f.repo, decision_type: 'engine_merge', outcome: 'approve' } });
    const b = await decision(f.owner.accountId, f.repo);
    expect((await call(f.owner, path(b), { choice: 'decline' })).status).toBe(200);
  });

  it('a second answer is 409 and the first stands, with no second audit row', async () => {
    const f = await fixture();
    const a = await decision(f.owner.accountId, f.repo);
    await call(f.owner, path(a), { choice: 'decline' });
    const again = await call(f.owner, path(a), { choice: 'approve' });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('already_answered');
    expect(await answers(a)).toEqual([{ choice: 'decline', answered_by: f.owner.userId }]);
    expect(await audits(f.owner.accountId)).toHaveLength(1);
  });

  it('a member is 403, a token is refused, nothing is written', async () => {
    const f = await fixture();
    const a = await decision(f.owner.accountId, f.repo);
    expect((await call(f.member, path(a), { choice: 'approve' })).status).toBe(403);
    const token = generateToken();
    await insertApiToken(appUserPool, { accountId: f.owner.accountId, createdBy: f.owner.userId, tokenHash: hashToken(token), displayHint: 'fxat_...test', scopes: ['read'], expiresAt: new Date(Date.now() + 86_400_000) });
    const viaToken = await call(f.owner, path(a), { choice: 'approve' }, token);
    expect(viaToken.status).toBe(403);
    expect(await answers(a)).toEqual([]);
    expect(await audits(f.owner.accountId)).toHaveLength(0);
  });

  it('a decision already settled by the dial is 409 not_asked; unknown, malformed and foreign ids are 404', async () => {
    const f = await fixture();
    const other = await fixture();
    const acted = await decision(f.owner.accountId, f.repo, 'act');
    const res = await call(f.owner, path(acted), { choice: 'approve' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_asked');
    expect((await call(f.owner, path(randomUUID()), { choice: 'approve' })).status).toBe(404);
    expect((await call(f.owner, path('not-a-uuid'), { choice: 'approve' })).status).toBe(404);
    const foreign = await decision(other.owner.accountId, other.repo);
    expect((await call(f.owner, path(foreign), { choice: 'approve' })).status).toBe(404);
    expect(await answers(foreign)).toEqual([]);
  });

  it('only approve or decline, and nothing else in the body', async () => {
    const f = await fixture();
    const a = await decision(f.owner.accountId, f.repo);
    for (const body of [{ choice: 'defer' }, { choice: 'approve', note: 'x' }, {}, { choice: 1 }]) expect((await call(f.owner, path(a), body)).status, JSON.stringify(body)).toBe(422);
    expect(await answers(a)).toEqual([]);
  });

  it('when the audit row cannot be written the answer is not stored', async () => {
    const f = await fixture();
    const a = await decision(f.owner.accountId, f.repo);
    await admin.query("CREATE OR REPLACE FUNCTION eb9a_block_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'engine_decision.answered' THEN RAISE EXCEPTION 'blocked'; END IF; RETURN NEW; END $$");
    await admin.query('CREATE TRIGGER eb9a_block_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION eb9a_block_audit()');
    try {
      const res = await call(f.owner, path(a), { choice: 'approve' });
      expect(res.status).toBe(500);
      expect(await answers(a)).toEqual([]);
    } finally {
      await admin.query('DROP TRIGGER eb9a_block_audit ON audit_log');
      await admin.query('DROP FUNCTION eb9a_block_audit()');
    }
  });
});
