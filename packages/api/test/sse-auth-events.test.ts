import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken, revokeToken } from '@fx/core/src/tokens/service.js';
import { bumpSessionEpoch } from '@fx/core/src/auth/identity.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { WEBHOOK_EVENT_TYPES, fanOutPendingEvents } from '@fx/webhooks';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { openCursor } from '../src/sse/cursor.js';
import { AccountPoller } from '../src/sse/poller.js';
import { handleEventsRequest, type StreamDeps } from '../src/sse/stream.js';
import { SESSION_STREAMS_PER_USER } from '../src/sse/leases.js';
import { STREAM_INTERNAL_EVENT_TYPES } from '../src/sse/views.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';
import { countingPool, eventually, openSse, sleep, startServer, type CountingPool, type SseConnection, type TestServer } from './helpers/sse.js';

const CURSOR_KEY = randomBytes(32).toString('base64');
const TOKEN_NAME = 'laptop-deploy-key-7c1';
const DISPLAY_HINT = 'fxat_...Zq93';
/** Far below the 60 s re-check tick: a `revoked` frame inside this window can only come from the immediate re-check. */
const FAST_MS = 5_000;

/** D#31 C25 (API-5c) criteria 5-9: token and session events on the account stream, against real HTTP and Postgres. */
describe('account stream: token and session events (API-5c)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let app: Pool;
  let ops: Pool;
  let server: TestServer;
  let counted: { app: CountingPool; ops: CountingPool; server: TestServer };
  const open: SseConnection[] = [];

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    app = createPool(process.env.API_DATABASE_URL_APP_USER!);
    ops = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
    process.env.FX_CURSOR_KEY_V1 = CURSOR_KEY;
    process.env.FX_WEBHOOK_KEK_V1 = Buffer.alloc(32, 3).toString('base64');
    const build = (pool: Pool, opsPool: Pool): StreamDeps => ({
      pool,
      platformOpsPool: opsPool,
      poller: new AccountPoller({ pool, platformOpsPool: opsPool, activeIntervalMs: 40, idleIntervalMs: 40 }),
    });
    const plain = build(app, ops);
    server = await startServer((req) => handleEventsRequest(req, { kind: 'account' }, plain));
    const cApp = countingPool(app);
    const cOps = countingPool(ops);
    const cdeps = build(cApp.pool, cOps.pool);
    counted = { app: cApp, ops: cOps, server: await startServer((req) => handleEventsRequest(req, { kind: 'account' }, cdeps)) };
  });

  afterEach(() => {
    for (const c of open.splice(0)) c.abort();
  });

  afterAll(async () => {
    await server.close();
    await counted.server.close();
    for (const k of ['FX_SESSION_SECRET', 'FX_CURSOR_KEY_V1', 'FX_WEBHOOK_KEK_V1']) delete process.env[k];
    admin.release();
    await adminPool.end();
    await app.end();
    await ops.end();
  });

  const cookie = async (id: { userId: string; accountId: string }): Promise<string> =>
    `${SESSION_COOKIE_NAME}=${await signSession(id, process.env, { epoch: 0 })}`;

  async function connect(srv: TestServer, headers: Record<string, string>): Promise<SseConnection> {
    const c = await openSse(`${srv.url}/api/v1/events`, headers);
    open.push(c);
    await c.waitFor((f) => f.comment === 'ok');
    return c;
  }

  async function addMember(accountId: string): Promise<string> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [accountId, userId]);
    return userId;
  }

  async function mint(id: { accountId: string; userId: string }, name?: string): Promise<{ id: string; plaintext: string }> {
    const plaintext = generateToken();
    const inserted = await insertApiToken(app, {
      accountId: id.accountId,
      createdBy: id.userId,
      tokenHash: hashToken(plaintext),
      displayHint: name ? DISPLAY_HINT : 'fxat_...test',
      name,
      scopes: ['read'],
      expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    });
    return { id: inserted.id, plaintext };
  }

  async function insertEvent(accountId: string, type: string): Promise<void> {
    await admin.query(`INSERT INTO domain_events (account_id, type, payload) VALUES ($1, $2, '{}'::jsonb)`, [accountId, type]);
  }

  async function jsonPage(id: { userId: string; accountId: string }, cursor?: string): Promise<{ data: { type: string; data: unknown }[]; next_cursor: string }> {
    const res = await fetch(`${server.url}/api/v1/events${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, {
      headers: { cookie: await cookie(id), accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { data: { type: string; data: unknown }[]; next_cursor: string };
  }

  const leaseCount = async (accountId: string): Promise<number> =>
    (await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM stream_leases WHERE account_id = $1`, [accountId])).rows[0]!.n;

  it('token events reach the whole account (SSE and JSON) with no id, creator, name or hint, and no other tenant', async () => {
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const creator = { accountId: owner.accountId, userId: await addMember(owner.accountId) };
    const other = await seedAccountWithMember(admin, { role: 'owner' });
    const cursor0 = (await jsonPage(owner)).next_cursor;
    const sOwner = await connect(server, { cookie: await cookie(owner) });
    const sMember = await connect(server, { cookie: await cookie(creator) });
    const sOther = await connect(server, { cookie: await cookie(other) });

    const token = await mint(creator, TOKEN_NAME);
    expect(await revokeToken(app, creator, token.id, 'user_requested')).toBe(true);

    for (const s of [sOwner, sMember]) {
      const created = await s.waitFor((f) => f.event === 'api_token.created');
      const revoked = await s.waitFor((f) => f.event === 'api_token.revoked');
      expect(JSON.parse(created.data!).data).toEqual({});
      expect(JSON.parse(revoked.data!).data).toEqual({ reason: 'user_requested' });
    }
    const page = await eventually(async () => {
      const p = await jsonPage(owner, cursor0);
      return p.data.length >= 2 ? p : false;
    });
    expect(page.data.map((e) => e.type)).toEqual(['api_token.created', 'api_token.revoked']);
    const wire = [sOwner.text(), sMember.text(), JSON.stringify(page)].join('\n');
    for (const secret of [token.id, creator.userId, TOKEN_NAME, DISPLAY_HINT]) expect(wire).not.toContain(secret);

    await insertEvent(other.accountId, 'pr.opened');
    await sOther.waitFor((f) => f.event === 'pr.opened');
    expect(sOther.text()).not.toContain('api_token');
  });

  it('session.revoked: never on a wire, the cursor moves past it, and only the signed-out user\'s streams re-check at once', async () => {
    const a = await seedAccountWithMember(admin, { role: 'owner' });
    const b = await seedAccountWithMember(admin, { role: 'owner' });
    const u = { accountId: a.accountId, userId: await addMember(a.accountId) };
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [b.accountId, u.userId]);
    const c = await seedAccountWithMember(admin, { role: 'owner' });
    const cursor0 = (await jsonPage(a)).next_cursor;
    const phone = await connect(server, { cookie: await cookie(u) });
    const laptop = await connect(server, { cookie: await cookie(u) });
    const inB = await connect(server, { cookie: await cookie({ accountId: b.accountId, userId: u.userId }) });
    const bystander = await connect(server, { cookie: await cookie(a) });
    const elsewhere = await connect(server, { cookie: await cookie(c) });
    expect(STREAM_INTERNAL_EVENT_TYPES).toContain('session.revoked');

    await bumpSessionEpoch(ops, u.userId, { emitSessionRevoked: true });
    const rows = await admin.query(`SELECT account_id, subject_id, payload FROM domain_events WHERE type = 'session.revoked' AND subject_id = $1`, [u.userId]);
    expect(rows.rows.map((r) => r.account_id).sort()).toEqual([a.accountId, b.accountId].sort());
    expect(rows.rows[0].payload).toEqual({ reason: 'signed_out_everywhere' });

    for (const s of [phone, laptop, inB]) {
      await s.waitFor((f) => f.event === 'revoked', FAST_MS);
      await Promise.race([s.closed, sleep(FAST_MS).then(() => Promise.reject(new Error('stream did not close')))]);
    }
    await eventually(async () => (await leaseCount(a.accountId)) === 1 && (await leaseCount(b.accountId)) === 0);

    // Another member of the same account and an unrelated tenant are untouched, and the row is on no wire.
    await insertEvent(a.accountId, 'pr.opened');
    await bystander.waitFor((f) => f.event === 'pr.opened');
    expect(bystander.isClosed()).toBe(false);
    expect(elsewhere.isClosed()).toBe(false);
    const page = await jsonPage(a, cursor0);
    expect(page.data.map((e) => e.type)).toEqual(['pr.opened']);
    expect(openCursor(page.next_cursor, a.accountId, process.env).serial).toBeGreaterThan(openCursor(cursor0, a.accountId, process.env).serial);
    for (const text of [phone.text(), bystander.text(), elsewhere.text(), JSON.stringify(page)]) expect(text).not.toContain('session.revoked');
  });

  it('a JSON page whose only row is session.revoked is empty, and a reconnect with its cursor does not replay it', async () => {
    const a = await seedAccountWithMember(admin, { role: 'owner' });
    const cursor0 = (await jsonPage(a)).next_cursor;
    await bumpSessionEpoch(ops, (await addMember(a.accountId)), { emitSessionRevoked: true }); // the reader stays signed in
    const page = await jsonPage(a, cursor0);
    expect(page.data).toEqual([]);
    expect(openCursor(page.next_cursor, a.accountId, process.env).serial).toBeGreaterThan(openCursor(cursor0, a.accountId, process.env).serial);
    expect((await jsonPage(a, page.next_cursor)).data).toEqual([]);
  });

  it('a revoke for another user or another token adds no re-check query; the stream\'s own revoke ends it at once', async () => {
    const a = await seedAccountWithMember(admin, { role: 'owner' });
    const other = { accountId: a.accountId, userId: await addMember(a.accountId) };
    const mine = await mint(a);
    const theirs = await mint(other);
    const viaSession = await connect(counted.server, { cookie: await cookie(a) });
    const viaToken = await connect(counted.server, { authorization: `Bearer ${mine.plaintext}` });
    counted.ops.reset();
    counted.app.reset();

    await bumpSessionEpoch(ops, other.userId, { emitSessionRevoked: true });
    expect(await revokeToken(app, other, theirs.id, 'user_requested')).toBe(true);
    await insertEvent(a.accountId, 'pr.opened');
    await viaSession.waitFor((f) => f.event === 'pr.opened');
    await viaToken.waitFor((f) => f.event === 'pr.opened');
    expect(counted.ops.count(/session_epoch/)).toBe(0);
    expect(counted.app.count(/resolve_api_token/)).toBe(0);
    expect(viaSession.isClosed() || viaToken.isClosed()).toBe(false);

    expect(await revokeToken(app, a, mine.id, 'user_requested')).toBe(true);
    await viaToken.waitFor((f) => f.event === 'revoked', FAST_MS);
    await Promise.race([viaToken.closed, sleep(FAST_MS).then(() => Promise.reject(new Error('token stream did not close')))]);
    expect(viaSession.isClosed()).toBe(false);
  });

  it('none of the three types can be subscribed to, and none is fanned out', async () => {
    for (const type of ['api_token.created', 'api_token.revoked', 'session.revoked']) expect(WEBHOOK_EVENT_TYPES).not.toContain(type);
    const owner = await seedAccountWithMember(admin, { role: 'owner' });
    const create = async (event_types: string[]): Promise<Response> =>
      handleApiRequest(
        new Request('http://localhost/api/v1/webhook-endpoints', {
          method: 'POST',
          headers: { cookie: await cookie(owner), 'content-type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com/hooks/x', event_types }),
        }),
        app,
        ops,
        ROUTES,
      );
    for (const type of ['api_token.created', 'api_token.revoked', 'session.revoked']) expect((await create([type])).status).toBe(422);
    const endpoint = (await (await create(['pr.opened'])).json()) as { id: string };
    await mint(owner);
    await bumpSessionEpoch(ops, owner.userId, { emitSessionRevoked: true });
    await fanOutPendingEvents(ops);
    const { rows } = await admin.query(`SELECT 1 FROM webhook_deliveries WHERE endpoint_id = $1`, [endpoint.id]);
    expect(rows).toHaveLength(0);
  });

  it('per-user cap is 6: the 7th session stream is 429 stream_limit with Retry-After', async () => {
    const a = await seedAccountWithMember(admin, { role: 'owner' });
    expect(SESSION_STREAMS_PER_USER).toBe(6);
    for (let i = 0; i < 6; i++) await connect(server, { cookie: await cookie(a) });
    const res = await fetch(`${server.url}/api/v1/events`, { headers: { cookie: await cookie(a) } });
    expect(res.status).toBe(429);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({ error: { code: 'stream_limit' } });
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });
});
