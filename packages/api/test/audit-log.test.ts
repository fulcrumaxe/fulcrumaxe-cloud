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

const FX_SESSION_SECRET = 's'.repeat(32);
const URL_BASE = 'http://localhost/api/v1/audit-log';

interface AuditPage {
  data: { id: string; action: string; actor: string | null; payload: unknown; created_at: string }[];
  next_cursor: string | null;
}

/**
 * Every action the audit_write* allowlists on main can write, each with the
 * payload shape its real writer sends (audit_write in 0651, audit_write_api_tokens
 * in 0621, audit_write_webhook_endpoints in 0628, and the platform_ops-only
 * webhook_endpoint.disabled in 0631). `webhook_delivery.redelivered` is
 * allowlisted but has no writer in src yet, so its payload here is the obvious
 * id-only shape.
 */
function realPayloads(userId: string): [string, string, Record<string, unknown>][] {
  const id = randomUUID();
  return [
    ['decision_dial_changed', userId, { actor: userId, decision_type: 'merge', repo_id: id, previous: 'ask', new: 'act' }],
    ['model_connection.connect', userId, { provider: 'anthropic', fingerprint: 'ab12cd34ef56' }],
    ['model_connection.replace', userId, { provider: 'anthropic', fingerprint: '99aa88bb77cc' }],
    ['model_connection.remove', userId, {}],
    ['role_settings.mode_changed', userId, { repoId: id, role: 'build', mode: 'suggest' }],
    ['role_settings.guard_changed', userId, { repoId: id, before: { blockExternalAutoMerge: true }, after: { blockExternalAutoMerge: false } }],
    ['role_settings.model_changed', userId, { repoId: id, role: 'build', before: null, after: 'sonnet' }],
    ['run_limits.changed', userId, { role: 'default', before: { max_turns: 40 }, after: { max_turns: 60 } }],
    ['api_token.created', userId, { token_id: id, scopes: ['read', 'audit:read'], expires_at: '2026-12-01T00:00:00.000Z' }],
    ['api_token.revoked', userId, { token_id: id, reason: 'user' }],
    ['webhook_endpoint.created', userId, { endpoint_id: id }],
    ['webhook_endpoint.updated', userId, { endpoint_id: id }],
    ['webhook_endpoint.deleted', userId, { endpoint_id: id }],
    ['webhook_endpoint.secret_rotated', userId, { endpoint_id: id }],
    ['webhook_endpoint.test_sent', userId, { endpoint_id: id, ok: true, status_code: 200 }],
    ['webhook_delivery.redelivered', userId, { endpoint_id: id, delivery_id: randomUUID() }],
    ['webhook_endpoint.disabled', 'platform_ops', { endpoint_id: id, reason: 'failing' }],
  ];
}

/** D#31 API-7b: `GET /api/v1/audit-log` through the real `handleApiRequest` dispatcher. */
describe('D#31 API-7b: audit-log route', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = FX_SESSION_SECRET;
  });

  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await adminPool.end();
    await platformOpsPool.end();
    await appUserPool.end();
  });

  async function sessionGet(identity: { userId: string; accountId: string }, query = ''): Promise<Response> {
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(identity)}` });
    return handleApiRequest(new Request(`${URL_BASE}${query}`, { headers }), appUserPool, platformOpsPool, ROUTES);
  }

  async function mintToken(identity: { accountId: string; userId: string }, scopes: ('read' | 'audit:read')[]): Promise<string> {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, {
      accountId: identity.accountId,
      createdBy: identity.userId,
      tokenHash: hashToken(plaintext),
      displayHint: 'fxat_...test',
      scopes,
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    });
    return plaintext;
  }

  async function tokenGet(plaintext: string, query = ''): Promise<Response> {
    const headers = new Headers({ authorization: `Bearer ${plaintext}` });
    return handleApiRequest(new Request(`${URL_BASE}${query}`, { headers }), appUserPool, platformOpsPool, ROUTES);
  }

  async function insertAudit(accountId: string, actor: string | null, action: string, payload: unknown, createdAt?: string): Promise<string> {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO audit_log (account_id, actor, action, payload, created_at) VALUES ($1, $2, $3, $4::jsonb, COALESCE($5::timestamptz, clock_timestamp())) RETURNING id`,
      [accountId, actor, action, JSON.stringify(payload), createdAt ?? null],
    );
    return rows[0]!.id;
  }

  async function addMember(accountId: string, role: 'admin' | 'member'): Promise<{ accountId: string; userId: string }> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, userId, role]);
    return { accountId, userId };
  }

  it('an owner session and an admin session both get 200 with no-store; items carry exactly the five fields', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const adminUser = await addMember(owner.accountId, 'admin');
    await insertAudit(owner.accountId, owner.userId, 'model_connection.remove', {});
    for (const who of [owner, adminUser]) {
      const res = await sessionGet(who);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      const body = (await res.json()) as AuditPage;
      expect(body.data).toHaveLength(1);
      expect(Object.keys(body.data[0]!).sort()).toEqual(['action', 'actor', 'created_at', 'id', 'payload']);
      expect(body.next_cursor).toBeNull();
    }
  });

  it('a member session -> 403 insufficient_role', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const member = await addMember(owner.accountId, 'member');
    const res = await sessionGet(member);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('insufficient_role');
  });

  it('a read token -> 403 insufficient_scope; an audit:read token -> 200', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    await insertAudit(owner.accountId, owner.userId, 'model_connection.remove', {});
    const denied = await tokenGet(await mintToken(owner, ['read']));
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: { code: string } }).error.code).toBe('insufficient_scope');
    const ok = await tokenGet(await mintToken(owner, ['audit:read']));
    expect(ok.status).toBe(200);
    // Minting a token audits itself (api_token.created), so the page holds the seeded row plus those.
    const okActions = ((await ok.json()) as AuditPage).data.map((r) => r.action);
    expect(okActions).toContain('model_connection.remove');
    expect(okActions.filter((a) => a !== 'model_connection.remove' && a !== 'api_token.created')).toEqual([]);
  });

  it("never shows another account's rows to a session or a token", async () => {
    const a = await seedAccountWithMember(admin, { role: 'owner' });
    const b = await seedAccountWithMember(admin, { role: 'owner' });
    const aId = await insertAudit(a.accountId, a.userId, 'a.only', {});
    const bId = await insertAudit(b.accountId, b.userId, 'b.only', {});
    const viaSession = (await (await sessionGet(a)).json()) as AuditPage;
    expect(viaSession.data.map((r) => r.id)).toEqual([aId]);
    const viaToken = (await (await tokenGet(await mintToken(b, ['audit:read']))).json()) as AuditPage;
    // Minting b's token wrote its own api_token.created row into b's log; a's rows must still be absent.
    expect(viaToken.data.map((r) => r.id)).toContain(bId);
    expect(viaToken.data.map((r) => r.id)).not.toContain(aId);
    expect(viaToken.data.map((r) => r.action).filter((x) => x !== 'b.only' && x !== 'api_token.created')).toEqual([]);
  });

  it('paginates newest first through next_cursor with no duplicate or skip, and rejects a bad limit or cursor with 422', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.unshift(await insertAudit(owner.accountId, owner.userId, `page.${i}`, { i }, `2026-05-01T00:00:0${i}Z`));
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 5; guard++) {
      const body = (await (await sessionGet(owner, `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)).json()) as AuditPage;
      seen.push(...body.data.map((r) => r.id));
      cursor = body.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(ids);
    expect((await sessionGet(owner, '?limit=201')).status).toBe(422);
    expect((await sessionGet(owner, '?cursor=not-a-cursor')).status).toBe(422);
  });

  it('payload exposure: one row per allowlisted action, and no response body contains a secret-shaped value', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const rows = realPayloads(owner.userId);
    for (const [action, actor, payload] of rows) {
      await insertAudit(owner.accountId, actor, action, payload);
    }
    const res = await sessionGet(owner, '?limit=200');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(((JSON.parse(text) as AuditPage).data.map((r) => r.action)).sort()).toEqual(rows.map((r) => r[0]).sort());
    expect(text).not.toMatch(/(?<![A-Za-z0-9])(ghs_|sk-|sk_live_|whsec_|-----BEGIN|cus_|sub_|pi_)/);
  });
});
