import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { plannedFixture, type PlannedFixture } from '@fx/db/test/helpers/plannedChildren.js';
import { recordChildBranch, recordChildPullRequest } from '@fx/runner';
import { applyMappedEvent, mapEvent, type ApplyEventCtx, type ApplyResult, type GithubPullRequestPayload } from '../src/eventMapper.js';
import { seedAccountWithRepo, type SeedRefs } from './helpers/seed.js';

/**
 * [pg] D#483 S5-b2c-2 (R1): a planned PR child's pull request maps to the CHILD, never to its parent, by the branch and number its run recorded. The payloads are the shape GitHub
 * delivers (`head.ref`, `head.sha`, `head.repo.{id,full_name}` or `null` for a deleted fork, `base.repo.{id,full_name}`, `author_association`), and a builder checks that shape
 * before a test uses it, so a fixture cannot say something GitHub would not.
 */
const FULL_NAME = 'acme-corp/widgets';
const REPO_GH_ID = 9001;

interface PrInput {
  action: 'opened' | 'synchronize' | 'closed';
  number: number;
  ref: string;
  body?: string | null;
  merged?: boolean;
  /** `null` is a deleted fork (GitHub reports `head.repo` as null). */
  headRepoId?: number | null;
  association?: string;
  login?: string;
  /** The branch the pull request targets (default: main, the repository's default branch). */
  base?: string;
}

/** A pull_request delivery with every field GitHub sends that the mapper reads or could read. Throws when the result is not a shape GitHub would produce. */
function pull(input: PrInput): GithubPullRequestPayload {
  const headRepo = input.headRepoId === null ? null : { id: input.headRepoId ?? REPO_GH_ID, full_name: input.headRepoId !== undefined && input.headRepoId !== REPO_GH_ID ? 'stranger/widgets' : FULL_NAME };
  const merged = input.merged === true;
  const sha = 'c'.repeat(40);
  const payload = {
    action: input.action,
    number: input.number,
    pull_request: {
      number: input.number,
      state: input.action === 'closed' ? 'closed' : 'open',
      body: input.body ?? null,
      created_at: '2026-10-26T12:00:00Z',
      merged_at: merged ? '2026-10-26T13:00:00Z' : null,
      merged,
      user: { login: input.login ?? 'fulcrumaxe[bot]', type: 'Bot' },
      author_association: input.association ?? 'OWNER',
      head: { ref: input.ref, sha, repo: headRepo },
      base: { ref: input.base ?? 'main', sha: 'd'.repeat(40), repo: { id: REPO_GH_ID, full_name: FULL_NAME } },
    },
    repository: { id: REPO_GH_ID, full_name: FULL_NAME, default_branch: 'main' },
    installation: { id: 4243 },
  };
  const p = payload.pull_request;
  if (!['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'FIRST_TIMER', 'FIRST_TIME_CONTRIBUTOR', 'MANNEQUIN', 'NONE'].includes(p.author_association)) throw new Error('not a GitHub author_association');
  if (!/^[0-9a-f]{40}$/.test(p.head.sha) || typeof p.head.ref !== 'string' || p.head.ref === '') throw new Error('not a GitHub head');
  if (p.head.repo !== null && (typeof p.head.repo.id !== 'number' || !/^[^/]+\/[^/]+$/.test(p.head.repo.full_name))) throw new Error('not a GitHub head repo');
  if (p.merged && p.merged_at === null) throw new Error('a merged pull request has merged_at');
  return payload as unknown as GithubPullRequestPayload;
}

describe('a planned PR child maps from its pull request by the run\'s recorded binding [pg]', { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let appUserPool: Pool;
  let admin: PoolClient;
  let f: PlannedFixture;
  let other: SeedRefs;
  let seq = 100;

  beforeAll(async () => {
    adminPool = createPool(process.env.GITHUB_DATABASE_URL!);
    appUserPool = createPool(process.env.GITHUB_DATABASE_URL_APP_USER!);
    admin = await adminPool.connect();
    f = await plannedFixture(admin, appUserPool, { dial: null, weeklyUsd: null });
    await admin.query('UPDATE work_items SET gh_number = 41, stage = $2 WHERE id = $1', [f.parent, 'in_progress']);
    other = await seedAccountWithRepo(admin, 4244);
  });
  afterAll(async () => {
    admin.release();
    await appUserPool.end();
    await adminPool.end();
  });

  const ctxFor = (accountId: string, repoId: string): ApplyEventCtx => ({ accountId, installationId: randomUUID(), repoId, repo: { accountId, repoId, ghRepoId: REPO_GH_ID, fullName: FULL_NAME }, deliveryId: `d-${randomUUID()}` });
  const deliver = (payload: GithubPullRequestPayload, accountId = f.t.accountId, repoId = f.t.repoId): Promise<ApplyResult> =>
    withTenant(appUserPool, accountId, (client) => applyMappedEvent(client, ctxFor(accountId, repoId), mapEvent('pull_request', payload, { allowlist: [] })));
  const stageOf = async (id: string) => (await admin.query<{ stage: string }>('SELECT stage FROM work_items WHERE id = $1', [id])).rows[0]!.stage;
  const bindings = async (runId: string) => (await admin.query<{ kind: string; payload: Record<string, unknown> }>(`SELECT kind, payload FROM run_events WHERE run_id = $1 AND kind LIKE 'child.%' ORDER BY seq`, [runId])).rows;

  /** A child that has started: its executor run exists, recorded its branch through the real writer, and the item is in progress. */
  async function started(key: string): Promise<{ child: string; runId: string; branch: string }> {
    const child = f.kids[key]!;
    const runId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'production', 'running')`, [runId, f.t.accountId, child]);
    await admin.query(`UPDATE work_items SET stage = 'in_progress' WHERE id = $1`, [child]);
    const branch = `fx/41-${key}`;
    await withTenant(appUserPool, f.t.accountId, (c) => recordChildBranch(c, f.t.accountId, runId, branch));
    return { child, runId, branch };
  }

  it('the payload builder refuses a shape GitHub would not send', () => {
    expect(() => pull({ action: 'opened', number: 1, ref: 'x', association: 'WIZARD' })).toThrow();
    expect(() => pull({ action: 'opened', number: 1, ref: '' })).toThrow();
    expect(pull({ action: 'opened', number: 1, ref: 'x', headRepoId: null }).pull_request.head.repo).toBeNull();
  });

  it('S5b2c2-5: opened, synchronize and merged map to the child; the parent\'s stage and issue are untouched; the number is recorded once, on the first delivery', async () => {
    const { child, runId, branch } = await started('api');
    const n = seq++;
    const body = 'Refs #41\n\nOne planned PR.';
    expect(await deliver(pull({ action: 'opened', number: n, ref: branch, body }))).toMatchObject({ applied: 'transitioned', workItemId: child, recorded: true });
    expect(await stageOf(child)).toBe('pr_opened');
    expect(await bindings(runId)).toEqual([{ kind: 'child.binding', payload: { branch } }, { kind: 'child.binding_pr', payload: { branch, prNumber: n } }]);
    expect(await deliver(pull({ action: 'synchronize', number: n, ref: branch, body }))).toMatchObject({ applied: 'pr_push_recorded', workItemId: child, recorded: true });
    expect(await deliver(pull({ action: 'closed', number: n, ref: branch, body, merged: true }))).toMatchObject({ applied: 'transitioned', workItemId: child, recorded: true });
    expect(await stageOf(child)).toBe('merged');
    expect(await stageOf(f.parent)).toBe('in_progress');
    expect((await admin.query('SELECT 1 FROM work_item_transitions WHERE work_item_id = $1', [f.parent])).rowCount).toBe(0);
  });

  it('S5b2c2-5: a pull request closed without merging moves only the child, and a re-opened one on the same number maps back', async () => {
    const { child, branch } = await started('ui');
    const n = seq++;
    await deliver(pull({ action: 'opened', number: n, ref: branch, body: 'Refs #41' }));
    expect(await deliver(pull({ action: 'closed', number: n, ref: branch, body: 'Refs #41' }))).toMatchObject({ applied: 'transitioned', workItemId: child, recorded: true });
    expect(await stageOf(child)).toBe('closed_unmerged');
    expect(await stageOf(f.parent)).toBe('in_progress');
    await admin.query(`UPDATE work_items SET stage = 'in_progress' WHERE id = $1`, [child]);
    expect(await deliver(pull({ action: 'opened', number: n, ref: branch, body: 'Refs #41' }))).toMatchObject({ applied: 'transitioned', workItemId: child });
  });

  it('S5b2c2-5: a child a person closed stays closed when its pull request is merged later', async () => {
    const { child, branch } = await started('docs');
    const n = seq++;
    await deliver(pull({ action: 'opened', number: n, ref: branch, body: 'Refs #41' }));
    await admin.query(`UPDATE work_items SET stage = 'closed' WHERE id = $1`, [child]);
    expect(await deliver(pull({ action: 'closed', number: n, ref: branch, body: 'Refs #41', merged: true }))).toMatchObject({ applied: 'transitioned', workItemId: child, recorded: false });
    expect(await stageOf(child)).toBe('closed');
  });

  describe('S5b2c2-6: pull requests that are not the child\'s map to no child', () => {
    it('a fork\'s pull request on the same branch name, a deleted fork, a pull request from another branch that says Refs #parent, a second pull request on a branch whose number is set, and the same number in another repository', async () => {
      const f2 = await plannedFixture(admin, appUserPool, { dial: null, weeklyUsd: null });
      const key = 'api';
      const child = f2.kids[key]!;
      const runId = randomUUID();
      await admin.query('UPDATE work_items SET gh_number = 41 WHERE id = $1', [f2.parent]);
      await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'production', 'running')`, [runId, f2.t.accountId, child]);
      await admin.query(`UPDATE work_items SET stage = 'in_progress' WHERE id = $1`, [child]);
      await withTenant(appUserPool, f2.t.accountId, (c) => recordChildBranch(c, f2.t.accountId, runId, 'fx/41-api'));
      const go = (p: GithubPullRequestPayload, t = f2.t) => deliver(p, t.accountId, t.repoId);
      const noChange = async () => {
        expect(await stageOf(child)).toBe('in_progress');
        expect(await stageOf(f2.parent)).toBe('triaged');
        expect((await bindings(runId)).map((b) => b.kind)).toEqual(['child.binding']);
      };

      // A fork from a stranger, then a trusted author's fork, then a fork whose repository was deleted.
      expect(await go(pull({ action: 'opened', number: 500, ref: 'fx/41-api', headRepoId: 77, association: 'NONE', login: 'stranger' }))).toMatchObject({ applied: 'skipped' });
      expect(await go(pull({ action: 'opened', number: 501, ref: 'fx/41-api', headRepoId: 77 }))).toMatchObject({ applied: 'skipped' });
      expect(await go(pull({ action: 'opened', number: 502, ref: 'fx/41-api', headRepoId: null }))).toMatchObject({ applied: 'skipped' });
      await noChange();
      // From another branch, naming only the parent without a closing keyword.
      expect(await go(pull({ action: 'opened', number: 503, ref: 'feature/other', body: 'Refs #41' }))).toMatchObject({ applied: 'skipped' });
      expect(await go(pull({ action: 'opened', number: 504, ref: 'fx/41-docs', body: 'Refs #41' }))).toMatchObject({ applied: 'skipped' });
      await noChange();
      // An author the platform does not trust cannot claim the recorded branch (a not-yet-recorded number needs a trusted author).
      expect(await go(pull({ action: 'opened', number: 505, ref: 'fx/41-api', association: 'NONE', login: 'stranger' }))).toMatchObject({ applied: 'skipped' });
      await noChange();
      // A trusted author's same-head pull request into another base does not bind the number (it targets a branch that is not the repository's default).
      expect(await go(pull({ action: 'opened', number: 506, ref: 'fx/41-api', base: 'release/1.0', body: 'Refs #41' }))).toMatchObject({ applied: 'skipped' });
      await noChange();
      // The real one records its number; after that a second pull request on the same branch finds no child.
      expect(await go(pull({ action: 'opened', number: 600, ref: 'fx/41-api', body: 'Refs #41' }))).toMatchObject({ applied: 'transitioned', workItemId: child });
      expect(await go(pull({ action: 'opened', number: 601, ref: 'fx/41-api', body: 'Refs #41' }))).toMatchObject({ applied: 'skipped' });
      expect(await go(pull({ action: 'closed', number: 601, ref: 'fx/41-api', body: 'Refs #41', merged: true }))).toMatchObject({ applied: 'skipped' });
      expect(await stageOf(child)).toBe('pr_opened');
      // The same number in another repository (another account's) maps to nothing there.
      expect(await deliver(pull({ action: 'closed', number: 600, ref: 'fx/41-api', merged: true }), other.accountId, other.repoId)).toMatchObject({ applied: 'skipped' });
      expect(await stageOf(child)).toBe('pr_opened');
      expect(await stageOf(f2.parent)).toBe('triaged');
    });
  });

  it('S5b2c2-7: the number on a binding is set once: a second record, from any writer, is a no-op and adds no row', async () => {
    const g = await plannedFixture(admin, appUserPool, { dial: null, weeklyUsd: null });
    const run = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'production', 'running')`, [run, g.t.accountId, g.kids.api]);
    const rec = (number: number) => withTenant(appUserPool, g.t.accountId, (c) => recordChildPullRequest(c, g.t.accountId, run, 'fx/41-api', number));
    expect(await withTenant(appUserPool, g.t.accountId, (c) => recordChildBranch(c, g.t.accountId, run, 'fx/41-api'))).toBe(true);
    expect(await withTenant(appUserPool, g.t.accountId, (c) => recordChildBranch(c, g.t.accountId, run, 'fx/41-api'))).toBe(false);
    expect(await rec(7)).toBe(true);
    const before = (await bindings(run)).length;
    expect(await rec(7)).toBe(false);
    expect(await rec(8)).toBe(false);
    expect(await Promise.all([rec(9), rec(10)])).toEqual([false, false]);
    expect(await bindings(run)).toHaveLength(before);
    expect((await bindings(run)).filter((b) => b.kind === 'child.binding_pr').map((b) => b.payload)).toEqual([{ branch: 'fx/41-api', prNumber: 7 }]);
    await expect(withTenant(appUserPool, g.t.accountId, (c) => recordChildPullRequest(c, g.t.accountId, run, 'fx/issue-41', 7))).rejects.toThrow();
  });

  it('S5b2c2-7: two deliveries at once record one number', async () => {
    const g = await plannedFixture(admin, appUserPool, { dial: null, weeklyUsd: null });
    const run = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'production', 'running')`, [run, g.t.accountId, g.kids.api]);
    await withTenant(appUserPool, g.t.accountId, (c) => recordChildBranch(c, g.t.accountId, run, 'fx/41-api'));
    const rec = (number: number) => withTenant(appUserPool, g.t.accountId, (c) => recordChildPullRequest(c, g.t.accountId, run, 'fx/41-api', number));
    const out = await Promise.all([rec(21), rec(22), rec(23), rec(24)]);
    expect(out.filter(Boolean)).toHaveLength(1);
    expect((await bindings(run)).filter((b) => b.kind === 'child.binding_pr')).toHaveLength(1);
  });

  it('S5b2c2-8: a runner repo\'s child records its pull request on done as for any item, and that pull request maps to the child, not the parent', async () => {
    const g = await plannedFixture(admin, appUserPool, { dial: null, weeklyUsd: null });
    const runnerChild = g.kids.ui!;
    const runId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'runner', 'succeeded')`, [runId, g.t.accountId, runnerChild]);
    await admin.query(`UPDATE work_items SET stage = 'pr_opened', gh_number = NULL WHERE id = $1`, [runnerChild]);
    await admin.query('UPDATE work_items SET gh_number = 41 WHERE id = $1', [g.parent]);
    await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'run.status_changed', $3::jsonb)`, [g.t.accountId, runId, JSON.stringify({ to: 'succeeded', viaRunnerDone: 'true', prNumber: 777 })]);
    // The runner's pull request body references the parent without closing it; its branch is the run's own.
    const out = await deliver(pull({ action: 'closed', number: 777, ref: `fx/${runId}-g1`, body: 'Opened by a run.\n\nRefs #41', merged: true }), g.t.accountId, g.t.repoId);
    expect(out).toMatchObject({ applied: 'transitioned', workItemId: runnerChild });
    expect(await stageOf(runnerChild)).toBe('merged');
    expect(await stageOf(g.parent)).toBe('triaged');
  });

  it('S5b2c2-11: two children of one parent have distinct branches and numbers, and each pull request maps to its own child', async () => {
    const g = await plannedFixture(admin, appUserPool, { dial: null, weeklyUsd: null });
    const mk = async (key: string) => {
      const run = randomUUID();
      await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'production', 'running')`, [run, g.t.accountId, g.kids[key]]);
      await admin.query(`UPDATE work_items SET stage = 'in_progress' WHERE id = $1`, [g.kids[key]]);
      await withTenant(appUserPool, g.t.accountId, (c) => recordChildBranch(c, g.t.accountId, run, `fx/41-${key}`));
      return run;
    };
    const [ra, rb] = [await mk('api'), await mk('docs')];
    const [na, nb] = [seq++, seq++];
    expect(await deliver(pull({ action: 'opened', number: nb, ref: 'fx/41-docs' }), g.t.accountId, g.t.repoId)).toMatchObject({ workItemId: g.kids.docs });
    expect(await deliver(pull({ action: 'opened', number: na, ref: 'fx/41-api' }), g.t.accountId, g.t.repoId)).toMatchObject({ workItemId: g.kids.api });
    expect((await bindings(ra)).find((b) => b.kind === 'child.binding_pr')!.payload).toEqual({ branch: 'fx/41-api', prNumber: na });
    expect((await bindings(rb)).find((b) => b.kind === 'child.binding_pr')!.payload).toEqual({ branch: 'fx/41-docs', prNumber: nb });
    expect(await deliver(pull({ action: 'closed', number: na, ref: 'fx/41-api', merged: true }), g.t.accountId, g.t.repoId)).toMatchObject({ workItemId: g.kids.api });
    expect(await stageOf(g.kids.docs!)).toBe('pr_opened');
  });
});
