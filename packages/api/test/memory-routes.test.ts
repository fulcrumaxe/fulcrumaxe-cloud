import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '@fx/core/src/tenancy/withTenant.js';
import { listMemoryVersions, repoScopeRef } from '@fx/core/src/memory/index.js';
import { memoryEditDeps } from '../src/routes/memory.js';
import { insertApiToken, type Scope } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { effectivePrincipals } from '../src/registry.js';
import { ROUTES } from '../src/routes/index.js';

const NODE = 'R_kgDOApiMem01';
const MEMORY_OPS = ['listMemory', 'listMemoryRuns', 'getMemoryQueue', 'getMemoryPendingCounts', 'openMemoryCard', 'decideMemory', 'editMemory', 'decideMemoryBatch'];

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

  it('registers the eight operations, session only (no token principal can decide memory)', () => {
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
      ['POST', `/memory/${id}/edit`, { body: 'x' }],
      ['GET', `/memory/pending-counts?repo_ids=${a.repoId}`, undefined],
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

  describe('edit (a new version; the author kind stays)', () => {
    type EditBody = { entry: { id: string; status: string; version: number; author_kind: string; body: string; scope: string; kind: string }; previous_id: string };
    const edit = (who: Identity | string, id: string, body: unknown) => call(who, 'POST', `/memory/${id}/edit`, body);

    it('editing an agent proposal records version 2, keeps it proposed and agent-authored, and leaves the old text readable as superseded', async () => {
      const id = await proposal(a.accountId, { author: 'agent', prov: { source_run_id: 'run-edit-1', evidence: 'the failing test' } });
      const newBody = text('edited by a person');
      const r = await ok<EditBody>(await edit(aAdmin, id, { body: newBody, why: 'it warms a cache', kind: 'gotcha' }), 'editMemory');
      expect(r.previous_id).toBe(id);
      expect(r.entry).toMatchObject({ version: 2, status: 'proposed', author_kind: 'agent', body: newBody, kind: 'gotcha', scope: 'repo' });
      expect(r.entry.id).not.toBe(id);
      expect(await status(id)).toBe('superseded');
      const chain = { v: await listMemoryVersions({ pool: appUserPool, principal: aAdmin, liveSecrets: () => [] }, r.entry.id) };
      expect(chain.v.map((e) => [e.version, e.status, e.authorKind])).toEqual([[1, 'superseded', 'agent'], [2, 'proposed', 'agent']]);
      // The card still says who proposed it, and the edit did not move the text out of the fence (the author kind is the fence's key).
      const q = await ok<{ cards: Array<{ entry: { id: string }; proposed_by: string }> }>(await call(aAdmin, 'GET', `/memory/queue?repo_id=${a.repoId}`), 'getMemoryQueue');
      expect(q.cards.find((c) => c.entry.id === r.entry.id)!.proposed_by).toBe('Proposed by agent (run run-edit-1)');
      expect(q.cards.some((c) => c.entry.id === id)).toBe(false);
      // Edit then approve: the answer's id is the one to decide on.
      const approved = await ok<{ entry: { status: string } }>(await call(aAdmin, 'POST', `/memory/${r.entry.id}/decide`, { to: 'approved' }), 'decideMemory');
      expect(approved.entry.status).toBe('approved');
    });

    it('editing an approved entry keeps it approved as the new version, and "restore previous" is an edit back to the old text (history keeps all three)', async () => {
      const id = await proposal(a.accountId, { author: 'agent' });
      await call(aAdmin, 'POST', `/memory/${id}/decide`, { to: 'approved' });
      const original = (await admin.query<{ body: string }>(`SELECT body FROM memory_entries WHERE id = $1`, [id])).rows[0]!.body;
      const v2 = await ok<EditBody>(await edit(aAdmin, id, { body: text('second') }), 'editMemory');
      expect(v2.entry).toMatchObject({ status: 'approved', version: 2, author_kind: 'agent' });
      const v3 = await ok<EditBody>(await edit(aAdmin, v2.entry.id, { body: original }), 'editMemory');
      expect(v3.entry).toMatchObject({ status: 'approved', version: 3, body: original });
      expect(await Promise.all([id, v2.entry.id].map(status))).toEqual(['superseded', 'superseded']);
    });

    it('moves an entry ("Change scope") from the repo to an item and back; an agent\'s text cannot become an account entry; a place needs its one id', async () => {
      const id = await proposal(a.accountId, { author: 'agent' });
      const toItem = await ok<EditBody>(await edit(aAdmin, id, { body: text('moved'), scope: 'item', item_id: a.workItemId }), 'editMemory');
      expect(toItem.entry).toMatchObject({ scope: 'item', author_kind: 'agent', version: 2 });
      const toRepo = await ok<EditBody>(await edit(aAdmin, toItem.entry.id, { body: text('home'), scope: 'repo', repo_id: a.repoId }), 'editMemory');
      expect(toRepo.entry).toMatchObject({ scope: 'repo', version: 3 });
      expect(await err(await edit(aAdmin, toRepo.entry.id, { body: text('up'), scope: 'account' }))).toBe('invalid_message');
      for (const body of [
        { body: 'x', scope: 'repo' },
        { body: 'x', scope: 'repo', repo_id: a.repoId, item_id: a.workItemId },
        { body: 'x', scope: 'account', repo_id: a.repoId },
        { body: 'x', repo_id: a.repoId },
      ]) {
        expect((await edit(aAdmin, toRepo.entry.id, body)).status, JSON.stringify(body)).toBe(422);
      }
      expect((await edit(aAdmin, toRepo.entry.id, { body: 'x', scope: 'item', item_id: randomUUID() })).status).toBe(404);
      expect(await status(toRepo.entry.id)).toBe('proposed');
    });

    it('refuses a text that holds a live token value or a credential shape (422 secret_detected), stores nothing, and the refusal does not echo the text', async () => {
      const id = await proposal(a.accountId, { author: 'agent' });
      const live = `live-${randomUUID()}-${randomUUID()}`;
      const before = (await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM memory_entries WHERE account_id = $1`, [a.accountId])).rows[0]!.n;
      memoryEditDeps.liveSecrets = () => [live];
      try {
        for (const body of [`use ${live} to log in`, `ghs_${'A1b2C3d4E5'.repeat(4)}`]) {
          const res = await edit(aAdmin, id, { body });
          expect(res.status).toBe(422);
          const raw = await res.text();
          expect((JSON.parse(raw) as ErrBody).error.code).toBe('secret_detected');
          expect(raw).not.toContain(live);
        }
      } finally {
        memoryEditDeps.liveSecrets = () => [];
      }
      const after = (await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM memory_entries WHERE account_id = $1`, [a.accountId])).rows[0]!.n;
      expect(after).toBe(before);
      expect(await status(id)).toBe('proposed');
      expect((await admin.query(`SELECT 1 FROM memory_entries WHERE account_id = $1 AND body LIKE $2`, [a.accountId, `%${live}%`])).rowCount).toBe(0);
    });

    it('the registered live-secret source is read at each edit, not once', async () => {
      const id = await proposal(a.accountId, { author: 'agent' });
      const live = `late-${randomUUID()}-${randomUUID()}`;
      expect((await edit(aAdmin, id, { body: `ok ${live}` })).status).toBe(200);
      const id2 = await proposal(a.accountId, { author: 'agent' });
      memoryEditDeps.liveSecrets = () => [live];
      try {
        expect(await err(await edit(aAdmin, id2, { body: `ok ${live}` }))).toBe('secret_detected');
      } finally {
        memoryEditDeps.liveSecrets = () => [];
      }
    });

    it('a member may not edit a repo entry they did not propose (403, nothing changed); another account gets 404; a malformed id is 404; a token is 403', async () => {
      const id = await proposal(a.accountId, { author: 'import' });
      expect((await edit(aMember, id, { body: text('nope') })).status).toBe(403);
      expect(await status(id)).toBe('proposed');
      expect((await edit(bAdmin, id, { body: text('nope') })).status).toBe(404);
      expect((await edit(aAdmin, 'not-a-uuid', { body: 'x' })).status).toBe(404);
      const t = await tokenFor(aAdmin, ['read', 'work_items:write']);
      expect((await edit(t, id, { body: 'x' })).status).toBe(403);
      expect((await admin.query(`SELECT 1 FROM memory_entries WHERE supersedes_id = $1`, [id])).rowCount).toBe(0);
    });

    it('a member edits the proposal they made themselves, in place, but a pipeline proposal is nobody\'s own (migration 0868)', async () => {
      const mine = await withTenant(appUserPool, a.accountId, aMember.userId, async (c) => {
        const { rows } = await c.query<{ id: string }>(`SELECT memory_propose('repo', $1, 'fact', $2, NULL, 'person', '{}'::jsonb) AS id`, [repoRef, text('mine')]);
        return rows[0]!.id;
      });
      const r = await ok<EditBody>(await edit(aMember, mine, { body: text('mine, reworded') }), 'editMemory');
      expect(r.entry).toMatchObject({ author_kind: 'person', status: 'proposed', version: 2 });
      // Moving it to another scope is not "in place": a repo or account entry is for an owner or admin.
      expect((await edit(aMember, r.entry.id, { body: text('moved'), scope: 'account' })).status).toBe(403);
      const pipeline = await proposal(a.accountId, { author: 'runner_agent' });
      expect((await edit(aMember, pipeline, { body: text('rewrite') })).status).toBe(403);
      expect(await status(pipeline)).toBe('proposed');
    });

    it('an item member edits an item entry; a rejected entry cannot be edited (422) and a superseded one is a conflict (409)', async () => {
      const item = await proposal(a.accountId, { author: 'agent', scope: 'item', ref: a.workItemId });
      expect((await edit(aMember, item, { body: text('item edit') })).status).toBe(200);
      const rejected = await proposal(a.accountId, { author: 'agent' });
      await call(aAdmin, 'POST', `/memory/${rejected}/decide`, { to: 'rejected' });
      expect(await err(await edit(aAdmin, rejected, { body: text('late') }))).toBe('invalid_transition');
      // The first edit made `item` a superseded version: a second edit of it lost the race, which the database reports as a conflict.
      expect(await err(await edit(aAdmin, item, { body: text('stale') }))).toBe('conflict');
    });

    it('strict bodies: no body, an empty or over-1-KiB body, an unknown key, a reason over 256 B, an unknown kind and a non-object are 422', async () => {
      const id = await proposal(a.accountId, { author: 'agent' });
      for (const body of [{}, { body: '' }, { body: 'x'.repeat(1025) }, { body: 'x', extra: 1 }, { body: 'x', why: 'w'.repeat(257) }, { body: 'x', kind: 'bogus' }, 'text']) {
        expect((await edit(aAdmin, id, body)).status, JSON.stringify(body).slice(0, 50)).toBe(422);
      }
      expect(await status(id)).toBe('proposed');
    });

    it('two edits of one version at once: one wins, the other is 409 conflict, and the table holds one superseded row and one new version', async () => {
      const id = await proposal(a.accountId, { author: 'agent' });
      const results = await Promise.all([edit(aAdmin, id, { body: text('first') }), edit(aAdmin, id, { body: text('second') })]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const loser = results.find((r) => r.status === 409)!;
      expect(((await loser.json()) as ErrBody).error.code).toBe('conflict');
      const successors = await admin.query(`SELECT status FROM memory_entries WHERE supersedes_id = $1`, [id]);
      expect(successors.rows).toEqual([{ status: 'proposed' }]);
      expect(await status(id)).toBe('superseded');
    });
  });

  describe('the runs behind "Used in N runs"', () => {
    type Runs = { total: number; truncated: boolean; runs: Array<{ id: string; recorded_at: string }> };
    async function runRecalling(accountId: string, entries: Array<{ id: string; version: number }>): Promise<string> {
      const id = randomUUID();
      await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'executor', 'production', 'succeeded')`, [id, accountId]);
      await admin.query(`INSERT INTO run_context_inputs (account_id, run_id, recalled_entry_ids, recalled_entry_versions) VALUES ($1, $2, $3::uuid[], $4::integer[])`, [accountId, id, entries.map((e) => e.id), entries.map((e) => e.version)]);
      return id;
    }
    const runsOf = (who: Identity, id: string) => call(who, 'GET', `/memory/${id}/runs`);
    const listedRuns = async (who: Identity, id: string) => {
      const body = await ok<{ groups: Array<{ entries: Array<{ id: string; runs: number }> }> }>(await call(who, 'GET', '/memory?status=proposed,approved'), 'listMemory');
      return body.groups.flatMap((g) => g.entries).find((e) => e.id === id)!.runs;
    };

    it('lists the specific runs, and the total equals the count the list shows; none gives 0 and an empty list', async () => {
      const id = await proposal(a.accountId, { author: 'agent' });
      const none = await ok<Runs>(await runsOf(aMember, id), 'listMemoryRuns');
      expect(none).toEqual({ total: 0, truncated: false, runs: [] });
      expect(await listedRuns(aMember, id)).toBe(0);
      const runs = [await runRecalling(a.accountId, [{ id, version: 1 }]), await runRecalling(a.accountId, [{ id, version: 1 }]), await runRecalling(a.accountId, [{ id, version: 1 }])];
      const three = await ok<Runs>(await runsOf(aMember, id), 'listMemoryRuns');
      expect(three.total).toBe(3);
      expect(three.runs.map((r) => r.id).sort()).toEqual([...runs].sort());
      expect(three.total).toBe(three.runs.length);
      expect(await listedRuns(aMember, id)).toBe(three.total);
      for (const r of three.runs) expect((await admin.query(`SELECT 1 FROM agent_runs WHERE id = $1 AND account_id = $2`, [r.id, a.accountId])).rowCount).toBe(1);
    });

    it('an edit does not reset it: asking about either version names the runs of both', async () => {
      const id = await proposal(a.accountId, { author: 'agent' });
      const r1 = await runRecalling(a.accountId, [{ id, version: 1 }]);
      const edited = await ok<{ entry: { id: string } }>(await call(aAdmin, 'POST', `/memory/${id}/edit`, { body: text('second') }), 'editMemory');
      const r2 = await runRecalling(a.accountId, [{ id: edited.entry.id, version: 2 }]);
      for (const ask of [id, edited.entry.id]) {
        const r = await ok<Runs>(await runsOf(aMember, ask), 'listMemoryRuns');
        expect(r.runs.map((x) => x.id).sort()).toEqual([r1, r2].sort());
        expect(r.total).toBe(2);
      }
      expect(await listedRuns(aMember, edited.entry.id)).toBe(2);
    });

    it('caps the list at 50 and says so: total keeps counting', async () => {
      const id = await proposal(a.accountId, { author: 'agent' });
      for (let i = 0; i < 51; i++) await runRecalling(a.accountId, [{ id, version: 1 }]);
      const r = await ok<Runs>(await runsOf(aMember, id), 'listMemoryRuns');
      expect(r.runs).toHaveLength(50);
      expect(r).toMatchObject({ total: 51, truncated: true });
    });

    // Row-level security already isolates tenants; this guards that the query stays on the tenant session
    // (a privileged pool or a SECURITY DEFINER function would let account B's run into A's list and total).
    it('another account gets 404 (the same answer as no such entry), its own runs never appear, a malformed id is 404, a token is 403', async () => {
      const id = await proposal(a.accountId, { author: 'agent' });
      const mine = await runRecalling(a.accountId, [{ id, version: 1 }]);
      const foreign = await runRecalling(b.accountId, [{ id, version: 1 }]);
      const own = await ok<Runs>(await runsOf(aMember, id), 'listMemoryRuns');
      expect(own.runs.map((r) => r.id)).toEqual([mine]);
      expect(own.runs.map((r) => r.id)).not.toContain(foreign);
      expect(own).toMatchObject({ total: 1, truncated: false });
      expect(await listedRuns(aMember, id)).toBe(1);
      expect((await runsOf(bAdmin, id)).status).toBe(404);
      expect((await runsOf(bAdmin, randomUUID())).status).toBe(404);
      expect((await runsOf(aMember, 'not-a-uuid')).status).toBe(404);
      expect((await call(await tokenFor(aAdmin, ['read']), 'GET', `/memory/${id}/runs`)).status).toBe(403);
    });
  });

  describe('pending counts (the badge equals the queue)', () => {
    type Counts = { repos: Record<string, number>; items: Record<string, number> };
    const counts = async (who: Identity, qs: string) => ok<Counts>(await call(who, 'GET', `/memory/pending-counts?${qs}`), 'getMemoryPendingCounts');
    const queueSize = async (who: Identity, qs: string) => (await ok<{ cards: unknown[] }>(await call(who, 'GET', `/memory/queue?${qs}`), 'getMemoryQueue')).cards.length;

    it('a repo and an item count the same cards the queue holds, and the number drops after a decision', async () => {
      const ids = [await proposal(a.accountId), await proposal(a.accountId, { author: 'agent' })];
      await proposal(a.accountId, { author: 'agent', scope: 'item', ref: a.workItemId });
      const c = await counts(aMember, `repo_ids=${a.repoId}&item_ids=${a.workItemId}`);
      expect(c.repos[a.repoId]).toBe(await queueSize(aMember, `repo_id=${a.repoId}`));
      expect(c.items[a.workItemId]).toBe(await queueSize(aMember, `item_id=${a.workItemId}`));
      expect(c.repos[a.repoId]).toBeGreaterThanOrEqual(2);
      await call(aAdmin, 'POST', `/memory/${ids[1]}/decide`, { to: 'approved' });
      const after = await counts(aMember, `repo_ids=${a.repoId}`);
      expect(after.repos[a.repoId]).toBe(c.repos[a.repoId]! - 1);
      expect(after.repos[a.repoId]).toBe(await queueSize(aMember, `repo_id=${a.repoId}`));
      expect(after.items).toEqual({});
    });

    it('answers a number for every id asked; another account\'s ids read 0 and reveal nothing, and its own counts are unaffected', async () => {
      const stranger = randomUUID();
      const c = await counts(bAdmin, `repo_ids=${a.repoId}&item_ids=${a.workItemId},${stranger}`);
      expect(c).toEqual({ repos: { [a.repoId]: 0 }, items: { [a.workItemId]: 0, [stranger]: 0 } });
    });

    it('needs at least one list; refuses 201 ids, a malformed id, an empty list and an unknown key (422)', async () => {
      const many = Array.from({ length: 201 }, () => randomUUID()).join(',');
      for (const qs of ['', `repo_ids=${many}`, 'repo_ids=nope', 'repo_ids=', 'item_ids=,,', `repo_ids=${a.repoId}&extra=1`]) {
        expect((await call(aMember, 'GET', `/memory/pending-counts?${qs}`)).status, qs.slice(0, 40)).toBe(422);
      }
    });
  });
});
