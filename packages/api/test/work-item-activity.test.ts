import { createHash, randomUUID } from 'node:crypto';
import { COPY } from '@fulcrumaxe/runner-protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { ACTIVITY_LIMITS, readOutcomeCodes } from '@fx/core/src/work-items/activity.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { activityResponseSchema, workItemActivityRoutes } from '../src/routes/work-item-activity.js';
import { seedAccountWithMember } from './helpers/seed.js';

const FX_SESSION_SECRET = 's'.repeat(32);

interface Activity {
  stage: string;
  repo: { owner: string; name: string } | null;
  issue_number: number | null;
  pr_number: number | null;
  auto_merge: boolean;
  comments: Array<{ role: string | null; body: string; created_at: string }>;
  comments_truncated: boolean;
  spec: { version: number; body: string } | null;
  runs: Array<{ id: string; role: string; status: string; usd: number | null; created_at: string; summary: string | null; lines: Array<{ at: string; text: string }> }>;
  runs_truncated: boolean;
  steps: Array<{ kind: string; state: string; code: string | null; result: string | null; reasons: string[]; at: string; finished_at: string | null }>;
  notice: { kind: 'not_feasible' | 'needs_human' | 'check_failed' | 'no_file_list' | 'respec_failed'; reason: string } | null;
  actions: string[];
  close_on_github: boolean;
}

/** D#483 P4: GET /api/v1/work-items/{id}/activity against real Postgres: what it reads, what it bounds, who may call it. */
describe('GET /api/v1/work-items/{id}/activity (D#483 P4)', { timeout: 60_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = FX_SESSION_SECRET;
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  async function get(id: string, identity: { userId: string; accountId: string }): Promise<Response> {
    const token = await signSession(identity);
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${token}` });
    return handleApiRequest(new Request(`http://localhost/api/v1/work-items/${id}/activity`, { headers }), appUserPool, platformOpsPool, ROUTES);
  }

  async function seedItem(accountId: string, opts: { autoMerge?: boolean; stage?: string; withRepo?: boolean } = {}) {
    const repoId = randomUUID();
    if (opts.withRepo !== false) {
      await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, settings) VALUES ($1, $2, $3, 'team', 'acme', 'docs', $4::jsonb)`, [
        repoId,
        accountId,
        Math.floor(Math.random() * 1e9),
        JSON.stringify(opts.autoMerge === undefined ? {} : { autoMerge: opts.autoMerge }),
      ]);
    }
    const itemId = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', $4, 42)`, [
      itemId,
      accountId,
      opts.withRepo === false ? null : repoId,
      opts.stage ?? 'pr_opened',
    ]);
    return { itemId, repoId };
  }

  async function seedDiscussion(accountId: string, itemId: string): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind)
       VALUES ($1, $2, $3, 'feature', 'A discussion', $4, 'internal', 'system')`,
      [id, accountId, Math.floor(Math.random() * 1e9), itemId],
    );
    await admin.query(`UPDATE work_items SET discussion_id = $1 WHERE id = $2`, [id, itemId]);
    return id;
  }

  async function seedRun(accountId: string, itemId: string, p: { role: string; status: string; usd?: number; envelope?: unknown; createdAt?: string; prNumber?: number }): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, usd, envelope, created_at, dispatch_pr_number)
       VALUES ($1, $2, $3, $4, 'production', $5, $6, $7::jsonb, COALESCE($8::timestamptz, now()), $9)`,
      [id, accountId, itemId, p.role, p.status, p.usd ?? null, p.envelope === undefined ? null : JSON.stringify(p.envelope), p.createdAt ?? null, p.prNumber ?? null],
    );
    return id;
  }

  async function seedComment(accountId: string, discussionId: string, p: { role: string; body: string; signed?: boolean; at: string; deleted?: boolean }) {
    const runId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, $3, 'production', 'succeeded')`, [runId, accountId, p.role]);
    await admin.query(
      `INSERT INTO discussion_comments (account_id, discussion_id, author_kind, role, agent_run_id, body, provenance, origin, system_signed, created_at, deleted_at)
       VALUES ($1, $2, 'agent', $3, $4, $5, 'internal', 'fx', $6, $7::timestamptz, $8)`,
      [accountId, discussionId, p.role, runId, p.body, p.signed !== false, p.at, p.deleted ? new Date() : null],
    );
  }

  async function seedEvent(accountId: string, runId: string, seq: number, kind: string, payload: Record<string, unknown>) {
    await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, $3, $4, $5::jsonb)`, [accountId, runId, seq, kind, JSON.stringify(payload)]);
  }

  it('registers one session-only member GET with a read rate class', () => {
    expect(workItemActivityRoutes).toHaveLength(1);
    const [route] = workItemActivityRoutes;
    expect(route!.method).toBe('GET');
    expect(route!.principals).toEqual(['session']);
    expect(route!.minRole).toBe('member');
    expect(route!.idempotency).toBe('never');
    expect(ROUTES).toContain(route);
  });

  it('an item with nothing recorded answers every empty state', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const { itemId } = await seedItem(accountId, { withRepo: false, stage: 'triaged' });
    const res = await get(itemId, { accountId, userId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Activity;
    expect(activityResponseSchema.parse(body)).toEqual(body);
    expect(body).toMatchObject({ stage: 'triaged', halted: false, repo: null, pr_number: null, auto_merge: false, comments: [], spec: null, runs: [], steps: [], runs_truncated: false, comments_truncated: false, notice: null });
  });

  it('halted is the marker, not the stage: true at triaged, discussing and spec_ready once halted, false again once the marker is cleared', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    for (const stage of ['triaged', 'discussing', 'spec_ready']) {
      const { itemId } = await seedItem(accountId, { withRepo: false, stage });
      expect(((await (await get(itemId, { accountId, userId })).json()) as Activity & { halted: boolean }).halted).toBe(false);
      await admin.query('UPDATE work_items SET halted_at = now(), halt_action_id = $2, halt_epoch = 1 WHERE id = $1', [itemId, randomUUID()]);
      const body = (await (await get(itemId, { accountId, userId })).json()) as Activity & { halted: boolean };
      expect(body).toMatchObject({ stage, halted: true });
      await admin.query('UPDATE work_items SET halted_at = NULL, halt_action_id = NULL WHERE id = $1', [itemId]);
      expect(((await (await get(itemId, { accountId, userId })).json()) as Activity & { halted: boolean }).halted).toBe(false);
    }
  });

  describe('notice: why the pipeline stopped (restored from the live driver)', () => {
    const noticeOf = async (accountId: string, userId: string, itemId: string) => {
      const res = await get(itemId, { accountId, userId });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Activity;
      expect(activityResponseSchema.parse(body)).toEqual(body);
      return body.notice;
    };

    it('not_feasible: the project manager\'s reason, read from its stored envelope, as plain text', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const { itemId } = await seedItem(accountId, { stage: 'triaged' });
      await seedRun(accountId, itemId, { role: 'project-manager', status: 'succeeded', createdAt: '2026-10-03T10:00:00Z', envelope: { feasible: false, reason: 'Needs a <b>database</b> this repo lacks.', summary: 'ignored here' } });
      expect(await noticeOf(accountId, userId, itemId)).toEqual({ kind: 'not_feasible', reason: 'Needs a <b>database</b> this repo lacks.' });
    });

    it('not_feasible: only the JSON false counts, a feasible run says nothing, and a Spec published afterwards clears it', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const { itemId } = await seedItem(accountId, { stage: 'triaged' });
      await seedRun(accountId, itemId, { role: 'project-manager', status: 'succeeded', createdAt: '2026-10-03T10:00:00Z', envelope: { feasible: 'false', reason: 'a string is not a verdict' } });
      await seedRun(accountId, itemId, { role: 'project-manager', status: 'succeeded', createdAt: '2026-10-03T10:05:00Z', envelope: { feasible: true, reason: '' } });
      expect(await noticeOf(accountId, userId, itemId)).toBeNull();
      await seedRun(accountId, itemId, { role: 'project-manager', status: 'succeeded', createdAt: '2026-10-03T10:10:00Z', envelope: { feasible: false, reason: 'Too vague.' } });
      expect(await noticeOf(accountId, userId, itemId)).toEqual({ kind: 'not_feasible', reason: 'Too vague.' });
      await admin.query(
        `INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind, created_at) VALUES ($1, $2, 1, 'spec', $3, 'system', '2026-10-03T11:00:00Z')`,
        [accountId, itemId, createHash('sha256').update('spec').digest('hex')],
      );
      expect(await noticeOf(accountId, userId, itemId)).toBeNull();
    });

    it('needs_human: the newest executor run\'s own summary, only while the item is at needs_human', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const { itemId } = await seedItem(accountId, { stage: 'needs_human' });
      await seedRun(accountId, itemId, { role: 'executor', status: 'succeeded', createdAt: '2026-10-03T09:00:00Z', envelope: { summary: 'An older account.' } });
      await seedRun(accountId, itemId, { role: 'executor', status: 'succeeded', createdAt: '2026-10-03T10:00:00Z', envelope: { summary: 'The Spec asks for a file that cannot exist, so I opened no pull request.' } });
      expect(await noticeOf(accountId, userId, itemId)).toEqual({ kind: 'needs_human', reason: 'The Spec asks for a file that cannot exist, so I opened no pull request.' });
      await admin.query(`UPDATE work_items SET stage = 'in_progress' WHERE id = $1`, [itemId]);
      expect(await noticeOf(accountId, userId, itemId)).toBeNull();
    });

    it('needs_human: a run with no summary gets a fixed sentence naming its status; no run at all gets the general one', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const { itemId } = await seedItem(accountId, { stage: 'needs_human' });
      expect(await noticeOf(accountId, userId, itemId)).toEqual({ kind: 'needs_human', reason: 'The pipeline stopped and needs a person.' });
      await seedRun(accountId, itemId, { role: 'executor', status: 'timed_out', createdAt: '2026-10-03T10:00:00Z' });
      expect(await noticeOf(accountId, userId, itemId)).toEqual({ kind: 'needs_human', reason: 'The executor run timed out without a pull request.' });
    });

    it('check_failed: at in_progress, the newest recorded stop of Check the build gives a fixed sentence; any other code, or a later stage, gives none', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const { itemId } = await seedItem(accountId, { stage: 'in_progress' });
      const stop = (code: string, key: string) =>
        admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, dedupe_key) VALUES ($1, $2, 'stopped', $3, $4)`, [accountId, itemId, code, key]);
      expect(await noticeOf(accountId, userId, itemId)).toBeNull();
      await stop('check_build_unavailable', 'a');
      expect(await noticeOf(accountId, userId, itemId)).toEqual({ kind: 'check_failed', reason: "Couldn't check the build right now. Try again in a moment." });
      await stop('check_build_ambiguous', 'b');
      expect((await noticeOf(accountId, userId, itemId))!.reason).toMatch(/More than one open pull request/);
      await stop('constructor', 'c'); // a newer stop that is not ours: no sentence, and no prototype lookup
      expect(await noticeOf(accountId, userId, itemId)).toBeNull();
      await stop('check_build_unavailable', 'd');
      await admin.query(`UPDATE work_items SET stage = 'pr_opened' WHERE id = $1`, [itemId]);
      expect(await noticeOf(accountId, userId, itemId)).toBeNull();
    });

    it('check_failed is bound to the current attempt: it shows when nothing has happened since, and not once a new build has started', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const { itemId } = await seedItem(accountId, { stage: 'in_progress' });
      const moveIn = (ref: string) =>
        admin.query(
          `INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'spec_ready', 'in_progress', now(), 'control_plane', $3)`,
          [accountId, itemId, ref],
        );
      const stop = (key: string) =>
        admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, dedupe_key) VALUES ($1, $2, 'stopped', 'check_build_unavailable', $3)`, [accountId, itemId, key]);
      await moveIn('first-build');
      await stop('s1');
      // The check failed and nothing has happened since: shown.
      expect((await noticeOf(accountId, userId, itemId))!.kind).toBe('check_failed');
      // A new build starts (the item moves into in_progress again): the old failed check is not shown.
      await moveIn('second-build');
      expect(await noticeOf(accountId, userId, itemId)).toBeNull();
      // A failed check of THIS attempt shows again.
      await stop('s2');
      expect((await noticeOf(accountId, userId, itemId))!.kind).toBe('check_failed');
      // While any run of the item is live (a review or a build is going on), it is hidden.
      const live = await seedRun(accountId, itemId, { role: 'code-reviewer', status: 'running' });
      expect(await noticeOf(accountId, userId, itemId)).toBeNull();
      await admin.query(`UPDATE agent_runs SET status = 'succeeded' WHERE id = $1`, [live]);
      expect((await noticeOf(accountId, userId, itemId))!.kind).toBe('check_failed');
    });

    it('a token-shaped string in a PM reason, an executor notice or a run summary comes back redacted (the fixture is built at runtime)', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      // Built at runtime so no literal credential shape sits in the source.
      const token = ['sk', 'ant', 'api03'].join('-') + '-' + 'A1b2C3d4E5f6G7h8I9j0'.repeat(3);
      const ghToken = 'gh' + 'p_' + 'Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8';
      const { itemId } = await seedItem(accountId, { stage: 'needs_human' });
      await seedRun(accountId, itemId, { role: 'project-manager', status: 'succeeded', createdAt: '2026-10-03T09:00:00Z', envelope: { feasible: false, reason: `Not buildable; the env had ${token}.` } });
      await seedRun(accountId, itemId, { role: 'executor', status: 'succeeded', createdAt: '2026-10-03T10:00:00Z', envelope: { summary: `Stopped. I saw ${ghToken} in the log.` } });
      const res = await get(itemId, { accountId, userId });
      const raw = await res.text();
      expect(raw).not.toContain(token);
      expect(raw).not.toContain(ghToken);
      const body = JSON.parse(raw) as Activity;
      expect(body.notice!.reason).toContain('Not buildable; the env had ');
      expect(body.runs.find((r) => r.role === 'executor')!.summary).toContain('Stopped. I saw ');
      // The needs_human notice is redacted too (the PM verdict above is superseded by a Spec).
      await admin.query(
        `INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind, created_at) VALUES ($1, $2, 1, 'spec', $3, 'system', '2026-10-03T11:00:00Z')`,
        [accountId, itemId, createHash('sha256').update('spec').digest('hex')],
      );
      const again = await (await get(itemId, { accountId, userId })).text();
      expect(again).not.toContain(ghToken);
      expect((JSON.parse(again) as Activity).notice).toMatchObject({ kind: 'needs_human' });
    });

    it('the reason is cut to its cap', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const { itemId } = await seedItem(accountId, { stage: 'needs_human' });
      await seedRun(accountId, itemId, { role: 'executor', status: 'succeeded', envelope: { summary: 'x'.repeat(5000) } });
      const n = await noticeOf(accountId, userId, itemId);
      expect(n!.reason.length).toBeLessThanOrEqual(ACTIVITY_LIMITS.maxNoticeChars);
    });
  });

  describe('pr_number: the real pull request, never the issue the build was keyed on', () => {
    const prOf = async (accountId: string, userId: string, itemId: string) => ((await (await get(itemId, { accountId, userId })).json()) as Activity).pr_number;

    it('an executor run holds the ISSUE number as its dispatch target (42 here): a reviewer\'s target (58) is the pull request, even when the executor run is newer', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const { itemId } = await seedItem(accountId, { stage: 'review_passed' });
      await seedRun(accountId, itemId, { role: 'code-reviewer', status: 'succeeded', createdAt: '2026-10-03T10:00:00Z', prNumber: 58 });
      await seedRun(accountId, itemId, { role: 'executor', status: 'succeeded', createdAt: '2026-10-03T11:00:00Z', prNumber: 42 });
      expect(await prOf(accountId, userId, itemId)).toBe(58);
    });

    it('with only executor runs, their issue-number dispatch target is not a pull request; the envelope\'s report is', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const { itemId } = await seedItem(accountId, { stage: 'pr_opened' });
      await seedRun(accountId, itemId, { role: 'executor', status: 'succeeded', createdAt: '2026-10-03T10:00:00Z', prNumber: 42 });
      expect(await prOf(accountId, userId, itemId)).toBeNull();
      await seedRun(accountId, itemId, { role: 'executor', status: 'succeeded', createdAt: '2026-10-03T11:00:00Z', prNumber: 42, envelope: { pr_number: 57 } });
      expect(await prOf(accountId, userId, itemId)).toBe(57);
    });
  });

  it('reads the signed comments, the newest Spec, the runs oldest first with summary and lines, the steps and the real auto-merge setting', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const { itemId } = await seedItem(accountId, { autoMerge: true, stage: 'review_passed' });
    const discussionId = await seedDiscussion(accountId, itemId);
    await seedComment(accountId, discussionId, { role: 'technical-architect', body: 'Round one view', at: '2026-10-03T09:00:00Z' });
    await seedComment(accountId, discussionId, { role: 'technical-architect', body: 'Challenge view', at: '2026-10-03T09:10:00Z' });
    await seedComment(accountId, discussionId, { role: 'product-owner', body: 'Not signed by the system', signed: false, at: '2026-10-03T09:05:00Z' });
    await seedComment(accountId, discussionId, { role: 'security-expert', body: 'Deleted comment', at: '2026-10-03T09:06:00Z', deleted: true });
    for (const [version, text] of [[1, 'old spec'], [2, 'new spec']] as const) {
      await admin.query(`INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, $3, $4, $5, 'system')`, [
        accountId,
        itemId,
        version,
        text,
        createHash('sha256').update(text).digest('hex'),
      ]);
    }
    const exec = await seedRun(accountId, itemId, { role: 'executor', status: 'succeeded', usd: 1.25, createdAt: '2026-10-03T10:00:00Z', envelope: { summary: 'Built it.', pr_number: 57 } });
    const reviewer = await seedRun(accountId, itemId, { role: 'code-reviewer', status: 'running', createdAt: '2026-10-03T11:00:00Z', prNumber: 58 });
    await seedEvent(accountId, reviewer, 1, 'run.status_changed', { to: 'running' });
    await seedEvent(accountId, reviewer, 2, 'agent.activity', { tool: 'read', path: 'src/a.ts' });
    await seedEvent(accountId, reviewer, 3, 'agent.activity', { tool: 'command', command: 'git diff --stat' });
    await seedEvent(accountId, reviewer, 4, 'agent.activity', { tool: 'test', command: 'pnpm vitest run' });
    await seedEvent(accountId, reviewer, 5, 'agent.activity', { tool: 'command' }); // kind only: the fixed template
    await seedEvent(accountId, reviewer, 6, 'agent.output', { text: 'model words that must never appear' });
    await admin.query(
      `INSERT INTO run_action_requests (account_id, kind, target_id, requested_by, principal_kind, request_hash, state, outcome, finished_at)
       VALUES ($1, 'continue_work_item', $2, 'user:x', 'session', 'h1', 'done', $3::jsonb, now())`,
      [accountId, itemId, JSON.stringify({ outcome: 'ready_human_merges', reasons: ['ci_not_green', 'Not A Code', 'auto_merge_not_allowed'], note: 'free text must be ignored' })],
    );

    const res = await get(itemId, { accountId, userId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Activity;
    expect(activityResponseSchema.parse(body)).toEqual(body);
    expect(body.stage).toBe('review_passed');
    expect(body.repo).toEqual({ owner: 'acme', name: 'docs' });
    expect(body.issue_number).toBe(42);
    expect(body.auto_merge).toBe(true);
    expect(body.pr_number).toBe(58); // the newest run that names a PR
    expect(body.comments.map((c) => [c.role, c.body])).toEqual([
      ['technical-architect', 'Round one view'],
      ['technical-architect', 'Challenge view'],
    ]);
    expect(body.spec).toEqual({ version: 2, body: 'new spec' });
    expect(body.runs.map((r) => [r.role, r.status])).toEqual([['executor', 'succeeded'], ['code-reviewer', 'running']]);
    expect(body.runs[0]).toMatchObject({ id: exec, usd: 1.25, summary: 'Built it.', lines: [] });
    expect(body.runs[1]!.summary).toBeNull();
    expect(body.runs[1]!.lines.map((l) => l.text)).toEqual([
      'The run started',
      'Reading src/a.ts',
      'Ran: git diff --stat',
      'Ran tests: pnpm vitest run',
      'Running a command',
    ]);
    expect(JSON.stringify(body)).not.toContain('model words');
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0]).toMatchObject({ kind: 'continue_work_item', state: 'done', result: 'ready_human_merges', reasons: ['ci_not_green', 'auto_merge_not_allowed'] });
    expect(JSON.stringify(body)).not.toContain('free text');
  });

  it('auto_merge is false unless the repo setting is exactly true', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const off = await seedItem(accountId, { autoMerge: false });
    const unset = await seedItem(accountId);
    for (const { itemId } of [off, unset]) {
      const body = (await (await get(itemId, { accountId, userId })).json()) as Activity;
      expect(body.auto_merge).toBe(false);
    }
    const stringy = await seedItem(accountId);
    await admin.query(`UPDATE repos SET settings = '{"autoMerge":"true"}'::jsonb WHERE id = $1`, [stringy.repoId]);
    expect(((await (await get(stringy.itemId, { accountId, userId })).json()) as Activity).auto_merge).toBe(false);
    // External work follows the gate's rule: on only when the external guard is switched off with the boolean false.
    const external = await seedItem(accountId, { autoMerge: true });
    await admin.query(`UPDATE work_items SET provenance = 'external' WHERE id = $1`, [external.itemId]);
    expect(((await (await get(external.itemId, { accountId, userId })).json()) as Activity).auto_merge).toBe(false);
    await admin.query(`UPDATE repos SET settings = '{"autoMerge":true,"blockExternalAutoMerge":false}'::jsonb WHERE id = $1`, [external.repoId]);
    expect(((await (await get(external.itemId, { accountId, userId })).json()) as Activity).auto_merge).toBe(true);
  });

  it('never shows a stored command that holds a credentialed URL, a placeholder or a control character', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const { itemId } = await seedItem(accountId);
    const run = await seedRun(accountId, itemId, { role: 'executor', status: 'running' });
    await seedEvent(accountId, run, 1, 'agent.activity', { tool: 'command', command: 'git push https://x:y@github.com/o/r' });
    await seedEvent(accountId, run, 2, 'agent.activity', { tool: 'command', command: 'echo [redacted]' });
    await seedEvent(accountId, run, 3, 'agent.activity', { tool: 'command', command: 'ls\u0007' });
    await seedEvent(accountId, run, 4, 'agent.activity', { tool: 'command', command: 'z'.repeat(250) });
    await seedEvent(accountId, run, 5, 'agent.activity', { tool: 'command', command: ['curl', '--user', 'admin:hunter2', 'https://example.test'].join(' ') });
    await seedEvent(accountId, run, 6, 'agent.activity', { tool: 'command', command: 'mysql -u root -phunter2 db' });
    await seedEvent(accountId, run, 7, 'agent.activity', { tool: 'command', command: 'mkdir -p out' });
    const body = (await (await get(itemId, { accountId, userId })).json()) as Activity;
    expect(body.runs[0]!.lines.map((l) => l.text)).toEqual([...Array(6).fill('Running a command'), 'Ran: mkdir -p out']);
    expect(JSON.stringify(body)).not.toContain('hunter2');
  });

  it('bounds the lists and the texts', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const { itemId } = await seedItem(accountId);
    const discussionId = await seedDiscussion(accountId, itemId);
    for (let i = 0; i < ACTIVITY_LIMITS.maxComments + 5; i++) {
      await seedComment(accountId, discussionId, { role: `role-${i}`, body: i === 0 ? 'x'.repeat(9000) : `comment ${i}`, at: new Date(Date.UTC(2026, 9, 3, 9, 0, i)).toISOString() });
    }
    const longSpec = 'S'.repeat(30000);
    await admin.query(`INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, $3, $4, 'system')`, [
      accountId,
      itemId,
      longSpec,
      createHash('sha256').update(longSpec).digest('hex'),
    ]);
    const runIds: string[] = [];
    for (let i = 0; i < ACTIVITY_LIMITS.maxRuns + 4; i++) {
      runIds.push(await seedRun(accountId, itemId, { role: 'executor', status: 'succeeded', createdAt: new Date(Date.UTC(2026, 9, 3, 10, 0, i)).toISOString(), envelope: { summary: 'Y'.repeat(6000) } }));
    }
    for (let s = 1; s <= 260; s++) await seedEvent(accountId, runIds[runIds.length - 1]!, s, 'agent.activity', { tool: 'read', path: `src/f${s}.ts` });

    const body = (await (await get(itemId, { accountId, userId })).json()) as Activity;
    expect(body.comments).toHaveLength(ACTIVITY_LIMITS.maxComments);
    expect(body.comments_truncated).toBe(true);
    // The newest comments are kept, in time order: the 9000-character one (the oldest) fell off.
    expect(body.comments.every((c) => c.body.length <= ACTIVITY_LIMITS.maxCommentChars)).toBe(true);
    expect(body.spec!.body.length).toBe(ACTIVITY_LIMITS.maxSpecChars);
    expect(body.spec!.body.endsWith('…')).toBe(true);
    expect(body.runs).toHaveLength(ACTIVITY_LIMITS.maxRuns);
    expect(body.runs_truncated).toBe(true);
    expect(body.runs.every((r) => (r.summary ?? '').length <= ACTIVITY_LIMITS.maxSummaryChars)).toBe(true);
    // Oldest first among the newest N: the last one is the newest run, and carries a bounded feed.
    expect(body.runs[body.runs.length - 1]!.id).toBe(runIds[runIds.length - 1]);
    expect(body.runs[body.runs.length - 1]!.lines.length).toBeLessThanOrEqual(30);
    expect(body.runs[0]!.id).toBe(runIds[4]);
  });

  it('answers 404 for an unknown id, a malformed id and another account\'s item', async () => {
    const a = await seedAccountWithMember(admin);
    const b = await seedAccountWithMember(admin);
    const { itemId } = await seedItem(b.accountId);
    for (const id of [randomUUID(), 'not-a-uuid', itemId]) {
      const res = await get(id, a);
      expect(res.status, id).toBe(404);
    }
  });

  describe('actions: what the CALLER may do now, from the same table the action routes ask', () => {
    async function seedSpec(accountId: string, itemId: string) {
      await admin.query(`INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, 'spec', $3, 'system')`, [accountId, itemId, createHash('sha256').update('spec').digest('hex')]);
    }
    const actionsOf = async (accountId: string, userId: string, itemId: string) => {
      const body = (await (await get(itemId, { accountId, userId })).json()) as Activity;
      expect(activityResponseSchema.parse(body)).toEqual(body);
      return { actions: body.actions, onGithub: body.close_on_github };
    };

    it.each(['owner', 'admin'] as const)('an %s at Needs a person with a published feature Spec that has no file list is offered Build again, Re-spec, Back to discussion and Close', async (role) => {
      const { accountId, userId } = await seedAccountWithMember(admin, { role });
      const { itemId } = await seedItem(accountId, { stage: 'needs_human' });
      await seedDiscussion(accountId, itemId);
      await seedSpec(accountId, itemId);
      expect(await actionsOf(accountId, userId, itemId)).toEqual({ actions: ['build_again', 'respec', 'back_to_discussion', 'close'], onGithub: false });
    });

    it('Re-spec goes once the newest Spec version stores a readable list, and comes back if that version is erased and the one before has none', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, { role: 'owner' });
      const { itemId } = await seedItem(accountId, { stage: 'needs_human' });
      await seedDiscussion(accountId, itemId);
      await seedSpec(accountId, itemId);
      expect((await actionsOf(accountId, userId, itemId)).actions).toContain('respec');
      await admin.query(`INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind, frontmatter) VALUES ($1, $2, 2, 'spec 2', $3, 'system', '{"acceptance_files":["src/**"]}'::jsonb)`, [accountId, itemId, createHash('sha256').update('spec 2').digest('hex')]);
      expect((await actionsOf(accountId, userId, itemId)).actions).toEqual(['build_again', 'back_to_discussion', 'close']);
      await admin.query(`UPDATE spec_versions SET erased_at = now() WHERE work_item_id = $1 AND version = 2`, [itemId]);
      expect((await actionsOf(accountId, userId, itemId)).actions).toContain('respec');
    });

    it('Re-spec at Spec ready: offered with Close for a Spec with no list', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, { role: 'owner' });
      const { itemId } = await seedItem(accountId, { stage: 'spec_ready' });
      await seedDiscussion(accountId, itemId);
      await seedSpec(accountId, itemId);
      expect((await actionsOf(accountId, userId, itemId)).actions).toEqual(['respec', 'close']);
    });

    it('a plain member is offered nothing, at any stage', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, { role: 'member' });
      const { itemId } = await seedItem(accountId, { stage: 'needs_human' });
      await seedDiscussion(accountId, itemId);
      await seedSpec(accountId, itemId);
      expect(await actionsOf(accountId, userId, itemId)).toEqual({ actions: [], onGithub: false });
      await admin.query(`UPDATE work_items SET stage = 'pr_opened' WHERE id = $1`, [itemId]);
      expect(await actionsOf(accountId, userId, itemId)).toEqual({ actions: [], onGithub: false });
    });

    it('a discussing project is offered Treat as a feature and Close; once it is a feature, only Close', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, { role: 'owner' });
      const { itemId } = await seedItem(accountId, { stage: 'discussing' });
      const d = await seedDiscussion(accountId, itemId);
      await admin.query(`UPDATE discussions SET kind = 'project' WHERE id = $1`, [d]);
      expect((await actionsOf(accountId, userId, itemId)).actions).toEqual(['treat_as_feature', 'close']);
      await admin.query(`UPDATE discussions SET kind = 'feature' WHERE id = $1`, [d]);
      expect((await actionsOf(accountId, userId, itemId)).actions).toEqual(['close']);
    });

    it('a pull request stage offers no Close, and says to close the pull request on GitHub (to an owner or admin only)', async () => {
      const owner = await seedAccountWithMember(admin, { role: 'owner' });
      for (const stage of ['pr_opened', 'changes_requested', 'review_passed']) {
        const { itemId } = await seedItem(owner.accountId, { stage });
        expect(await actionsOf(owner.accountId, owner.userId, itemId), stage).toEqual({ actions: [], onGithub: true });
      }
      const { itemId: merged } = await seedItem(owner.accountId, { stage: 'merged' });
      expect(await actionsOf(owner.accountId, owner.userId, merged)).toEqual({ actions: [], onGithub: false });
    });

    it('a live run hides every action; a finished one does not', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, { role: 'owner' });
      const { itemId } = await seedItem(accountId, { stage: 'in_progress' });
      expect((await actionsOf(accountId, userId, itemId)).actions).toEqual(['close']);
      const run = await seedRun(accountId, itemId, { role: 'executor', status: 'running' });
      expect((await actionsOf(accountId, userId, itemId)).actions).toEqual([]);
      await admin.query(`UPDATE agent_runs SET status = 'failed' WHERE id = $1`, [run]);
      expect((await actionsOf(accountId, userId, itemId)).actions).toEqual(['close']);
    });

    it('an external item is offered nothing', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, { role: 'owner' });
      const { itemId } = await seedItem(accountId, { stage: 'needs_human' });
      await admin.query(`UPDATE work_items SET provenance = 'external' WHERE id = $1`, [itemId]);
      expect(await actionsOf(accountId, userId, itemId)).toEqual({ actions: [], onGithub: false });
    });

    it('an item with no repository can still be closed, but not built again or sent back', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, { role: 'owner' });
      const { itemId } = await seedItem(accountId, { stage: 'needs_human', withRepo: false });
      await seedDiscussion(accountId, itemId);
      await seedSpec(accountId, itemId);
      expect((await actionsOf(accountId, userId, itemId)).actions).toEqual(['close']);
    });

    it('Build again that stopped at an open pull request (or could not check) says so at Needs a person, but only for a stop since the item reached it', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, { role: 'owner' });
      const { itemId } = await seedItem(accountId, { stage: 'needs_human' });
      const stop = (code: string, key: string) =>
        admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, dedupe_key) VALUES ($1, $2, 'stopped', $3, $4)`, [accountId, itemId, code, key]);
      const noticeNow = async () => ((await (await get(itemId, { accountId, userId })).json()) as Activity).notice;
      // A stop from before the item reached Needs a person does not count.
      await stop('rebuild_pr_open', 'old');
      await admin.query(`INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'in_progress', 'needs_human', now(), 'control_plane', 'later')`, [accountId, itemId]);
      expect((await noticeNow())!.kind).toBe('needs_human');
      await stop('rebuild_pr_open', 'new');
      expect(await noticeNow()).toEqual({ kind: 'check_failed', reason: "A pull request is still open for this issue's branch, so the build was not started again. Close that pull request on GitHub, then press Build again." });
      await stop('rebuild_check_unavailable', 'newer');
      expect((await noticeNow())!.reason).toMatch(/Couldn't check for an open pull request/);
    });

    it("after Back to discussion only the new panel's comments are shown, so the old panel is not read as its challenge round", async () => {
      const { accountId, userId } = await seedAccountWithMember(admin, { role: 'owner' });
      const { itemId } = await seedItem(accountId, { stage: 'discussing' });
      const d = await seedDiscussion(accountId, itemId);
      await seedComment(accountId, d, { role: 'technical-architect', body: 'old panel', at: '2020-01-01T00:00:00Z' });
      await seedComment(accountId, d, { role: 'technical-architect', body: 'new panel', at: '2099-01-01T00:00:00Z' });
      const read = async () => ((await (await get(itemId, { accountId, userId })).json()) as Activity).comments.map((c) => c.body);
      expect(await read()).toEqual(['old panel', 'new panel']);
      await admin.query(
        `INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'needs_human', 'discussing', now(), 'control_plane', 'back_to_discussion:test')`,
        [accountId, itemId],
      );
      await admin.query(`UPDATE discussion_comments SET created_at = now() + interval '1 hour' WHERE body = 'new panel'`);
      expect(await read()).toEqual(['new panel']);
    });
  });

  it('refuses a request with no session', async () => {
    const res = await handleApiRequest(new Request(`http://localhost/api/v1/work-items/${randomUUID()}/activity`), appUserPool, platformOpsPool, ROUTES);
    expect(res.status).toBe(401);
  });
  /** D#6 R4d-5b (C34 sections 2.3 and 2.4, F12): the notice says what is wrong in the runner protocol's own words, in both states. */
  describe('Re-spec notices: the file-list sentences come from the runner protocol copy', () => {
    async function seedPreFix(accountId: string, itemId: string, createdAt = '2026-10-03T08:00:00Z') {
      await admin.query(`INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind, created_at) VALUES ($1, $2, 1, 'spec', $3, 'system', $4)`, [accountId, itemId, createHash('sha256').update('spec').digest('hex'), createdAt]);
    }
    const noticeNow = async (accountId: string, userId: string, itemId: string) => {
      const body = (await (await get(itemId, { accountId, userId })).json()) as Activity;
      expect(activityResponseSchema.parse(body)).toEqual(body);
      return body.notice;
    };
    const fact = (accountId: string, itemId: string, kind: string, code: string, key: string) =>
      admin.query(`INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, dedupe_key) VALUES ($1, $2, $3, $4, $5)`, [accountId, itemId, kind, code, key]);

    it('Spec ready: a build refused for the missing list shows exactly specHasNoFileList; a Spec with a list, or a refusal from before the Spec, shows none', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const { itemId } = await seedItem(accountId, { stage: 'spec_ready' });
      await seedPreFix(accountId, itemId);
      expect(await noticeNow(accountId, userId, itemId)).toBeNull();
      await fact(accountId, itemId, 'build_refused', 'spec_has_no_file_list', 'b1');
      expect(await noticeNow(accountId, userId, itemId)).toEqual({ kind: 'no_file_list', reason: COPY.specHasNoFileList });
      await admin.query(`INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind, frontmatter) VALUES ($1, $2, 2, 'spec', $3, 'system', '{"acceptance_files":["src/**"]}'::jsonb)`, [accountId, itemId, createHash('sha256').update('spec').digest('hex')]);
      expect(await noticeNow(accountId, userId, itemId)).toBeNull();
    });

    it('Needs a person: a run that ended scope_unknown with the detail no_file_list shows exactly specHasNoFileList; the detail-less scope_unknown does not', async () => {
      const { accountId, userId } = await seedAccountWithMember(admin);
      const { itemId } = await seedItem(accountId, { stage: 'needs_human' });
      await seedPreFix(accountId, itemId);
      const runId = await seedRun(accountId, itemId, { role: 'executor', status: 'failed', createdAt: '2026-10-03T10:00:00Z', envelope: { summary: 'The executor says so.' } });
      const event = (detail?: string) =>
        admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, COALESCE((SELECT max(seq) + 1 FROM run_events WHERE run_id = $2), 1), 'run.status_changed', $3::jsonb)`, [accountId, runId, JSON.stringify({ to: 'failed', failureReason: 'scope_unknown', ...(detail ? { detail } : {}) })]);
      await event();
      expect(await noticeNow(accountId, userId, itemId)).toMatchObject({ kind: 'needs_human' });
      await event('no_file_list');
      expect(await noticeNow(accountId, userId, itemId)).toEqual({ kind: 'no_file_list', reason: COPY.specHasNoFileList });
    });

    it('F10: after a Re-spec whose list could not be read the notice is exactly respecListUnreadable, at both stages, and it goes when a new version is published', async () => {
      for (const stage of ['spec_ready', 'needs_human']) {
        const { accountId, userId } = await seedAccountWithMember(admin);
        const { itemId } = await seedItem(accountId, { stage });
        await seedPreFix(accountId, itemId);
        await fact(accountId, itemId, 'build_refused', 'spec_has_no_file_list', 'b1');
        await fact(accountId, itemId, 'stopped', 'respec_list_unreadable', 'respec:1');
        expect(await noticeNow(accountId, userId, itemId), stage).toEqual({ kind: 'respec_failed', reason: COPY.respecListUnreadable });
        await admin.query(`INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind, frontmatter) VALUES ($1, $2, 2, 'spec', $3, 'system', '{"acceptance_files":["src/**"]}'::jsonb)`, [accountId, itemId, createHash('sha256').update('spec').digest('hex')]);
        expect(await noticeNow(accountId, userId, itemId), stage).not.toMatchObject({ kind: 'respec_failed' });
      }
    });

    it('the exact words are the ones the issue gave', () => {
      expect(COPY.specHasNoFileList).toBe("This Spec has no file list, so the platform cannot check the agent's changes and will not open a pull request. Re-spec to have the project manager add the list (the Spec's text stays the same), then Build again.");
      expect(COPY.respecListUnreadable).toBe("The project manager's file list for this Spec could not be read, so nothing was changed. Re-spec to try again.");
    });
  });

});

describe('readOutcomeCodes', () => {
  it('keeps only plain codes, at most ten reasons, and reads outcome or advance', () => {
    expect(readOutcomeCodes({ outcome: 'merged' })).toEqual({ result: 'merged', reasons: [] });
    expect(readOutcomeCodes({ advance: 'started' })).toEqual({ result: 'started', reasons: [] });
    expect(readOutcomeCodes({ outcome: 'Free Text!', reasons: ['ok_code', 5, 'Bad Code', null, 'x'.repeat(80)] })).toEqual({ result: null, reasons: ['ok_code'] });
    expect(readOutcomeCodes({ reasons: Array.from({ length: 30 }, (_, i) => `code_${i}`) }).reasons).toHaveLength(ACTIVITY_LIMITS.maxReasons);
    for (const bad of [null, undefined, 'merged', 7, ['merged']]) expect(readOutcomeCodes(bad)).toEqual({ result: null, reasons: [] });
  });
});
