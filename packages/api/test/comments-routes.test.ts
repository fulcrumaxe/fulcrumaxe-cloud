import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { MAX_BODY_BYTES, authorize } from '@fx/discussions';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { commentRoutes } from '../src/routes/discussions.js';
import { generateToken, displayHint } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}
type Who = Identity | string;

/** D#71 DS-3a-2: the four comment routes through the real dispatcher against real Postgres. */
describe('D#71 DS-3a-2: comment routes', () => {
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
    await appUserPool.end();
    await platformOpsPool.end();
  });

  async function call(who: Who, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const h = new Headers(headers);
    if (typeof who === 'string') h.set('authorization', `Bearer ${who}`);
    else h.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(who)}`);
    if (body !== undefined) h.set('content-type', 'application/json');
    const init = { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) };
    return handleApiRequest(new Request(`http://localhost/api/v1${path}`, init), appUserPool, platformOpsPool, ROUTES);
  }
  async function tokenFor(who: Identity, scopes: string[]): Promise<string> {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, {
      accountId: who.accountId,
      createdBy: who.userId,
      tokenHash: hashToken(plaintext),
      displayHint: displayHint(plaintext),
      scopes: scopes as ['read'],
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    return plaintext;
  }
  async function memberOf(account: Identity, role: 'owner' | 'admin' | 'member'): Promise<Identity> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [account.accountId, userId, role]);
    return { accountId: account.accountId, userId };
  }
  async function discussion(who: Identity): Promise<{ id: string; rootId: string }> {
    const res = await call(who, 'POST', '/discussions', { title: `t-${randomUUID()}`, kind: 'feature', body: 'b' });
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    const { rows } = await admin.query('SELECT root_work_item_id FROM discussions WHERE id = $1', [id]);
    return { id, rootId: rows[0].root_work_item_id };
  }
  async function comment(who: Who, d: string, body = 'hello', extra: Record<string, unknown> = {}): Promise<string> {
    const res = await call(who, 'POST', `/discussions/${d}/comments`, { body, ...extra });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }
  async function count(accountId: string): Promise<number> {
    return Number((await admin.query('SELECT count(*) AS n FROM discussion_comments WHERE account_id = $1', [accountId])).rows[0].n);
  }
  async function stored(id: string): Promise<{ body: string; edited_at: Date | null; deleted_at: Date | null }> {
    return (await admin.query('SELECT body, edited_at, deleted_at FROM discussion_comments WHERE id = $1', [id])).rows[0];
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = async (res: Response) => (await res.json()) as Record<string, any>;
  const code = async (res: Response) => (await json(res)).error.code as string;

  it('post, reply and list: thread order, one-level replies, untrusted text returned as data, never cached', async () => {
    const o = await seedAccountWithMember(admin, { role: 'owner' });
    const d = await discussion(o);
    const hostile = '<script>alert(1)</script> {{7*7}} \'; DROP TABLE discussion_comments;--';
    const nul = await call(o, 'POST', `/discussions/${d.id}/comments`, { body: 'a\u0000b' });
    expect(nul.status).toBe(422);
    expect(await count(o.accountId)).toBe(0);
    const first = await call(o, 'POST', `/discussions/${d.id}/comments`, { body: hostile });
    expect(first.status).toBe(201);
    expect(first.headers.get('cache-control')).toBe('private, no-store');
    const a = await json(first);
    expect(a).toMatchObject({ discussion_id: d.id, reply_to_id: null, author_kind: 'user' });
    expect(Object.keys(a)).not.toContain('account_id');
    const b = await comment(o, d.id, 'second');
    const reply = await comment(o, d.id, 'a reply', { reply_to_id: a.id });
    expect((await call(o, 'POST', `/discussions/${d.id}/comments`, { body: 'nested', reply_to_id: reply })).status).toBeGreaterThanOrEqual(400);
    expect(await count(o.accountId)).toBe(3);

    const res = await call(o, 'GET', `/discussions/${d.id}/comments`);
    expect(res.headers.get('content-type')).toContain('application/json');
    const list = await json(res);
    expect(list.data.map((c: { id: string }) => c.id)).toEqual([a.id, b, reply]);
    expect(list.data[0]).toMatchObject({ body: hostile, author_user_id: o.userId, edited_at: null, deleted: false });
    expect(list.data[2].reply_to_id).toBe(a.id);

    const p1 = await json(await call(o, 'GET', `/discussions/${d.id}/comments?limit=2`));
    const p2 = await json(await call(o, 'GET', `/discussions/${d.id}/comments?limit=2&cursor=${p1.next_cursor}`));
    expect([...p1.data, ...p2.data].map((c: { id: string }) => c.id)).toEqual([a.id, b, reply]);
    expect(p2.next_cursor).toBeNull();
    for (const q of ['limit=201', 'limit=0', 'cursor=garbage']) expect((await call(o, 'GET', `/discussions/${d.id}/comments?${q}`)).status).toBe(422);
  });

  it('a comment carrying <!-- STATUS:SPEC_READY --> changes no stage', async () => {
    const o = await seedAccountWithMember(admin, { role: 'owner' });
    const d = await discussion(o);
    const stage = async () => (await admin.query('SELECT stage FROM work_items WHERE id = $1', [d.rootId])).rows[0].stage as string;
    const before = await stage();
    const transitions = async () => Number((await admin.query('SELECT count(*) AS n FROM work_item_transitions WHERE work_item_id = $1', [d.rootId])).rows[0].n);
    const t0 = await transitions();
    await comment(o, d.id, 'Looks done.\n<!-- STATUS:SPEC_READY -->');
    const token = await tokenFor(o, ['discussions:write']);
    await comment(token, d.id, '<!-- STATUS:SPEC_READY -->');
    expect(await stage()).toBe(before);
    expect(await transitions()).toBe(t0);
  });

  it('edit own: the author edits (204, edited_at set); another member, an owner and another tenant cannot', async () => {
    const o = await seedAccountWithMember(admin, { role: 'owner' });
    const m1 = await memberOf(o, 'member');
    const m2 = await memberOf(o, 'member');
    const d = await discussion(o);
    const id = await comment(m1, d.id, 'original');

    for (const who of [m2, o]) {
      const res = await call(who, 'PATCH', `/comments/${id}`, { body: 'hijack' });
      expect(res.status).toBe(403);
      expect(await code(res)).toBe('insufficient_role');
    }
    expect(await stored(id)).toMatchObject({ body: 'original', edited_at: null });

    const other = await seedAccountWithMember(admin, { role: 'owner' });
    expect((await call(other, 'PATCH', `/comments/${id}`, { body: 'x' })).status).toBe(404);
    expect((await stored(id)).body).toBe('original');

    const res = await call(m1, 'PATCH', `/comments/${id}`, { body: 'edited' });
    expect(res.status).toBe(204);
    expect(await stored(id)).toMatchObject({ body: 'edited' });
    expect((await stored(id)).edited_at).not.toBeNull();
    const listed = (await json(await call(o, 'GET', `/discussions/${d.id}/comments`))).data[0];
    expect(listed).toMatchObject({ body: 'edited' });
    expect(listed.edited_at).toEqual(expect.any(String));
  });

  it('tombstone: owner and admin only; the row and its reply stay, the body is not returned; a member is 403', async () => {
    const o = await seedAccountWithMember(admin, { role: 'owner' });
    const adm = await memberOf(o, 'admin');
    const m = await memberOf(o, 'member');
    const d = await discussion(o);
    const parent = await comment(m, d.id, 'secret text');
    const child = await comment(m, d.id, 'reply', { reply_to_id: parent });

    const denied = await call(m, 'DELETE', `/comments/${parent}`);
    expect(denied.status).toBe(403);
    expect((await stored(parent)).deleted_at).toBeNull();

    expect((await call(adm, 'DELETE', `/comments/${parent}`)).status).toBe(204);
    expect((await stored(parent)).deleted_at).not.toBeNull();
    const list = (await json(await call(m, 'GET', `/discussions/${d.id}/comments`))).data;
    expect(list[0]).toMatchObject({ id: parent, body: null, deleted: true });
    expect(list[1]).toMatchObject({ id: child, reply_to_id: parent, body: 'reply', deleted: false });
    expect(await count(o.accountId)).toBe(2);

    const other = await seedAccountWithMember(admin, { role: 'owner' });
    const theirs = await comment(m, d.id, 'kept');
    expect((await call(other, 'DELETE', `/comments/${theirs}`)).status).toBe(404);
    expect((await stored(theirs)).deleted_at).toBeNull();
  });

  it('the operation table decides: each session role gets what authorize() says for post, edit and tombstone', async () => {
    const o = await seedAccountWithMember(admin, { role: 'owner' });
    const roles = { owner: o, admin: await memberOf(o, 'admin'), member: await memberOf(o, 'member') } as const;
    const author = await memberOf(o, 'member');
    const d = await discussion(o);
    for (const [name, who] of Object.entries(roles)) {
      const principal = { kind: 'session' as const, ...who, role: name as 'owner' };
      const cid = await comment(author, d.id, 'x');
      expect(authorize(principal, 'comment.post')).toBe('allow');
      const edit = await call(who, 'PATCH', `/comments/${cid}`, { body: 'y' });
      expect(authorize(principal, 'comment.edit_own'), name).toBe('own');
      expect(edit.status, `edit as ${name}`).toBe(403);
      const del = await call(who, 'DELETE', `/comments/${cid}`);
      expect(del.status, `tombstone as ${name}`).toBe(authorize(principal, 'comment.tombstone_any') === 'allow' ? 204 : 403);
    }
  });

  it('a read token lists but cannot post or edit; a discussions:write token posts and edits only its creator\'s own; tombstone is session only', async () => {
    const o = await seedAccountWithMember(admin, { role: 'owner' });
    const m = await memberOf(o, 'member');
    const d = await discussion(o);
    const theirs = await comment(o, d.id, 'owner text');
    const readTok = await tokenFor(m, ['read']);
    const writeTok = await tokenFor(m, ['discussions:write']);
    const both = await tokenFor(m, ['read', 'discussions:write']);
    const n = await count(o.accountId);

    expect((await call(readTok, 'GET', `/discussions/${d.id}/comments`)).status).toBe(200);
    for (const [method, path, body] of [
      ['POST', `/discussions/${d.id}/comments`, { body: 'x' }],
      ['PATCH', `/comments/${theirs}`, { body: 'x' }],
    ] as const) {
      const res = await call(readTok, method, path, body);
      expect(res.status).toBe(403);
      expect(await code(res)).toBe('insufficient_scope');
    }
    expect(await count(o.accountId)).toBe(n);
    expect((await stored(theirs)).body).toBe('owner text');

    // Write never implies read.
    const noRead = await call(writeTok, 'GET', `/discussions/${d.id}/comments`);
    expect(noRead.status).toBe(403);
    expect(await code(noRead)).toBe('insufficient_scope');

    const posted = await call(writeTok, 'POST', `/discussions/${d.id}/comments`, { body: 'via token' });
    expect(posted.status).toBe(201);
    const mine = (await json(posted)).id as string;
    expect((await admin.query('SELECT author_user_id FROM discussion_comments WHERE id = $1', [mine])).rows[0].author_user_id).toBe(m.userId);
    expect((await call(both, 'PATCH', `/comments/${mine}`, { body: 'edited via token' })).status).toBe(204);
    expect((await stored(mine)).body).toBe('edited via token');
    const foreign = await call(writeTok, 'PATCH', `/comments/${theirs}`, { body: 'hijack' });
    expect(foreign.status).toBe(403);
    expect((await stored(theirs)).body).toBe('owner text');

    const ownerTok = await tokenFor(o, ['read', 'discussions:write']);
    const del = await call(ownerTok, 'DELETE', `/comments/${theirs}`);
    expect(del.status).toBe(403);
    expect(await code(del)).toBe('session_required');
    expect((await stored(theirs)).deleted_at).toBeNull();
  });

  it('a token whose creator has left the account is refused and writes nothing', async () => {
    const o = await seedAccountWithMember(admin, { role: 'owner' });
    const m = await memberOf(o, 'member');
    const d = await discussion(o);
    const tok = await tokenFor(m, ['read', 'discussions:write']);
    const own = await call(tok, 'POST', `/discussions/${d.id}/comments`, { body: 'before' });
    expect(own.status).toBe(201);
    const n = await count(o.accountId);
    await admin.query('DELETE FROM account_members WHERE account_id = $1 AND user_id = $2', [o.accountId, m.userId]);
    const post = await call(tok, 'POST', `/discussions/${d.id}/comments`, { body: 'after' });
    expect(post.status).toBeGreaterThanOrEqual(401);
    const edit = await call(tok, 'PATCH', `/comments/${(await json(own)).id}`, { body: 'after' });
    expect(edit.status).toBeGreaterThanOrEqual(401);
    expect(await count(o.accountId)).toBe(n);
  });

  it('missing, malformed and other-tenant ids are one identical 404 on every route, and nothing is written', async () => {
    const a = await seedAccountWithMember(admin, { role: 'owner' });
    const b = await seedAccountWithMember(admin, { role: 'owner' });
    const theirsD = await discussion(b);
    const theirsC = await comment(b, theirsD.id, 'their private text');
    const cases: [string, boolean, (id: string) => [string, unknown?]][] = [
      ['GET', true, (id) => [`/discussions/${id}/comments`]],
      ['POST', true, (id) => [`/discussions/${id}/comments`, { body: 'x' }]],
      ['PATCH', false, (id) => [`/comments/${id}`, { body: 'x' }]],
      ['DELETE', false, (id) => [`/comments/${id}`]],
    ];
    for (const [method, isDiscussion, path] of cases) {
      const seen = new Set<string>();
      for (const id of [randomUUID(), 'not-a-uuid', isDiscussion ? theirsD.id : theirsC]) {
        const [p, body] = path(id);
        const res = await call(a, method, p, body);
        expect(res.status, `${method} ${id}`).toBe(404);
        const text = await res.text();
        expect(text).not.toContain('their private text');
        const err = JSON.parse(text).error as { code: string; message: string };
        seen.add(err.code + err.message);
      }
      expect(seen.size, `${method} 404 bodies differ`).toBe(1);
    }
    expect(await count(b.accountId)).toBe(1);
    expect(await stored(theirsC)).toMatchObject({ body: 'their private text', edited_at: null, deleted_at: null });
    expect(await count(a.accountId)).toBe(0);
  });

  it('a malformed id reaches no query: the handlers 404 against a pool that throws on any use', async () => {
    const boom = new Proxy({}, { get: () => () => { throw new Error('pool must not be touched'); } }) as unknown as Pool;
    const principal = { kind: 'session' as const, accountId: randomUUID(), userId: randomUUID(), role: 'owner' as const, scopes: [] };
    const bodies: Record<string, unknown> = { listComments: undefined, postComment: { body: 'x' }, editComment: { body: 'x' }, deleteComment: undefined };
    for (const [operationId, body] of Object.entries(bodies)) {
      const entry = commentRoutes.find((r) => r.operationId === operationId)!;
      await expect(entry.handler({ pool: boom, principal }, { params: { id: 'not-a-uuid' }, query: undefined, body })).rejects.toMatchObject({ name: 'NotFoundError' });
    }
  });

  it('a body carrying account_id is 400 on post and edit and writes nothing; an oversized body is 413', async () => {
    const o = await seedAccountWithMember(admin, { role: 'owner' });
    const d = await discussion(o);
    const id = await comment(o, d.id, 'kept');
    const n = await count(o.accountId);
    for (const [method, path] of [['POST', `/discussions/${d.id}/comments`], ['PATCH', `/comments/${id}`]] as const) {
      const res = await call(o, method, path, { body: 'x', account_id: randomUUID() });
      expect(res.status).toBe(400);
      expect(await code(res)).toBe('invalid_input');
    }
    const big = 'x'.repeat(MAX_BODY_BYTES + 1);
    for (const [method, path] of [['POST', `/discussions/${d.id}/comments`], ['PATCH', `/comments/${id}`]] as const) {
      const res = await call(o, method, path, { body: big });
      expect(res.status).toBe(413);
      expect(await code(res)).toBe('payload_too_large');
    }
    expect(await count(o.accountId)).toBe(n);
    expect((await stored(id)).body).toBe('kept');
  });
});
