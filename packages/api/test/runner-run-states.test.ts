import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNNER_LEASE_SECONDS } from '@fulcrumaxe/runner-protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertRunner } from '@fx/db/test/helpers/runnerFixtures.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { RUNNER_LEASE_SECONDS_READ } from '@fx/core/src/work-items/activity.js';
import { RUNNER_USAGE_NOTE } from '@fx/core/src/runs/runnerUsage.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { activityResponseSchema } from '../src/routes/work-item-activity.js';
import { runInsightResponseSchema } from '../src/routes/run-insight.js';
import { seedAccountWithMember } from './helpers/seed.js';

const FX_SESSION_SECRET = 's'.repeat(32);
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'v1');
const T0 = Date.parse('2026-10-03T10:00:00.000Z');
const at = (seconds: number): Date => new Date(T0 + seconds * 1000);
const SERVER_TIME = '2026-10-03T12:00:00.000Z';
const uuid = (block: string, n: number): string => `00000000-0000-4000-8000-${block}${String(n).padStart(11, "0")}`;

interface Line {
  at: string;
  text: string;
}
interface RunBody {
  lines: Line[];
  runtime?: string;
  runner_checked_in_at?: string | null;
  runner_usage_state?: string | null;
  runner_usage_note?: string | null;
  runner_usage?: { api_equivalent_usd: number | null; tokens_in: number; tokens_out: number } | null;
}
interface ActivityBody {
  pr_number: number | null;
  runs: [RunBody];
}
interface InsightBody {
  lines: Line[];
  lines_truncated: boolean;
  pr_number: number | null;
  runner_checked_in_at?: string | null;
}

interface EventSeed {
  seq: number;
  kind: string;
  payload: Record<string, unknown>;
}
interface StateSeed {
  /** The fixture name: `200-<name>.json` under both operations. */
  name: string;
  role?: string;
  status: string;
  /** Whether a runner holds the run and when its lease runs out (seconds from T0). */
  lease?: number | null;
  events?: EventSeed[];
  usage?: { input: number; output: number; usd: number | null; model?: string } | null;
  envelope?: Record<string, unknown> | null;
}

const ev = (seq: number, kind: string, payload: Record<string, unknown>): EventSeed => ({ seq, kind, payload });
const runnerEv = (seq: number, payload: Record<string, unknown>): EventSeed => ev(seq, 'runner.event', { seq, ts: at(seq).toISOString(), ...payload });
const started = ev(1, 'run.status_changed', { from: 'pending', to: 'running' });
const failed = (seq: number, failureReason: string): EventSeed => ev(seq, 'run.status_changed', { from: 'running', to: 'failed', failureReason });
const ended = (seq: number, reason: string, detail?: string, extra: Record<string, unknown> = {}): EventSeed =>
  runnerEv(seq, { type: 'run_ended', reason, ...(detail === undefined ? {} : { detail }), ...extra });

/** Every state C42-3 names, one run each. The expected lines are pinned in the fixtures; the assertions below pin the ones that carry a decision. */
const STATES: StateSeed[] = [
  { name: 'runner-waiting', status: 'pending', events: [ev(1, 'runner.waiting', { repo_id: uuid('3', 1), waited_since: at(0).toISOString() })] },
  { name: 'runner-approval-needed', status: 'pending', events: [] },
  { name: 'runner-claimed-no-events', status: 'running', lease: 300, events: [] },
  {
    name: 'runner-running-activity',
    status: 'running',
    lease: 300,
    events: [
      started,
      ev(2, 'run.stage', { stage: 'sandbox_ready' }),
      ev(3, 'run.stage', { stage: 'cloned' }),
      // Noise that must not reach a line or crowd one out: raw tool uses, command exits, usage.
      runnerEv(4, { type: 'tool_use', tool_name: 'Read', file_path: 'src/a.ts' }),
      ev(5, 'agent.activity', { tool: 'read', path: 'src/a.ts' }),
      runnerEv(6, { type: 'command_exit', exit_code: 0, duration_ms: 1200 }),
      ev(7, 'agent.activity', { tool: 'test', command: 'pnpm test' }),
      runnerEv(8, { type: 'usage', usage: { input: 10, output: 5 } }),
    ],
  },
  {
    name: 'runner-capped',
    status: 'running',
    lease: 300,
    events: [started, ...Array.from({ length: 200 }, (_, i) => ev(i + 2, 'agent.activity', { tool: 'read', path: `src/file${i}.ts` }))],
  },
  {
    name: 'runner-succeeded-with-pr',
    status: 'succeeded',
    lease: 300,
    events: [started, ev(2, 'agent.activity', { tool: 'read', path: 'src/a.ts' }), ev(3, 'run.stage', { stage: 'writing_result' }), ev(4, 'run.status_changed', { from: 'running', to: 'succeeded', viaRunnerDone: true, prNumber: 123, branch: 'fx/run-g1' })],
    envelope: { summary: 'Built it.' },
    usage: { input: 1000, output: 200, usd: 0.0147, model: 'sonnet-5' },
  },
  { name: 'runner-failed-job-refused', status: 'failed', events: [started, ended(2, 'job_refused', 'duplicate_job'), failed(3, 'job_refused')] },
  { name: 'runner-failed-agent-failed', status: 'failed', events: [started, ended(2, 'agent_failed'), failed(3, 'agent_failed')] },
  { name: 'runner-failed-push-rejected', status: 'failed', events: [started, ended(2, 'push_rejected'), failed(3, 'push_rejected')] },
  { name: 'runner-failed-runner-setup', status: 'failed', events: [started, ended(2, 'runner_setup', 'mirror_failed'), failed(3, 'runner_setup')] },
  { name: 'runner-failed-push-too-large', status: 'failed', events: [started, ended(2, 'runner_setup', 'push_too_large', { size_mb: 7 }), failed(3, 'runner_setup')] },
  // A reason with no sentence in the protocol keeps the plain form.
  { name: 'runner-failed-wall-clock', status: 'failed', events: [started, ended(2, 'wall_clock'), failed(3, 'wall_clock')] },
  { name: 'runner-lease-lost', status: 'failed', lease: -60, events: [started, failed(2, 'runner_lost')] },
  { name: 'runner-taken-over', status: 'failed', events: [started, runnerEv(2, { type: 'taken_over' }), failed(3, 'taken_over')] },
  {
    name: 'runner-usage-limit',
    status: 'failed',
    events: [started, runnerEv(2, { type: 'usage_limit_reached', reset_at: '2026-10-03T14:05:00.000Z' }), failed(3, 'usage_limit')],
  },
  { name: 'runner-usage-not-priced', status: 'succeeded', events: [started], usage: { input: 500, output: 100, usd: null, model: 'unpriced-model' } },
  { name: 'runner-usage-not-recorded', status: 'succeeded', events: [started] },
];

/** D#6 C42-3 against real Postgres: the activity and insight reads of every state of a run on a person's machine, pinned as fixtures. */
describe('runner run states through getWorkItemActivity and getRunInsight (D#6 C42-3)', { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let me: { accountId: string; userId: string };
  let runnerId: string;
  let repoId: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = FX_SESSION_SECRET;
    me = await seedAccountWithMember(admin);
    runnerId = await insertRunner(admin, me.accountId, me.userId, { credentialMode: 'subscription' });
    repoId = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, settings) VALUES ($1, $2, $3, 'team', 'acme', 'docs', '{}'::jsonb)`, [repoId, me.accountId, Math.floor(Math.random() * 1e9)]);
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });

  async function getJson(urlPath: string, identity = me): Promise<unknown> {
    const token = await signSession(identity);
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${token}` });
    const res = await handleApiRequest(new Request(`http://localhost${urlPath}`, { headers }), appUserPool, platformOpsPool, ROUTES);
    expect(res.status).toBe(200);
    return res.json();
  }

  interface Seeded {
    itemId: string;
    runId: string;
  }
  async function seedState(s: StateSeed, n: number): Promise<Seeded> {
    const itemId = uuid('1', n);
    const runId = uuid('2', n);
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number, created_at) VALUES ($1, $2, $3, 'feature', 'internal', 'in_progress', 595, $4)`, [itemId, me.accountId, repoId, at(0)]);
    const held = s.lease !== undefined && s.lease !== null;
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, execution_mode, status, envelope, runner_id, lease_generation, lease_expires_at, dispatch_repo_id, created_at, started_at, ended_at)
       VALUES ($1, $2, $3, $4, 'runner', 'runner_local', $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13)`,
      [
        runId,
        me.accountId,
        itemId,
        s.role ?? 'executor',
        s.status,
        s.envelope ? JSON.stringify(s.envelope) : null,
        held ? runnerId : null,
        held ? 1 : 0,
        held ? at(s.lease!) : null,
        repoId,
        at(0),
        s.status === 'pending' ? null : at(1),
        s.status === 'running' || s.status === 'pending' ? null : at(60),
      ],
    );
    for (const e of s.events ?? []) {
      await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload, created_at) VALUES ($1, $2, $3, $4, $5::jsonb, $6)`, [me.accountId, runId, e.seq, e.kind, JSON.stringify(e.payload), at(e.seq)]);
    }
    if (s.usage) {
      await admin.query(
        `INSERT INTO runner_run_usage (account_id, run_id, runner_id, credential_mode, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, api_equivalent_usd, price_table_version, recorded_at)
         VALUES ($1, $2, $3, 'subscription', $4, $5, $6, 5000, 300, $7, $8, $9)`,
        [me.accountId, runId, runnerId, s.usage.model ?? 'sonnet-5', s.usage.input, s.usage.output, s.usage.usd, s.usage.usd === null ? null : '2026-10-01', at(60)],
      );
    }
    return { itemId, runId };
  }

  // What the database stamps on its own (the clock, the plan's limits) is replaced by fixed values, so a fixture pins the state and not the day it was made.
  const LIMITS = { max_run_minutes: 60, max_model_calls: 300, per_run_usd: 40, max_turns: 100, silence_minutes: 15, max_extensions: 2, max_resumes: 2, auto_resume: true };
  const normalise = (insight: unknown): unknown => {
    const i = insight as { run: Record<string, unknown> } & Record<string, unknown>;
    const run = { ...i.run, started_at: i.run.started_at === null ? null : at(1).toISOString(), ended_at: i.run.ended_at === null ? null : at(60).toISOString() };
    return { ...i, server_time: SERVER_TIME, run, limits: LIMITS };
  };
  const pretty = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

  function pin(operationId: string, name: string, actual: unknown): void {
    const file = path.join(FIXTURES, operationId, `200-${name}.json`);
    if (process.env.FX_WRITE_FIXTURES === '1') {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, pretty(actual));
    }
    expect(existsSync(file), `${file} is missing: run with FX_WRITE_FIXTURES=1 and read the diff`).toBe(true);
    expect(pretty(actual)).toBe(readFileSync(file, 'utf8'));
  }

  const results = new Map<string, { activity: ActivityBody; insight: InsightBody; seeded: Seeded }>();

  STATES.forEach((s, i) => {
    it(`${s.name}: both reads match their pinned fixture and their response schema`, async () => {
      const seeded = await seedState(s, i + 1);
      const activity = (await getJson(`/api/v1/work-items/${seeded.itemId}/activity`)) as ActivityBody;
      const insight = normalise(await getJson(`/api/v1/runs/${seeded.runId}/insight`)) as InsightBody;
      expect(activityResponseSchema.safeParse(activity).success).toBe(true);
      expect(runInsightResponseSchema.safeParse(insight).success).toBe(true);
      results.set(s.name, { activity, insight, seeded });
      pin('getWorkItemActivity', s.name, activity);
      pin('getRunInsight', s.name, insight);
      // The same lines on both screens, and no hole in any of them.
      expect(activity.runs[0].lines).toEqual(insight.lines);
      expect(JSON.stringify(activity.runs[0].lines)).not.toMatch(/undefined|null|NaN/);
    });
  });

  it('the decisions the fixtures carry', () => {
    const text = (name: string): string[] => results.get(name)!.insight.lines.map((l: { text: string }) => l.text);
    expect(text('runner-waiting')).toEqual(['Waiting for your runner to come online']);
    expect(text('runner-approval-needed')).toEqual([]);
    expect(text('runner-taken-over')).toEqual(['The run started', 'Taken over on the runner machine']);
    expect(text('runner-usage-limit')).toEqual(['The run started', 'Plan usage limit reached; resumes at 14:05 UTC']);
    expect(text('runner-lease-lost')).toEqual(['The run started']);
    // The runner protocol's own sentences, one per reason that has one; the rest keep the plain form.
    expect(text('runner-failed-job-refused')[1]).toBe('Your runner refused this job (duplicate_job).');
    expect(text('runner-failed-agent-failed')[1]).toBe('The agent stopped without finishing. Retry, or open the run for details.');
    expect(text('runner-failed-push-rejected')[1]).toMatch(/^Your runner could not push to the pull request's branch/);
    expect(text('runner-failed-runner-setup')[1]).toMatch(/^The runner could not update its local copy of this repository/);
    expect(text('runner-failed-push-too-large')[1]).toBe('This push is 7 MB; the limit through our proxy is 4 MB. A person can push this commit, or you can switch this repo to local-only (auto-merge turns off).');
    expect(text('runner-failed-wall-clock')[1]).toBe('The run ended (wall clock)');
    // Capped: the newest 30 lines of a run with 200 recorded, and the insight says it was cut.
    expect(results.get('runner-capped')!.insight.lines).toHaveLength(30);
    expect(results.get('runner-capped')!.insight.lines_truncated).toBe(true);
    // The running one draws activity and stages, and the raw runner steps stay out of the lines.
    expect(text('runner-running-activity')).toEqual(['The run started', 'The secure sandbox is ready', 'Repository cloned', 'Reading src/a.ts', 'Ran tests: pnpm test']);
    // The code on a line is private to the API: it never leaves.
    for (const { activity, insight } of results.values()) {
      expect(JSON.stringify(activity)).not.toContain('"ended"');
      expect(JSON.stringify(insight)).not.toContain('"ended"');
    }
  });

  it('a finished runner run has no check-in; a live one has the time its lease began, at or before now', async () => {
    for (const name of ['runner-succeeded-with-pr', 'runner-lease-lost', 'runner-taken-over', 'runner-usage-not-recorded', 'runner-waiting']) {
      const r = results.get(name)!;
      expect(r.insight.runner_checked_in_at, name).toBeNull();
      expect(r.activity.runs[0].runner_checked_in_at, name).toBeNull();
    }
    // Pinned: lease ends at T0+300 s, the lease is 90 s long.
    expect(results.get('runner-claimed-no-events')!.insight.runner_checked_in_at).toBe(at(300 - RUNNER_LEASE_SECONDS).toISOString());
    expect(results.get('runner-claimed-no-events')!.activity.runs[0].runner_checked_in_at).toBe(at(300 - RUNNER_LEASE_SECONDS).toISOString());
    // A run that checked in just now: a lease taken from the database clock.
    const itemId = randomUUID();
    const runId = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', 'in_progress', 596)`, [itemId, me.accountId, repoId]);
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, execution_mode, status, runner_id, lease_generation, lease_expires_at, dispatch_repo_id)
       VALUES ($1, $2, $3, 'executor', 'runner', 'runner_local', 'running', $4, 1, now() + make_interval(secs => $5), $6)`,
      [runId, me.accountId, itemId, runnerId, RUNNER_LEASE_SECONDS, repoId],
    );
    const insight = (await getJson(`/api/v1/runs/${runId}/insight`)) as { runner_checked_in_at: string };
    expect(Date.parse(insight.runner_checked_in_at)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(insight.runner_checked_in_at)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("the core's copy of the lease length is the protocol's", () => {
    expect(RUNNER_LEASE_SECONDS_READ).toBe(RUNNER_LEASE_SECONDS);
  });

  it('the PR link: the verdict the cloud recorded names the pull request, ahead of the agent, on both screens', async () => {
    const done = results.get('runner-succeeded-with-pr')!;
    expect(done.insight.pr_number).toBe(123);
    expect(done.activity.pr_number).toBe(123);
    // The cloud's verdict outranks what the agent wrote about itself.
    const both = await seedState({ name: 'x', status: 'succeeded', envelope: { pr_number: 9 }, events: [started, ev(2, 'run.status_changed', { from: 'running', to: 'succeeded', viaRunnerDone: true, prNumber: 124 })] }, 101);
    expect(((await getJson(`/api/v1/runs/${both.runId}/insight`)) as { pr_number: number }).pr_number).toBe(124);
    expect(((await getJson(`/api/v1/work-items/${both.itemId}/activity`)) as { pr_number: number }).pr_number).toBe(124);
    // No verdict: the envelope still counts, as before. A verdict with no pull request (or a stray event not from done) names none.
    const envOnly = await seedState({ name: 'y', status: 'succeeded', envelope: { pr_number: 9 }, events: [started] }, 102);
    expect(((await getJson(`/api/v1/runs/${envOnly.runId}/insight`)) as { pr_number: number }).pr_number).toBe(9);
    const stray = await seedState({ name: 'z', status: 'failed', events: [started, ev(2, 'run.status_changed', { from: 'running', to: 'failed', prNumber: 55 })] }, 103);
    expect(((await getJson(`/api/v1/runs/${stray.runId}/insight`)) as { pr_number: number | null }).pr_number).toBeNull();
    expect(((await getJson(`/api/v1/work-items/${stray.itemId}/activity`)) as { pr_number: number | null }).pr_number).toBeNull();
  });

  it('cost is a state, never a silent 0: recorded has a figure, the others have none and say why', () => {
    const run = (name: string) => results.get(name)!.activity.runs[0];
    expect(run('runner-succeeded-with-pr')).toMatchObject({ runtime: 'runner', runner_usage_state: 'recorded', runner_usage_note: null, runner_usage: { api_equivalent_usd: 0.0147, tokens_in: 1000, tokens_out: 200 } });
    expect(run('runner-usage-not-priced')).toMatchObject({ runner_usage_state: 'not_priced', runner_usage_note: RUNNER_USAGE_NOTE.not_priced, runner_usage: { api_equivalent_usd: null, tokens_in: 500, tokens_out: 100 } });
    expect(run('runner-usage-not-recorded')).toMatchObject({ runner_usage_state: 'not_recorded', runner_usage_note: RUNNER_USAGE_NOTE.not_recorded, runner_usage: null });
    // A run still going has no state yet; its usage may still arrive.
    expect(run('runner-running-activity')).toMatchObject({ runner_usage_state: null, runner_usage_note: null, runner_usage: null });
    // The words say the figure is not zero.
    expect(RUNNER_USAGE_NOTE.not_recorded).toMatch(/not the same as \$0/);
    expect(RUNNER_USAGE_NOTE.not_priced).toMatch(/not the same as \$0/);
    expect(run('runner-usage-not-priced').runner_usage?.api_equivalent_usd).not.toBe(0);
  });

  it('a run of another kind reads exactly as before: no runner field on a sandbox run', async () => {
    const itemId = randomUUID();
    const runId = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', 'pr_opened', 597)`, [itemId, me.accountId, repoId]);
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, envelope) VALUES ($1, $2, $3, 'executor', 'production', 'succeeded', $4::jsonb)`, [runId, me.accountId, itemId, JSON.stringify({ summary: 'Built.', pr_number: 8 })]);
    const activity = (await getJson(`/api/v1/work-items/${itemId}/activity`)) as { pr_number: number; runs: Array<Record<string, unknown>> };
    expect(activity.pr_number).toBe(8);
    expect(Object.keys(activity.runs[0]!).sort()).toEqual(['created_at', 'id', 'lines', 'role', 'runtime', 'status', 'summary', 'usd']);
    const insight = (await getJson(`/api/v1/runs/${runId}/insight`)) as Record<string, unknown>;
    expect('runner_usage' in insight).toBe(false);
    expect('runner_checked_in_at' in insight).toBe(false);
  });

  it('the runner states are read even behind a long run of tool uses, which are not read', async () => {
    const events: EventSeed[] = [started, runnerEv(2, { type: 'taken_over' })];
    for (let i = 0; i < 400; i++) events.push(runnerEv(3 + i, { type: 'tool_use', tool_name: 'Read', file_path: 'src/a.ts' }));
    const seeded = await seedState({ name: 'crowd', status: 'failed', events: [...events, failed(500, 'taken_over')] }, 104);
    const insight = (await getJson(`/api/v1/runs/${seeded.runId}/insight`)) as { lines: Array<{ text: string }>; lines_truncated: boolean };
    expect(insight.lines.map((l) => l.text)).toEqual(['The run started', 'Taken over on the runner machine']);
    expect(insight.lines_truncated).toBe(false);
  });
});
