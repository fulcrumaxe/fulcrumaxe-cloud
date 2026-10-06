import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { ForbiddenError, NotFoundError } from '../src/tenancy/errors.js';
import { ENGINE_LOOP_MARKER, executePlanImport, ROADMAP_PATHS, type PlanSource } from '../src/plan/executeImport.js';
import { beginPlanImport, ImportNotRunningError, ImportRateLimitedError, ImportRepoNotConnectedError, ImportRunningError, writeSucceededImport } from '../src/plan/persist.js';
import { getLatestPlanImport, getPlanView } from '../src/plan/read.js';
import type { PullFacts } from '../src/plan/computePlan.js';
import { parseRoadmapFile } from '../src/plan/roadmapFile.js';
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
}
function source(o: SourceOpts): PlanSource & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
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
      return { pulls: o.pulls ?? [], truncated: o.truncated ?? false };
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

  describe('failures', () => {
    it.each([
      ['no roadmap file', {}, 'plan_file_missing', /none of/],
      ['the wrong shape', { files: { 'roadmap.json': JSON.stringify({ milestones: { a: { tasks: 'x' } }, task_status: {} }) } }, 'plan_file_shape', /milestones\.a\.tasks is not a list/],
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
        writeSucceededImport(appPool, principal(r), { importId, repoId, sourcePath: 'roadmap.json', sourceSha: SHA, plan, computed: computePlan(plan, []), owner: 'product', truncated: false, maxMergedPr: 0, evidence: { requests: [], tokenPermissions: null } }),
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
        const out = await run(r, repoId, source({}));
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
