import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken, type Scope } from '@fx/core/src/tokens/service.js';
import { createRecordingRunActionSignal } from '@fx/core/src/runActions/index.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { runActionDeps } from '../src/routes/run-actions.js';
import { seedAccountWithMember } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}
interface ErrBody {
  error: { code: string; message: string; request_id: string };
}
interface Accepted {
  action_id: string;
  state: string;
}

let ghNumber = 500;
let discussionNumber = 900;

/**
 * Back to discussion, Treat as a feature and Close: POST /work-items/{id}/{back-to-discussion,treat-as-feature,close}
 * through the real dispatcher against real Postgres. Allowed paths, and every refusal (wrong role, a token, a live run,
 * an illegal stage, the wrong kind, an outsider's item, no repository, no issue, no Spec), each writing nothing.
 */
describe('work item actions: back to discussion, treat as a feature, close', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  const signal = createRecordingRunActionSignal();

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
  beforeEach(() => {
    runActionDeps.getRunActionSignal = () => signal;
    signal.sent.length = 0;
  });
  afterEach(() => {
    runActionDeps.getRunActionSignal = () => null;
  });

  async function post(who: Identity | string, urlPath: string, extra: { headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
    const h = new Headers(extra.headers ?? {});
    if (typeof who === 'string') h.set('authorization', `Bearer ${who}`);
    else h.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(who)}`);
    if (extra.body !== undefined) h.set('content-type', 'application/json');
    return handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { method: 'POST', headers: h, body: extra.body }), appUserPool, platformOpsPool, ROUTES);
  }
  const person = (role: 'owner' | 'admin' | 'member') => seedAccountWithMember(admin, { role });
  const code = async (res: Response) => ((await res.json()) as ErrBody).error.code;
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

  interface Seed {
    stage?: string;
    kind?: string;
    spec?: boolean;
    discussion?: boolean;
    provenance?: string;
    repo?: boolean;
    number?: boolean;
    /** The Spec stores a readable file list (default: it does not, as every Spec written before D#6 R4d-5a). */
    list?: boolean;
  }
  /** The pipeline's card for an issue: a work item with its discussion of `kind`, and (unless `spec` is false) one published Spec. */
  async function seed(accountId: string, over: Seed = {}): Promise<{ item: string; discussion: string | null }> {
    const item = randomUUID();
    const repo = over.repo === false ? null : randomUUID();
    if (repo) await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, 'team', 'acme', 'widgets')`, [repo, accountId, Math.floor(Math.random() * 1_000_000_000) + 1]);
    const kind = over.kind ?? 'feature';
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, gh_number, provenance, stage) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
      item,
      accountId,
      repo,
      kind,
      over.number === false ? null : ghNumber++,
      over.provenance ?? 'internal',
      over.stage ?? 'needs_human',
    ]);
    let discussion: string | null = null;
    if (over.discussion !== false) {
      discussion = randomUUID();
      await admin.query(`INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, $2, $3, $4, 't', $5, 'internal', 'user')`, [discussion, accountId, discussionNumber++, kind, item]);
      await admin.query('UPDATE work_items SET discussion_id = $1 WHERE id = $2', [discussion, item]);
    }
    if (over.spec !== false) {
      await admin.query(`INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind, frontmatter) VALUES ($1, $2, 1, 'spec', encode(sha256(convert_to('spec', 'UTF8')), 'hex'), 'system', $3::jsonb)`, [accountId, item, JSON.stringify(over.list === true ? { acceptance_files: ['src/**'] } : {})]);
    }
    return { item, discussion };
  }
  async function seedRun(accountId: string, workItemId: string, status: string): Promise<void> {
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'local', $4)`, [randomUUID(), accountId, workItemId, status]);
  }
  const one = async <T>(sql: string, params: unknown[]): Promise<T | undefined> => (await admin.query(sql, params)).rows[0] as T | undefined;
  const stageOf = async (item: string) => (await one<{ stage: string }>('SELECT stage FROM work_items WHERE id = $1', [item]))!.stage;
  const kindsOf = async (item: string, discussion: string) => ({
    card: (await one<{ kind: string }>('SELECT kind FROM work_items WHERE id = $1', [item]))!.kind,
    discussion: (await one<{ kind: string }>('SELECT kind FROM discussions WHERE id = $1', [discussion]))!.kind,
  });
  const count = async (sql: string, accountId: string) => Number((await admin.query<{ n: string }>(sql, [accountId])).rows[0]!.n);
  const requests = (a: string) => count('SELECT count(*) AS n FROM run_action_requests WHERE account_id = $1', a);
  const audits = (a: string) => count(`SELECT count(*) AS n FROM audit_log WHERE account_id = $1 AND action LIKE 'work_item.%'`, a);
  const transitions = (a: string) => count(`SELECT count(*) AS n FROM work_item_transitions WHERE account_id = $1`, a);
  /** The item is exactly as seeded: same stage, nothing requested, nothing audited, no transition, no signal. */
  async function expectUntouched(a: string, item: string, stage: string) {
    expect(await stageOf(item)).toBe(stage);
    expect(await requests(a)).toBe(0);
    expect(await audits(a)).toBe(0);
    expect(await transitions(a)).toBe(0);
    expect(signal.sent).toEqual([]);
  }

  describe('Re-spec (D#6 R4d-5b)', () => {
    const path = (id: string) => `/work-items/${id}/respec`;

    it.each([
      ['owner', 'spec_ready'],
      ['admin', 'needs_human'],
    ] as const)('an %s re-specs an item at %s whose Spec has no list: 202, one respec_work_item request and its signal, and NOTHING else is written (no stage move, no audit, no Spec)', async (role, stage) => {
      const p = await person(role);
      const { item } = await seed(p.accountId, { stage });
      const res = await post(p, path(item));
      expect(res.status).toBe(202);
      const body = (await res.json()) as Accepted;
      expect(body.state).toBe('accepted');
      expect(await one('SELECT 1 AS x FROM run_action_requests WHERE id = $1 AND kind = $2 AND target_id = $3', [body.action_id, 'respec_work_item', item])).toBeTruthy();
      expect(signal.sent).toEqual([{ actionId: body.action_id, accountId: p.accountId, kind: 'respec_work_item' }]);
      expect(await stageOf(item)).toBe(stage);
      expect(await audits(p.accountId)).toBe(0);
      expect(await transitions(p.accountId)).toBe(0);
      expect(Number((await one<{ n: string }>('SELECT count(*) AS n FROM spec_versions WHERE work_item_id = $1', [item]))!.n)).toBe(1);
    });

    it('a keyed repeat is the same action, and a second press while one is accepted is the same live request', async () => {
      const p = await person('owner');
      const { item } = await seed(p.accountId, { stage: 'spec_ready' });
      const first = (await (await post(p, path(item), { headers: { 'idempotency-key': 'k1' } })).json()) as Accepted;
      const again = (await (await post(p, path(item), { headers: { 'idempotency-key': 'k1' } })).json()) as Accepted;
      expect(again.action_id).toBe(first.action_id);
      expect(await requests(p.accountId)).toBe(1);
    });

    it('F11: an item whose newest Spec already has a readable list is 409 action_not_available and nothing is written', async () => {
      const p = await person('owner');
      const { item } = await seed(p.accountId, { stage: 'spec_ready', list: true });
      const res = await post(p, path(item));
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('action_not_available');
      await expectUntouched(p.accountId, item, 'spec_ready');
    });

    it.each(['triaged', 'discussing', 'in_progress', 'pr_opened', 'merged', 'closed'])('an item at %s is 409 action_not_available', async (stage) => {
      const p = await person('owner');
      const { item } = await seed(p.accountId, { stage });
      const res = await post(p, path(item));
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('action_not_available');
      await expectUntouched(p.accountId, item, stage);
    });

    it('a member is 403 insufficient_role, a token is 403 session_required, an external item is 403 external_requires_human, no repository is 409 no_repo; nothing is written', async () => {
      const m = await person('member');
      const mine = await seed(m.accountId, { stage: 'spec_ready' });
      const res = await post(m, path(mine.item));
      expect(res.status).toBe(403);
      expect(await code(res)).toBe('insufficient_role');
      const p = await person('owner');
      const { item } = await seed(p.accountId, { stage: 'spec_ready' });
      const viaToken = await post(await tokenFor(p, ['read', 'runs:cancel']), path(item));
      expect(viaToken.status).toBe(403);
      expect(await code(viaToken)).toBe('session_required');
      expect(await code(await post(p, path((await seed(p.accountId, { stage: 'spec_ready', provenance: 'external' })).item)))).toBe('external_requires_human');
      expect(await code(await post(p, path((await seed(p.accountId, { stage: 'spec_ready', repo: false })).item)))).toBe('no_repo');
      expect(await requests(p.accountId)).toBe(0);
      expect(await requests(m.accountId)).toBe(0);
    });

    it.each(['pending', 'running', 'paused'])('a %s run on the item is 409 already_running', async (status) => {
      const p = await person('owner');
      const { item } = await seed(p.accountId, { stage: 'needs_human' });
      await seedRun(p.accountId, item, status);
      const res = await post(p, path(item));
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('already_running');
      await expectUntouched(p.accountId, item, 'needs_human');
    });

    it("a malformed, an unknown and another account's id all get the same 404", async () => {
      const a = await person('owner');
      const b = await person('owner');
      const foreign = (await seed(b.accountId, { stage: 'spec_ready' })).item;
      for (const id of ['not-a-uuid', randomUUID(), foreign]) expect((await post(a, path(id))).status, id).toBe(404);
    });
  });

  describe('Back to discussion', () => {
    const path = (id: string) => `/work-items/${id}/back-to-discussion`;

    it.each(['owner', 'admin'] as const)('an %s sends a Needs-a-person feature with a Spec back: 202, the stage is discussing, one transition, one audit row, one advance_work_item request, one signal', async (role) => {
      const p = await person(role);
      const { item } = await seed(p.accountId);
      const res = await post(p, path(item));
      expect(res.status).toBe(202);
      const body = (await res.json()) as Accepted;
      expect(body.state).toBe('accepted');
      expect(await stageOf(item)).toBe('discussing');
      const t = await one<{ from_stage: string; to_stage: string; source: string; source_ref: string }>('SELECT from_stage, to_stage, source, source_ref FROM work_item_transitions WHERE work_item_id = $1', [item]);
      expect(t).toMatchObject({ from_stage: 'needs_human', to_stage: 'discussing', source: 'control_plane' });
      expect(t!.source_ref).toMatch(/^back_to_discussion:/);
      const a = await one<{ actor: string; payload: Record<string, string> }>(`SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'work_item.sent_back'`, [p.accountId]);
      expect(a!.actor).toBe(p.userId);
      expect(a!.payload).toMatchObject({ work_item_id: item, from_stage: 'needs_human', to_stage: 'discussing' });
      expect(await one('SELECT 1 AS x FROM run_action_requests WHERE id = $1 AND kind = $2 AND target_id = $3', [body.action_id, 'advance_work_item', item])).toBeTruthy();
      expect(signal.sent).toEqual([{ actionId: body.action_id, accountId: p.accountId, kind: 'advance_work_item' }]);
    });

    it('the Spec stays published (the new panel and Spec supersede it); the item can be approved at discussing afterwards', async () => {
      const p = await person('owner');
      const { item } = await seed(p.accountId, { kind: 'critical' });
      expect((await post(p, path(item))).status).toBe(202);
      expect(Number((await one<{ n: string }>('SELECT count(*) AS n FROM spec_versions WHERE work_item_id = $1', [item]))!.n)).toBe(1);
      await admin.query('DELETE FROM run_action_requests WHERE account_id = $1', [p.accountId]);
      expect((await post(p, `/work-items/${item}/approve`)).status).toBe(202);
    });

    it('a plain member is 403 insufficient_role and nothing is written', async () => {
      const p = await person('member');
      const { item } = await seed(p.accountId);
      const res = await post(p, path(item));
      expect(res.status).toBe(403);
      expect(await code(res)).toBe('insufficient_role');
      await expectUntouched(p.accountId, item, 'needs_human');
    });

    it('any token is 403 session_required, whatever its scope, and nothing is written', async () => {
      const p = await person('owner');
      const { item } = await seed(p.accountId);
      for (const scopes of [['read'], ['runs:cancel'], ['read', 'runs:cancel']] as Scope[][]) {
        const res = await post(await tokenFor(p, scopes), path(item));
        expect(res.status).toBe(403);
        expect(await code(res)).toBe('session_required');
      }
      await expectUntouched(p.accountId, item, 'needs_human');
    });

    it.each(['triaged', 'discussing', 'spec_ready', 'in_progress', 'pr_opened', 'review_passed', 'merged', 'closed_unmerged', 'closed'])('an item at %s is 409 action_not_available and nothing is written', async (stage) => {
      const p = await person('owner');
      const { item } = await seed(p.accountId, { stage });
      const res = await post(p, path(item));
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('action_not_available');
      await expectUntouched(p.accountId, item, stage);
    });

    it.each([
      ['a bug (no panel)', { kind: 'bug' }],
      ['a doc (no panel)', { kind: 'doc' }],
      ['a project', { kind: 'project' }],
      ['an item with no published Spec', { spec: false }],
      ['an item with no discussion', { discussion: false }],
    ])('%s is 409 action_not_available and nothing is written', async (_n, over) => {
      const p = await person('owner');
      const { item } = await seed(p.accountId, over);
      const res = await post(p, path(item));
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('action_not_available');
      await expectUntouched(p.accountId, item, 'needs_human');
    });

    it('an external item is 403 external_requires_human, no repository is 409 no_repo, no issue is 409 action_not_available; nothing is written', async () => {
      const p = await person('owner');
      const external = await seed(p.accountId, { provenance: 'external' });
      const res = await post(p, path(external.item));
      expect(res.status).toBe(403);
      expect(await code(res)).toBe('external_requires_human');
      expect(await code(await post(p, path((await seed(p.accountId, { repo: false })).item)))).toBe('no_repo');
      expect(await code(await post(p, path((await seed(p.accountId, { number: false })).item)))).toBe('action_not_available');
      expect(await requests(p.accountId)).toBe(0);
      expect(await audits(p.accountId)).toBe(0);
      expect(await transitions(p.accountId)).toBe(0);
    });

    it.each(['pending', 'running', 'paused'])('a %s run on the item is 409 already_running; a finished run does not block', async (status) => {
      const p = await person('owner');
      const { item } = await seed(p.accountId);
      await seedRun(p.accountId, item, status);
      const res = await post(p, path(item));
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('already_running');
      await expectUntouched(p.accountId, item, 'needs_human');
      await admin.query(`UPDATE agent_runs SET status = 'failed' WHERE work_item_id = $1`, [item]);
      expect((await post(p, path(item))).status).toBe(202);
    });

    it('a request body is refused and nothing is written (the route takes none)', async () => {
      const p = await person('owner');
      const { item } = await seed(p.accountId);
      for (const body of ['{}', '{"anything":1}']) {
        const res = await post(p, path(item), { body });
        expect(res.status, body).toBeGreaterThanOrEqual(400);
        expect(res.status, body).toBeLessThan(500);
      }
      await expectUntouched(p.accountId, item, 'needs_human');
    });

    it("a malformed, an unknown and another account's id all get the same 404 body", async () => {
      const a = await person('owner');
      const b = await person('owner');
      const foreign = (await seed(b.accountId)).item;
      const seen = new Set<string>();
      for (const id of ['not-a-uuid', randomUUID(), foreign]) {
        const res = await post(a, path(id));
        expect(res.status, id).toBe(404);
        const body = (await res.json()) as ErrBody;
        seen.add(JSON.stringify({ ...body, error: { ...body.error, request_id: '' } }));
      }
      expect(seen.size).toBe(1);
      expect(await stageOf(foreign)).toBe('needs_human');
      expect(await audits(b.accountId)).toBe(0);
    });

    it('with no signal registered it is 503 run_actions_unavailable before any write', async () => {
      runActionDeps.getRunActionSignal = () => null;
      const p = await person('owner');
      const { item } = await seed(p.accountId);
      const res = await post(p, path(item));
      expect(res.status).toBe(503);
      expect(await code(res)).toBe('run_actions_unavailable');
      await expectUntouched(p.accountId, item, 'needs_human');
    });

    it('a keyed repeat replays the original action_id and does not move or audit twice', async () => {
      const p = await person('owner');
      const { item } = await seed(p.accountId);
      const headers = { 'idempotency-key': 'k-back-1' };
      const first = (await (await post(p, path(item), { headers })).json()) as Accepted;
      const again = await post(p, path(item), { headers });
      expect(again.status).toBe(202);
      expect(again.headers.get('idempotent-replayed')).toBe('true');
      expect(((await again.json()) as Accepted).action_id).toBe(first.action_id);
      expect(await transitions(p.accountId)).toBe(1);
      expect(await audits(p.accountId)).toBe(1);
      expect(signal.sent).toHaveLength(1);
    });

    it('a second send-back (after the first panel ran and the item came back) is a new generation: its own transition row', async () => {
      const p = await person('owner');
      const { item } = await seed(p.accountId);
      expect((await post(p, path(item))).status).toBe(202);
      await admin.query(`UPDATE work_items SET stage = 'needs_human' WHERE id = $1`, [item]);
      await admin.query('DELETE FROM run_action_requests WHERE account_id = $1', [p.accountId]);
      expect((await post(p, path(item))).status).toBe(202);
      expect(Number((await one<{ n: string }>(`SELECT count(*) AS n FROM work_item_transitions WHERE work_item_id = $1 AND from_stage = 'needs_human' AND to_stage = 'discussing'`, [item]))!.n)).toBe(2);
    });
  });

  describe('Treat as a feature', () => {
    const path = (id: string) => `/work-items/${id}/treat-as-feature`;

    it.each(['owner', 'admin'] as const)('an %s changes a discussing project to a feature: 202, both kinds say feature, one audit row with old and new kind and who, one request, one signal', async (role) => {
      const p = await person(role);
      const { item, discussion } = await seed(p.accountId, { stage: 'discussing', kind: 'project', spec: false });
      const res = await post(p, path(item));
      expect(res.status).toBe(202);
      const body = (await res.json()) as Accepted;
      expect(await kindsOf(item, discussion!)).toEqual({ card: 'feature', discussion: 'feature' });
      expect(await stageOf(item)).toBe('discussing');
      const a = await one<{ actor: string; payload: Record<string, string> }>(`SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'work_item.kind_changed'`, [p.accountId]);
      expect(a!.actor).toBe(p.userId);
      expect(a!.payload).toMatchObject({ work_item_id: item, discussion_id: discussion, from_kind: 'project', to_kind: 'feature' });
      expect(signal.sent).toEqual([{ actionId: body.action_id, accountId: p.accountId, kind: 'advance_work_item' }]);
      expect(await requests(p.accountId)).toBe(1);
    });

    it.each(['feature', 'critical', 'bug', 'question'])('a discussing %s is 409 action_not_available (only a project is treated as a feature) and keeps its kind', async (kind) => {
      const p = await person('owner');
      const { item, discussion } = await seed(p.accountId, { stage: 'discussing', kind, spec: false });
      const res = await post(p, path(item));
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('action_not_available');
      expect(await kindsOf(item, discussion!)).toEqual({ card: kind, discussion: kind });
      expect(await audits(p.accountId)).toBe(0);
      expect(await requests(p.accountId)).toBe(0);
    });

    it.each(['triaged', 'spec_ready', 'in_progress', 'needs_human', 'merged', 'closed'])('a project at %s is 409 action_not_available and keeps its kind', async (stage) => {
      const p = await person('owner');
      const { item, discussion } = await seed(p.accountId, { stage, kind: 'project', spec: false });
      expect(await code(await post(p, path(item)))).toBe('action_not_available');
      expect(await kindsOf(item, discussion!)).toEqual({ card: 'project', discussion: 'project' });
      expect(await audits(p.accountId)).toBe(0);
    });

    it('a member is 403, a token is 403 session_required, an external item is 403 external_requires_human; the kind is unchanged', async () => {
      const m = await person('member');
      const mine = await seed(m.accountId, { stage: 'discussing', kind: 'project', spec: false });
      expect(await code(await post(m, path(mine.item)))).toBe('insufficient_role');
      const o = await person('owner');
      const theirs = await seed(o.accountId, { stage: 'discussing', kind: 'project', spec: false });
      expect(await code(await post(await tokenFor(o, ['read']), path(theirs.item)))).toBe('session_required');
      const outside = await seed(o.accountId, { stage: 'discussing', kind: 'project', spec: false, provenance: 'external' });
      expect(await code(await post(o, path(outside.item)))).toBe('external_requires_human');
      for (const s of [mine, theirs, outside]) expect(await kindsOf(s.item, s.discussion!)).toEqual({ card: 'project', discussion: 'project' });
      expect(await audits(m.accountId)).toBe(0);
      expect(await audits(o.accountId)).toBe(0);
      expect(signal.sent).toEqual([]);
    });

    it('no repository is 409 no_repo, no issue is 409 action_not_available, a live run is 409 already_running; the kind is unchanged', async () => {
      const p = await person('owner');
      const noRepo = await seed(p.accountId, { stage: 'discussing', kind: 'project', spec: false, repo: false });
      const noIssue = await seed(p.accountId, { stage: 'discussing', kind: 'project', spec: false, number: false });
      const live = await seed(p.accountId, { stage: 'discussing', kind: 'project', spec: false });
      await seedRun(p.accountId, live.item, 'running');
      expect(await code(await post(p, path(noRepo.item)))).toBe('no_repo');
      expect(await code(await post(p, path(noIssue.item)))).toBe('action_not_available');
      expect(await code(await post(p, path(live.item)))).toBe('already_running');
      for (const s of [noRepo, noIssue, live]) expect(await kindsOf(s.item, s.discussion!)).toEqual({ card: 'project', discussion: 'project' });
      expect(await audits(p.accountId)).toBe(0);
    });

    it('with no signal registered it is 503 before the kind changes', async () => {
      runActionDeps.getRunActionSignal = () => null;
      const p = await person('owner');
      const { item, discussion } = await seed(p.accountId, { stage: 'discussing', kind: 'project', spec: false });
      expect((await post(p, path(item))).status).toBe(503);
      expect(await kindsOf(item, discussion!)).toEqual({ card: 'project', discussion: 'project' });
      expect(await audits(p.accountId)).toBe(0);
    });

    it('after the change the item is an ordinary discussing feature: Approve starts the panel (the recovery if the request had failed)', async () => {
      const p = await person('owner');
      const { item } = await seed(p.accountId, { stage: 'discussing', kind: 'project', spec: false });
      expect(await code(await post(p, `/work-items/${item}/approve`))).toBe('not_approvable');
      expect((await post(p, path(item))).status).toBe(202);
      await admin.query('DELETE FROM run_action_requests WHERE account_id = $1', [p.accountId]);
      expect((await post(p, `/work-items/${item}/approve`)).status).toBe(202);
    });

    it('a second press after the change is 409 (it is a feature now) and audits nothing more', async () => {
      const p = await person('owner');
      const { item } = await seed(p.accountId, { stage: 'discussing', kind: 'project', spec: false });
      expect((await post(p, path(item))).status).toBe(202);
      expect(await code(await post(p, path(item)))).toBe('action_not_available');
      expect(await audits(p.accountId)).toBe(1);
    });
  });

  describe('Close', () => {
    const path = (id: string) => `/work-items/${id}/close`;
    const CLOSABLE = ['triaged', 'discussing', 'spec_ready', 'in_progress', 'needs_human'];

    it.each(CLOSABLE)('an owner closes an item at %s: 200 { work_item_id, stage }, the stage is closed, one transition, one audit row naming the person and the old stage; no run action, no signal', async (stage) => {
      const p = await person('owner');
      const { item } = await seed(p.accountId, { stage });
      const res = await post(p, path(item));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ work_item_id: item, stage: 'closed' });
      expect(await stageOf(item)).toBe('closed');
      const t = await one<{ from_stage: string; to_stage: string; source: string; source_ref: string }>('SELECT from_stage, to_stage, source, source_ref FROM work_item_transitions WHERE work_item_id = $1', [item]);
      expect(t).toMatchObject({ from_stage: stage, to_stage: 'closed', source: 'control_plane' });
      expect(t!.source_ref).toMatch(/^close:/);
      const a = await one<{ actor: string; payload: Record<string, string> }>(`SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'work_item.closed'`, [p.accountId]);
      expect(a!.actor).toBe(p.userId);
      expect(a!.payload).toMatchObject({ work_item_id: item, from_stage: stage });
      expect(await requests(p.accountId)).toBe(0);
      expect(signal.sent).toEqual([]);
    });

    it('an admin closes an item too', async () => {
      const p = await person('admin');
      const { item } = await seed(p.accountId, { stage: 'spec_ready' });
      expect((await post(p, path(item))).status).toBe(200);
    });

    it('closing works with no run-action signal registered (no agent is involved)', async () => {
      runActionDeps.getRunActionSignal = () => null;
      const p = await person('owner');
      const { item } = await seed(p.accountId, { stage: 'triaged', repo: false, number: false });
      expect((await post(p, path(item))).status).toBe(200);
    });

    it.each(['pr_opened', 'changes_requested', 'review_passed'])('an item at %s (an open pull request) is 409 action_not_available: it is closed by closing the pull request on GitHub', async (stage) => {
      const p = await person('owner');
      const { item } = await seed(p.accountId, { stage });
      const res = await post(p, path(item));
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('action_not_available');
      await expectUntouched(p.accountId, item, stage);
    });

    it.each(['merged', 'closed_unmerged', 'closed'])('an item at %s is 409 action_not_available and nothing is written', async (stage) => {
      const p = await person('owner');
      const { item } = await seed(p.accountId, { stage });
      expect(await code(await post(p, path(item)))).toBe('action_not_available');
      await expectUntouched(p.accountId, item, stage);
    });

    it('a plain member is 403 insufficient_role and nothing is written', async () => {
      const p = await person('member');
      const { item } = await seed(p.accountId);
      const res = await post(p, path(item));
      expect(res.status).toBe(403);
      expect(await code(res)).toBe('insufficient_role');
      await expectUntouched(p.accountId, item, 'needs_human');
    });

    it('any token is 403 session_required and nothing is written', async () => {
      const p = await person('owner');
      const { item } = await seed(p.accountId);
      for (const scopes of [['read'], ['runs:cancel']] as Scope[][]) {
        const res = await post(await tokenFor(p, scopes), path(item));
        expect(res.status).toBe(403);
        expect(await code(res)).toBe('session_required');
      }
      await expectUntouched(p.accountId, item, 'needs_human');
    });

    it('an external item is 403 external_requires_human and stays open', async () => {
      const p = await person('owner');
      const { item } = await seed(p.accountId, { provenance: 'external' });
      const res = await post(p, path(item));
      expect(res.status).toBe(403);
      expect(await code(res)).toBe('external_requires_human');
      await expectUntouched(p.accountId, item, 'needs_human');
    });

    it.each(['pending', 'running', 'paused'])('a %s run is 409 already_running (cancel it first); a finished run does not block', async (status) => {
      const p = await person('owner');
      const { item } = await seed(p.accountId, { stage: 'in_progress' });
      await seedRun(p.accountId, item, status);
      const res = await post(p, path(item));
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('already_running');
      await expectUntouched(p.accountId, item, 'in_progress');
      await admin.query(`UPDATE agent_runs SET status = 'cancelled' WHERE work_item_id = $1`, [item]);
      expect((await post(p, path(item))).status).toBe(200);
    });

    it('a request body is refused and the item stays open', async () => {
      const p = await person('owner');
      const { item } = await seed(p.accountId);
      for (const body of ['{}', '{"anything":1}']) {
        const res = await post(p, path(item), { body });
        expect(res.status, body).toBeGreaterThanOrEqual(400);
        expect(res.status, body).toBeLessThan(500);
      }
      await expectUntouched(p.accountId, item, 'needs_human');
    });

    it("a malformed, an unknown and another account's id all get the same 404 body, and the other account's item stays open", async () => {
      const a = await person('owner');
      const b = await person('owner');
      const foreign = (await seed(b.accountId)).item;
      const seen = new Set<string>();
      for (const id of ['not-a-uuid', randomUUID(), foreign]) {
        const res = await post(a, path(id));
        expect(res.status, id).toBe(404);
        const body = (await res.json()) as ErrBody;
        seen.add(JSON.stringify({ ...body, error: { ...body.error, request_id: '' } }));
      }
      expect(seen.size).toBe(1);
      await expectUntouched(b.accountId, foreign, 'needs_human');
    });

    it('a second close is 409 (already closed) and writes nothing more; a keyed repeat replays the first answer', async () => {
      const p = await person('owner');
      const { item } = await seed(p.accountId);
      const headers = { 'idempotency-key': 'k-close-1' };
      expect((await post(p, path(item), { headers })).status).toBe(200);
      const again = await post(p, path(item), { headers });
      expect(again.status).toBe(200);
      expect(again.headers.get('idempotent-replayed')).toBe('true');
      expect(await code(await post(p, path(item)))).toBe('action_not_available');
      expect(await transitions(p.accountId)).toBe(1);
      expect(await audits(p.accountId)).toBe(1);
    });

    it('a closed item can be reopened by the graph (closed to triaged) and closed again: each close is its own transition and audit row', async () => {
      const p = await person('owner');
      const { item } = await seed(p.accountId, { stage: 'triaged' });
      expect((await post(p, path(item))).status).toBe(200);
      await admin.query(`UPDATE work_items SET stage = 'triaged' WHERE id = $1`, [item]);
      expect((await post(p, path(item))).status).toBe(200);
      expect(await transitions(p.accountId)).toBe(2);
      expect(await audits(p.accountId)).toBe(2);
    });
  });

  describe('Reopen', () => {
    const path = (id: string) => `/work-items/${id}/reopen`;

    it('an owner reopens a closed item: 200, triaged, one transition and one audit row (sent_back, action reopen) naming the person; no run action', async () => {
      const p = await person('owner');
      const { item } = await seed(p.accountId, { stage: 'closed' });
      const res = await post(p, path(item));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ work_item_id: item, stage: 'triaged' });
      expect(await stageOf(item)).toBe('triaged');
      const t = await one<{ from_stage: string; to_stage: string; source: string; source_ref: string }>('SELECT from_stage, to_stage, source, source_ref FROM work_item_transitions WHERE work_item_id = $1', [item]);
      expect(t).toMatchObject({ from_stage: 'closed', to_stage: 'triaged', source: 'control_plane' });
      expect(t!.source_ref).toMatch(/^reopen:/);
      const a = await one<{ actor: string; payload: Record<string, string> }>(`SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'work_item.sent_back'`, [p.accountId]);
      expect(a!.actor).toBe(p.userId);
      expect(a!.payload).toMatchObject({ work_item_id: item, from_stage: 'closed', to_stage: 'triaged', action: 'reopen' });
      expect(await requests(p.accountId)).toBe(0);
      expect(signal.sent).toEqual([]);
    });

    it('an admin reopens too', async () => {
      const p = await person('admin');
      const { item } = await seed(p.accountId, { stage: 'closed' });
      expect((await post(p, path(item))).status).toBe(200);
    });

    it.each(['triaged', 'discussing', 'spec_ready', 'in_progress', 'needs_human', 'pr_opened', 'review_passed', 'merged', 'closed_unmerged'])('an item at %s is 409 action_not_available and nothing is written', async (stage) => {
      const p = await person('owner');
      const { item } = await seed(p.accountId, { stage });
      const res = await post(p, path(item));
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('action_not_available');
      await expectUntouched(p.accountId, item, stage);
    });

    it('a plain member is 403 insufficient_role and nothing is written', async () => {
      const p = await person('member');
      const { item } = await seed(p.accountId, { stage: 'closed' });
      const res = await post(p, path(item));
      expect(res.status).toBe(403);
      expect(await code(res)).toBe('insufficient_role');
      await expectUntouched(p.accountId, item, 'closed');
    });

    it('any token is 403 and nothing is written', async () => {
      const p = await person('owner');
      const { item } = await seed(p.accountId, { stage: 'closed' });
      expect((await post(await tokenFor(p, ['read']), path(item))).status).toBe(403);
      await expectUntouched(p.accountId, item, 'closed');
    });

    it('an external item is refused', async () => {
      const p = await person('owner');
      const { item } = await seed(p.accountId, { stage: 'closed', provenance: 'external' });
      expect(await code(await post(p, path(item)))).toBe('external_requires_human');
      await expectUntouched(p.accountId, item, 'closed');
    });

    it('a second reopen is 409 (no longer closed), and the item can then be closed again', async () => {
      const p = await person('owner');
      const { item } = await seed(p.accountId, { stage: 'closed' });
      expect((await post(p, path(item))).status).toBe(200);
      expect(await code(await post(p, path(item)))).toBe('action_not_available');
      expect((await post(p, `/work-items/${item}/close`)).status).toBe(200);
    });
  });
});
