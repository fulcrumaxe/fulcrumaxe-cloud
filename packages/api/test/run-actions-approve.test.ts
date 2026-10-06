import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { DISCUSSION_KINDS, isBuildableKind } from '@fx/discussions';
import { ADVANCE_NON_BUILDABLE_KINDS, ADVANCEABLE_STAGES } from '@fx/core/src/work-items/advance.js';
import { TERMINAL_RUN_STATUSES, runActionDeps } from '../src/routes/run-actions.js';
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

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LIVE = ['pending', 'running', 'paused'];
let ghNumber = 100;

/** D#483 P1: POST /work-items/{id}/approve through the real dispatcher against real Postgres. */
describe('D#483 P1: approve route', () => {
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
  async function seedRepo(accountId: string): Promise<string> {
    const repo = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, 'team', 'acme', 'widgets')`, [repo, accountId, Math.floor(Math.random() * 1_000_000_000) + 1]);
    return repo;
  }
  /** The work item the webhook makes for an issue: internal, at triaged, with the repo and the issue's number. */
  async function seedIssueItem(accountId: string, over: { stage?: string; provenance?: string; repo?: boolean; number?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    const repo = over.repo === false ? null : await seedRepo(accountId);
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, gh_number, provenance, stage) VALUES ($1, $2, $3, 'issue', $4, $5, $6)`, [
      id,
      accountId,
      repo,
      over.number === false ? null : ghNumber++,
      over.provenance ?? 'internal',
      over.stage ?? 'triaged',
    ]);
    return id;
  }
  async function seedRun(accountId: string, workItemId: string, status: string): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'project-manager', 'local', $4)`, [id, accountId, workItemId, status]);
    return id;
  }
  const count = async (sql: string, accountId: string) => Number((await admin.query<{ n: string }>(sql, [accountId])).rows[0]!.n);
  const rowCount = (a: string) => count('SELECT count(*) AS n FROM run_action_requests WHERE account_id = $1', a);
  const auditCount = (a: string) => count(`SELECT count(*) AS n FROM audit_log WHERE account_id = $1 AND action = 'run_action.requested'`, a);
  async function expectNothingWritten(a: string) {
    expect(await rowCount(a)).toBe(0);
    expect(await auditCount(a)).toBe(0);
    expect(signal.sent).toEqual([]);
  }
  const code = async (res: Response) => ((await res.json()) as ErrBody).error.code;

  it('one table says what can be approved: the route, the worker and the workflow ask it and keep no list of their own', () => {
    expect([...ADVANCEABLE_STAGES]).toEqual(['triaged', 'discussing', 'spec_ready', 'in_progress', 'pr_opened', 'changes_requested', 'review_passed', 'needs_human']);
    const read = (...p: string[]) => readFileSync(path.join(REPO_ROOT, ...p), 'utf8');
    for (const file of [
      read('packages', 'api', 'src', 'routes', 'run-actions.ts'),
      read('packages', 'worker', 'src', 'advance.ts'),
      read('apps', 'web', 'lib', 'advanceSteps.ts'),
    ]) {
      expect(file).not.toMatch(/(APPROVABLE|ADVANCEABLE)_STAGES\s*=/);
      expect(file).not.toMatch(/NON_BUILDABLE_KINDS\s*=/);
    }
    for (const file of [read('packages', 'api', 'src', 'routes', 'run-actions.ts'), read('packages', 'worker', 'src', 'advance.ts'), read('apps', 'web', 'lib', 'advanceSteps.ts')]) {
      expect(file).toContain('advanceActionFor');
    }
    const worker = read('packages', 'worker', 'src', 'advance.ts');
    const t = /ADVANCE_TERMINAL_STATUSES = \[([^\]]*)\] as const/.exec(worker);
    expect([...t![1]!.matchAll(/"([a-z_]+)"/g)].map((x) => x[1])).toEqual([...TERMINAL_RUN_STATUSES]);
  });

  it('the kinds the table never builds are exactly the kinds isBuildableKind refuses', () => {
    expect([...ADVANCE_NON_BUILDABLE_KINDS]).toEqual(DISCUSSION_KINDS.filter((k) => !isBuildableKind(k)));
  });

  it.each(['owner', 'admin'] as const)('an %s session approves an internal item at triaged: 202 accepted, one advance_work_item row, one audit row, one signal', async (role) => {
    const p = await person(role);
    const item = await seedIssueItem(p.accountId);
    const res = await post(p, `/work-items/${item}/approve`);
    expect(res.status).toBe(202);
    const body = (await res.json()) as Accepted;
    expect(body.state).toBe('accepted');
    const { rows } = await admin.query('SELECT kind, target_id, principal_kind FROM run_action_requests WHERE id = $1', [body.action_id]);
    expect(rows[0]).toMatchObject({ kind: 'advance_work_item', target_id: item, principal_kind: 'session' });
    expect(await rowCount(p.accountId)).toBe(1);
    expect(await auditCount(p.accountId)).toBe(1);
    expect(signal.sent).toEqual([{ actionId: body.action_id, accountId: p.accountId, kind: 'advance_work_item' }]);
  });

  it('a plain member is 403 insufficient_role and nothing is written', async () => {
    const p = await person('member');
    const item = await seedIssueItem(p.accountId);
    const res = await post(p, `/work-items/${item}/approve`);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('insufficient_role');
    await expectNothingWritten(p.accountId);
  });

  it('any token is 403 session_required, whatever its scope, and nothing is written', async () => {
    const p = await person('owner');
    const item = await seedIssueItem(p.accountId);
    for (const scopes of [['read'], ['runs:cancel'], ['read', 'runs:cancel']] as Scope[][]) {
      const res = await post(await tokenFor(p, scopes), `/work-items/${item}/approve`);
      expect(res.status).toBe(403);
      expect(await code(res)).toBe('session_required');
    }
    await expectNothingWritten(p.accountId);
  });

  it('a request body is refused and nothing is written (the route takes none)', async () => {
    const p = await person('owner');
    const item = await seedIssueItem(p.accountId);
    for (const body of ['{}', '{"anything":1}']) {
      const res = await post(p, `/work-items/${item}/approve`, { body });
      expect(res.status, body).toBeGreaterThanOrEqual(400);
      expect(res.status, body).toBeLessThan(500);
    }
    await expectNothingWritten(p.accountId);
  });

  it.each(['discussing', 'spec_ready', 'pr_opened', 'review_passed', 'merged', 'closed'])('an item at %s is 409 not_approvable and nothing is written', async (stage) => {
    const p = await person('owner');
    const item = await seedIssueItem(p.accountId, { stage });
    const res = await post(p, `/work-items/${item}/approve`);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('not_approvable');
    await expectNothingWritten(p.accountId);
  });

  it('an item the pipeline already triaged (it has a discussion) is 409 not_approvable', async () => {
    const p = await person('owner');
    const item = await seedIssueItem(p.accountId);
    const discussion = randomUUID();
    await admin.query(
      `INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, $2, 1, 'question', 't', $3, 'internal', 'user')`,
      [discussion, p.accountId, item],
    );
    await admin.query('UPDATE work_items SET discussion_id = $1 WHERE id = $2', [discussion, item]);
    const res = await post(p, `/work-items/${item}/approve`);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('not_approvable');
    await expectNothingWritten(p.accountId);
  });

  let discussionNumber = 10;
  /** The pipeline's root item for an issue at spec_ready: a discussion of `kind` and, unless `spec` is false, one published Spec. */
  async function seedSpecReady(accountId: string, over: { kind?: string; spec?: boolean; discussion?: boolean; provenance?: string; repo?: boolean; stage?: string } = {}): Promise<string> {
    const item = await seedIssueItem(accountId, { stage: over.stage ?? 'spec_ready', provenance: over.provenance, repo: over.repo });
    if (over.discussion !== false) {
      const discussion = randomUUID();
      await admin.query(
        `INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, $2, $3, $4, 't', $5, 'internal', 'user')`,
        [discussion, accountId, discussionNumber++, over.kind ?? 'feature', item],
      );
      await admin.query('UPDATE work_items SET discussion_id = $1 WHERE id = $2', [discussion, item]);
    }
    if (over.spec !== false) {
      await admin.query(
        `INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, 'spec', encode(sha256(convert_to('spec', 'UTF8')), 'hex'), 'system')`,
        [accountId, item],
      );
    }
    return item;
  }

  it.each(['critical', 'feature', 'small', 'bug', 'doc'])('an item at spec_ready with a published %s Spec is approved (the build): 202, one advance_work_item row', async (kind) => {
    const p = await person('owner');
    const item = await seedSpecReady(p.accountId, { kind });
    const res = await post(p, `/work-items/${item}/approve`);
    expect(res.status).toBe(202);
    const body = (await res.json()) as Accepted;
    const { rows } = await admin.query('SELECT kind, target_id FROM run_action_requests WHERE id = $1', [body.action_id]);
    expect(rows[0]).toMatchObject({ kind: 'advance_work_item', target_id: item });
    expect(signal.sent).toEqual([{ actionId: body.action_id, accountId: p.accountId, kind: 'advance_work_item' }]);
  });

  it.each([
    ['a project (its Spec is a plan)', { kind: 'project' }],
    ['a question', { kind: 'question' }],
    ['an item with no Spec', { spec: false }],
    ['an item with no discussion', { discussion: false }],
  ])('an item at spec_ready that is %s is 409 not_approvable and nothing is written', async (_n, over) => {
    const p = await person('owner');
    const item = await seedSpecReady(p.accountId, over);
    const res = await post(p, `/work-items/${item}/approve`);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('not_approvable');
    await expectNothingWritten(p.accountId);
  });

  it('an external item at spec_ready is 403 external_requires_human, and one with no repo is 409 no_repo; both write nothing', async () => {
    const p = await person('owner');
    const external = await seedSpecReady(p.accountId, { provenance: 'external' });
    const res = await post(p, `/work-items/${external}/approve`);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('external_requires_human');
    const noRepo = await seedSpecReady(p.accountId, { repo: false });
    expect(await code(await post(p, `/work-items/${noRepo}/approve`))).toBe('no_repo');
    await expectNothingWritten(p.accountId);
  });

  it('an item at spec_ready whose executor is running is 409 already_running; a finished run does not block a second approval', async () => {
    const p = await person('owner');
    const item = await seedSpecReady(p.accountId);
    await seedRun(p.accountId, item, 'running');
    expect(await code(await post(p, `/work-items/${item}/approve`))).toBe('already_running');
    await admin.query(`UPDATE agent_runs SET status = 'failed' WHERE work_item_id = $1`, [item]);
    expect((await post(p, `/work-items/${item}/approve`)).status).toBe(202);
  });

  describe('P3: the stages with a pull request, and the panel and Spec again', () => {
    it.each(['pr_opened', 'changes_requested', 'review_passed'])('an item at %s with a published Spec is approved (the review): 202, one advance_work_item row', async (stage) => {
      const p = await person('owner');
      const item = await seedSpecReady(p.accountId, { stage });
      const res = await post(p, `/work-items/${item}/approve`);
      expect(res.status).toBe(202);
      const { rows } = await admin.query('SELECT kind, target_id FROM run_action_requests WHERE id = $1', [((await res.json()) as Accepted).action_id]);
      expect(rows[0]).toMatchObject({ kind: 'advance_work_item', target_id: item });
    });

    it('an item at in_progress with a published Spec and nothing running is approved (Check the build): 202, one advance_work_item row', async () => {
      const p = await person('owner');
      const item = await seedSpecReady(p.accountId, { stage: 'in_progress' });
      const res = await post(p, `/work-items/${item}/approve`);
      expect(res.status).toBe(202);
      const { rows } = await admin.query('SELECT kind, target_id FROM run_action_requests WHERE id = $1', [((await res.json()) as Accepted).action_id]);
      expect(rows[0]).toMatchObject({ kind: 'advance_work_item', target_id: item });
    });

    it('an item at in_progress with NO published Spec, or with no issue number, is 409 not_approvable and nothing is written', async () => {
      const p = await person('owner');
      const noSpec = await seedSpecReady(p.accountId, { stage: 'in_progress', spec: false });
      expect(await code(await post(p, `/work-items/${noSpec}/approve`))).toBe('not_approvable');
      const noIssue = await seedSpecReady(p.accountId, { stage: 'in_progress' });
      await admin.query('UPDATE work_items SET gh_number = NULL WHERE id = $1', [noIssue]);
      expect(await code(await post(p, `/work-items/${noIssue}/approve`))).toBe('not_approvable');
      await expectNothingWritten(p.accountId);
    });

    it('an item at in_progress is approved by an admin and refused for a plain member', async () => {
      const admin1 = await person('admin');
      expect((await post(admin1, `/work-items/${await seedSpecReady(admin1.accountId, { stage: 'in_progress' })}/approve`)).status).toBe(202);
      const member = await person('member');
      const res = await post(member, `/work-items/${await seedSpecReady(member.accountId, { stage: 'in_progress' })}/approve`);
      expect(res.status).toBe(403);
      expect(await code(res)).toBe('insufficient_role');
    });

    it.each(['pr_opened', 'changes_requested', 'review_passed'])('an item at %s with NO published Spec has nothing to review against: 409 not_approvable, nothing written', async (stage) => {
      const p = await person('owner');
      const item = await seedSpecReady(p.accountId, { stage, spec: false });
      const res = await post(p, `/work-items/${item}/approve`);
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('not_approvable');
      await expectNothingWritten(p.accountId);
    });

    it.each(['small', 'bug', 'doc'])('a triaged %s item the pipeline already discussed (no panel) and has no Spec is approved again: the short Spec runs again', async (kind) => {
      const p = await person('owner');
      const item = await seedSpecReady(p.accountId, { stage: 'triaged', kind, spec: false });
      expect((await post(p, `/work-items/${item}/approve`)).status).toBe(202);
    });

    it.each([
      ['a bug that already has its Spec', { kind: 'bug', spec: true }],
      ['a question', { kind: 'question', spec: false }],
    ])('a triaged item the pipeline already discussed: %s is 409 not_approvable', async (_n, over) => {
      const p = await person('owner');
      const item = await seedSpecReady(p.accountId, { stage: 'triaged', ...over });
      expect(await code(await post(p, `/work-items/${item}/approve`))).toBe('not_approvable');
    });

    it.each(['feature', 'critical'])('an item left at discussing with a %s discussion and no Spec is approved again (the panel and the Spec run once more)', async (kind) => {
      const p = await person('owner');
      const item = await seedSpecReady(p.accountId, { stage: 'discussing', kind, spec: false });
      expect((await post(p, `/work-items/${item}/approve`)).status).toBe(202);
    });

    it.each([
      ['a project (it has no panel)', { kind: 'project', spec: false }],
      ['a bug (it has no panel)', { kind: 'bug', spec: false }],
      ['an item with no discussion', { discussion: false, spec: false }],
    ])('an item at discussing: %s is 409 not_approvable', async (_n, over) => {
      const p = await person('owner');
      const item = await seedSpecReady(p.accountId, { stage: 'discussing', ...over });
      const res = await post(p, `/work-items/${item}/approve`);
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('not_approvable');
      await expectNothingWritten(p.accountId);
    });

    it('an item at discussing that already has its Spec (sent back to the panel) is approved: the panel and the Spec run again', async () => {
      const p = await person('owner');
      const item = await seedSpecReady(p.accountId, { stage: 'discussing', kind: 'feature', spec: true });
      expect((await post(p, `/work-items/${item}/approve`)).status).toBe(202);
    });

    it.each(['critical', 'feature', 'small', 'bug', 'doc'])('an item at needs_human with a published %s Spec is approved (Build again): 202, one advance_work_item row', async (kind) => {
      const p = await person('owner');
      const item = await seedSpecReady(p.accountId, { stage: 'needs_human', kind });
      const res = await post(p, `/work-items/${item}/approve`);
      expect(res.status).toBe(202);
      const { rows } = await admin.query('SELECT kind, target_id FROM run_action_requests WHERE id = $1', [((await res.json()) as Accepted).action_id]);
      expect(rows[0]).toMatchObject({ kind: 'advance_work_item', target_id: item });
    });

    it.each([
      ['no published Spec', { spec: false }],
      ['a project', { kind: 'project' }],
      ['a question', { kind: 'question' }],
      ['no discussion', { discussion: false }],
    ])('an item at needs_human with %s has nothing to build again: 409 not_approvable, nothing written', async (_n, over) => {
      const p = await person('owner');
      const item = await seedSpecReady(p.accountId, { stage: 'needs_human', ...over });
      const res = await post(p, `/work-items/${item}/approve`);
      expect(res.status).toBe(409);
      expect(await code(res)).toBe('not_approvable');
      await expectNothingWritten(p.accountId);
    });

    it('Build again by a plain member is 403, with an external item 403 external_requires_human, and while a run is live 409 already_running; none writes anything', async () => {
      const member = await person('member');
      expect(await code(await post(member, `/work-items/${await seedSpecReady(member.accountId, { stage: 'needs_human' })}/approve`))).toBe('insufficient_role');
      const p = await person('owner');
      expect(await code(await post(p, `/work-items/${await seedSpecReady(p.accountId, { stage: 'needs_human', provenance: 'external' })}/approve`))).toBe('external_requires_human');
      const live = await seedSpecReady(p.accountId, { stage: 'needs_human' });
      await seedRun(p.accountId, live, 'running');
      expect(await code(await post(p, `/work-items/${live}/approve`))).toBe('already_running');
      await expectNothingWritten(member.accountId);
      await expectNothingWritten(p.accountId);
    });

    it.each(['merged', 'closed_unmerged'])('an item at %s is 409 not_approvable', async (stage) => {
      const p = await person('owner');
      const item = await seedSpecReady(p.accountId, { stage });
      expect(await code(await post(p, `/work-items/${item}/approve`))).toBe('not_approvable');
      await expectNothingWritten(p.accountId);
    });

    it.each(['triaged', 'discussing', 'spec_ready', 'in_progress', 'pr_opened', 'changes_requested', 'review_passed'])('a second press while ANY run of an item at %s is live is 409 already_running (live, it started a duplicate review driver)', async (stage) => {
      const p = await person('owner');
      const item = await seedSpecReady(p.accountId, { stage, spec: stage !== 'triaged' && stage !== 'discussing' });
      if (stage === 'triaged') await admin.query('UPDATE work_items SET discussion_id = NULL WHERE id = $1', [item]);
      for (const status of ['pending', 'running']) {
        const run = await seedRun(p.accountId, item, status);
        const res = await post(p, `/work-items/${item}/approve`);
        expect(res.status, `${stage} ${status}`).toBe(409);
        expect(await code(res)).toBe('already_running');
        await admin.query('DELETE FROM agent_runs WHERE id = $1', [run]);
      }
      await expectNothingWritten(p.accountId);
    });
  });

  it('an item with no GitHub issue behind it is 409 not_approvable', async () => {
    const p = await person('owner');
    const item = await seedIssueItem(p.accountId, { number: false });
    const res = await post(p, `/work-items/${item}/approve`);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('not_approvable');
    await expectNothingWritten(p.accountId);
  });

  it('an external item is 403 external_requires_human, and an item with no repo is 409 no_repo; both write nothing', async () => {
    const p = await person('owner');
    const external = await seedIssueItem(p.accountId, { provenance: 'external' });
    const res = await post(p, `/work-items/${external}/approve`);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('external_requires_human');
    const noRepo = await seedIssueItem(p.accountId, { repo: false });
    const res2 = await post(p, `/work-items/${noRepo}/approve`);
    expect(res2.status).toBe(409);
    expect(await code(res2)).toBe('no_repo');
    await expectNothingWritten(p.accountId);
  });

  it.each(LIVE)('a %s run on the item is 409 already_running; a finished run does not block', async (status) => {
    const p = await person('owner');
    const item = await seedIssueItem(p.accountId);
    await seedRun(p.accountId, item, status);
    const res = await post(p, `/work-items/${item}/approve`);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('already_running');
    await expectNothingWritten(p.accountId);
  });

  it.each([...TERMINAL_RUN_STATUSES])('a %s run on the item does not block an approval (the retry path after a failed classify)', async (status) => {
    const p = await person('owner');
    const item = await seedIssueItem(p.accountId);
    await seedRun(p.accountId, item, status);
    expect((await post(p, `/work-items/${item}/approve`)).status).toBe(202);
  });

  it("a malformed, an unknown and another account's item id all get the same 404 body, and nothing is written", async () => {
    const a = await person('owner');
    const b = await person('owner');
    const foreign = await seedIssueItem(b.accountId);
    const seen = new Set<string>();
    for (const p of ['/work-items/not-a-uuid/approve', `/work-items/${randomUUID()}/approve`, `/work-items/${foreign}/approve`]) {
      const res = await post(a, p);
      expect(res.status, p).toBe(404);
      const body = (await res.json()) as ErrBody;
      seen.add(JSON.stringify({ ...body, error: { ...body.error, request_id: '' } }));
    }
    expect(seen.size).toBe(1);
    await expectNothingWritten(a.accountId);
    await expectNothingWritten(b.accountId);
  });

  it('a second approval while the first is still live returns the same action_id and writes nothing new', async () => {
    const p = await person('owner');
    const item = await seedIssueItem(p.accountId);
    const first = (await (await post(p, `/work-items/${item}/approve`)).json()) as Accepted;
    const second = await post(p, `/work-items/${item}/approve`);
    expect(second.status).toBe(202);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(((await second.json()) as Accepted).action_id).toBe(first.action_id);
    expect(await rowCount(p.accountId)).toBe(1);
    expect(await auditCount(p.accountId)).toBe(1);
    expect(signal.sent).toHaveLength(1);
  });

  it('keyed replay: the same key replays the original action_id even after the item has moved on; a fresh key is the plain refusal', async () => {
    const p = await person('owner');
    const item = await seedIssueItem(p.accountId);
    const headers = { 'idempotency-key': 'k-approve-replay' };
    const first = await post(p, `/work-items/${item}/approve`, { headers });
    expect(first.status).toBe(202);
    const a = (await first.json()) as Accepted;
    await admin.query(`UPDATE work_items SET stage = 'discussing' WHERE id = $1`, [item]);
    await admin.query(`UPDATE idempotency_keys SET expires_at = now() - interval '1 minute' WHERE account_id = $1 AND key = 'k-approve-replay'`, [p.accountId]);
    const replay = await post(p, `/work-items/${item}/approve`, { headers });
    expect(replay.status).toBe(202);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
    expect(((await replay.json()) as Accepted).action_id).toBe(a.action_id);
    expect(await rowCount(p.accountId)).toBe(1);
    expect(signal.sent).toHaveLength(1);
    expect(await code(await post(p, `/work-items/${item}/approve`))).toBe('not_approvable');
  });

  it('the same key for another item is 422 idempotency_key_reused with no new row', async () => {
    const p = await person('owner');
    const one = await seedIssueItem(p.accountId);
    const two = await seedIssueItem(p.accountId);
    const headers = { 'idempotency-key': 'k-approve-diff' };
    expect((await post(p, `/work-items/${one}/approve`, { headers })).status).toBe(202);
    const res = await post(p, `/work-items/${two}/approve`, { headers });
    expect(res.status).toBe(422);
    expect(await code(res)).toBe('idempotency_key_reused');
    expect(await rowCount(p.accountId)).toBe(1);
  });

  it('with no signal registered the route is 503 run_actions_unavailable before any write', async () => {
    runActionDeps.getRunActionSignal = () => null;
    const p = await person('owner');
    const item = await seedIssueItem(p.accountId);
    const res = await post(p, `/work-items/${item}/approve`);
    expect(res.status).toBe(503);
    expect(await code(res)).toBe('run_actions_unavailable');
    await expectNothingWritten(p.accountId);
  });
});
