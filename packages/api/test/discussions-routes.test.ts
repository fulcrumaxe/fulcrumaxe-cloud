import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { MAX_BODY_BYTES, OPERATION_TABLE, authorize, type Operation } from '@fx/discussions';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { discussionRoutes } from '../src/routes/discussions.js';
import { generateToken, displayHint } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}
type Who = Identity | string;

/** D#71 DS-3a-1/3: the five discussion routes through the real dispatcher against real Postgres. */
describe('D#71 DS-3a-1: discussion routes', () => {
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
  async function tokenFor(who: Identity, scopes: string[] = ['read']): Promise<string> {
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
  async function create(who: Identity, extra: Record<string, unknown> = {}): Promise<{ id: string; title: string }> {
    const title = `t-${randomUUID()}`;
    const res = await call(who, 'POST', '/discussions', { title, kind: 'feature', body: 'first body', ...extra });
    expect(res.status).toBe(201);
    return { id: ((await res.json()) as { id: string }).id, title };
  }
  async function count(table: 'discussions' | 'discussion_revisions', accountId: string): Promise<number> {
    return Number((await admin.query(`SELECT count(*) AS n FROM ${table} WHERE account_id = $1`, [accountId])).rows[0].n);
  }
  async function row(id: string): Promise<{ visibility: string; security: boolean }> {
    return (await admin.query('SELECT visibility, security FROM discussions WHERE id = $1', [id])).rows[0];
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const json = async (res: Response) => (await res.json()) as Record<string, any>;
  const code = async (res: Response) => (await json(res)).error.code as string;

  it('create then get: 201 with the DTO, revision 1 body on GET, listed, never cached', async () => {
    const o = await seedAccountWithMember(admin, { role: 'owner' });
    const res = await call(o, 'POST', '/discussions', { title: 'Dark mode', kind: 'feature', body: 'Please add it.' });
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const made = await json(res);
    expect(made).toMatchObject({ number: 1, kind: 'feature', title: 'Dark mode', visibility: 'private', security: false, provenance: 'internal' });
    expect(Object.keys(made)).not.toContain('account_id');

    const got = await json(await call(o, 'GET', `/discussions/${made.id}`));
    expect(got).toMatchObject({ id: made.id, body: 'Please add it.', rev: 1 });
    const list = await json(await call(o, 'GET', '/discussions'));
    expect(list.data.map((d: { id: string }) => d.id)).toEqual([made.id]);
    expect(list.data[0].body).toBeUndefined();
  });

  it('revisions: 201 { rev }, GET shows the latest body; a member may revise only their own', async () => {
    const o = await seedAccountWithMember(admin, { role: 'owner' });
    const m1 = await memberOf(o, 'member');
    const m2 = await memberOf(o, 'member');
    const mine = await create(m1);
    const res = await call(m1, 'POST', `/discussions/${mine.id}/revisions`, { body: 'second' });
    expect(res.status).toBe(201);
    expect(await json(res)).toEqual({ rev: 2 });
    expect((await json(await call(m2, 'GET', `/discussions/${mine.id}`))).body).toBe('second');

    const refused = await call(m2, 'POST', `/discussions/${mine.id}/revisions`, { body: 'hijack' });
    expect(refused.status).toBe(403);
    expect((await call(o, 'POST', `/discussions/${mine.id}/revisions`, { body: 'third' })).status).toBe(201);
    expect(await count('discussion_revisions', o.accountId)).toBe(3);
  });

  it('the operation table decides: every session role gets exactly what authorize() says on each exposed operation', async () => {
    const o = await seedAccountWithMember(admin, { role: 'owner' });
    const roles = { owner: o, admin: await memberOf(o, 'admin'), member: await memberOf(o, 'member') } as const;
    const author = await memberOf(o, 'member');
    const exposed: Operation[] = ['discussion.create', 'discussion.revise', 'visibility.set', 'security.set', 'security.clear'];
    // Every exposed operation is in the table, and nothing outside DS-3a-1's five routes is exercised here.
    for (const op of exposed) expect(OPERATION_TABLE[op]).toBeDefined();

    const attempt: Record<string, (who: Identity, d: string) => Promise<Response>> = {
      'discussion.create': (who) => call(who, 'POST', '/discussions', { title: 'x', kind: 'bug', body: 'b' }),
      'discussion.revise': (who, d) => call(who, 'POST', `/discussions/${d}/revisions`, { body: 'r' }),
      'visibility.set': (who, d) => call(who, 'PATCH', `/discussions/${d}`, { visibility: 'repo' }),
      'security.set': (who, d) => call(who, 'PATCH', `/discussions/${d}`, { security: true }),
      'security.clear': (who, d) => call(who, 'PATCH', `/discussions/${d}`, { security: false }),
    };
    for (const op of exposed) {
      for (const [name, who] of Object.entries(roles)) {
        const d = (await create(author)).id;
        const access = authorize({ kind: 'session', ...who, role: name as 'owner' }, op);
        const res = await attempt[op]!(who, d);
        if (access === 'deny' || access === 'own') {
          // 'own' is the author's alone: none of these three is the author.
          expect(res.status, `${op} as ${name}`).toBe(403);
          expect(await code(res)).toBe('insufficient_role');
          if (op !== 'discussion.create') expect(await row(d)).toEqual({ visibility: 'private', security: false });
        } else {
          expect(res.status, `${op} as ${name}`).toBeLessThan(300);
        }
      }
    }
    // The author, holding 'own', may revise.
    const d = (await create(author)).id;
    expect((await attempt['discussion.revise']!(author, d)).status).toBe(201);
  });

  it('a read-only token reads; on each write route it is 403 insufficient_scope and changes nothing', async () => {
    const o = await seedAccountWithMember(admin, { role: 'owner' });
    const { id } = await create(o);
    const token = await tokenFor(o);
    expect((await call(token, 'GET', '/discussions')).status).toBe(200);
    expect((await call(token, 'GET', `/discussions/${id}`)).status).toBe(200);
    const writes: [string, string, unknown][] = [
      ['POST', '/discussions', { title: 'x', kind: 'bug', body: 'b' }],
      ['PATCH', `/discussions/${id}`, { security: true }],
      ['POST', `/discussions/${id}/revisions`, { body: 'r' }],
    ];
    for (const [method, path, body] of writes) {
      const res = await call(token, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await code(res)).toBe('insufficient_scope');
    }
    expect(await count('discussions', o.accountId)).toBe(1);
    expect(await count('discussion_revisions', o.accountId)).toBe(1);
    expect(await row(id)).toEqual({ visibility: 'private', security: false });

    const other = await tokenFor(o, ['audit:read']);
    const res = await call(other, 'GET', '/discussions');
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('insufficient_scope');
  });

  it('a discussions:write token creates, revises its creator\'s own discussion and sets security true', async () => {
    const o = await seedAccountWithMember(admin, { role: 'owner' });
    const m = await memberOf(o, 'member');
    const token = await tokenFor(m, ['discussions:write']);
    const made = await call(token, 'POST', '/discussions', { title: 'via token', kind: 'bug', body: 'b1' });
    expect(made.status).toBe(201);
    const id = ((await json(made)) as { id: string }).id;
    const creator = (await admin.query('SELECT created_by_kind, created_by_user_id FROM discussions WHERE id = $1', [id])).rows[0];
    expect(creator).toMatchObject({ created_by_user_id: m.userId });

    const rev = await call(token, 'POST', `/discussions/${id}/revisions`, { body: 'b2' });
    expect(rev.status).toBe(201);
    expect(await json(rev)).toEqual({ rev: 2 });

    // PATCH answers with the discussion, so it also needs `read`: without it, refused before any write.
    const noRead = await call(token, 'PATCH', `/discussions/${id}`, { security: true });
    expect(noRead.status).toBe(403);
    expect(await code(noRead)).toBe('insufficient_scope');
    expect(await row(id)).toEqual({ visibility: 'private', security: false });
    const patched = await call(await tokenFor(m, ['read', 'discussions:write']), 'PATCH', `/discussions/${id}`, { security: true });
    expect(patched.status).toBe(200);
    expect(await row(id)).toEqual({ visibility: 'private', security: true });
  });

  it('a write token cannot revise someone else\'s discussion, or change visibility or clear security', async () => {
    const o = await seedAccountWithMember(admin, { role: 'owner' });
    const m1 = await memberOf(o, 'member');
    const theirs = await create(o);
    const mine = await create(m1);
    const token = await tokenFor(m1, ['read', 'discussions:write']);
    const before = await count('discussion_revisions', o.accountId);

    const revise = await call(token, 'POST', `/discussions/${theirs.id}/revisions`, { body: 'hijack' });
    expect(revise.status).toBe(403);
    expect(await code(revise)).toBe('insufficient_role');
    expect(await count('discussion_revisions', o.accountId)).toBe(before);

    // Make the discussion public and secure-free, so a refused change would show.
    await admin.query("UPDATE discussions SET visibility = 'public' WHERE id = $1", [mine.id]);
    for (const body of [{ visibility: 'repo' }, { visibility: 'private' }, { security: false }, { security: false, visibility: 'public' }]) {
      const res = await call(token, 'PATCH', `/discussions/${mine.id}`, body);
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect(await code(res)).toBe('session_required');
    }
    expect(await row(mine.id)).toEqual({ visibility: 'public', security: false });

    // security true with a private visibility is the one thing a token may send; and it may not clear it afterwards.
    expect((await call(token, 'PATCH', `/discussions/${mine.id}`, { security: true, visibility: 'private' })).status).toBe(200);
    expect(await row(mine.id)).toEqual({ visibility: 'private', security: true });
    const clear = await call(token, 'PATCH', `/discussions/${mine.id}`, { security: false });
    expect(clear.status).toBe(403);
    expect(await code(clear)).toBe('session_required');
    expect(await row(mine.id)).toEqual({ visibility: 'private', security: true });
  });

  it('a token minted by a demoted-away creator is refused on the write routes (scope is capped by the creator\'s current role)', async () => {
    const o = await seedAccountWithMember(admin, { role: 'owner' });
    const m = await memberOf(o, 'member');
    const token = await tokenFor(m, ['discussions:write']);
    await admin.query('DELETE FROM account_members WHERE account_id = $1 AND user_id = $2', [o.accountId, m.userId]);
    const res = await call(token, 'POST', '/discussions', { title: 'x', kind: 'bug', body: 'b' });
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(res.status).toBeLessThan(500);
    expect(await count('discussions', o.accountId)).toBe(0);
  });

  describe('repo_id on create', () => {
    let seq = 9_000_000;
    async function seedRepo(accountId: string): Promise<string> {
      const id = randomUUID();
      await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product) VALUES ($1, $2, $3, 'team')`, [id, accountId, ++seq]);
      return id;
    }
    async function rows(accountId: string): Promise<[number, number]> {
      const wi = Number((await admin.query('SELECT count(*) AS n FROM work_items WHERE account_id = $1', [accountId])).rows[0].n);
      return [await count('discussions', accountId), wi];
    }
    /** A pool whose connections report every SQL text to `onQuery` before running it. */
    function spyPool(onQuery: (sql: string) => Promise<void> | void): Pool {
      const wrapClient = (client: PoolClient): PoolClient =>
        new Proxy(client, {
          get(target, prop, receiver) {
            if (prop === 'query') {
              return async (...args: unknown[]) => {
                if (typeof args[0] === 'string') await onQuery(args[0]);
                return (target.query as (...a: unknown[]) => unknown)(...args);
              };
            }
            const v = Reflect.get(target, prop, receiver);
            return typeof v === 'function' ? v.bind(target) : v;
          },
        });
      return new Proxy(appUserPool, {
        get(target, prop, receiver) {
          if (prop === 'connect') return async () => wrapClient(await target.connect());
          const v = Reflect.get(target, prop, receiver);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
    }
    const withoutRequestId = async (res: Response) => {
      const b = await json(res);
      delete b.error.request_id;
      return JSON.stringify(b);
    };

    it("stores the account's own repo, for a session and for a write token; null and absent store none", async () => {
      const o = await seedAccountWithMember(admin, { role: 'owner' });
      const repo = await seedRepo(o.accountId);
      const stored = async (id: string) => (await admin.query('SELECT repo_id FROM discussions WHERE id = $1', [id])).rows[0].repo_id as string | null;
      const s = await create(o, { repo_id: repo });
      expect(await stored(s.id)).toBe(repo);
      const token = await tokenFor(o, ['discussions:write']);
      const t = await call(token, 'POST', '/discussions', { title: 't', kind: 'bug', body: 'b', repo_id: repo });
      expect(t.status).toBe(201);
      expect(await stored(((await json(t)) as { id: string }).id)).toBe(repo);
      expect(await stored((await create(o, { repo_id: null })).id)).toBeNull();
      expect(await stored((await create(o)).id)).toBeNull();
    });

    it("another account's repo, a missing repo and a malformed id are the same 422, and nothing is inserted", async () => {
      const a = await seedAccountWithMember(admin, { role: 'owner' });
      const b = await seedAccountWithMember(admin, { role: 'owner' });
      const theirs = await seedRepo(b.accountId);
      const token = await tokenFor(a, ['discussions:write']);
      for (const who of [a, token] as Who[]) {
        const before = await rows(a.accountId);
        const bodies = new Set<string>();
        for (const repo_id of [theirs, randomUUID(), 'not-a-uuid', '']) {
          const res = await call(who, 'POST', '/discussions', { title: 'x', kind: 'bug', body: 'b', repo_id });
          expect(res.status, `repo_id ${repo_id}`).toBe(422);
          const text = await withoutRequestId(res);
          expect(text).toContain('"path":"repo_id"');
          bodies.add(text);
        }
        expect(bodies.size, 'the refusals differ').toBe(1);
        expect(await rows(a.accountId)).toEqual(before);
      }
      expect(await rows(b.accountId)).toEqual([0, 0]);
    });

    it('the service refuses a foreign, missing or malformed repo before it issues any insert', async () => {
      const a = await seedAccountWithMember(admin, { role: 'owner' });
      const b = await seedAccountWithMember(admin, { role: 'owner' });
      const theirs = await seedRepo(b.accountId);
      const inserts: string[] = [];
      const spied = spyPool((sql) => {
        if (/INSERT INTO (work_items|discussions|discussion_revisions)/.test(sql)) inserts.push(sql);
      });
      const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(a)}`, 'content-type': 'application/json' });
      for (const repo_id of [theirs, randomUUID(), 'not-a-uuid']) {
        const req = new Request('http://localhost/api/v1/discussions', {
          method: 'POST',
          headers,
          body: JSON.stringify({ title: 'x', kind: 'bug', body: 'b', repo_id }),
        });
        expect((await handleApiRequest(req, spied, platformOpsPool, ROUTES)).status).toBe(422);
      }
      expect(inserts).toEqual([]);
    });

    it('a repo deleted between the check and the insert hits the foreign key and is the same 422, not a 500', async () => {
      const o = await seedAccountWithMember(admin, { role: 'owner' });
      const repo = await seedRepo(o.accountId);
      const before = await rows(o.accountId);
      // The pool proxy deletes the repo on the connection that is about to insert the discussion.
      let deleted = false;
      const proxied = spyPool(async (sql) => {
        if (!deleted && sql.includes('INSERT INTO discussions')) {
          deleted = true;
          await admin.query('DELETE FROM repos WHERE id = $1', [repo]);
        }
      });
      const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(o)}`, 'content-type': 'application/json' });
      const req = new Request('http://localhost/api/v1/discussions', {
        method: 'POST',
        headers,
        body: JSON.stringify({ title: 'x', kind: 'bug', body: 'b', repo_id: repo }),
      });
      const res = await handleApiRequest(req, proxied, platformOpsPool, ROUTES);
      expect(deleted, 'the proxy never saw the insert').toBe(true);
      expect(res.status).toBe(422);
      expect(await json(res)).toMatchObject({ error: { code: 'validation_failed' }, details: [{ path: 'repo_id', code: 'invalid' }] });
      expect(await rows(o.accountId)).toEqual(before);
    });
  });

  it('missing, malformed and other-tenant ids are one identical 404, and leak no title', async () => {
    const a = await seedAccountWithMember(admin, { role: 'owner' });
    const b = await seedAccountWithMember(admin, { role: 'owner' });
    const theirs = await create(b);
    const calls: [string, (id: string) => [string, unknown?]][] = [
      ['GET', (id) => [`/discussions/${id}`]],
      ['PATCH', (id) => [`/discussions/${id}`, { security: true }]],
      ['POST', (id) => [`/discussions/${id}/revisions`, { body: 'x' }]],
    ];
    for (const [method, path] of calls) {
      const seen = new Set<string>();
      for (const id of [randomUUID(), 'not-a-uuid', theirs.id]) {
        const [p, body] = path(id);
        const res = await call(a, method, p, body);
        expect(res.status, `${method} ${id}`).toBe(404);
        const text = await res.text();
        expect(text).not.toContain(theirs.title);
        seen.add(JSON.stringify((JSON.parse(text) as { error: { code: string; message: string } }).error.code + JSON.parse(text).error.message));
      }
      expect(seen.size, `${method} 404 bodies differ`).toBe(1);
    }
    expect(await row(theirs.id)).toEqual({ visibility: 'private', security: false });
    expect(await count('discussion_revisions', b.accountId)).toBe(1);
  });

  it('a malformed id reaches no query: the handlers 404 against a pool that throws on connect and query', async () => {
    const boom = new Proxy({}, { get: () => () => { throw new Error('pool must not be touched'); } }) as unknown as Pool;
    const principal = { kind: 'session' as const, accountId: randomUUID(), userId: randomUUID(), role: 'owner' as const, scopes: [] };
    const bodies: Record<string, unknown> = { getDiscussion: undefined, patchDiscussion: { security: true }, reviseDiscussion: { body: 'x' } };
    for (const [operationId, body] of Object.entries(bodies)) {
      const entry = discussionRoutes.find((r) => r.operationId === operationId)!;
      await expect(entry.handler({ pool: boom, principal }, { params: { id: 'not-a-uuid' }, query: undefined, body })).rejects.toMatchObject({ name: 'NotFoundError' });
    }
  });

  it('a body carrying account_id is 400 invalid_input on all three write routes and writes nothing', async () => {
    const o = await seedAccountWithMember(admin, { role: 'owner' });
    const { id } = await create(o);
    const other = randomUUID();
    const cases: [string, string, Record<string, unknown>][] = [
      ['POST', '/discussions', { title: 'x', kind: 'bug', body: 'b', account_id: other }],
      ['PATCH', `/discussions/${id}`, { security: true, accountId: other }],
      ['POST', `/discussions/${id}/revisions`, { body: 'r', account_id: other }],
    ];
    for (const [method, path, body] of cases) {
      const res = await call(o, method, path, body);
      expect(res.status).toBe(400);
      expect(await code(res)).toBe('invalid_input');
    }
    expect(await count('discussions', o.accountId)).toBe(1);
    expect(await count('discussion_revisions', o.accountId)).toBe(1);
    expect((await row(id)).security).toBe(false);
  });

  it('PATCH: visibility, security set/clear, and the authorise-before-write rule', async () => {
    const o = await seedAccountWithMember(admin, { role: 'owner' });
    const m = await memberOf(o, 'member');
    const { id } = await create(m);

    const pub = await call(o, 'PATCH', `/discussions/${id}`, { visibility: 'public' });
    expect(pub.status).toBe(200);
    expect(await json(pub)).toMatchObject({ id, visibility: 'public', body: 'first body' });

    // A member may set security (which forces private) but not change visibility or clear it.
    expect((await call(m, 'PATCH', `/discussions/${id}`, { visibility: 'repo' })).status).toBe(403);
    expect(await row(id)).toEqual({ visibility: 'public', security: false });
    expect(await json(await call(m, 'PATCH', `/discussions/${id}`, { security: true }))).toMatchObject({ security: true, visibility: 'private' });
    expect((await call(m, 'PATCH', `/discussions/${id}`, { security: false, visibility: 'private' })).status).toBe(403);
    expect(await row(id)).toEqual({ visibility: 'private', security: true });
    expect((await call(o, 'PATCH', `/discussions/${id}`, { security: false, visibility: 'repo' })).status).toBe(200);
    expect(await row(id)).toEqual({ visibility: 'repo', security: false });

    for (const bad of [{}, { security: true, visibility: 'public' }, { visibility: 'world' }]) {
      const res = await call(o, 'PATCH', `/discussions/${id}`, bad);
      expect(res.status).toBe(422);
    }
    expect(await row(id)).toEqual({ visibility: 'repo', security: false });
  });

  it('two tenants: lists never cross, and another tenant cannot change or revise a row', async () => {
    const a = await seedAccountWithMember(admin, { role: 'owner' });
    const b = await seedAccountWithMember(admin, { role: 'owner' });
    const one = await create(a);
    const two = await create(b);
    expect((await json(await call(a, 'GET', '/discussions'))).data.map((d: { id: string }) => d.id)).toEqual([one.id]);
    expect((await json(await call(b, 'GET', '/discussions'))).data.map((d: { id: string }) => d.id)).toEqual([two.id]);
    // b's owner presented against a's account is not a member there.
    const res = await call({ accountId: a.accountId, userId: b.userId }, 'PATCH', `/discussions/${one.id}`, { visibility: 'public' });
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(await row(one.id)).toEqual({ visibility: 'private', security: false });
  });

  it('pagination: limit 2 over 3 rows gives 2 then 1 with no repeat; bad limit and cursor are 422', async () => {
    const o = await seedAccountWithMember(admin, { role: 'owner' });
    const ids = [(await create(o)).id, (await create(o)).id, (await create(o)).id];
    const first = await json(await call(o, 'GET', '/discussions?limit=2'));
    expect(first.data).toHaveLength(2);
    expect(first.next_cursor).toEqual(expect.any(String));
    const second = await json(await call(o, 'GET', `/discussions?limit=2&cursor=${first.next_cursor}`));
    expect(second.data).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    expect([...first.data, ...second.data].map((d: { id: string }) => d.id).sort()).toEqual([...ids].sort());
    for (const q of ['limit=201', 'limit=0', 'cursor=garbage']) expect((await call(o, 'GET', `/discussions?${q}`)).status).toBe(422);
  });

  it('a repeated Idempotency-Key replays the first response and writes exactly one row', async () => {
    const o = await seedAccountWithMember(admin, { role: 'owner' });
    const headers = { 'idempotency-key': 'k-create-1' };
    const body = { title: 'once', kind: 'bug', body: 'b' };
    const first = await call(o, 'POST', '/discussions', body, headers);
    const second = await call(o, 'POST', '/discussions', body, headers);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect((await json(second)).id).toBe((await json(first)).id);
    expect(await count('discussions', o.accountId)).toBe(1);
  });

  it('an oversized body is 413 payload_too_large and writes nothing', async () => {
    const o = await seedAccountWithMember(admin, { role: 'owner' });
    const { id } = await create(o);
    const big = 'x'.repeat(MAX_BODY_BYTES + 1);
    const res = await call(o, 'POST', '/discussions', { title: 't', kind: 'bug', body: big });
    expect(res.status).toBe(413);
    expect(await code(res)).toBe('payload_too_large');
    expect((await call(o, 'POST', `/discussions/${id}/revisions`, { body: big })).status).toBe(413);
    expect(await count('discussions', o.accountId)).toBe(1);
    expect(await count('discussion_revisions', o.accountId)).toBe(1);
  });
});
