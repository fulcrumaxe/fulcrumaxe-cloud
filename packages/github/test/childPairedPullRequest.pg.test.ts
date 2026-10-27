import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '@fx/db/src/pool.js';
import { withTenant } from '@fx/db/src/withTenant.js';
import { plannedFixture, type PlannedFixture } from '@fx/db/test/helpers/plannedChildren.js';
import { stampPlanePush } from '@fx/core/src/repos/planePushRecord.js';
import { recordChildBranch, recordChildCodePullRequest } from '@fx/runner';
import { applyMappedEvent, mapEvent, type ApplyEventCtx, type ApplyResult, type GithubPullRequestPayload } from '../src/eventMapper.js';

/**
 * [pg] D#483 S5-b2c-4 (R9), acceptance 5, 6 and 9: a PAIRED planned PR child has two pull requests, and each maps to the child by its own record only.
 *
 *   code plane   the public repository's pull request on `fx/p-<push id>`: by the run's code-plane binding (`child.binding_pr`, `plane: "code"`, repository and number, written once by the publish
 *                step after the hosted side confirmed the pull request) AND the child's own `plane_pushes` row (same repository, number and branch)
 *   private      the draft on the child's branch `fx/<parent#>-<key>`: by the run's `plane.private_pr` marker (the number the publish step opened), in the private repository, never by the branch name
 *
 * The payloads are the shape GitHub delivers on both repositories (`head.ref`, `head.repo.{id,full_name}` or `null` for a deleted fork, `base.repo.full_name`, `author_association`,
 * `merged`), and a builder checks that shape before a test uses it, so a fixture cannot say something GitHub would not. The public repository's delivery is resolved to the account like the
 * private one's (the repository's own full name is what the code-plane lookup compares, without case); the tenant row of the delivery is the private repository's here, which that lookup never reads.
 */
const PRIVATE = 'acme-corp/widgets';
const PUBLIC = 'acme-corp/widgets-public';
const PRIVATE_GH_ID = 9001;
const PUBLIC_GH_ID = 9002;

interface PrInput {
  repo: 'private' | 'public';
  action: 'opened' | 'synchronize' | 'closed';
  number: number;
  ref: string;
  merged?: boolean;
  /** `null` is a deleted fork (GitHub reports `head.repo` as null). A number other than the repository's own is a fork. */
  headRepoId?: number | null;
  /** Overrides the delivery's repository full name (a pull request of the same number in another repository). */
  fullName?: string;
}

function pull(input: PrInput): GithubPullRequestPayload {
  const fullName = input.fullName ?? (input.repo === 'public' ? PUBLIC : PRIVATE);
  const ghId = input.repo === 'public' ? PUBLIC_GH_ID : PRIVATE_GH_ID;
  const headRepo = input.headRepoId === null ? null : { id: input.headRepoId ?? ghId, full_name: input.headRepoId !== undefined && input.headRepoId !== ghId ? 'stranger/widgets' : fullName };
  const merged = input.merged === true;
  const payload = {
    action: input.action,
    number: input.number,
    pull_request: {
      number: input.number,
      state: input.action === 'closed' ? 'closed' : 'open',
      body: input.repo === 'public' ? 'This change was prepared by a fulcrumaxe run.\n\nRefs #41' : 'Opened by a run.\n\nRefs #41',
      created_at: '2026-10-26T12:00:00Z',
      merged_at: merged ? '2026-10-26T13:00:00Z' : null,
      merged,
      user: { login: 'fulcrumaxe[bot]', type: 'Bot' },
      author_association: 'OWNER',
      head: { ref: input.ref, sha: 'c'.repeat(40), repo: headRepo },
      base: { ref: 'main', sha: 'd'.repeat(40), repo: { id: ghId, full_name: fullName } },
    },
    repository: { id: ghId, full_name: fullName, default_branch: 'main' },
    installation: { id: 4243 },
  };
  const p = payload.pull_request;
  if (!/^[0-9a-f]{40}$/.test(p.head.sha) || typeof p.head.ref !== 'string' || p.head.ref === '') throw new Error('not a GitHub head');
  if (p.head.repo !== null && (typeof p.head.repo.id !== 'number' || !/^[^/]+\/[^/]+$/.test(p.head.repo.full_name))) throw new Error('not a GitHub head repo');
  if (p.merged && p.merged_at === null) throw new Error('a merged pull request has merged_at');
  return payload as unknown as GithubPullRequestPayload;
}

describe('a paired planned PR child maps from both of its pull requests by its own records [pg]', { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let appUserPool: Pool;
  let admin: PoolClient;
  let f: PlannedFixture;
  let seq = 300;

  beforeAll(async () => {
    adminPool = createPool(process.env.GITHUB_DATABASE_URL!);
    appUserPool = createPool(process.env.GITHUB_DATABASE_URL_APP_USER!);
    admin = await adminPool.connect();
    f = await plannedFixture(admin, appUserPool, { dial: null, weeklyUsd: null });
    await admin.query('UPDATE work_items SET gh_number = 41, stage = $2 WHERE id = $1', [f.parent, 'in_progress']);
    await admin.query(`INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, $3, ARRAY['docs/ops/'])`, [f.t.repoId, f.t.accountId, PUBLIC]);
  });
  afterAll(async () => {
    admin.release();
    await appUserPool.end();
    await adminPool.end();
  });

  const ctxFor = (payload: GithubPullRequestPayload): ApplyEventCtx => {
    const delivered = (payload as unknown as { repository: { id: number; full_name: string } }).repository;
    return { accountId: f.t.accountId, installationId: randomUUID(), repoId: f.t.repoId, repo: { accountId: f.t.accountId, repoId: f.t.repoId, ghRepoId: delivered.id, fullName: delivered.full_name }, deliveryId: `d-${randomUUID()}` };
  };
  const deliver = (payload: GithubPullRequestPayload): Promise<ApplyResult> =>
    withTenant(appUserPool, f.t.accountId, (client) => applyMappedEvent(client, ctxFor(payload), mapEvent('pull_request', payload, { allowlist: [] })));
  const stageOf = async (id: string) => (await admin.query<{ stage: string }>('SELECT stage FROM work_items WHERE id = $1', [id])).rows[0]!.stage;
  const bindingPrs = async (runId: string) => (await admin.query<{ payload: Record<string, unknown> }>(`SELECT payload FROM run_events WHERE run_id = $1 AND kind = 'child.binding_pr'`, [runId])).rows.map((r) => r.payload);

  interface Paired { child: string; runId: string; branch: string; publicBranch: string; pushId: string }
  /**
   * A paired child that published: it started (its run recorded its branch through the real writer), its push record is stamped and holds the open public pull request `codePr`, and the
   * publish step recorded the code-plane binding through the real writer. With `privatePr`, the run also carries the marker of the private draft it opened.
   */
  async function paired(key: string, codePr: number, privatePr: number | null, opts: { bind?: boolean; row?: boolean } = {}): Promise<Paired> {
    const child = f.kids[key]!;
    const runId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'production', 'succeeded')`, [runId, f.t.accountId, child]);
    await admin.query(`UPDATE work_items SET stage = 'in_progress' WHERE id = $1`, [child]);
    const branch = `fx/41-${key}`;
    await withTenant(appUserPool, f.t.accountId, (c) => recordChildBranch(c, f.t.accountId, runId, branch));
    const row = (await withTenant(appUserPool, f.t.accountId, (c) => stampPlanePush(c, { accountId: f.t.accountId, workItemId: child, repoId: f.t.repoId })))!;
    if (opts.row !== false) {
      await admin.query(`UPDATE plane_pushes SET state = 'pr_opened', head_sha = $2, tip_sha = $3, pr_number = $4, pr_url = $5 WHERE id = $1`, [row.id, 'e'.repeat(40), 'f'.repeat(40), codePr, `https://github.com/${PUBLIC}/pull/${codePr}`]);
    }
    if (opts.bind !== false) await withTenant(appUserPool, f.t.accountId, (c) => recordChildCodePullRequest(c, f.t.accountId, runId, { branch: row.branch, prNumber: codePr, codeRepo: PUBLIC }));
    if (privatePr !== null) await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 3, 'plane.private_pr', $3::jsonb)`, [f.t.accountId, runId, JSON.stringify({ outcome: 'opened', pr: privatePr })]);
    return { child, runId, branch, publicBranch: row.branch, pushId: row.id };
  }

  it('the payload builder refuses a shape GitHub would not send', () => {
    expect(() => pull({ repo: 'public', action: 'opened', number: 1, ref: '' })).toThrow();
    expect(pull({ repo: 'public', action: 'opened', number: 1, ref: 'x', headRepoId: null }).pull_request.head.repo).toBeNull();
  });

  it('S5b2c4-5: the public pull request\'s opened, synchronize, closed (unmerged) and merged events map to the child; the parent is untouched; the binding is the only one the run holds', async () => {
    const a = await paired('api', seq++, null);
    const n = Number((await admin.query<{ pr_number: number }>('SELECT pr_number FROM plane_pushes WHERE id = $1', [a.pushId])).rows[0]!.pr_number);
    const ev = (action: PrInput['action'], merged = false) => pull({ repo: 'public', action, number: n, ref: a.publicBranch, merged });
    expect(await deliver(ev('opened'))).toMatchObject({ applied: 'transitioned', workItemId: a.child, recorded: true });
    expect(await stageOf(a.child)).toBe('pr_opened');
    expect(await deliver(ev('synchronize'))).toMatchObject({ applied: 'pr_push_recorded', workItemId: a.child, recorded: true });
    expect(await deliver(ev('closed'))).toMatchObject({ applied: 'transitioned', workItemId: a.child, recorded: true });
    expect(await stageOf(a.child)).toBe('closed_unmerged');
    // a re-opened pull request on the bound number maps back, and its merge ends at merged
    await admin.query(`UPDATE work_items SET stage = 'in_progress' WHERE id = $1`, [a.child]);
    expect(await deliver(ev('opened'))).toMatchObject({ applied: 'transitioned', workItemId: a.child });
    expect(await deliver(ev('closed', true))).toMatchObject({ applied: 'transitioned', workItemId: a.child, recorded: true });
    expect(await stageOf(a.child)).toBe('merged');
    // S5b2c4-9 (the webhook half): the child's merge moves only the child; the parent stays open and has no transition
    expect(await stageOf(f.parent)).toBe('in_progress');
    expect((await admin.query('SELECT 1 FROM work_item_transitions WHERE work_item_id = $1', [f.parent])).rowCount).toBe(0);
    expect((await admin.query('SELECT 1 FROM plane_pushes WHERE work_item_id = $1', [f.parent])).rowCount).toBe(0);
    // the delivery wrote no second binding and no private-plane one
    expect(await bindingPrs(a.runId)).toEqual([{ branch: a.publicBranch, prNumber: n, plane: 'code', codeRepo: PUBLIC }]);
  });

  it('S5b2c4-5: the private draft\'s opened, synchronize and closed events map to the child by the run\'s marker, in the private repository; no private binding is written', async () => {
    const u = await paired('ui', seq++, 55);
    const ev = (action: PrInput['action']) => pull({ repo: 'private', action, number: 55, ref: u.branch });
    expect(await deliver(ev('opened'))).toMatchObject({ applied: 'transitioned', workItemId: u.child, recorded: true });
    expect(await stageOf(u.child)).toBe('pr_opened');
    expect(await deliver(ev('synchronize'))).toMatchObject({ applied: 'pr_push_recorded', workItemId: u.child });
    expect(await deliver(ev('closed'))).toMatchObject({ applied: 'transitioned', workItemId: u.child, recorded: true });
    expect(await stageOf(u.child)).toBe('closed_unmerged');
    expect(await stageOf(f.parent)).toBe('in_progress');
    expect((await bindingPrs(u.runId)).map((p) => p.plane)).toEqual(['code']);
  });

  describe('S5b2c4-6: a pull request that is not the child\'s maps to no child, and nothing moves', () => {
    it('a public pull request with the bound number whose push record is another\'s: the child\'s own row has another number, a sibling\'s row has this one but no binding', async () => {
      const g = await plannedFixture(admin, appUserPool, { dial: null, weeklyUsd: null });
      await admin.query('UPDATE work_items SET gh_number = 41, stage = $2 WHERE id = $1', [g.parent, 'in_progress']);
      await admin.query(`INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, $3, ARRAY['docs/ops/'])`, [g.t.repoId, g.t.accountId, PUBLIC]);
      const mk = async (key: string, codePr: number, bound: boolean) => {
        const child = g.kids[key]!;
        const run = randomUUID();
        await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'production', 'succeeded')`, [run, g.t.accountId, child]);
        await admin.query(`UPDATE work_items SET stage = 'in_progress' WHERE id = $1`, [child]);
        await withTenant(appUserPool, g.t.accountId, (c) => recordChildBranch(c, g.t.accountId, run, `fx/41-${key}`));
        const row = (await withTenant(appUserPool, g.t.accountId, (c) => stampPlanePush(c, { accountId: g.t.accountId, workItemId: child, repoId: g.t.repoId })))!;
        await admin.query(`UPDATE plane_pushes SET state = 'pr_opened', head_sha = $2, tip_sha = $3, pr_number = $4, pr_url = $5 WHERE id = $1`, [row.id, 'e'.repeat(40), 'f'.repeat(40), codePr, `https://github.com/${PUBLIC}/pull/${codePr}`]);
        if (bound) await withTenant(appUserPool, g.t.accountId, (c) => recordChildCodePullRequest(c, g.t.accountId, run, { branch: row.branch, prNumber: 700, codeRepo: PUBLIC }));
        return { child, branch: row.branch };
      };
      // `api` is bound to number 700 but its own push record holds 701; `ui` holds 700 on its row and has no binding
      const api = await mk('api', 701, true);
      const ui = await mk('ui', 700, false);
      const go = (p: GithubPullRequestPayload) =>
        withTenant(appUserPool, g.t.accountId, (client) => applyMappedEvent(client, { ...ctxFor(p), accountId: g.t.accountId, repoId: g.t.repoId }, mapEvent('pull_request', p, { allowlist: [] })));
      // the bound number on the api child's branch: its row says 701
      expect(await go(pull({ repo: 'public', action: 'closed', number: 700, ref: api.branch, merged: true }))).toMatchObject({ applied: 'skipped' });
      // the number on the sibling's row and branch: the sibling holds no binding, so its row alone maps nothing
      expect(await go(pull({ repo: 'public', action: 'closed', number: 700, ref: ui.branch, merged: true }))).toMatchObject({ applied: 'skipped' });
      expect(await go(pull({ repo: 'public', action: 'opened', number: 700, ref: ui.branch }))).toMatchObject({ applied: 'skipped' });
      expect(await go(pull({ repo: 'public', action: 'synchronize', number: 700, ref: ui.branch }))).toMatchObject({ applied: 'skipped' });
      for (const id of [api.child, ui.child]) expect(await stageOf(id)).toBe('in_progress');
      expect(await stageOf(g.parent)).toBe('in_progress');
    });

    it('a public pull request with the right number in another repository, on another branch, or as a fork, and a private pull request on the child\'s branch before its marker exists, or as a fork', async () => {
      const d = await paired('docs', seq++, null);
      const n = Number((await admin.query<{ pr_number: number }>('SELECT pr_number FROM plane_pushes WHERE id = $1', [d.pushId])).rows[0]!.pr_number);
      const noChange = async () => {
        expect(await stageOf(d.child)).toBe('in_progress');
        expect(await stageOf(f.parent)).toBe('in_progress');
        expect(await bindingPrs(d.runId)).toHaveLength(1);
      };
      // the same number and branch name in another repository
      expect(await deliver(pull({ repo: 'public', action: 'closed', number: n, ref: d.publicBranch, merged: true, fullName: 'acme-corp/other-public' }))).toMatchObject({ applied: 'skipped' });
      // the right repository and number, another branch
      expect(await deliver(pull({ repo: 'public', action: 'closed', number: n, ref: 'fx/p-00000000-0000-4000-8000-000000000000', merged: true }))).toMatchObject({ applied: 'skipped' });
      // a fork of the public repository, and a deleted fork, on the child's public branch
      expect(await deliver(pull({ repo: 'public', action: 'opened', number: n, ref: d.publicBranch, headRepoId: 77 }))).toMatchObject({ applied: 'skipped' });
      expect(await deliver(pull({ repo: 'public', action: 'opened', number: n, ref: d.publicBranch, headRepoId: null }))).toMatchObject({ applied: 'skipped' });
      // a private pull request on the child's branch before any marker exists (any number, the bound one included), and a fork of the private repository with the child's branch name
      expect(await deliver(pull({ repo: 'private', action: 'opened', number: 88, ref: d.branch }))).toMatchObject({ applied: 'skipped' });
      expect(await deliver(pull({ repo: 'private', action: 'opened', number: n, ref: d.branch }))).toMatchObject({ applied: 'skipped' });
      expect(await deliver(pull({ repo: 'private', action: 'opened', number: 88, ref: d.branch, headRepoId: 77 }))).toMatchObject({ applied: 'skipped' });
      await noChange();
      // once the marker exists, a fork with the marked number and the child's branch name still maps nowhere, and so does a different number
      await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 3, 'plane.private_pr', $3::jsonb)`, [f.t.accountId, d.runId, JSON.stringify({ outcome: 'opened', pr: 88 })]);
      expect(await deliver(pull({ repo: 'private', action: 'opened', number: 88, ref: d.branch, headRepoId: 77 }))).toMatchObject({ applied: 'skipped' });
      expect(await deliver(pull({ repo: 'private', action: 'opened', number: 89, ref: d.branch }))).toMatchObject({ applied: 'skipped' });
      await noChange();
      // and the code-plane number never maps a PRIVATE pull request, even with the child's branch name
      expect(await deliver(pull({ repo: 'private', action: 'closed', number: n, ref: d.branch, merged: true }))).toMatchObject({ applied: 'skipped' });
      await noChange();
      // the marked private pull request itself still maps
      expect(await deliver(pull({ repo: 'private', action: 'opened', number: 88, ref: d.branch }))).toMatchObject({ applied: 'transitioned', workItemId: d.child });
    });

    it('S5b2c4-6(d): a paired child with a push row and a child.binding, but no binding_pr and no marker: a private opened event on its branch maps nowhere (the branch-only first match is off)', async () => {
      const g = await plannedFixture(admin, appUserPool, { dial: null, weeklyUsd: null });
      await admin.query('UPDATE work_items SET gh_number = 41, stage = $2 WHERE id = $1', [g.parent, 'in_progress']);
      await admin.query(`INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, $3, ARRAY['docs/ops/'])`, [g.t.repoId, g.t.accountId, PUBLIC]);
      const child = g.kids['api']!;
      const run = randomUUID();
      await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'production', 'running')`, [run, g.t.accountId, child]);
      await admin.query(`UPDATE work_items SET stage = 'in_progress' WHERE id = $1`, [child]);
      await withTenant(appUserPool, g.t.accountId, (c) => recordChildBranch(c, g.t.accountId, run, 'fx/41-api'));
      await withTenant(appUserPool, g.t.accountId, (c) => stampPlanePush(c, { accountId: g.t.accountId, workItemId: child, repoId: g.t.repoId }));
      const p = pull({ repo: 'private', action: 'opened', number: 61, ref: 'fx/41-api' });
      const out = await withTenant(appUserPool, g.t.accountId, (client) => applyMappedEvent(client, { ...ctxFor(p), accountId: g.t.accountId, repoId: g.t.repoId }, mapEvent('pull_request', p, { allowlist: [] })));
      expect(out).toMatchObject({ applied: 'skipped' });
      expect(await stageOf(child)).toBe('in_progress');
      expect(await bindingPrs(run)).toEqual([]);
    });

    it('a record the publish step never wrote (a push row with a number but no binding) maps nothing: the row alone is not the child\'s proof', async () => {
      const key = 'api';
      const g = await plannedFixture(admin, appUserPool, { dial: null, weeklyUsd: null });
      await admin.query('UPDATE work_items SET gh_number = 41, stage = $2 WHERE id = $1', [g.parent, 'in_progress']);
      await admin.query(`INSERT INTO repo_pairing (repo_id, account_id, code_repo, overlay_globs) VALUES ($1, $2, $3, ARRAY['docs/ops/'])`, [g.t.repoId, g.t.accountId, PUBLIC]);
      const child = g.kids[key]!;
      const row = (await withTenant(appUserPool, g.t.accountId, (c) => stampPlanePush(c, { accountId: g.t.accountId, workItemId: child, repoId: g.t.repoId })))!;
      await admin.query(`UPDATE plane_pushes SET state = 'pr_opened', head_sha = $2, tip_sha = $3, pr_number = 9, pr_url = $4 WHERE id = $1`, [row.id, 'e'.repeat(40), 'f'.repeat(40), `https://github.com/${PUBLIC}/pull/9`]);
      await admin.query(`UPDATE work_items SET stage = 'in_progress' WHERE id = $1`, [child]);
      const out = await withTenant(appUserPool, g.t.accountId, (client) => {
        const p = pull({ repo: 'public', action: 'closed', number: 9, ref: row.branch, merged: true });
        return applyMappedEvent(client, { ...ctxFor(p), accountId: g.t.accountId, repoId: g.t.repoId }, mapEvent('pull_request', p, { allowlist: [] }));
      });
      expect(out).toMatchObject({ applied: 'skipped' });
      expect(await stageOf(child)).toBe('in_progress');
    });
  });
});
