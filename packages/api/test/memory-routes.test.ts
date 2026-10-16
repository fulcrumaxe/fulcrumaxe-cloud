import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '@fx/core/src/tenancy/withTenant.js';
import { repoScopeRef } from '@fx/core/src/memory/index.js';
import { insertApiToken, type Scope } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { effectivePrincipals } from '../src/registry.js';
import { ROUTES } from '../src/routes/index.js';

const NODE = 'R_kgDOApiMem01';
const MEMORY_OPS = ['listMemory', 'getMemoryQueue', 'openMemoryCard', 'decideMemory', 'decideMemoryBatch'];

interface Identity {
  accountId: string;
  userId: string;
}
interface ErrBody {
  error: { code: string; message: string; request_id: string };
  details?: Array<{ path: string; code: string }>;
}

/** D#601 MEM-4a2: the memory routes through the real dispatcher on real Postgres (row security forced, the real definers of migration 0835). */
describe('D#601 MEM-4a2: memory routes', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let aAdmin: Identity;
  let aMember: Identity;
  let bAdmin: Identity;
  let repoRef: string;
  let n = 0;

  async function addMember(accountId: string, role: 'admin' | 'member'): Promise<Identity> {
    const userId = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [accountId, userId, role]);
    return { accountId, userId };
  }
  async function call(who: Identity | string, method: string, urlPath: string, body?: unknown) {
    const h = new Headers();
    if (typeof who === 'string') h.set('authorization', `Bearer ${who}`);
    else h.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(who)}`);
    if (body !== undefined) h.set('content-type', 'application/json');
    return handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), appUserPool, platformOpsPool, ROUTES);
  }
  const schemaOf = (operationId: string) => ROUTES.find((r) => r.operationId === operationId)!.responseSchema;
  /** The body, checked against the response schema the OpenAPI document publishes. */
  async function ok<T = Record<string, unknown>>(res: Response, operationId: string): Promise<T> {
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(schemaOf(operationId).safeParse(json).success, JSON.stringify(json)).toBe(true);
    return json as T;
  }
  const err = async (res: Response) => ((await res.json()) as ErrBody).error.code;
  const text = (what: string) => `${what} ${++n} ${randomUUID()}`;
  /** A proposal written the way the pipeline does it (no user in the session). */
  const proposal = (accountId: string, over: Partial<{ author: 'agent' | 'import' | 'runner_agent'; prov: Record<string, string>; scope: 'repo' | 'item'; ref: string }> = {}): Promise<string> =>
    withTenant(appUserPool, accountId, async (c) => {
      const { rows } = await c.query<{ id: string }>(`SELECT memory_propose($1, $2, 'fact', $3, NULL, $4, $5::jsonb) AS id`, [
        over.scope ?? 'repo',
        over.ref ?? repoRef,
        text('proposal'),
        over.author ?? 'import',
        JSON.stringify(over.prov ?? { source_path: 'CLAUDE.md', source_commit: 'abcdef0123456789' }),
      ]);
      return rows[0]!.id;
    });
  async function tokenFor(who: Identity, scopes: Scope[]): Promise<string> {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, { accountId: who.accountId, createdBy: who.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes, expiresAt: new Date(Date.now() + 86_400_000) });
    return plaintext;
  }
  const status = async (id: string) => (await admin.query<{ status: string }>(`SELECT status FROM memory_entries WHERE id = $1`, [id])).rows[0]!.status;

  beforeAll(async () => {
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    aAdmin = await addMember(a.accountId, 'admin');
    aMember = await addMember(a.accountId, 'member');
    bAdmin = await addMember(b.accountId, 'admin');
    const inst = (await admin.query<{ g: string }>(`SELECT gh_installation_id::text AS g FROM installations WHERE id = $1`, [a.installationId])).rows[0]!.g;
    await admin.query(`UPDATE repos SET gh_node_id = $2, gh_owner = 'acme', gh_name = 'widgets' WHERE id = $1`, [a.repoId, NODE]);
    await admin.query(`UPDATE work_items SET title = 'Add the thing', gh_number = 42 WHERE id = $1`, [a.workItemId]);
    repoRef = repoScopeRef(NODE, inst);
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await Promise.all([adminPool.end(), platformOpsPool.end(), appUserPool.end()]);
  });

  it('registers the five operations, session only (no token principal can decide memory)', () => {
    for (const op of MEMORY_OPS) {
      const entry = ROUTES.find((r) => r.operationId === op);
      expect(entry, op).toBeDefined();
      expect(effectivePrincipals(entry!), op).toEqual(['session']);
    }
  });

  it('a token is refused on every route, whatever its scopes', async () => {
    const t = await tokenFor(aAdmin, ['read', 'work_items:write', 'corrections:write']);
    const id = await proposal(a.accountId, { author: 'agent' });
    for (const [method, p, body] of [
      ['GET', '/memory', undefined],
      ['GET', '/memory/queue', undefined],
      ['POST', `/memory/${id}/open`, undefined],
      ['POST', `/memory/${id}/decide`, { to: 'approved' }],
      ['POST', '/memory/decide-batch', { ids: [id], to: 'approved' }],
    ] as const) {
      expect((await call(t, method, p, body)).status, `${method} ${p}`).toBe(403);
    }
    expect(await status(id)).toBe('proposed');
  });

  describe('list and queue', () => {
    it('groups by scope with owner/name, shows runs as a number (0 when none), and no field is null where the schema says string', async () => {
      const id = await proposal(a.accountId, { author: 'agent', prov: { source_run_id: randomUUID() } });
      const itemEntry = await proposal(a.accountId, { author: 'agent', scope: 'item', ref: a.workItemId });
      const body = await ok<{ groups: Array<{ scope: string; label: string; target_id: string | null; entries: Array<Record<string, unknown>> }> }>(await call(aMember, 'GET', '/memory'), 'listMemory');
      const repoGroup = body.groups.find((g) => g.scope === 'repo')!;
      expect(repoGroup.label).toBe('acme/widgets');
      expect(repoGroup.target_id).toBe(a.repoId);
      const row = repoGroup.entries.find((e) => e.id === id)!;
      expect(row.runs).toBe(0);
      expect(row.runs_label).toBeTruthy();
      expect(body.groups.find((g) => g.scope === 'item')!.label).toBe('#42 Add the thing');
      expect(body.groups.flatMap((g) => g.entries).some((e) => e.id === itemEntry)).toBe(true);
      expect(JSON.stringify(body)).not.toMatch(/"(?:null|undefined)"/);
      for (const e of body.groups.flatMap((g) => g.entries)) for (const [k, v] of Object.entries(e)) expect(v, `${k} of ${e.id}`).not.toBeNull();
    });

    it('filters by repo, kind and status; an unknown name, an unknown key and a malformed id are 422', async () => {
      const filtered = await ok<{ groups: Array<{ scope: string }> }>(await call(aMember, 'GET', `/memory?repo_id=${a.repoId}&kind=fact&status=proposed`), 'listMemory');
      expect(filtered.groups.every((g) => g.scope === 'repo')).toBe(true);
      expect((await call(aMember, 'GET', '/memory?status=bogus')).status).toBe(422);
      expect((await call(aMember, 'GET', '/memory?extra=1')).status).toBe(422);
      expect((await call(aMember, 'GET', '/memory?repo_id=not-a-uuid')).status).toBe(422);
      expect((await call(aMember, 'GET', '/memory/queue?limit=0')).status).toBe(422);
      expect((await call(aMember, 'GET', '/memory/queue?kind=fact')).status).toBe(422);
    });

    it('another account sees none of it, and names none of its ids: a repo id of account A is a 404 for B', async () => {
      const body = await ok<{ groups: unknown[] }>(await call(bAdmin, 'GET', '/memory'), 'listMemory');
      expect(body.groups).toEqual([]);
      const q = await ok<{ cards: unknown[] }>(await call(bAdmin, 'GET', '/memory/queue'), 'getMemoryQueue');
      expect(q.cards).toEqual([]);
      expect((await call(bAdmin, 'GET', `/memory?repo_id=${a.repoId}`)).status).toBe(404);
    });

    it('the queue shows open_state per caller and per version, and the open route flips it for that caller only', async () => {
      const imp = await proposal(a.accountId, { author: 'import' });
      const agent = await proposal(a.accountId, { author: 'agent' });
      const states = async (who: Identity) => {
        const q = await ok<{ cards: Array<{ entry: { id: string }; open_state: string; proposed_by: string; evidence: string }> }>(await call(who, 'GET', `/memory/queue?repo_id=${a.repoId}`), 'getMemoryQueue');
        return Object.fromEntries(q.cards.map((c) => [c.entry.id, c.open_state]));
      };
      expect((await states(aAdmin))[imp]).toBe('unopened');
      expect((await states(aAdmin))[agent]).toBe('not_required');
      const opened = await ok<{ opened: boolean }>(await call(aAdmin, 'POST', `/memory/${imp}/open`), 'openMemoryCard');
      expect(opened.opened).toBe(true);
      expect((await states(aAdmin))[imp]).toBe('opened');
      const second = await addMember(a.accountId, 'admin');
      expect((await states(second))[imp]).toBe('unopened');
      // an agent card needs no record
      expect((await ok<{ opened: boolean }>(await call(aAdmin, 'POST', `/memory/${agent}/open`), 'openMemoryCard')).opened).toBe(false);
      const q = await ok<{ cards: Array<{ entry: { id: string }; proposed_by: string; evidence: string }> }>(await call(aAdmin, 'GET', '/memory/queue'), 'getMemoryQueue');
      expect(q.cards.find((c) => c.entry.id === agent)!.proposed_by).toMatch(/^Proposed by agent/);
      expect(q.cards.every((c) => typeof c.evidence === 'string')).toBe(true);
    });
  });

  describe('decide one', () => {
    it('an admin approves, a second call says already_decided, and a reject of an approved entry is refused with a fixed 422', async () => {
      const id = await proposal(a.accountId, { author: 'agent' });
      const first = await ok<{ outcome: string; entry: { status: string } }>(await call(aAdmin, 'POST', `/memory/${id}/decide`, { to: 'approved' }), 'decideMemory');
      expect(first.outcome).toBe('decided');
      expect(first.entry.status).toBe('approved');
      const again = await ok<{ outcome: string }>(await call(aAdmin, 'POST', `/memory/${id}/decide`, { to: 'approved' }), 'decideMemory');
      expect(again.outcome).toBe('already_decided');
      const bad = await call(aAdmin, 'POST', `/memory/${id}/decide`, { to: 'rejected' });
      expect(bad.status).toBe(422);
      expect(await status(id)).toBe('approved');
    });

    it('a member may not decide a repo entry (403, nothing changed); another account gets 404 on open, decide and batch; a malformed id is 404', async () => {
      const id = await proposal(a.accountId, { author: 'import' });
      expect((await call(aMember, 'POST', `/memory/${id}/decide`, { to: 'approved' })).status).toBe(403);
      expect((await call(aMember, 'POST', `/memory/${id}/open`)).status).toBe(403);
      expect(await status(id)).toBe('proposed');
      expect((await call(bAdmin, 'POST', `/memory/${id}/decide`, { to: 'approved' })).status).toBe(404);
      expect((await call(bAdmin, 'POST', `/memory/${id}/open`)).status).toBe(404);
      expect((await call(bAdmin, 'POST', '/memory/decide-batch', { ids: [id], to: 'approved' })).status).toBe(404);
      expect((await call(aAdmin, 'POST', '/memory/not-a-uuid/decide', { to: 'approved' })).status).toBe(404);
      expect(await status(id)).toBe('proposed');
    });

    it('strict bodies: an unknown key, a missing decision, a decision a person does not make here, and a non-object are 422', async () => {
      const id = await proposal(a.accountId, { author: 'agent' });
      for (const body of [{ to: 'approved', extra: 1 }, {}, { to: 'retired' }, { to: 'proposed' }, 'approved']) {
        expect((await call(aAdmin, 'POST', `/memory/${id}/decide`, body)).status, JSON.stringify(body)).toBe(422);
      }
      expect(await status(id)).toBe('proposed');
    });
  });

  describe('decide a batch', () => {
    it('a batch spanning two sources is refused with mixed_sources in the declared error shape, and nothing changes', async () => {
      const imp = await proposal(a.accountId, { author: 'import' });
      const agent = await proposal(a.accountId, { author: 'agent' });
      await call(aAdmin, 'POST', `/memory/${imp}/open`);
      const res = await call(aAdmin, 'POST', '/memory/decide-batch', { ids: [imp, agent], to: 'approved' });
      expect(res.status).toBe(422);
      const body = (await res.json()) as ErrBody;
      expect(body.error.code).toBe('mixed_sources');
      expect(body.error.request_id).toBeTruthy();
      expect(body.details).toEqual([{ path: 'ids', code: 'mixed_sources' }]);
      expect([await status(imp), await status(agent)]).toEqual(['proposed', 'proposed']);
    });

    it('an unopened import batch is refused with must_open_first naming how many, and opening them all lets it through', async () => {
      const ids = [await proposal(a.accountId), await proposal(a.accountId), await proposal(a.accountId)];
      await call(aAdmin, 'POST', `/memory/${ids[0]}/open`);
      const res = await call(aAdmin, 'POST', '/memory/decide-batch', { ids, to: 'approved' });
      expect(res.status).toBe(422);
      const body = (await res.json()) as ErrBody;
      expect(body.error.code).toBe('must_open_first');
      expect(body.error.message).toMatch(/^2 of these cards/);
      expect(body.details).toEqual([{ path: 'ids', code: 'must_open_first' }]);
      expect(await Promise.all(ids.map(status))).toEqual(['proposed', 'proposed', 'proposed']);
      for (const id of ids.slice(1)) await call(aAdmin, 'POST', `/memory/${id}/open`);
      const done = await ok<{ decided: number; entries: Array<{ status: string }> }>(await call(aAdmin, 'POST', '/memory/decide-batch', { ids, to: 'approved' }), 'decideMemoryBatch');
      expect(done.decided).toBe(3);
      expect(done.entries.map((e) => e.status)).toEqual(['approved', 'approved', 'approved']);
    });

    it('user A\'s open record does not satisfy user B\'s batch', async () => {
      const id = await proposal(a.accountId);
      await call(aAdmin, 'POST', `/memory/${id}/open`);
      const other = await addMember(a.accountId, 'admin');
      const res = await call(other, 'POST', '/memory/decide-batch', { ids: [id], to: 'approved' });
      expect(await err(res)).toBe('must_open_first');
    });

    it('an agent batch needs no open record; a reject works too', async () => {
      const ids = [await proposal(a.accountId, { author: 'agent' }), await proposal(a.accountId, { author: 'agent' })];
      const done = await ok<{ decided: number; entries: Array<{ status: string }> }>(await call(aAdmin, 'POST', '/memory/decide-batch', { ids, to: 'rejected' }), 'decideMemoryBatch');
      expect(done.decided).toBe(2);
      expect(done.entries.map((e) => e.status)).toEqual(['rejected', 'rejected']);
    });

    it('21 ids, no ids, a malformed id, an unknown key and a decision that is not approve or reject are 422; a member is 403', async () => {
      const ids21 = Array.from({ length: 21 }, () => randomUUID());
      for (const body of [{ ids: ids21, to: 'approved' }, { ids: [], to: 'approved' }, { ids: ['nope'], to: 'approved' }, { ids: [randomUUID()], to: 'approved', extra: true }, { ids: [randomUUID()], to: 'retired' }]) {
        expect((await call(aAdmin, 'POST', '/memory/decide-batch', body)).status, JSON.stringify(body).slice(0, 60)).toBe(422);
      }
      const id = await proposal(a.accountId, { author: 'agent' });
      expect((await call(aMember, 'POST', '/memory/decide-batch', { ids: [id], to: 'approved' })).status).toBe(403);
      expect(await status(id)).toBe('proposed');
    });
  });
});
