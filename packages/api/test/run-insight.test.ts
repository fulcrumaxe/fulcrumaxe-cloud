import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { ACTIVITY_LIMITS } from '@fx/core/src/work-items/activity.js';
import { INSIGHT_LIMITS, type RunInsight } from '@fx/core/src/runs/insight.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { runInsightResponseSchema, runInsightRoutes } from '../src/routes/run-insight.js';
import { seedAccountWithMember } from './helpers/seed.js';

const FX_SESSION_SECRET = 's'.repeat(32);

/** D#483 P5: GET /api/v1/runs/{id}/insight against real Postgres: what it reads, what it bounds, who may call it. */
describe('GET /api/v1/runs/{id}/insight (D#483 P5)', { timeout: 60_000 }, () => {
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
    return handleApiRequest(new Request(`http://localhost/api/v1/runs/${id}/insight`, { headers }), appUserPool, platformOpsPool, ROUTES);
  }

  async function seedItem(accountId: string): Promise<string> {
    const repoId = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, settings) VALUES ($1, $2, $3, 'team', 'acme', 'docs', '{}'::jsonb)`, [
      repoId,
      accountId,
      Math.floor(Math.random() * 1e9),
    ]);
    const itemId = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', 'pr_opened', 42)`, [itemId, accountId, repoId]);
    return itemId;
  }

  async function seedRun(
    accountId: string,
    p: { role: string; status: string; itemId?: string | null; envelope?: unknown; usd?: number; model?: string; head?: string; parent?: string; prNumber?: number; startedAt?: string; endedAt?: string },
  ): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, envelope, usd, tokens_in, tokens_out, model, head_sha, parent_run_id, dispatch_pr_number, started_at, ended_at)
       VALUES ($1, $2, $3, $4, 'production', $5, $6::jsonb, $7, 1000, 200, $8, $9, $10, $11, $12::timestamptz, $13::timestamptz)`,
      [id, accountId, p.itemId ?? null, p.role, p.status, p.envelope === undefined ? null : JSON.stringify(p.envelope), p.usd ?? null, p.model ?? null, p.head ?? null, p.parent ?? null, p.prNumber ?? null, p.startedAt ?? null, p.endedAt ?? null],
    );
    return id;
  }

  const seedEvent = (accountId: string, runId: string, seq: number, kind: string, payload: Record<string, unknown>) =>
    admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, $3, $4, $5::jsonb)`, [accountId, runId, seq, kind, JSON.stringify(payload)]);
  const seedLedger = (accountId: string, runId: string, kind: 'model' | 'compute', source: string, usd: number) =>
    admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, $2, $3, $4, $5, CASE WHEN $2 = 'model' THEN 'model' ELSE 'foreground_compute' END)`, [accountId, kind, source, usd, runId]);

  it('registers one session-only member GET with a read rate class', () => {
    expect(runInsightRoutes).toHaveLength(1);
    const [route] = runInsightRoutes;
    expect(route!.method).toBe('GET');
    expect(route!.principals).toEqual(['session']);
    expect(route!.minRole).toBe('member');
    expect(route!.idempotency).toBe('never');
    expect(ROUTES).toContain(route);
  });

  it('a bare running run with no item and no envelope answers every empty state', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const id = await seedRun(accountId, { role: 'executor', status: 'running', startedAt: '2026-10-03T10:00:00Z' });
    const res = await get(id, { accountId, userId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as RunInsight;
    expect(runInsightResponseSchema.parse(body)).toEqual(body);
    expect(body).toMatchObject({
      work_item: null,
      pr_number: null,
      outcome: null,
      lines: [],
      lines_truncated: false,
      parent: null,
      escalated_from: null,
      children: [],
      cost: { model: { source: null }, compute: { usd: null, source: null } },
    });
    expect(body.run).toMatchObject({ role: 'executor', status: 'running', ended_at: null, model: null, head_sha: null });
    expect(body.limits.max_run_minutes).toBe(60); // the default: nothing set for this account
  });

  it('reads a reviewer: verdict, findings, summary, the customer-key model cost, compute, lines, facts and links', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const itemId = await seedItem(accountId);
    const parent = await seedRun(accountId, { role: 'code-reviewer', status: 'failed', itemId });
    const id = await seedRun(accountId, {
      role: 'code-reviewer',
      status: 'succeeded',
      itemId,
      parent,
      model: 'sonnet-5',
      head: '9b708c17e4a1d2f3a4b5c6d7e8f901234567abcd',
      prNumber: 57,
      usd: 1.5,
      startedAt: '2026-10-03T10:00:00Z',
      endedAt: '2026-10-03T10:12:30Z',
      envelope: {
        summary: 'Two problems.',
        verdict: 'needs-fix',
        findings: ['First problem', { text: 'Second problem' }, { message: 'Third problem' }, 7, { other: 'ignored' }],
        files_touched: ['never.read'],
        note: 'a field the detail does not read',
      },
    });
    const child = await seedRun(accountId, { role: 'code-reviewer', status: 'running', itemId, parent: id });
    await seedLedger(accountId, id, 'model', 'customer_anthropic', 1.5);
    await seedLedger(accountId, id, 'compute', 'sandbox', 0.04);
    await seedEvent(accountId, id, 1, 'agent.activity', { tool: 'read', path: 'src/a.ts' });
    await seedEvent(accountId, id, 2, 'agent.activity', { tool: 'test', command: 'pnpm vitest run' });
    await seedEvent(accountId, id, 3, 'agent.output', { text: 'model words that must never appear' });

    const body = (await (await get(id, { accountId, userId })).json()) as RunInsight;
    expect(runInsightResponseSchema.parse(body)).toEqual(body);
    expect(body.run).toMatchObject({ id, role: 'code-reviewer', status: 'succeeded', model: 'sonnet-5', head_sha: '9b708c17e4a1d2f3a4b5c6d7e8f901234567abcd'});
    expect(body.run.ended_at).not.toBeNull(); // stamped by the database when the run reached a terminal status
    expect(body.work_item).toEqual({ id: itemId, stage: 'pr_opened', issue_number: 42, repo: { owner: 'acme', name: 'docs' } });
    expect(body.pr_number).toBe(57);
    expect(body.outcome).toEqual({ summary: 'Two problems.', verdict: 'needs-fix', findings: ['First problem', 'Second problem', 'Third problem'], findings_truncated: false, branch: null });
    expect(body.cost).toEqual({
      model: { usd: 1.5, source: 'customer_anthropic', tokens_in: 1000, tokens_out: 200 },
      compute: { usd: 0.04, source: 'sandbox' },
    });
    expect(body.lines.map((l) => l.text)).toEqual(['Reading src/a.ts', 'Ran tests: pnpm vitest run']);
    expect(JSON.stringify(body)).not.toContain('model words');
    expect(JSON.stringify(body)).not.toContain('never.read');
    expect(JSON.stringify(body)).not.toContain('does not read');
    expect(body.parent).toMatchObject({ id: parent, status: 'failed' });
    expect(body.children.map((c) => [c.id, c.status])).toEqual([[child, 'running']]);
  });

  it('the run detail drops a stored command that could hold a secret and keeps a clean one', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const id = await seedRun(accountId, { role: 'executor', status: 'running' });
    const pw = ['hun', 'ter', '2'].join('');
    await seedEvent(accountId, id, 1, 'agent.activity', { tool: 'command', command: `mysql -u root -p${pw} db` });
    await seedEvent(accountId, id, 2, 'agent.activity', { tool: 'command', command: ['curl', '--user', `admin:${pw}`, 'https://example.test'].join(' ') });
    await seedEvent(accountId, id, 3, 'agent.activity', { tool: 'command', command: 'mkdir -p out' });
    const body = (await (await get(id, { accountId, userId })).json()) as RunInsight;
    expect(body.lines.map((l) => l.text)).toEqual(['Running a command', 'Running a command', 'Ran: mkdir -p out']);
    expect(JSON.stringify(body)).not.toContain(pw);
  });

  it('an operator-subscription run has no per-token model amount, and an executor reads its branch and PR number', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const itemId = await seedItem(accountId);
    const id = await seedRun(accountId, { role: 'executor', status: 'succeeded', itemId, usd: 9, envelope: { summary: 'Built.', verdict: 'done', branch: 'runs-detail', pr_number: 58 } });
    await seedLedger(accountId, id, 'model', 'operator_subscription', 0);
    const body = (await (await get(id, { accountId, userId })).json()) as RunInsight;
    expect(body.cost.model).toMatchObject({ usd: null, source: 'operator_subscription' });
    expect(body.outcome).toMatchObject({ summary: 'Built.', verdict: 'done', branch: 'runs-detail', findings: [] });
    expect(body.pr_number).toBe(58); // the envelope's, when the dispatch recorded none
  });

  it("an executor run's dispatch number is the ISSUE number, never a pull request: no PR number unless its own envelope reports one", async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const itemId = await seedItem(accountId);
    const noPr = await seedRun(accountId, { role: 'executor', status: 'failed', itemId, prNumber: 64 });
    expect(((await (await get(noPr, { accountId, userId })).json()) as RunInsight).pr_number).toBeNull();
    const withEnv = await seedRun(accountId, { role: 'executor', status: 'succeeded', itemId, prNumber: 64, envelope: { summary: 'Built.', pr_number: 70 } });
    expect(((await (await get(withEnv, { accountId, userId })).json()) as RunInsight).pr_number).toBe(70);
    // A reviewer's dispatch target is a real pull request.
    const reviewer = await seedRun(accountId, { role: 'code-reviewer', status: 'succeeded', itemId, prNumber: 70 });
    expect(((await (await get(reviewer, { accountId, userId })).json()) as RunInsight).pr_number).toBe(70);
  });

  it("gives the run's failure reason code from its last failing status change, and null for a run that did not fail", async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const failed = await seedRun(accountId, { role: 'executor', status: 'failed' });
    await seedEvent(accountId, failed, 1, 'run.status_changed', { from: 'pending', to: 'failed', failureReason: 'sandbox_busy' });
    const body = (await (await get(failed, { accountId, userId })).json()) as RunInsight;
    expect(runInsightResponseSchema.parse(body)).toEqual(body);
    expect(body.failure_reason).toBe('sandbox_busy');
    const ok = await seedRun(accountId, { role: 'executor', status: 'succeeded' });
    await seedEvent(accountId, ok, 1, 'run.status_changed', { from: 'pending', to: 'running' });
    expect(((await (await get(ok, { accountId, userId })).json()) as RunInsight).failure_reason).toBeNull();
    const odd = await seedRun(accountId, { role: 'executor', status: 'failed' });
    await seedEvent(accountId, odd, 1, 'run.status_changed', { from: 'pending', to: 'failed', failureReason: 'Not a <code>' });
    expect(((await (await get(odd, { accountId, userId })).json()) as RunInsight).failure_reason).toBeNull();
  });

  it('an envelope with no summary, a hostile branch or verdict, and a non-array findings gives a bare outcome', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const odd = await seedRun(accountId, { role: 'code-reviewer', status: 'succeeded', envelope: { verdict: 'PASS <b>', branch: 'a b;rm -rf', findings: 'not a list', pr_number: 'x' } });
    const body = (await (await get(odd, { accountId, userId })).json()) as RunInsight;
    expect(body.outcome).toEqual({ summary: null, verdict: null, findings: [], findings_truncated: false, branch: null });
    expect(body.pr_number).toBeNull();
    const none = await seedRun(accountId, { role: 'code-reviewer', status: 'failed' });
    expect(((await (await get(none, { accountId, userId })).json()) as RunInsight).outcome).toBeNull();
  });

  it('bounds the summary, the findings and the activity lines', async () => {
    const { accountId, userId } = await seedAccountWithMember(admin);
    const findings = Array.from({ length: INSIGHT_LIMITS.maxFindings + 5 }, (_, i) => (i === 0 ? 'F'.repeat(3000) : `finding ${i}`));
    const id = await seedRun(accountId, { role: 'code-reviewer', status: 'succeeded', envelope: { summary: 'S'.repeat(9000), verdict: 'pass', findings } });
    for (let s = 1; s <= ACTIVITY_LIMITS.maxEventsPerRun + 60; s++) await seedEvent(accountId, id, s, 'agent.activity', { tool: 'read', path: `src/f${s}.ts` });
    const body = (await (await get(id, { accountId, userId })).json()) as RunInsight;
    expect(body.outcome!.summary!.length).toBe(ACTIVITY_LIMITS.maxSummaryChars);
    expect(body.outcome!.summary!.endsWith('…')).toBe(true);
    expect(body.outcome!.findings).toHaveLength(INSIGHT_LIMITS.maxFindings);
    expect(body.outcome!.findings_truncated).toBe(true);
    expect(body.outcome!.findings[0]!.length).toBe(INSIGHT_LIMITS.maxFindingChars);
    expect(body.lines_truncated).toBe(true);
    expect(body.lines.length).toBeLessThanOrEqual(ACTIVITY_LIMITS.maxEventsPerRun);
  });

  it("answers 404 for an unknown id, a malformed id and another account's run", async () => {
    const a = await seedAccountWithMember(admin);
    const b = await seedAccountWithMember(admin);
    const theirs = await seedRun(b.accountId, { role: 'executor', status: 'running' });
    for (const id of [randomUUID(), 'not-a-uuid', theirs]) {
      const res = await get(id, a);
      expect(res.status, id).toBe(404);
    }
  });

  it('refuses a request with no session', async () => {
    const res = await handleApiRequest(new Request(`http://localhost/api/v1/runs/${randomUUID()}/insight`), appUserPool, platformOpsPool, ROUTES);
    expect(res.status).toBe(401);
  });
});
