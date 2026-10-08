import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import type { RepoPermission } from '@fx/trust';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { ForbiddenError, NotFoundError } from '../src/tenancy/errors.js';
import { ENGINE_LOOP_MARKER, executePlanImport, ROADMAP_PATHS, type PlanSource } from '../src/plan/executeImport.js';
import { beginPlanImport, ImportNotRunningError, ImportRateLimitedError, ImportRepoNotConnectedError, ImportRunningError, writeSucceededImport } from '../src/plan/persist.js';
import { getLatestPlanImport, getPlanView } from '../src/plan/read.js';
import type { PullFacts } from '../src/plan/computePlan.js';
import { parseRoadmapFile } from '../src/plan/roadmapFile.js';
import type { SpecComment } from '../src/plan/specTables.js';
import { computePlan } from '../src/plan/computePlan.js';

/**
 * D#483 S3-c/S3-d (live build): the import end to end against a real Postgres, with a fake read-only source. What it pins:
 * the one write transaction and its role (M0 E4: nothing is started), the derived and stamped states of proposals across
 * re-imports, the failure codes, and that a failed import leaves the previous import's rows untouched.
 */
const FIXTURES = new URL('./fixtures/plan/', import.meta.url);
const SHA = 'f'.repeat(40);
const pr = (number: number, title: string, dLines: string[], state: PullFacts['state'] = 'merged'): PullFacts => ({ number, title, state, dLines });
const rm = (tasks: Record<string, Record<string, unknown>>, lists: Record<string, string[]>) =>
  JSON.stringify({
    milestones: Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, { definition: `Milestone ${k}. Rest.`, tasks: v }])),
    task_status: Object.fromEntries(Object.entries(tasks).map(([k, v]) => [k, { milestone: 'm1', planned_prs: 1, prs: [], ...v }])),
  });

interface SourceOpts {
  files?: Record<string, string>;
  pulls?: PullFacts[];
  truncated?: boolean;
  headError?: { code: string };
  fileError?: { code: string };
  pullsError?: { code: string };
  discussions?: Array<{ number: number; title: string; body: string; closed?: boolean; authorLogin?: string | null }>;
  comments?: Record<number, Array<SpecComment & { isMinimized?: boolean }>>;
  issues?: Array<{ number: number; title: string; state: 'open' | 'closed' }>;
  permissions?: Record<string, RepoPermission>;
  discussionsError?: { code: string };
  /** A read that runs into the request budget (the client's own error code) at this step. */
  budgetAt?: 'permission' | 'pulls' | 'discussions' | 'comments';
}
function source(o: SourceOpts): PlanSource & { asked: string[]; permissionAsked: string[]; commentsAsked: number[] } {
  const asked: string[] = [];
  const permissionAsked: string[] = [];
  const commentsAsked: number[] = [];
  const budget = () => Object.assign(new Error('x'), { code: 'request_budget_exceeded' });
  return {
    asked,
    permissionAsked,
    commentsAsked,
    async head() {
      if (o.headError) throw Object.assign(new Error('x'), o.headError);
      return { defaultBranch: 'main', sha: SHA };
    },
    async file(path) {
      asked.push(path);
      if (o.fileError) throw Object.assign(new Error('x'), o.fileError);
      return o.files?.[path] ?? null;
    },
    async pulls() {
      if (o.pullsError) throw Object.assign(new Error('x'), o.pullsError);
      if (o.budgetAt === 'pulls') throw budget();
      return { pulls: o.pulls ?? [], truncated: o.truncated ?? false };
    },
    // The two Discussion reads keep the contract of PlanSource: they page to the end, keep only the items the caller's
    // predicate accepts (and, for comments, that are not minimized), and fail closed past a bound. The paging itself, the
    // request counting and the real bounds are pinned against the TLS fake in the github package's planRead.contract test.
    async discussions(match) {
      if (o.discussionsError) throw Object.assign(new Error('x'), o.discussionsError);
      if (o.budgetAt === 'discussions') throw budget();
      const all = (o.discussions ?? []).map((d) => ({ closed: false, authorLogin: 'someone', ...d }));
      const specs = all.filter((d) => match.isSpec(d.body));
      if (specs.length > 600) throw Object.assign(new Error('x'), { code: 'plan_source_too_large' });
      return { discussions: all.slice(0, 600), specs, truncated: all.length > 600 };
    },
    async discussionComments(n, match) {
      commentsAsked.push(n);
      if (o.budgetAt === 'comments') throw budget();
      const kept = (o.comments?.[n] ?? []).filter((c) => !c.isMinimized && match.isCorrection(c.body)).map(({ body, createdAt, authorLogin }) => ({ body, createdAt, authorLogin }));
      if (kept.length > 300) throw Object.assign(new Error('x'), { code: 'plan_source_too_large' });
      return { comments: kept };
    },
    async issues() {
      return { issues: o.issues ?? [], truncated: false };
    },
    async authorPermission(login) {
      permissionAsked.push(login);
      if (o.budgetAt === 'permission') throw budget();
      return o.permissions?.[login] ?? 'none';
    },
    evidence() {
      return { requests: [{ method: 'POST', path: '/graphql PlanRepoHead', status: 200 }, { method: 'GET', path: '/repos/acme/widgets/issues', status: 200 }], tokenPermissions: { metadata: 'read', contents: 'read', issues: 'read', discussions: 'read' } };
    },
  };
}
const LOOP = { [ENGINE_LOOP_MARKER]: '{}' };

describe('plan import (live build L1)', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let admin: PoolClient;

  let b: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    admin = await adminPool.connect();

    b = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  const principal = (r: SeedRefs) => ({ accountId: r.accountId, userId: r.userId });
  async function repo(r: SeedRefs, connected = true): Promise<string> {
    const id = randomUUID();
    await admin.query('INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, $4, $5)', [id, r.accountId, connected ? r.installationId : null, Math.floor(Math.random() * 1e9) + 10, 'team']);
    return id;
  }
  /** begin + execute, as the route does. */
  async function run(r: SeedRefs, repoId: string, src: PlanSource) {
    const importId = await beginPlanImport(appPool, principal(r), repoId);
    return executePlanImport({ pool: appPool, principal: principal(r), repoId, importId, source: src });
  }
  const view = (r: SeedRefs, repoId: string, q = {}) => getPlanView({ pool: appPool, principal: principal(r) }, repoId, q);
  const counts = async (r: SeedRefs) => {
    const one = async (sql: string) => (await admin.query(sql, [r.accountId])).rows[0].n as number;
    return {
      work_items: await one('SELECT count(*)::int n FROM work_items WHERE account_id = $1'),
      agent_runs: await one('SELECT count(*)::int n FROM agent_runs WHERE account_id = $1'),
      run_action_requests: await one('SELECT count(*)::int n FROM run_action_requests WHERE account_id = $1'),
    };
  };
  const proposals = async (repoId: string) =>
    Object.fromEntries((await admin.query('SELECT dedupe_key, state, owner_process, title, plan_task_id FROM proposals WHERE repo_id = $1', [repoId])).rows.map((x) => [x.dedupe_key, x]));

  describe('a successful import', () => {
    it('writes the plan, the proposals for what remains, and the evidence, and starts nothing (E4)', async () => {
      const r = await seedAccount(admin, randomUUID());
      const repoId = await repo(r);
      const before = await counts(r);
      const files = {
        ...LOOP,
        '.autonomous-team/roadmap.json': rm(
          { 'D#1:A': { prs: [10], note: 'Do A' }, 'D#1:B': { note: 'Do B' }, 'D#2:C': { planned_prs: 2, prs: [11, 12] }, 'D#1:P': { planned_prs: 0, split_into: ['D#1:B'] } },
          { m1: ['D#1:A', 'D#1:B', 'D#1:P'], m2: ['D#2:C'] },
        ),
      };
      const out = await run(r, repoId, source({ files, pulls: [pr(10, 'A', []), pr(11, 'C1', []), pr(12, 'C2', [], 'open'), pr(513, 'later', [])] }));
      expect(out.state).toBe('succeeded');
      if (out.state !== 'succeeded') throw new Error('unreachable');
      expect(out.computed.totals).toMatchObject({ tasks: 3, done: 1, remaining: 2, partial: 1, not_started: 1 });
      expect(out.sourcePath).toBe('.autonomous-team/roadmap.json');
      expect(out.maxMergedPr).toBe(513);

      const imp = (await admin.query('SELECT * FROM plan_imports WHERE id = $1', [out.importId])).rows[0];
      expect(imp).toMatchObject({ state: 'succeeded', level: 'roadmap_file', source_path: '.autonomous-team/roadmap.json', source_sha: SHA, truncated: false, max_merged_pr: 513, error_code: null });
      expect(imp.finished_at).not.toBeNull();
      expect(imp.counts).toMatchObject({ tasks: 3, done: 1, remaining: 2, per_milestone: { m1: { tasks: 2, done: 1, remaining: 1 }, m2: { tasks: 1, done: 0, remaining: 1 } } });
      expect(imp.github_requests.map((e: { method: string }) => e.method)).toEqual(['POST', 'GET']);
      expect(imp.token_permissions).toEqual({ metadata: 'read', contents: 'read', issues: 'read', discussions: 'read' });

      const tasks = (await admin.query('SELECT task_key, milestone_key, status, merged_prs, open_prs, title, owner_process, is_leaf FROM plan_tasks WHERE repo_id = $1 ORDER BY task_key', [repoId])).rows;
      expect(tasks.map((t) => [t.task_key, t.milestone_key, t.status, t.merged_prs, t.open_prs])).toEqual([
        ['D#1:A', 'm1', 'done', [10], []],
        ['D#1:B', 'm1', 'not_started', [], []],
        ['D#2:C', 'm2', 'partial', [11], [12]],
      ]);
      expect(tasks.every((t) => t.owner_process === 'internal_loop' && t.is_leaf)).toBe(true);
      expect(tasks.find((t) => t.task_key === 'D#1:A')!.title).toBe('Do A');

      // Done tasks never become proposals; every remaining task does, owned by the repo's own loop.
      const props = await proposals(repoId);
      expect(Object.keys(props).sort()).toEqual(['plan:D#1:B', 'plan:D#2:C']);
      for (const p of Object.values(props)) expect(p).toMatchObject({ state: 'new', owner_process: 'internal_loop' });

      expect(await counts(r)).toEqual(before);
      expect((await admin.query(`SELECT count(*)::int n FROM audit_log WHERE account_id = $1 AND action LIKE 'proposal.%'`, [r.accountId])).rows[0].n).toBe(0);
    });

    it('a repository without the engine loop gets product-owned proposals; the file is looked for in the Spec order', async () => {
      const r = await seedAccount(admin, randomUUID());
      const repoId = await repo(r);
      const src = source({ files: { 'roadmap.json': rm({ 'D#1:A': {} }, { m1: ['D#1:A'] }) } });
      const out = await run(r, repoId, src);
      expect(out.state).toBe('succeeded');
      expect(src.asked.slice(0, 3)).toEqual([...ROADMAP_PATHS]);
      expect((await proposals(repoId))['plan:D#1:A']!.owner_process).toBe('product');
      expect((await admin.query('SELECT owner_process FROM plan_tasks WHERE repo_id = $1', [repoId])).rows[0].owner_process).toBe('product');
    });

    // S3-H (0753): the owner of a proposal is fixed when it is created. A later import that would decide otherwise (the engine
    // loop appeared in the repository) neither fails nor moves the owner; the plan task keeps following the repository.
    it('a later import that would decide another owner leaves the proposal owner as it was, and still succeeds', async () => {
      const r = await seedAccount(admin, randomUUID());
      const repoId = await repo(r);
      const files = { 'roadmap.json': rm({ 'D#1:A': {} }, { m1: ['D#1:A'] }) };
      expect((await run(r, repoId, source({ files }))).state).toBe('succeeded');
      expect((await proposals(repoId))['plan:D#1:A']!.owner_process).toBe('product');
      const again = await run(r, repoId, source({ files: { ...files, ...LOOP } }));
      expect(again.state).toBe('succeeded');
      expect((await proposals(repoId))['plan:D#1:A']!.owner_process).toBe('product');
      expect((await admin.query('SELECT owner_process FROM plan_tasks WHERE repo_id = $1', [repoId])).rows[0].owner_process).toBe('internal_loop');
    });

    it('the whole frozen fixture through the database equals the committed file, per milestone, as sets (A1 through the API read)', async () => {
      const r = await seedAccount(admin, randomUUID());
      const repoId = await repo(r);
      const text = readFileSync(new URL('roadmap.json', FIXTURES), 'utf8');
      const pulls = (JSON.parse(readFileSync(new URL('pulls.json', FIXTURES), 'utf8')) as { pulls: PullFacts[] }).pulls;
      const out = await run(r, repoId, source({ files: { ...LOOP, '.autonomous-team/roadmap.json': text }, pulls }));
      expect(out.state).toBe('succeeded');
      const full = await view(r, repoId, { full: true });
      expect(full.totals).toEqual({ tasks: 19, done: 7, remaining: 12 });
      expect(full.tasks.length).toBe(19);
      expect(full.next_cursor).toBeNull();
      const doc = JSON.parse(text) as { milestones: Record<string, { tasks: string[] }>; task_status: Record<string, { status?: string; split_into?: string[] }> };
      for (const m of full.milestones) {
        const R = doc.milestones[m.key]!.tasks.filter((k) => !(doc.task_status[k]!.split_into?.length)).sort();
        const Rdone = R.filter((k) => doc.task_status[k]!.status === 'done').sort();
        const mine = full.tasks.filter((t) => t.milestone_key === m.key);
        expect(mine.map((t) => t.task_key).sort(), m.key).toEqual(R);
        expect(mine.filter((t) => t.status === 'done').map((t) => t.task_key).sort(), m.key).toEqual(Rdone);
        expect([m.tasks, m.done, m.remaining]).toEqual([R.length, Rdone.length, R.length - Rdone.length]);
      }
      expect(Object.values(await proposals(repoId)).length).toBe(12);
    });
  });

  describe('re-import: derived states move, decisions do not', () => {
    it('closed at the source withdraws a new proposal, reopened brings it back; approved and rejected are untouched; a removed task is marked, not deleted', async () => {
      const r = await seedAccount(admin, randomUUID());
      const repoId = await repo(r);
      const tasks = { 'D#1:A': { prs: [10] }, 'D#1:B': { prs: [11] }, 'D#1:C': {}, 'D#1:D': {}, 'D#1:E': {} };
      const lists = { m1: Object.keys(tasks) };
      const text = rm(tasks, lists);
      // First import: only #10 merged, so B..E are remaining and proposed.
      let out = await run(r, repoId, source({ files: { 'roadmap.json': text }, pulls: [pr(10, 'A', [])] }));
      expect(out.state).toBe('succeeded');
      expect(Object.keys(await proposals(repoId)).sort()).toEqual(['plan:D#1:B', 'plan:D#1:C', 'plan:D#1:D', 'plan:D#1:E']);

      // A person approves C (with a work item made the ordinary way) and rejects D.
      const wi = (await admin.query(`INSERT INTO work_items (account_id, repo_id, kind, provenance) VALUES ($1, $2, 'issue', 'internal') RETURNING id`, [r.accountId, repoId])).rows[0].id;
      const pid = async (key: string) => (await admin.query('SELECT id FROM proposals WHERE repo_id = $1 AND dedupe_key = $2', [repoId, key])).rows[0].id as string;
      // owner_process is internal_loop only when the engine loop is installed; this repo has none, so these are product items.
      await withTenant(appPool, r.accountId, r.userId, async (c) => {
        await c.query('SELECT * FROM approve_proposal($1, $2)', [await pid('plan:D#1:C'), wi]);
        await c.query('SELECT * FROM reject_proposal($1, $2)', [await pid('plan:D#1:D'), 'later']);
      });
      const stamped = (await admin.query(`SELECT dedupe_key, state, decided_by_user_id, decided_at, roadmap_position, reject_note FROM proposals WHERE repo_id = $1 AND state IN ('approved','rejected') ORDER BY dedupe_key`, [repoId])).rows;

      // Second import: B merged (new proposal -> withdrawn), C and D also merged (decisions untouched), E removed from the file.
      const next = rm({ 'D#1:A': { prs: [10] }, 'D#1:B': { prs: [11] }, 'D#1:C': { prs: [12] }, 'D#1:D': { prs: [13] } }, { m1: ['D#1:A', 'D#1:B', 'D#1:C', 'D#1:D'] });
      out = await run(r, repoId, source({ files: { 'roadmap.json': next }, pulls: [pr(10, 'A', []), pr(11, 'B', []), pr(12, 'C', []), pr(13, 'D', [])] }));
      expect(out.state).toBe('succeeded');
      let props = await proposals(repoId);
      expect(props['plan:D#1:B']!.state).toBe('withdrawn');
      expect(props['plan:D#1:E']!.state).toBe('withdrawn');
      expect(props['plan:D#1:C']!.state).toBe('approved');
      expect(props['plan:D#1:D']!.state).toBe('rejected');
      expect((await admin.query(`SELECT dedupe_key, state, decided_by_user_id, decided_at, roadmap_position, reject_note FROM proposals WHERE repo_id = $1 AND state IN ('approved','rejected') ORDER BY dedupe_key`, [repoId])).rows).toEqual(stamped);
      const e = (await admin.query(`SELECT removed_at, status FROM plan_tasks WHERE repo_id = $1 AND task_key = 'D#1:E'`, [repoId])).rows[0];
      expect(e.removed_at).not.toBeNull();
      expect((await view(r, repoId, { full: true })).totals).toEqual({ tasks: 4, done: 4, remaining: 0 });

      // Third import: B is not merged any more and E is back in the file, so both return to new. The decisions still stand.
      out = await run(r, repoId, source({ files: { 'roadmap.json': text }, pulls: [pr(10, 'A', [])] }));
      expect(out.state).toBe('succeeded');
      props = await proposals(repoId);
      expect(props['plan:D#1:B']!.state).toBe('new');
      expect(props['plan:D#1:E']!.state).toBe('new');
      expect(props['plan:D#1:C']!.state).toBe('approved');
      expect(props['plan:D#1:D']!.state).toBe('rejected');
      expect((await admin.query(`SELECT removed_at FROM plan_tasks WHERE repo_id = $1 AND task_key = 'D#1:E'`, [repoId])).rows[0].removed_at).toBeNull();
      expect(await pid('plan:D#1:B')).toBeTruthy();
    });

    it('a milestone missing from a later file is marked removed and its tasks leave the counts', async () => {
      const r = await seedAccount(admin, randomUUID());
      const repoId = await repo(r);
      await run(r, repoId, source({ files: { 'roadmap.json': rm({ 'D#1:A': {}, 'D#2:B': {} }, { m1: ['D#1:A'], m2: ['D#2:B'] }) } }));
      expect((await view(r, repoId)).milestones.map((m) => m.key)).toEqual(['m1', 'm2']);
      await run(r, repoId, source({ files: { 'roadmap.json': rm({ 'D#1:A': {} }, { m1: ['D#1:A'] }) } }));
      const v = await view(r, repoId);
      expect(v.milestones.map((m) => m.key)).toEqual(['m1']);
      expect(v.totals).toEqual({ tasks: 1, done: 0, remaining: 1 });
      expect((await admin.query(`SELECT removed_at FROM plan_milestones WHERE repo_id = $1 AND key = 'm2'`, [repoId])).rows[0].removed_at).not.toBeNull();
    });
  });

  describe('fallback levels (S3-F)', () => {
    const SPEC_BODY = [
      'STATUS: SPEC_READY',
      '',
      '## Spec (Acceptance)',
      '',
      '| Task | Description | Planned PRs | Estimate | Depends |',
      '|---|---|---|---|---|',
      '| T1 | Build the first part | 1 | 100 lines | - |',
      '| T2 | Build the second part | 2 | 50 lines | T1 |',
    ].join('\n');
    const CORRECTION = ['## Correction C1', '', '| Task | Description |', '|---|---|', '| T2-a | First half |', '| T2-b | Second half |'].join('\n');
    const comment = (body: string, authorLogin: string, createdAt = '2026-10-02T00:00:00Z'): SpecComment => ({ body, createdAt, authorLogin });
    // Specs are written by a maintainer here; the permissions map of a test adds the Correction authors it needs.
    const specRepo = { discussions: [{ number: 7, title: 'Plan the widgets', body: SPEC_BODY, authorLogin: 'specmaint' }], permissions: { specmaint: 'maintain' as RepoPermission } };
    const taskRows = async (repoId: string) => (await admin.query('SELECT task_key, status, parent_key, planned_prs, title FROM plan_tasks WHERE repo_id = $1 ORDER BY task_key', [repoId])).rows;
    const lastImport = async (importId: string) => (await admin.query('SELECT level, source_path, error_detail, counts, truncated FROM plan_imports WHERE id = $1', [importId])).rows[0];

    it('F1: with no roadmap file, a Spec table and a trusted Correction that splits a row import at spec_tables, and the parent is not counted', async () => {
      const r = await seedAccount(admin, randomUUID());
      const repoId = await repo(r);
      const before = await counts(r);
      const out = await run(r, repoId, source({ ...specRepo, comments: { 7: [comment(CORRECTION, 'maint')] }, permissions: { ...specRepo.permissions, maint: 'maintain' }, pulls: [pr(20, 'Closes D#7:T1', [])] }));
      expect(out).toMatchObject({ state: 'succeeded', level: 'spec_tables', sourcePath: null });
      expect(await lastImport(out.importId)).toMatchObject({ level: 'spec_tables', source_path: null, error_detail: null });
      expect(await taskRows(repoId)).toMatchObject([
        { task_key: 'D#7:T1', status: 'done', planned_prs: 1, title: 'Build the first part' },
        { task_key: 'D#7:T2-a', status: 'not_started', parent_key: 'D#7:T2', planned_prs: 1, title: 'First half' },
        { task_key: 'D#7:T2-b', status: 'not_started', parent_key: 'D#7:T2', planned_prs: 1, title: 'Second half' },
      ]);
      const v = await view(r, repoId);
      expect(v.milestones).toMatchObject([{ key: 'D#7', title: 'D#7 Plan the widgets', tasks: 3, done: 1, remaining: 2 }]);
      const props = await proposals(repoId);
      expect(Object.keys(props).sort()).toEqual(['plan:D#7:T2-a', 'plan:D#7:T2-b']);
      expect(await counts(r)).toEqual(before);
    });

    it('F2: the same Correction from an author without a trusted permission is ignored whole', async () => {
      const r = await seedAccount(admin, randomUUID());
      const repoId = await repo(r);
      const out = await run(r, repoId, source({ ...specRepo, comments: { 7: [comment(CORRECTION, 'stranger'), comment(CORRECTION, 'writer')] }, permissions: { ...specRepo.permissions, writer: 'write' } }));
      expect(out).toMatchObject({ state: 'succeeded', level: 'spec_tables' });
      expect((await taskRows(repoId)).map((t) => t.task_key)).toEqual(['D#7:T1', 'D#7:T2']);
    });

    it('F2-1: a Spec-shaped Discussion by an author with only read or write permission imports at issues_discussions; by a maintain or admin author, at spec_tables', async () => {
      const r = await seedAccount(admin, randomUUID());
      const fixture = (authorLogin: string | null) => ({ discussions: [{ ...specRepo.discussions[0]!, authorLogin }], permissions: { writer: 'write', reader: 'read', maint: 'maintain', boss: 'admin' } as Record<string, RepoPermission> });
      for (const author of ['reader', 'writer', 'stranger', null]) {
        const repoId = await repo(r);
        const out = await run(r, repoId, source(fixture(author)));
        expect(out, String(author)).toMatchObject({ state: 'succeeded', level: 'issues_discussions' });
        expect(await taskRows(repoId)).toEqual([]);
        // level 3 still reads the untrusted Discussion as an ordinary one: one proposal
        expect(Object.keys(await proposals(repoId))).toEqual(['gh:discussion:7']);
      }
      for (const author of ['maint', 'boss']) {
        const repoId = await repo(r);
        const out = await run(r, repoId, source(fixture(author)));
        expect(out, author).toMatchObject({ state: 'succeeded', level: 'spec_tables' });
        expect((await taskRows(repoId)).map((t) => t.task_key)).toEqual(['D#7:T1', 'D#7:T2']);
      }
    });

    it('F2-1: an untrusted Spec-shaped Discussion does not take an issues-level repo to spec_tables, so its issue proposals stay', async () => {
      const r = await seedAccount(admin, randomUUID());
      const repoId = await repo(r);
      const out = await run(r, repoId, source({ ...specRepo, discussions: [{ ...specRepo.discussions[0]!, authorLogin: 'stranger' }], issues: [{ number: 3, title: 'A real bug', state: 'open' }] }));
      expect(out).toMatchObject({ state: 'succeeded', level: 'issues_discussions' });
      expect((await proposals(repoId))['gh:issue:3']).toMatchObject({ state: 'new' });
    });

    it('F2-2: one permission lookup per distinct author in an import, none for the comment authors of an untrusted Discussion, no comment read for it', async () => {
      const r = await seedAccount(admin, randomUUID());
      const repoId = await repo(r);
      const second = { number: 8, title: 'Second plan', body: SPEC_BODY, authorLogin: 'SpecMaint' };
      const third = { number: 9, title: 'Outsider plan', body: SPEC_BODY, authorLogin: 'stranger' };
      const fourth = { number: 10, title: 'Another outsider plan', body: SPEC_BODY, authorLogin: 'stranger' };
      const src = source({
        discussions: [specRepo.discussions[0]!, second, third, fourth],
        comments: { 7: [comment(CORRECTION, 'maint'), comment(CORRECTION, 'maint'), comment(CORRECTION, 'SPECMAINT')], 8: [comment(CORRECTION, 'maint')], 9: [comment(CORRECTION, 'lurker')] },
        permissions: { ...specRepo.permissions, maint: 'maintain' },
      });
      const out = await run(r, repoId, src);
      expect(out).toMatchObject({ state: 'succeeded', level: 'spec_tables' });
      expect(src.permissionAsked.map((l) => l.toLowerCase()).sort()).toEqual(['maint', 'specmaint', 'stranger']);
      expect(src.permissionAsked).not.toContain('lurker');
      expect(src.commentsAsked).toEqual([7, 8]);
      expect((await view(r, repoId)).milestones.map((m) => m.key)).toEqual(['D#7', 'D#8']);
    });

    describe('F2-3: the request budget running out fails the import closed', () => {
      const snapshot = async (repoId: string) => ({
        milestones: (await admin.query('SELECT * FROM plan_milestones WHERE repo_id = $1 ORDER BY key', [repoId])).rows,
        tasks: (await admin.query('SELECT * FROM plan_tasks WHERE repo_id = $1 ORDER BY task_key', [repoId])).rows,
        props: (await admin.query('SELECT * FROM proposals WHERE repo_id = $1 ORDER BY dedupe_key', [repoId])).rows,
      });
      it.each([
        ['the trust lookups', 'permission'],
        ['the merged pull request read', 'pulls'],
        ['the Discussions read', 'discussions'],
        ['the Spec comment reads', 'comments'],
      ] as const)('running out during %s ends failed with request_budget_exhausted; the previous plan rows are byte-identical and no succeeded row exists for the new import', async (_label, budgetAt) => {
        const r = await seedAccount(admin, randomUUID());
        const repoId = await repo(r);
        const good = source({ ...specRepo, comments: { 7: [comment(CORRECTION, 'maint')] }, permissions: { ...specRepo.permissions, maint: 'maintain' }, pulls: [pr(20, 'Closes D#7:T1', [])] });
        const first = await run(r, repoId, good);
        expect(first.state).toBe('succeeded');
        const before = await snapshot(repoId);
        expect(before.tasks.length).toBe(3);
        const bad = await run(r, repoId, source({ ...specRepo, comments: { 7: [comment(CORRECTION, 'maint')] }, permissions: { ...specRepo.permissions, maint: 'maintain' }, pulls: [pr(20, 'Closes D#7:T1', [])], budgetAt }));
        expect(bad).toMatchObject({ state: 'failed', code: 'request_budget_exhausted' });
        expect(await snapshot(repoId)).toEqual(before);
        expect((await admin.query(`SELECT state, error_code, level FROM plan_imports WHERE id = $1`, [bad.importId])).rows).toEqual([{ state: 'failed', error_code: 'request_budget_exhausted', level: null }]);
        expect((await admin.query(`SELECT count(*)::int n FROM plan_imports WHERE repo_id = $1 AND state = 'succeeded'`, [repoId])).rows[0].n).toBe(1);
        // the plan view keeps the previous successful import's rows and time; the failure is the latest import
        const v = await view(r, repoId);
        expect(v.latest_import).toMatchObject({ id: bad.importId, state: 'failed', error_code: 'request_budget_exhausted' });
        expect(v.imported_from).toMatchObject({ id: first.importId, state: 'succeeded' });
        expect(v.totals).toEqual({ tasks: 3, done: 1, remaining: 2 });
        // nothing is stuck running: the next start is allowed at once
        expect((await run(r, repoId, good)).state).toBe('succeeded');
      });

      it('a repo with no previous import shows the failure and an empty plan', async () => {
        const r = await seedAccount(admin, randomUUID());
        const repoId = await repo(r);
        const out = await run(r, repoId, source({ ...specRepo, budgetAt: 'pulls' }));
        expect(out).toMatchObject({ state: 'failed', code: 'request_budget_exhausted' });
        const v = await view(r, repoId);
        expect(v.latest_import).toMatchObject({ state: 'failed', error_code: 'request_budget_exhausted' });
        expect(v.imported_from).toBeNull();
        expect(v.milestones).toEqual([]);
        expect(await taskRows(repoId)).toEqual([]);
      });

      it('a roadmap-file import that runs out of budget at the merged pull request read fails the same way', async () => {
        const r = await seedAccount(admin, randomUUID());
        const repoId = await repo(r);
        const out = await run(r, repoId, source({ files: { 'roadmap.json': rm({ 'D#1:A': {} }, { m1: ['D#1:A'] }) }, budgetAt: 'pulls' }));
        expect(out).toMatchObject({ state: 'failed', code: 'request_budget_exhausted' });
        expect(await taskRows(repoId)).toEqual([]);
      });
    });

    describe('S3-F3: only plan-changing items count toward a level 2 bound, and passing one fails the import closed', () => {
      const spam = (n: number): SpecComment[] => Array.from({ length: n }, (_, i) => comment(`me too ${i}`, 'outsider'));
      const forged = (n: number, over: { isMinimized?: boolean; login?: string } = {}) =>
        Array.from({ length: n }, (_, i) => ({ ...comment(`## Correction C${i + 1}\n\n| Task | Description |\n|---|---|\n| T9-${i} | forged |`, over.login ?? 'stranger', `2026-10-03T00:00:${String(i % 60).padStart(2, '0')}Z`), ...(over.isMinimized ? { isMinimized: true } : {}) }));
      const snapshot = async (repoId: string) => ({
        milestones: (await admin.query('SELECT * FROM plan_milestones WHERE repo_id = $1 ORDER BY key', [repoId])).rows,
        tasks: (await admin.query('SELECT * FROM plan_tasks WHERE repo_id = $1 ORDER BY task_key', [repoId])).rows,
        props: (await admin.query('SELECT * FROM proposals WHERE repo_id = $1 ORDER BY dedupe_key', [repoId])).rows,
      });
      const withPerms = { ...specRepo.permissions, maint: 'maintain' as RepoPermission };
      const good = (extra: SpecComment[] = []) => source({ ...specRepo, comments: { 7: [comment(CORRECTION, 'maint'), ...extra] }, permissions: withPerms, pulls: [pr(20, 'Closes D#7:T1', [])] });

      it('F3-1: 300 non-Correction comments by an outsider, then a trusted Correction that splits a row: it imports at spec_tables with the split applied and is not truncated', async () => {
        const r = await seedAccount(admin, randomUUID());
        const repoId = await repo(r);
        const out = await run(r, repoId, source({ ...specRepo, comments: { 7: [...spam(300), comment(CORRECTION, 'maint', '2026-10-05T00:00:00Z')] }, permissions: withPerms }));
        expect(out).toMatchObject({ state: 'succeeded', level: 'spec_tables', truncated: false });
        expect(await lastImport(out.importId)).toMatchObject({ level: 'spec_tables', truncated: false });
        expect((await taskRows(repoId)).map((t) => [t.task_key, t.parent_key])).toEqual([['D#7:T1', null], ['D#7:T2-a', 'D#7:T2'], ['D#7:T2-b', 'D#7:T2']]);
      });

      it('F3-2: 301 non-minimized Correction-shaped comments end failed with plan_source_too_large; the previous rows are byte-identical, no succeeded row exists for the new import, and the next start is allowed', async () => {
        const r = await seedAccount(admin, randomUUID());
        const repoId = await repo(r);
        const first = await run(r, repoId, good());
        expect(first.state).toBe('succeeded');
        const before = await snapshot(repoId);
        expect(before.tasks.length).toBe(3);
        const bad = await run(r, repoId, good(forged(300)));
        expect(bad).toMatchObject({ state: 'failed', code: 'plan_source_too_large', detail: null });
        expect(await snapshot(repoId)).toEqual(before);
        expect((await admin.query(`SELECT state, error_code, level FROM plan_imports WHERE id = $1`, [bad.importId])).rows).toEqual([{ state: 'failed', error_code: 'plan_source_too_large', level: null }]);
        expect((await admin.query(`SELECT count(*)::int n FROM plan_imports WHERE repo_id = $1 AND state = 'succeeded'`, [repoId])).rows[0].n).toBe(1);
        const v = await view(r, repoId);
        expect(v.latest_import).toMatchObject({ id: bad.importId, state: 'failed', error_code: 'plan_source_too_large' });
        expect(v.imported_from).toMatchObject({ id: first.importId, state: 'succeeded' });
        expect(v.totals).toEqual({ tasks: 3, done: 1, remaining: 2 });
        expect((await run(r, repoId, good())).state).toBe('succeeded');
      });

      it('F3-2: a repo with no previous import shows the failure and an empty plan, with no null or undefined text', async () => {
        const r = await seedAccount(admin, randomUUID());
        const repoId = await repo(r);
        const out = await run(r, repoId, source({ ...specRepo, comments: { 7: forged(301) }, permissions: withPerms }));
        expect(out).toMatchObject({ state: 'failed', code: 'plan_source_too_large' });
        const v = await view(r, repoId);
        expect(v.latest_import).toMatchObject({ state: 'failed', error_code: 'plan_source_too_large' });
        expect(v.imported_from).toBeNull();
        expect(v.milestones).toEqual([]);
        expect(await taskRows(repoId)).toEqual([]);
        expect(JSON.stringify(v)).not.toMatch(/undefined/);
      });

      it('F3-3: with 2 of the 301 minimized (299 kept) it succeeds, and a minimized trusted Correction is not applied; un-minimizing it applies it at the next import', async () => {
        const r = await seedAccount(admin, randomUUID());
        const repoId = await repo(r);
        const hidden = [{ ...comment(CORRECTION, 'maint', '2026-10-05T00:00:00Z'), isMinimized: true }, ...forged(1, { isMinimized: true })];
        const out = await run(r, repoId, source({ ...specRepo, comments: { 7: [...hidden, ...forged(299)] }, permissions: withPerms }));
        expect(out).toMatchObject({ state: 'succeeded', level: 'spec_tables', truncated: false });
        expect((await taskRows(repoId)).map((t) => t.task_key)).toEqual(['D#7:T1', 'D#7:T2']);
        const again = await run(r, repoId, source({ ...specRepo, comments: { 7: [comment(CORRECTION, 'maint', '2026-10-05T00:00:00Z'), ...forged(1, { isMinimized: true }), ...forged(299)] }, permissions: withPerms }));
        expect(again).toMatchObject({ state: 'succeeded', level: 'spec_tables' });
        // the earlier import's T2 row is soft-removed (removed_at), so only the live rows are compared
        const live = (await admin.query('SELECT task_key FROM plan_tasks WHERE repo_id = $1 AND removed_at IS NULL ORDER BY task_key', [repoId])).rows.map((t) => t.task_key);
        expect(live).toEqual(['D#7:T1', 'D#7:T2-a', 'D#7:T2-b']);
      });

      it('F3-4: 650 Discussions with the trusted Spec the newest import at spec_tables; with 601 Spec-shaped Discussions the import fails with plan_source_too_large', async () => {
        const r = await seedAccount(admin, randomUUID());
        const repoId = await repo(r);
        const ordinary = Array.from({ length: 649 }, (_, i) => ({ number: i + 1, title: `Thought ${i + 1}`, body: 'just a thought', authorLogin: 'someone' }));
        const newest = { number: 650, title: 'Plan the widgets', body: SPEC_BODY, authorLogin: 'specmaint' };
        const out = await run(r, repoId, source({ discussions: [...ordinary, newest], permissions: specRepo.permissions }));
        expect(out).toMatchObject({ state: 'succeeded', level: 'spec_tables', truncated: false });
        expect((await taskRows(repoId)).map((t) => t.task_key)).toEqual(['D#650:T1', 'D#650:T2']);

        const many = (n: number) => Array.from({ length: n }, (_, i) => ({ number: i + 1, title: `Plan ${i + 1}`, body: SPEC_BODY, authorLogin: 'specmaint' }));
        const before = await snapshot(repoId);
        const ok = await run(r, repoId, source({ discussions: many(600), permissions: specRepo.permissions }));
        expect(ok).toMatchObject({ state: 'succeeded', level: 'spec_tables' });
        const mid = await snapshot(repoId);
        expect(mid).not.toEqual(before);
        const bad = await run(r, repoId, source({ discussions: many(601), permissions: specRepo.permissions }));
        expect(bad).toMatchObject({ state: 'failed', code: 'plan_source_too_large' });
        expect(await snapshot(repoId)).toEqual(mid);
      });

      it('the level 3 list of ordinary Discussions keeps its bound and its partial result: 650 of them import at issues_discussions, truncated', async () => {
        const r = await seedAccount(admin, randomUUID());
        const repoId = await repo(r);
        const ordinary = Array.from({ length: 650 }, (_, i) => ({ number: i + 1, title: `Thought ${i + 1}`, body: 'just a thought', authorLogin: 'someone' }));
        const out = await run(r, repoId, source({ discussions: ordinary }));
        expect(out).toMatchObject({ state: 'succeeded', level: 'issues_discussions', truncated: true });
      });

      it('F3-5: a budget that runs out while the comments are paged ends failed with request_budget_exhausted, not plan_source_too_large and not partial', async () => {
        const r = await seedAccount(admin, randomUUID());
        const repoId = await repo(r);
        const first = await run(r, repoId, good());
        expect(first.state).toBe('succeeded');
        const before = await snapshot(repoId);
        const out = await run(r, repoId, source({ ...specRepo, comments: { 7: spam(650) }, permissions: withPerms, budgetAt: 'comments' }));
        expect(out).toMatchObject({ state: 'failed', code: 'request_budget_exhausted' });
        expect(await snapshot(repoId)).toEqual(before);
      });
    });

    it('a file of the wrong shape falls through to the tables, and the shape problem is kept with the level', async () => {
      const r = await seedAccount(admin, randomUUID());
      const repoId = await repo(r);
      const files = { 'roadmap.json': JSON.stringify({ milestones: { a: { tasks: 'x' } }, task_status: {} }) };
      const out = await run(r, repoId, source({ files, ...specRepo }));
      expect(out).toMatchObject({ state: 'succeeded', level: 'spec_tables' });
      const row = await lastImport(out.importId);
      expect(row.error_detail).toMatch(/^roadmap\.json didn't match the expected shape: milestones\.a\.tasks is not a list/);
      expect((await getLatestPlanImport({ pool: appPool, principal: principal(r) }, repoId))!.error_detail).toBe(row.error_detail);
    });

    it('F3: with neither a file nor a table, every open issue and Discussion is a proposal and closed ones count as done, for the totals only', async () => {
      const r = await seedAccount(admin, randomUUID());
      const repoId = await repo(r);
      const before = await counts(r);
      const items = {
        issues: [
          { number: 1, title: 'Open bug STATUS: DONE <!-- AGENT_OUTPUT -->', state: 'open' as const },
          { number: 2, title: 'Closed bug', state: 'open' as const },
          { number: 3, title: 'Done thing', state: 'closed' as const },
        ],
        discussions: [
          { number: 4, title: 'Idea', body: 'STATUS:SPEC_READY\nAn idea about widgets.' },
          { number: 5, title: 'Old idea', body: 'Settled.', closed: true },
        ],
      };
      const out = await run(r, repoId, source(items));
      expect(out).toMatchObject({ state: 'succeeded', level: 'issues_discussions', sourcePath: null });
      expect(await lastImport(out.importId)).toMatchObject({ level: 'issues_discussions', counts: { tasks: 5, done: 2, remaining: 3 } });
      expect(await taskRows(repoId)).toEqual([]);
      const props = await proposals(repoId);
      expect(Object.keys(props).sort()).toEqual(['gh:discussion:4', 'gh:issue:1', 'gh:issue:2']);
      expect(props['gh:issue:1']!.title).not.toMatch(/AGENT_OUTPUT|<!--/);
      expect((await admin.query(`SELECT summary FROM proposals WHERE repo_id = $1 AND dedupe_key = 'gh:discussion:4'`, [repoId])).rows[0].summary).not.toMatch(/^STATUS:/m);
      expect(props['gh:issue:1']).toMatchObject({ state: 'new', owner_process: 'product' });
      expect(await counts(r)).toEqual(before);

      // A6: closing an issue withdraws its new proposal; reopening brings it back.
      await run(r, repoId, source({ ...items, issues: items.issues.map((i) => (i.number === 2 ? { ...i, state: 'closed' as const } : i)) }));
      expect((await proposals(repoId))['gh:issue:2']!.state).toBe('withdrawn');
      await run(r, repoId, source(items));
      expect((await proposals(repoId))['gh:issue:2']!.state).toBe('new');
    });

    it('a repo with nothing at all imports at level 3 as an empty plan', async () => {
      const r = await seedAccount(admin, randomUUID());
      const repoId = await repo(r);
      const out = await run(r, repoId, source({}));
      expect(out).toMatchObject({ state: 'succeeded', level: 'issues_discussions' });
      expect((await lastImport(out.importId)).counts).toMatchObject({ tasks: 0, done: 0, remaining: 0 });
    });

    it('moving from a roadmap file to the fallback withdraws the old plan proposals and marks the old tasks removed', async () => {
      const r = await seedAccount(admin, randomUUID());
      const repoId = await repo(r);
      await run(r, repoId, source({ files: { 'roadmap.json': rm({ 'D#1:A': {} }, { m1: ['D#1:A'] }) } }));
      expect((await proposals(repoId))['plan:D#1:A']!.state).toBe('new');
      const out = await run(r, repoId, source({ issues: [{ number: 9, title: 'Fresh', state: 'open' }] }));
      expect(out).toMatchObject({ state: 'succeeded', level: 'issues_discussions' });
      const props = await proposals(repoId);
      expect(props['plan:D#1:A']!.state).toBe('withdrawn');
      expect(props['gh:issue:9']!.state).toBe('new');
      expect((await admin.query(`SELECT removed_at FROM plan_tasks WHERE repo_id = $1 AND task_key = 'D#1:A'`, [repoId])).rows[0].removed_at).not.toBeNull();
    });

    it('F5: a repo with a valid roadmap file imports at level 1 exactly as before, and never reads Discussions or issues', async () => {
      const r = await seedAccount(admin, randomUUID());
      const repoId = await repo(r);
      const files = { ...LOOP, '.autonomous-team/roadmap.json': rm({ 'D#1:A': { prs: [10] }, 'D#1:B': {} }, { m1: ['D#1:A', 'D#1:B'] }) };
      const noFallback = { discussionsError: { code: 'discussions_disabled' }, discussions: specRepo.discussions, issues: [{ number: 1, title: 'x', state: 'open' as const }] };
      const out = await run(r, repoId, source({ files, pulls: [pr(10, 'A', [])], ...noFallback }));
      expect(out).toMatchObject({ state: 'succeeded', level: 'roadmap_file', sourcePath: '.autonomous-team/roadmap.json' });
      expect((await lastImport(out.importId)).error_detail).toBeNull();
      expect(await taskRows(repoId)).toMatchObject([{ task_key: 'D#1:A', status: 'done' }, { task_key: 'D#1:B', status: 'not_started' }]);
      expect(Object.keys(await proposals(repoId))).toEqual(['plan:D#1:B']);
    });
  });

  describe('failures', () => {
    it.each([
      ['Discussions being off, with no roadmap file', { discussionsError: { code: 'discussions_disabled' } }, 'discussions_disabled', null],
      ['an inconsistent file', { files: { 'roadmap.json': rm({ 'D#1:T': {} }, { m1: ['D#1:T'], m2: ['D#1:T'] }) } }, 'plan_file_inconsistent', /D#1:T/],
      ['a file that is too large', { fileError: { code: 'plan_file_too_large' } }, 'plan_file_too_large', null],
      ['a missing permission', { headError: { code: 'app_permission_missing' } }, 'app_permission_missing', null],
      ['a token that is not read-only', { headError: { code: 'token_not_read_only' } }, 'token_not_read_only', null],
      ['GitHub being unavailable', { pullsError: { code: 'github_unavailable' }, files: { 'roadmap.json': rm({ 'D#1:T': {} }, { m1: ['D#1:T'] }) } }, 'github_unavailable', null],
      ['GitHub rate limiting', { pullsError: { code: 'rate_limited_by_github' }, files: { 'roadmap.json': rm({ 'D#1:T': {} }, { m1: ['D#1:T'] }) } }, 'rate_limited_by_github', null],
      ['a repository the App cannot see', { headError: { code: 'repo_not_connected' } }, 'repo_not_connected', null],
      ['anything unexpected', { headError: { code: 'something_else' } }, 'internal_error', /^Error: x$/],
    ] as Array<[string, SourceOpts, string, RegExp | null]>)('%s ends failed with %s, and says why', async (_label, opts, code, detail) => {
      const r = await seedAccount(admin, randomUUID());
      const repoId = await repo(r);
      const out = await run(r, repoId, source(opts));
      expect(out).toMatchObject({ state: 'failed', code });
      const latest = await getLatestPlanImport({ pool: appPool, principal: principal(r) }, repoId);
      expect(latest).toMatchObject({ state: 'failed', error_code: code });
      if (detail) expect(latest!.error_detail).toMatch(detail);
      expect(latest!.finished_at).not.toBeNull();
      // the evidence of what was asked is kept on a failed import too
      expect(latest!.github_requests).not.toBeNull();
      expect((await view(r, repoId)).milestones).toEqual([]);
    });

    it('a failed import leaves the previous import untouched, and the plan view still shows its data', async () => {
      const r = await seedAccount(admin, randomUUID());
      const repoId = await repo(r);
      const first = await run(r, repoId, source({ files: { 'roadmap.json': rm({ 'D#1:A': {} }, { m1: ['D#1:A'] }) } }));
      expect(first.state).toBe('succeeded');
      const snapshot = async () => ({
        tasks: (await admin.query('SELECT task_key, status, last_import_id, removed_at, updated_at FROM plan_tasks WHERE repo_id = $1 ORDER BY task_key', [repoId])).rows,
        props: (await admin.query('SELECT dedupe_key, state, last_import_id, updated_at FROM proposals WHERE repo_id = $1 ORDER BY dedupe_key', [repoId])).rows,
      });
      const before = await snapshot();
      const bad = await run(r, repoId, source({ files: { 'roadmap.json': rm({ 'D#1:T': {} }, { m1: ['D#1:T'], m2: ['D#1:T'] }) } }));
      expect(bad).toMatchObject({ state: 'failed', code: 'plan_file_inconsistent' });
      expect(await snapshot()).toEqual(before);
      const v = await view(r, repoId);
      expect(v.latest_import).toMatchObject({ state: 'failed', error_code: 'plan_file_inconsistent' });
      expect(v.imported_from).toMatchObject({ id: first.importId, state: 'succeeded' });
      expect(v.totals).toEqual({ tasks: 1, done: 0, remaining: 1 });
    });

    it('a failure inside the write transaction (after the reads) rolls the whole import back and ends it failed', async () => {
      const r = await seedAccount(admin, randomUUID());
      const repoId = await repo(r);
      await run(r, repoId, source({ files: { 'roadmap.json': rm({ 'D#1:A': { note: 'fine' } }, { m1: ['D#1:A'] }) } }));
      const before = (await admin.query('SELECT task_key, title, last_import_id FROM plan_tasks WHERE repo_id = $1', [repoId])).rows;
      // A trigger that fails the proposals step, which runs after milestones and tasks were already written in the same transaction.
      await admin.query(`CREATE FUNCTION s3_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.title = 'BOOM' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$`);
      await admin.query('CREATE TRIGGER s3_boom BEFORE INSERT OR UPDATE ON proposals FOR EACH ROW EXECUTE FUNCTION s3_boom()');
      try {
        const out = await run(r, repoId, source({ files: { 'roadmap.json': rm({ 'D#1:A': { note: 'changed' }, 'D#1:Z': { note: 'BOOM' } }, { m1: ['D#1:A', 'D#1:Z'] }) } }));
        expect(out).toMatchObject({ state: 'failed', code: 'internal_error' });
      } finally {
        await admin.query('DROP TRIGGER s3_boom ON proposals');
        await admin.query('DROP FUNCTION s3_boom()');
      }
      expect((await admin.query('SELECT task_key, title, last_import_id FROM plan_tasks WHERE repo_id = $1', [repoId])).rows).toEqual(before);
      expect((await admin.query(`SELECT count(*)::int n FROM plan_tasks WHERE repo_id = $1 AND task_key = 'D#1:Z'`, [repoId])).rows[0].n).toBe(0);
    });

    it('an import that was closed as interrupted cannot be written afterwards', async () => {
      const r = await seedAccount(admin, randomUUID());
      const repoId = await repo(r);
      const importId = await beginPlanImport(appPool, principal(r), repoId);
      await admin.query(`UPDATE plan_imports SET started_at = now() - interval '11 minutes' WHERE id = $1`, [importId]);
      await admin.query(`UPDATE plan_imports SET state = 'failed', error_code = 'interrupted', finished_at = now() WHERE id = $1`, [importId]);
      const plan = parseRoadmapFile(rm({ 'D#1:A': {} }, { m1: ['D#1:A'] }));
      await expect(
        writeSucceededImport(appPool, principal(r), { importId, repoId, level: 'roadmap_file', sourcePath: 'roadmap.json', sourceSha: SHA, plan, computed: computePlan(plan, []), owner: 'product', truncated: false, maxMergedPr: 0, evidence: { requests: [], tokenPermissions: null } }),
      ).rejects.toBeInstanceOf(ImportNotRunningError);
      expect((await admin.query('SELECT count(*)::int n FROM plan_tasks WHERE repo_id = $1', [repoId])).rows[0].n).toBe(0);
    });

    it('a truncated read (a bound was hit) is recorded as truncated', async () => {
      const r = await seedAccount(admin, randomUUID());
      const repoId = await repo(r);
      const out = await run(r, repoId, source({ files: { 'roadmap.json': rm({ 'D#1:A': {} }, { m1: ['D#1:A'] }) }, truncated: true }));
      expect(out).toMatchObject({ state: 'succeeded', truncated: true });
      expect((await admin.query('SELECT truncated FROM plan_imports WHERE id = $1', [out.importId])).rows[0].truncated).toBe(true);
    });
  });

  describe('starting an import', () => {
    it('one import at a time per repository, then another is allowed once it ends', async () => {
      const r = await seedAccount(admin, randomUUID());
      const repoId = await repo(r);
      const id = await beginPlanImport(appPool, principal(r), repoId);
      await expect(beginPlanImport(appPool, principal(r), repoId)).rejects.toBeInstanceOf(ImportRunningError);
      await executePlanImport({ pool: appPool, principal: principal(r), repoId, importId: id, source: source({}) });
      await expect(beginPlanImport(appPool, principal(r), repoId)).resolves.toBeTruthy();
    });

    it('a member, another tenant, an unknown repository and a detached repository are refused with the right error', async () => {
      const r = await seedAccount(admin, randomUUID());
      const repoId = await repo(r);
      const memberId = randomUUID();
      await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [memberId, `${memberId}@example.test`]);
      await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [r.accountId, memberId]);
      await expect(beginPlanImport(appPool, { accountId: r.accountId, userId: memberId }, repoId)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(beginPlanImport(appPool, principal(b), repoId)).rejects.toBeInstanceOf(NotFoundError);
      await expect(beginPlanImport(appPool, principal(r), randomUUID())).rejects.toBeInstanceOf(NotFoundError);
      await expect(beginPlanImport(appPool, principal(r), await repo(r, false))).rejects.toBeInstanceOf(ImportRepoNotConnectedError);
    });

    it('the seventh start in an hour for one repository is rate limited, with the seconds to wait', async () => {
      const r = await seedAccount(admin, randomUUID());
      const repoId = await repo(r);
      for (let i = 0; i < 6; i += 1) {
        const out = await run(r, repoId, source({ headError: { code: 'github_unavailable' } }));
        expect(out.state).toBe('failed');
      }
      const err = await beginPlanImport(appPool, principal(r), repoId).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ImportRateLimitedError);
      expect((err as ImportRateLimitedError).retryAfterSeconds).toBeGreaterThan(0);
      expect((err as ImportRateLimitedError).retryAfterSeconds).toBeLessThanOrEqual(3600);
    });
  });

  describe('reads', () => {
    it('another tenant sees neither the import nor the plan (not found)', async () => {
      const r = await seedAccount(admin, randomUUID());
      const repoId = await repo(r);
      await run(r, repoId, source({ files: { 'roadmap.json': rm({ 'D#1:A': {} }, { m1: ['D#1:A'] }) } }));
      await expect(getLatestPlanImport({ pool: appPool, principal: principal(b) }, repoId)).rejects.toBeInstanceOf(NotFoundError);
      await expect(getPlanView({ pool: appPool, principal: principal(b) }, repoId)).rejects.toBeInstanceOf(NotFoundError);
      await expect(getPlanView({ pool: appPool, principal: principal(r) }, 'not-a-uuid')).rejects.toBeInstanceOf(NotFoundError);
    });

    it('a repository never imported has no latest import and an empty plan', async () => {
      const r = await seedAccount(admin, randomUUID());
      const repoId = await repo(r);
      expect(await getLatestPlanImport({ pool: appPool, principal: principal(r) }, repoId)).toBeNull();
      expect(await view(r, repoId)).toMatchObject({ latest_import: null, imported_from: null, milestones: [], tasks: [], totals: { tasks: 0, done: 0, remaining: 0 }, next_cursor: null });
    });

    it('the task page filters by milestone and status and pages by a cursor, with counts that are derived', async () => {
      const r = await seedAccount(admin, randomUUID());
      const repoId = await repo(r);
      const tasks: Record<string, Record<string, unknown>> = {};
      for (let i = 0; i < 7; i += 1) tasks[`D#1:T${i}`] = i % 2 === 0 ? { prs: [i + 1] } : {};
      await run(r, repoId, source({ files: { 'roadmap.json': rm(tasks, { m1: Object.keys(tasks).slice(0, 5), m2: Object.keys(tasks).slice(5) }) }, pulls: [1, 3, 5, 7].map((n) => pr(n, `p${n}`, [])) }));
      const v = await view(r, repoId, { limit: 3 });
      expect(v.tasks.map((t) => t.task_key)).toEqual(['D#1:T0', 'D#1:T1', 'D#1:T2']);
      expect(v.next_cursor).toBe('D#1:T2');
      const v2 = await view(r, repoId, { limit: 3, cursor: v.next_cursor! });
      expect(v2.tasks.map((t) => t.task_key)).toEqual(['D#1:T3', 'D#1:T4', 'D#1:T5']);
      expect((await view(r, repoId, { milestone: 'm2', status: 'done' })).tasks.map((t) => t.task_key)).toEqual(['D#1:T6']);
      expect((await view(r, repoId, { status: 'remaining' })).tasks.map((t) => t.task_key)).toEqual(['D#1:T1', 'D#1:T3', 'D#1:T5']);
      expect(v.milestones.map((m) => [m.key, m.tasks, m.done, m.remaining])).toEqual([['m1', 5, 3, 2], ['m2', 2, 1, 1]]);
    });
  });
});
