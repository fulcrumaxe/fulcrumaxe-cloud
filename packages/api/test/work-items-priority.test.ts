import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken, type Scope } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { compareQueueOrder } from '@fx/core/src/work-items/queueOrder.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { decodeCursor, decodeQueueCursor, encodeCursor, encodeQueueCursor } from '../src/pagination.js';
import { ROUTES } from '../src/routes/index.js';
import { seedAccountWithMember, seedUser } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}
interface ErrBody {
  error: { code: string };
}
interface Item {
  id: string;
  priority: string;
  queue_rank: number | null;
  stage: string;
}
interface Page {
  data: Item[];
  next_cursor: string | null;
}

/** D#31 API-12: PATCH /work-items/{id}/priority, the priority fields on the reads, and sort=queue, through the real dispatcher on real Postgres. */
describe('D#31 API-12: work-item priority route', () => {
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

  async function call(who: Identity | string, method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}) {
    const h = new Headers(headers);
    if (typeof who === 'string') h.set('authorization', `Bearer ${who}`);
    else h.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(who)}`);
    if (body !== undefined) h.set('content-type', 'application/json');
    return handleApiRequest(
      new Request(`http://localhost/api/v1${urlPath}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }),
      appUserPool,
      platformOpsPool,
      ROUTES,
    );
  }
  const owner = () => seedAccountWithMember(admin, { role: 'owner' });
  async function addMember(accountId: string, role: 'member' | 'admin'): Promise<Identity> {
    const userId = randomUUID();
    await seedUser(admin, userId);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [accountId, userId, role]);
    return { accountId, userId };
  }
  async function tokenFor(who: Identity, scopes: Scope[]): Promise<string> {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, {
      accountId: who.accountId,
      createdBy: who.userId,
      tokenHash: hashToken(plaintext),
      displayHint: 'fxat_...test',
      scopes,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    return plaintext;
  }
  let seq = 0;
  async function seedItem(accountId: string, o: { stage?: string; priority?: number; rank?: number | null; createdAt?: string } = {}) {
    const id = randomUUID();
    seq += 1;
    await admin.query(
      `INSERT INTO work_items (id, account_id, kind, provenance, stage, priority, queue_rank, created_at)
       VALUES ($1, $2, 'feature', 'internal', $3, $4, $5, COALESCE($6::timestamptz, '2026-01-01T00:00:00Z'::timestamptz + make_interval(secs => $7)))`,
      [id, accountId, o.stage ?? 'triaged', o.priority ?? 2, o.rank ?? null, o.createdAt ?? null, seq],
    );
    return id;
  }
  const count = async (sql: string, ...args: unknown[]) => Number((await admin.query<{ n: string }>(sql, args)).rows[0]!.n);
  const audits = (a: string) => count(`SELECT count(*) AS n FROM audit_log WHERE account_id = $1 AND action = 'work_item.priority_changed'`, a);
  const events = (a: string) => count(`SELECT count(*) AS n FROM domain_events WHERE account_id = $1 AND type = 'work_item.priority_changed'`, a);
  const snapshot = async (a: string) =>
    JSON.stringify((await admin.query('SELECT id, priority, queue_rank FROM work_items WHERE account_id = $1 ORDER BY id', [a])).rows);
  async function expectUntouched(a: string, before: string) {
    expect(await snapshot(a)).toBe(before);
    expect(await audits(a)).toBe(0);
    expect(await events(a)).toBe(0);
  }

  it('an owner session sets a priority: 200 with the read shape (a word, never the number), one audit row, one event', async () => {
    const o = await owner();
    const id = await seedItem(o.accountId);
    const res = await call(o, 'PATCH', `/work-items/${id}/priority`, { priority: 'urgent', move: 'top' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Item;
    expect(body.priority).toBe('urgent');
    expect(typeof body.queue_rank).toBe('number');
    expect(await audits(o.accountId)).toBe(1);
    expect(await events(o.accountId)).toBe(1);
  });

  it('a token holding work_items:write acts as its creator: 200', async () => {
    const o = await owner();
    const id = await seedItem(o.accountId);
    const res = await call(await tokenFor(o, ['work_items:write']), 'PATCH', `/work-items/${id}/priority`, { priority: 'low' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Item).priority).toBe('low');
  });

  it('the route entry names the scope and the admin floor', () => {
    const entry = ROUTES.find((r) => r.operationId === 'setWorkItemPriority')!;
    expect(entry.scope).toBe('work_items:write');
    expect(entry.principals).toEqual(['session', 'token']);
    expect(entry.minRole).toBe('admin');
  });

  it('a member session -> 403 and nothing is written', async () => {
    const o = await owner();
    const m = await addMember(o.accountId, 'member');
    const id = await seedItem(o.accountId);
    const before = await snapshot(o.accountId);
    const res = await call(m, 'PATCH', `/work-items/${id}/priority`, { priority: 'urgent' });
    expect(res.status).toBe(403);
    await expectUntouched(o.accountId, before);
  });

  it("a token whose creator is now a member -> 403 (the creator's current role decides) and nothing is written", async () => {
    const o = await owner();
    const a = await addMember(o.accountId, 'admin');
    const token = await tokenFor(a, ['work_items:write']);
    await admin.query(`UPDATE account_members SET role = 'member' WHERE account_id = $1 AND user_id = $2`, [a.accountId, a.userId]);
    const id = await seedItem(o.accountId);
    const before = await snapshot(o.accountId);
    const res = await call(token, 'PATCH', `/work-items/${id}/priority`, { priority: 'urgent' });
    expect(res.status).toBe(403);
    await expectUntouched(o.accountId, before);
  });

  it('a read-only token -> 403 insufficient_scope and nothing is written', async () => {
    const o = await owner();
    const id = await seedItem(o.accountId);
    const before = await snapshot(o.accountId);
    const res = await call(await tokenFor(o, ['read']), 'PATCH', `/work-items/${id}/priority`, { priority: 'urgent' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as ErrBody).error.code).toBe('insufficient_scope');
    await expectUntouched(o.accountId, before);
  });

  it.each(['merged', 'closed_unmerged', 'closed'])('a %s item -> 409 not_reorderable, nothing written', async (stage) => {
    const o = await owner();
    const id = await seedItem(o.accountId, { stage });
    const before = await snapshot(o.accountId);
    const res = await call(o, 'PATCH', `/work-items/${id}/priority`, { priority: 'urgent' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrBody).error.code).toBe('not_reorderable');
    await expectUntouched(o.accountId, before);
  });

  it.each(['needs_human', 'in_progress'])('a %s item stays reorderable', async (stage) => {
    const o = await owner();
    const id = await seedItem(o.accountId, { stage });
    expect((await call(o, 'PATCH', `/work-items/${id}/priority`, { priority: 'high' })).status).toBe(200);
  });

  it('missing, malformed and other-account ids give one identical 404', async () => {
    const o = await owner();
    const other = await owner();
    const theirs = await seedItem(other.accountId);
    const bodies: string[] = [];
    for (const id of [randomUUID(), 'not-a-uuid', theirs]) {
      const res = await call(o, 'PATCH', `/work-items/${id}/priority`, { priority: 'high' });
      expect(res.status).toBe(404);
      const b = (await res.json()) as { error: { code: string; message: string } };
      bodies.push(JSON.stringify([b.error.code, b.error.message]));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(await audits(other.accountId)).toBe(0);
  });

  it('a body carrying account_id -> 400 invalid_input, nothing written', async () => {
    const o = await owner();
    const id = await seedItem(o.accountId);
    const before = await snapshot(o.accountId);
    const res = await call(o, 'PATCH', `/work-items/${id}/priority`, { priority: 'high', account_id: randomUUID() });
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrBody).error.code).toBe('invalid_input');
    await expectUntouched(o.accountId, before);
  });

  it.each([
    ['neither field', {}],
    ['an unknown priority word', { priority: 'critical' }],
    ['the number instead of the word', { priority: 0 }],
    ['an unknown key', { priority: 'high', extra: 1 }],
    ['a bad move', { move: 'sideways' }],
    ['a before that is not an id', { move: { before: 'x' } }],
  ])('%s -> 422', async (_name, body) => {
    const o = await owner();
    const id = await seedItem(o.accountId);
    expect((await call(o, 'PATCH', `/work-items/${id}/priority`, body)).status).toBe(422);
  });

  it('a before naming an item outside the priority band -> 422, nothing written', async () => {
    const o = await owner();
    const id = await seedItem(o.accountId, { priority: 2 });
    const far = await seedItem(o.accountId, { priority: 3 });
    const before = await snapshot(o.accountId);
    expect((await call(o, 'PATCH', `/work-items/${id}/priority`, { move: { before: far } })).status).toBe(422);
    await expectUntouched(o.accountId, before);
  });

  it('a replay with the same Idempotency-Key returns the first response and writes once', async () => {
    const o = await owner();
    const id = await seedItem(o.accountId);
    const headers = { 'idempotency-key': `k-${randomUUID()}` };
    const first = await call(o, 'PATCH', `/work-items/${id}/priority`, { priority: 'urgent', move: 'top' }, headers);
    const second = await call(o, 'PATCH', `/work-items/${id}/priority`, { priority: 'urgent', move: 'top' }, headers);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());
    expect(await audits(o.accountId)).toBe(1);
    expect(await events(o.accountId)).toBe(1);
  });

  it('the reads carry priority (word) and queue_rank (nullable)', async () => {
    const o = await owner();
    const ranked = await seedItem(o.accountId, { priority: 1, rank: 4096 });
    const plain = await seedItem(o.accountId);
    const one = (await (await call(o, 'GET', `/work-items/${ranked}`)).json()) as Item;
    expect(one.priority).toBe('high');
    expect(one.queue_rank).toBe(4096);
    const list = (await (await call(o, 'GET', '/work-items')).json()) as Page;
    const got = new Map(list.data.map((i) => [i.id, i]));
    expect(got.get(plain)).toMatchObject({ priority: 'normal', queue_rank: null });
    expect(got.get(ranked)?.priority).toBe('high');
    for (const i of list.data) expect(typeof i.priority).toBe('string');
  });

  describe('sort=queue', () => {
    /** Ties on rank, ties on created_at, and NULL ranks, spread over three priorities. */
    async function seedMixed(accountId: string): Promise<string[]> {
      const same = '2026-03-01T00:00:00.000000Z';
      const ids: string[] = [];
      const spec: [number, number | null, string?][] = [
        [2, 2048], [2, 1024], [2, 1024], [2, null], [2, null, same], [2, null, same], [2, 5],
        [0, null], [0, 10], [3, null], [3, 7], [1, 1024, same], [1, 1024, same], [1, null],
      ];
      for (const [priority, rank, createdAt] of spec) ids.push(await seedItem(accountId, { priority, rank, createdAt }));
      return ids;
    }
    async function walk(o: Identity, limit: number, sort = 'queue'): Promise<string[]> {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let pages = 0; pages < 50; pages += 1) {
        const q: string = `/work-items?sort=${sort}&limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`;
        const res = await call(o, 'GET', q);
        expect(res.status).toBe(200);
        const page = (await res.json()) as Page;
        seen.push(...page.data.map((i) => i.id));
        if (!page.next_cursor) return seen;
        cursor = page.next_cursor;
      }
      throw new Error('paging did not terminate');
    }

    it.each([1, 2, 3, 5, 100])('pages in compareQueueOrder with no gap or repeat at limit=%i', async (limit) => {
      const o = await owner();
      const ids = await seedMixed(o.accountId);
      const rows = (await admin.query<{ id: string; priority: number; queue_rank: string | null; created_at: Date }>(
        'SELECT id, priority, queue_rank, created_at FROM work_items WHERE account_id = $1', [o.accountId])).rows;
      const expected = rows
        .map((r) => ({ id: r.id, priority: r.priority, queueRank: r.queue_rank === null ? null : Number(r.queue_rank), createdAt: r.created_at }))
        .sort(compareQueueOrder)
        .map((r) => r.id);
      expect(expected).toHaveLength(ids.length);
      expect(await walk(o, limit)).toEqual(expected);
    });

    it('the default sort is unchanged (newest first) and an old-style cursor still pages it', async () => {
      const o = await owner();
      await seedMixed(o.accountId);
      const newestFirst = (await admin.query<{ id: string }>(
        'SELECT id FROM work_items WHERE account_id = $1 ORDER BY created_at DESC, id DESC', [o.accountId])).rows.map((r) => r.id);
      const first = (await (await call(o, 'GET', '/work-items?limit=5')).json()) as Page;
      expect(first.data.map((i) => i.id)).toEqual(newestFirst.slice(0, 5));
      const legacy = decodeCursor(first.next_cursor!);
      expect(Object.keys(legacy).sort()).toEqual(['created_at', 'id']);
      const second = (await (await call(o, 'GET', `/work-items?limit=5&cursor=${encodeCursor(legacy.created_at, legacy.id)}`)).json()) as Page;
      expect(second.data.map((i) => i.id)).toEqual(newestFirst.slice(5, 10));
    });

    it('an unknown sort -> 422', async () => {
      const o = await owner();
      expect((await call(o, 'GET', '/work-items?sort=newest')).status).toBe(422);
    });

    it('a cursor from one sort used with the other -> 422 invalid_cursor, never mis-paged', async () => {
      const o = await owner();
      await seedMixed(o.accountId);
      const queuePage = (await (await call(o, 'GET', '/work-items?sort=queue&limit=2')).json()) as Page;
      const defaultPage = (await (await call(o, 'GET', '/work-items?limit=2')).json()) as Page;
      for (const [q, cursor] of [
        ['/work-items', queuePage.next_cursor],
        ['/work-items?sort=queue', defaultPage.next_cursor],
      ] as const) {
        const res = await call(o, 'GET', `${q}${q.includes('?') ? '&' : '?'}cursor=${cursor}`);
        expect(res.status).toBe(422);
        expect(((await res.json()) as ErrBody).error.code).toBe('invalid_cursor');
      }
    });
  });

  describe('queue cursor codec', () => {
    const key = { priority: 1, queueRank: '2048', createdAt: '2026-03-01T00:00:00.000000Z', id: randomUUID() };
    const forge = (o: Record<string, unknown>) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');

    it('round-trips, including an unranked (null) rank', () => {
      expect(decodeQueueCursor(encodeQueueCursor(key))).toEqual(key);
      expect(decodeQueueCursor(encodeQueueCursor({ ...key, queueRank: null }))).toEqual({ ...key, queueRank: null });
    });
    it.each([
      ['a wrong version', { v: 'q2' }],
      ['no version', { v: undefined }],
      ['a priority out of range', { priority: 4 }],
      ['a fractional priority', { priority: 1.5 }],
      ['a rank that is not digits', { queue_rank: '1e3' }],
      ['a rank too large for a safe integer', { queue_rank: '99999999999999999' }],
      ['a numeric rank', { queue_rank: 5 }],
      ['a bad timestamp', { created_at: '2026-02-30T00:00:00.000000Z' }],
      ['a bad id', { id: 'nope' }],
    ])('rejects %s', (_n, patch) => {
      const good = { v: 'q1', priority: 1, queue_rank: '2048', created_at: key.createdAt, id: key.id };
      expect(() => decodeQueueCursor(forge({ ...good, ...patch }))).toThrow();
    });
    it('the default decoder refuses a queue cursor, and the queue decoder refuses a default one', () => {
      expect(() => decodeCursor(encodeQueueCursor(key))).toThrow();
      expect(() => decodeQueueCursor(encodeCursor(key.createdAt, key.id))).toThrow();
    });
  });
});
