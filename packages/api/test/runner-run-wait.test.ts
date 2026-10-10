import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COPY } from '@fulcrumaxe/runner-protocol';
import { RUN_WAIT_REASONS } from '@fx/runner-cloud';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertRunner } from '@fx/db/test/helpers/runnerFixtures.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { activityResponseSchema } from '../src/routes/work-item-activity.js';
import { runInsightResponseSchema } from '../src/routes/run-insight.js';
import { runWaitField, waitText } from '../src/routes/runWait.js';
import { seedAccountWithMember, type SeedMemberResult } from './helpers/seed.js';

// The plan data is not in the test tree: by default the caps cannot be read (so no account cap is named), and a case that needs one sets it.
const plan = vi.hoisted(() => ({ limits: null as null | { maxConcurrentRunnerJobs: number; maxConcurrentHeavyRunnerJobs?: number } }));
vi.mock('@fx/spend', async (original) => ({
  ...(await original<typeof import('@fx/spend')>()),
  runnerLimitsFor: () => {
    if (plan.limits === null) throw new Error('the plan data has no runner plan');
    return plan.limits;
  },
}));

const FX_SESSION_SECRET = 's'.repeat(32);
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'v1');
const T0 = Date.parse('2026-10-03T10:00:00.000Z');
const at = (seconds: number): Date => new Date(T0 + seconds * 1000);
const SERVER_TIME = '2026-10-03T12:00:00.000Z';
// Fixed ids, so a fixture pins the state and not a random id; the counter is the file's, so no two cases share one.
let counter = 0;
const uuid = (block: string): string => `00000000-0000-4000-8000-${block}${String(++counter).padStart(11, '0')}`;

interface Wait {
  reason: string;
  limited_by: string | null;
  text: string;
}
interface RunBody {
  id: string;
  wait?: Wait | null;
}
interface InsightBody {
  lines: Array<{ at: string; text: string }>;
  wait?: Wait | null;
}

/** D#6 C42-3b against real Postgres: why a queued runner run is not running yet, on the Runs insight and on the work-item activity. */
describe('the wait of a queued runner run through getRunInsight and getWorkItemActivity (D#6 C42-3b)', { timeout: 120_000 }, () => {
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

  async function call(urlPath: string, identity: SeedMemberResult): Promise<{ status: number; body: unknown }> {
    const token = await signSession(identity);
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${token}` });
    const res = await handleApiRequest(new Request(`http://localhost${urlPath}`, { headers }), appUserPool, platformOpsPool, ROUTES);
    return { status: res.status, body: await res.json() };
  }
  async function getJson(urlPath: string, identity: SeedMemberResult): Promise<unknown> {
    const res = await call(urlPath, identity);
    expect(res.status).toBe(200);
    return res.body;
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

  /** One account with one repo, and the helpers to put runners and runs in it. Each case has its own, so nothing leaks between cases. */
  async function world(): Promise<{
    me: SeedMemberResult;
    repoId: string;
    runner: (o?: { mode?: string; cap?: { light: number; heavy: number; limitedBy?: string }; online?: boolean }) => Promise<string>;
    run: (o: { id?: string; status: string; runtime?: string; role?: string; runnerId?: string; parent?: string; claimableInSeconds?: number; item?: boolean; failedWith?: string; timedOutWith?: string; startedAt?: boolean }) => Promise<{ runId: string; itemId: string | null }>;
  }> {
    const me = await seedAccountWithMember(admin);
    const repoId = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, settings) VALUES ($1, $2, $3, 'team', 'acme', 'docs', '{}'::jsonb)`, [repoId, me.accountId, Math.floor(Math.random() * 1e9)]);
    let n = 0;
    return {
      me,
      repoId,
      async runner(o = {}) {
        const id = await insertRunner(admin, me.accountId, me.userId, { credentialMode: o.mode ?? 'api_key' });
        await admin.query(`UPDATE runners SET last_seen_at = CASE WHEN $2 THEN now() ELSE now() - interval '1 hour' END, protocol_version = 3, allowed_repo_ids = ARRAY[$3]::uuid[] WHERE id = $1`, [id, o.online ?? true, repoId]);
        if (o.cap) await admin.query(`INSERT INTO runner_capacity (runner_id, account_id, declared, light_limit, heavy_limit, limited_by) VALUES ($1, $2, true, $3, $4, $5)`, [id, me.accountId, o.cap.light, o.cap.heavy, o.cap.limitedBy ?? null]);
        return id;
      },
      async run(o) {
        n += 1;
        const runId = o.id ?? uuid('d');
        const itemId = o.item === false ? null : uuid('c');
        if (itemId) await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number, created_at) VALUES ($1, $2, $3, 'feature', 'internal', 'in_progress', $4, $5)`, [itemId, me.accountId, repoId, 600 + n, at(0)]);
        const running = o.status === 'running';
        await admin.query(
          `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, execution_mode, status, runner_id, lease_generation, lease_expires_at, parent_run_id, claimable_after, dispatch_repo_id, created_at, started_at, ended_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $10 THEN now() + interval '60 seconds' END, $11, CASE WHEN $12::int IS NULL THEN NULL ELSE now() + make_interval(secs => $12::int) END, $13, $14, $15, $16)`,
          [runId, me.accountId, itemId, o.role ?? 'executor', o.runtime ?? 'runner', (o.runtime ?? 'runner') === 'runner' ? 'runner_local' : null, o.status, o.runnerId ?? null, running ? 1 : 0, running, o.parent ?? null, o.claimableInSeconds ?? null, repoId, at(0), o.status === 'pending' ? null : at(1), ['pending', 'running'].includes(o.status) ? null : at(60)],
        );
        const move = o.failedWith ? { to: 'failed', failureReason: o.failedWith } : o.timedOutWith ? { to: 'timed_out', failureReason: o.timedOutWith } : null;
        if (move) await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload, created_at) VALUES ($1, $2, 1, 'run.status_changed', $3::jsonb, $4)`, [me.accountId, runId, JSON.stringify({ from: 'running', ...move }), at(2)]);
        return { runId, itemId };
      },
    };
  }

  /** Reads one run through both routes, checks the bodies against their schemas, and returns the wait each one carries. */
  async function waitsOf(w: Awaited<ReturnType<typeof world>>, seeded: { runId: string; itemId: string | null }, pinAs?: string): Promise<{ insight: Wait | null | undefined; activity: Wait | null | undefined }> {
    const insight = normalise(await getJson(`/api/v1/runs/${seeded.runId}/insight`, w.me)) as InsightBody;
    expect(runInsightResponseSchema.safeParse(insight).success).toBe(true);
    let activityWait: Wait | null | undefined;
    if (seeded.itemId) {
      const activity = (await getJson(`/api/v1/work-items/${seeded.itemId}/activity`, w.me)) as { runs: RunBody[] };
      expect(activityResponseSchema.safeParse(activity).success).toBe(true);
      activityWait = activity.runs.find((r) => r.id === seeded.runId)!.wait;
      if (pinAs) pin('getWorkItemActivity', pinAs, activity);
      // The same words on both screens, and no hole in them.
      expect(activityWait).toEqual(insight.wait);
    }
    if (pinAs) pin('getRunInsight', pinAs, insight);
    expect(JSON.stringify(insight.wait ?? null)).not.toMatch(/undefined|null"|NaN/);
    return { insight: insight.wait, activity: activityWait };
  }

  const longRunning = async (w: Awaited<ReturnType<typeof world>>, runnerId: string): Promise<void> => {
    await w.run({ status: 'running', runnerId, item: false });
  };

  it('waiting_for_runner: no runner that covers the repo is online', async () => {
    const w = await world();
    await w.runner({ online: false });
    const waits = await waitsOf(w, await w.run({ status: 'pending' }), 'runner-wait-waiting-for-runner');
    expect(waits.insight).toEqual({ reason: 'waiting_for_runner', limited_by: null, text: 'Waiting for your runner to come online' });
  });

  it('waiting_for_approval: only a subscription runner covers it and nobody has approved', async () => {
    const w = await world();
    await w.runner({ mode: 'subscription' });
    const waits = await waitsOf(w, await w.run({ status: 'pending' }), 'runner-wait-waiting-for-approval');
    expect(waits.insight).toEqual({ reason: 'waiting_for_approval', limited_by: null, text: COPY.waitApproval });
  });

  it('runner_lost_retrying: a pending follow-up of a run that lost its runner', async () => {
    const w = await world();
    await w.runner();
    const parent = await w.run({ status: 'failed', failedWith: 'runner_lost', item: false });
    const waits = await waitsOf(w, await w.run({ status: 'pending', parent: parent.runId }), 'runner-wait-runner-lost-retrying');
    expect(waits.insight).toEqual({ reason: 'runner_lost_retrying', limited_by: null, text: 'Your runner lost contact. Retrying from the last pushed commit' });
  });

  it('paused_usage_limit: a pending follow-up that waits for the plan limit to reset', async () => {
    const w = await world();
    await w.runner();
    const parent = await w.run({ status: 'failed', failedWith: 'usage_limit', item: false });
    const waits = await waitsOf(w, await w.run({ status: 'pending', parent: parent.runId, claimableInSeconds: 3600 }), 'runner-wait-paused-usage-limit');
    expect(waits.insight).toEqual({ reason: 'paused_usage_limit', limited_by: null, text: COPY.paused });
  });

  it('timed_out_waiting: a run that gave up waiting for a runner (its wait ended; any other timeout says nothing)', async () => {
    const w = await world();
    const waits = await waitsOf(w, await w.run({ status: 'timed_out', timedOutWith: 'queue_ttl' }), 'runner-wait-timed-out-waiting');
    expect(waits.insight).toEqual({ reason: 'timed_out_waiting', limited_by: null, text: COPY.timedOut });
    const other = await waitsOf(w, await w.run({ status: 'timed_out', timedOutWith: 'wall_clock' }));
    expect(other.insight).toBeNull();
  });

  // A full runner: every runner that covers the repo has no free slot. The cause it gave on its last claim words the sentence.
  const CAUSES: Array<[string | undefined, string]> = [
    [undefined, 'Waiting for a free slot on your runner'],
    ['memory', 'Waiting for a free slot on your runner (memory is short)'],
    ['cpu', 'Waiting for a free slot on your runner (CPU is busy)'],
    ['disk', 'Waiting for a free slot on your runner (disk is low)'],
    ['paused', 'Your runner is paused'],
    ['ceiling', 'Waiting: your runner is at its job limit'],
  ];
  for (const [cause, sentence] of CAUSES) {
    it(`waiting_for_runner_slot (${cause ?? 'no cause given'}): ${sentence}`, async () => {
      const w = await world();
      const runnerId = await w.runner({ cap: { light: 1, heavy: 1, limitedBy: cause } });
      await longRunning(w, runnerId);
      const waits = await waitsOf(w, await w.run({ status: 'pending' }), `runner-wait-slot-${cause ?? 'plain'}`);
      expect(waits.insight).toEqual({ reason: 'waiting_for_runner_slot', limited_by: cause ?? null, text: sentence });
    });
  }

  it("waiting_for_account_cap: the account's own runner job limit holds it while a runner has room", async () => {
    // The account's cap is however many runs it has running: a test's own number, not the plan's figure.
    const running = 2;
    plan.limits = { maxConcurrentRunnerJobs: running, maxConcurrentHeavyRunnerJobs: running };
    try {
      const w = await world();
      const runnerId = await w.runner({ cap: { light: 4, heavy: 4 } });
      for (let i = 0; i < running; i++) await longRunning(w, runnerId);
      const waits = await waitsOf(w, await w.run({ status: 'pending' }), 'runner-wait-account-cap');
      expect(waits.insight).toEqual({ reason: 'waiting_for_account_cap', limited_by: null, text: "Waiting: your account's runner job limit is reached" });
    } finally {
      plan.limits = null;
    }
  });

  it('with the plan data unreadable no account cap is named: the runner answers for itself', async () => {
    const w = await world();
    const runnerId = await w.runner({ cap: { light: 1, heavy: 1 } });
    await longRunning(w, runnerId);
    const waits = await waitsOf(w, await w.run({ status: 'pending' }));
    expect(waits.insight?.reason).toBe('waiting_for_runner_slot');
  });

  it('every reason has a sentence, and every cause of a full runner has its own', () => {
    for (const reason of RUN_WAIT_REASONS) {
      const text = waitText(reason, null);
      expect(text, reason).toMatch(/^[A-Z]/);
      expect(text, reason).not.toMatch(/\{|undefined|null|NaN/);
    }
    const slot = new Set(CAUSES.map(([cause]) => waitText('waiting_for_runner_slot', (cause ?? null) as never)));
    expect(slot.size).toBe(CAUSES.length);
  });

  it('a run that is not waiting has wait: null, and a run of another kind has no wait field at all', async () => {
    const w = await world();
    await w.runner({ cap: { light: 2, heavy: 2 } });
    // Claimable at once: a runner with room is online, so nothing holds it.
    expect((await waitsOf(w, await w.run({ status: 'pending' }))).insight).toBeNull();
    // Started, finished or failed: nothing to wait for.
    for (const status of ['running', 'succeeded', 'failed']) expect((await waitsOf(w, await w.run({ status }))).insight, status).toBeNull();
    // A sandbox run reads as before: no field on either body.
    const sandbox = await w.run({ status: 'pending', runtime: 'production' });
    const insight = (await getJson(`/api/v1/runs/${sandbox.runId}/insight`, w.me)) as Record<string, unknown>;
    expect('wait' in insight).toBe(false);
    const activity = (await getJson(`/api/v1/work-items/${sandbox.itemId}/activity`, w.me)) as { runs: Array<Record<string, unknown>> };
    expect('wait' in activity.runs[0]!).toBe(false);
  });

  it('a wait is derived: when the runner frees a slot or the run starts, it is gone on the next read', async () => {
    const w = await world();
    const runnerId = await w.runner({ cap: { light: 1, heavy: 1 } });
    const held = await w.run({ status: 'running', runnerId, item: false });
    const pending = await w.run({ status: 'pending' });
    expect((await waitsOf(w, pending)).insight?.reason).toBe('waiting_for_runner_slot');
    await admin.query(`UPDATE agent_runs SET status = 'succeeded' WHERE id = $1`, [held.runId]);
    expect((await waitsOf(w, pending)).insight).toBeNull();
  });

  describe('tenant isolation', () => {
    it("another account's run is not found through either route, and its wait is never read under this account", async () => {
      const mine = await world();
      const theirs = await world();
      await theirs.runner({ online: false });
      const theirRun = await theirs.run({ status: 'pending' });
      expect((await waitsOf(theirs, theirRun)).insight?.reason).toBe('waiting_for_runner');
      // The same ids asked for by the other account: not found, with no wait anywhere in the answer.
      const insight = await call(`/api/v1/runs/${theirRun.runId}/insight`, mine.me);
      expect(insight.status).toBe(404);
      expect(JSON.stringify(insight.body)).not.toContain('waiting_for_runner');
      const activity = await call(`/api/v1/work-items/${theirRun.itemId}/activity`, mine.me);
      expect(activity.status).toBe(404);
      expect(JSON.stringify(activity.body)).not.toContain('waiting_for_runner');
      // The reader itself, handed the other account's run id under this account: it reads through this tenant and finds no run.
      expect(await runWaitField(appUserPool, mine.me.accountId, { id: theirRun.runId, runtime: 'runner', status: 'pending' })).toEqual({ wait: null });
      // And this account's runner, online for its own repo, does not make the other account's run claimable.
      await mine.runner();
      expect((await waitsOf(theirs, theirRun)).insight?.reason).toBe('waiting_for_runner');
    });
  });
});
