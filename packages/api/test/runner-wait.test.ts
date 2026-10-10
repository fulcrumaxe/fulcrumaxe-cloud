import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITED_BY, WAIT_LINES, waitText } from '@fulcrumaxe/runner-protocol';
import { RUN_WAIT_REASONS } from '@fx/runner-cloud';
import { runnerLimitsFor } from '@fx/spend';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertRunner } from '@fx/db/test/helpers/runnerFixtures.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { activityResponseSchema } from '../src/routes/work-item-activity.js';
import { runInsightResponseSchema } from '../src/routes/run-insight.js';
import { readRunWait } from '../src/routes/runnerWait.js';
import { seedAccountWithMember } from './helpers/seed.js';

const FX_SESSION_SECRET = 's'.repeat(32);
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'v1');
const T0 = Date.parse('2026-10-03T10:00:00.000Z');
const SERVER_TIME = '2026-10-03T12:00:00.000Z';
const LIMITS = { max_run_minutes: 60, max_model_calls: 300, per_run_usd: 40, max_turns: 100, silence_minutes: 15, max_extensions: 2, max_resumes: 2, auto_resume: true };
const uuid = (block: string, n: number): string => `00000000-0000-4000-8000-${block}${String(n).padStart(11, '0')}`;
const pretty = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

interface Wait {
  reason: string;
  limited_by: string | null;
  text: string;
}
interface Ctx {
  /** A runner of the account, covering the repo. `online` is a poll just now. A declared capacity may name the cause that limits it. */
  runner(o: { credential: 'api_key' | 'subscription'; online: boolean; cap?: { light: number; heavy: number; limitedBy?: string } }): Promise<string>;
  /** A runner run of the account. Pass `item` to make it the case's run. */
  run(o: { role: string; status: string; runnerId?: string; starter: boolean; item?: number; parent?: string; claimableAfterHours?: number }): Promise<string>;
  parentFailed(reason: string): Promise<string>;
}
interface Case {
  name: string;
  want: { reason: string; limited_by: string | null } | null;
  setup(c: Ctx): Promise<void>;
}

/** The runner and cap of a pending executor, the case's own run being number 1. */
const CASES: Case[] = [
  { name: 'wait-no-runner', want: { reason: 'waiting_for_runner', limited_by: null }, setup: async (c) => { await c.runner({ credential: 'api_key', online: false }); await c.run({ role: 'executor', status: 'pending', starter: true, item: 1 }); } },
  { name: 'wait-approval', want: { reason: 'waiting_for_approval', limited_by: null }, setup: async (c) => { await c.runner({ credential: 'subscription', online: true }); await c.run({ role: 'executor', status: 'pending', starter: false, item: 1 }); } },
  {
    name: 'wait-account-cap',
    want: { reason: 'waiting_for_account_cap', limited_by: null },
    setup: async (c) => {
      const r = await c.runner({ credential: 'api_key', online: true, cap: { light: 8, heavy: 4 } });
      // The account's own heavy figure is used up by running executors, whatever the runner has free.
      for (let i = 0; i < runnerLimitsFor().maxConcurrentHeavyRunnerJobs!; i++) await c.run({ role: 'executor', status: 'running', runnerId: r, starter: true });
      await c.run({ role: 'executor', status: 'pending', starter: true, item: 1 });
    },
  },
  ...(['memory', 'cpu', 'disk', 'paused', 'ceiling'] as const).map((cause): Case => ({
    name: `wait-slot-${cause}`,
    want: { reason: 'waiting_for_runner_slot', limited_by: cause },
    setup: async (c) => {
      const r = await c.runner({ credential: 'api_key', online: true, cap: { light: 1, heavy: 1, limitedBy: cause } });
      await c.run({ role: 'code-reviewer', status: 'running', runnerId: r, starter: true });
      await c.run({ role: 'code-reviewer', status: 'pending', starter: true, item: 1 });
    },
  })),
  {
    name: 'wait-slot-no-cause',
    want: { reason: 'waiting_for_runner_slot', limited_by: null },
    setup: async (c) => {
      const r = await c.runner({ credential: 'api_key', online: true, cap: { light: 1, heavy: 1 } });
      await c.run({ role: 'code-reviewer', status: 'running', runnerId: r, starter: true });
      await c.run({ role: 'code-reviewer', status: 'pending', starter: true, item: 1 });
    },
  },
  { name: 'wait-runner-lost-retrying', want: { reason: 'runner_lost_retrying', limited_by: null }, setup: async (c) => { await c.runner({ credential: 'api_key', online: true, cap: { light: 8, heavy: 4 } }); await c.run({ role: 'executor', status: 'pending', starter: true, item: 1, parent: await c.parentFailed('runner_lost') }); } },
  { name: 'wait-paused-usage-limit', want: { reason: 'paused_usage_limit', limited_by: null }, setup: async (c) => { await c.runner({ credential: 'api_key', online: true, cap: { light: 8, heavy: 4 } }); await c.run({ role: 'executor', status: 'pending', starter: true, item: 1, parent: await c.parentFailed('usage_limit'), claimableAfterHours: 2 }); } },
  // A pending run a runner can take right now is not waiting on anything.
  { name: 'wait-none-claimable', want: null, setup: async (c) => { await c.runner({ credential: 'api_key', online: true, cap: { light: 8, heavy: 4 } }); await c.run({ role: 'executor', status: 'pending', starter: true, item: 1 }); } },
];

/** D#6 C42-3b against real Postgres: why a queued runner run waits, on both screens' reads, one pinned fixture per state. */
describe('the wait of a queued runner run through getWorkItemActivity and getRunInsight (D#6 C42-3b)', { timeout: 120_000 }, () => {
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

  async function getJson(urlPath: string, identity: { accountId: string; userId: string }, status = 200): Promise<unknown> {
    const token = await signSession(identity);
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${token}` });
    const res = await handleApiRequest(new Request(`http://localhost${urlPath}`, { headers }), appUserPool, platformOpsPool, ROUTES);
    expect(res.status).toBe(status);
    return res.json();
  }

  function pin(operationId: string, name: string, actual: unknown): void {
    const file = path.join(FIXTURES, operationId, `200-runner-${name}.json`);
    if (process.env.FX_WRITE_FIXTURES === '1') {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, pretty(actual));
    }
    expect(existsSync(file), `${file} is missing: run with FX_WRITE_FIXTURES=1 and read the diff`).toBe(true);
    expect(pretty(actual)).toBe(readFileSync(file, 'utf8'));
  }

  async function seedCase(n: number, c: Case): Promise<{ me: { accountId: string; userId: string }; itemId: string; runId: string }> {
    const me = await seedAccountWithMember(admin);
    const repoId = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, settings) VALUES ($1, $2, $3, 'team', 'acme', 'docs', '{}'::jsonb)`, [repoId, me.accountId, Math.floor(Math.random() * 1e9)]);
    const itemId = uuid('4', n);
    const runId = uuid('5', n);
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number, created_at) VALUES ($1, $2, $3, 'feature', 'internal', 'in_progress', 595, $4)`, [itemId, me.accountId, repoId, new Date(T0)]);
    const ctx: Ctx = {
      async runner(o) {
        const id = await insertRunner(admin, me.accountId, me.userId, { credentialMode: o.credential });
        await admin.query(`UPDATE runners SET last_seen_at = ${o.online ? 'now()' : "now() - interval '1 day'"}, protocol_version = 3, allowed_repo_ids = $2::uuid[] WHERE id = $1`, [id, [repoId]]);
        if (o.cap) await admin.query(`INSERT INTO runner_capacity (runner_id, account_id, declared, light_limit, heavy_limit, limited_by) VALUES ($1, $2, true, $3, $4, $5)`, [id, me.accountId, o.cap.light, o.cap.heavy, o.cap.limitedBy ?? null]);
        return id;
      },
      async run(o) {
        const id = o.item === undefined ? randomUUID() : runId;
        const running = o.status === 'running';
        await admin.query(
          `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, execution_mode, status, initiated_by, approved_by, runner_id, lease_generation, lease_expires_at, dispatch_repo_id, parent_run_id, claimable_after, created_at)
           VALUES ($1, $2, $3, $4, 'runner', 'runner_local', $5, $6, $6, $7, $8, ${running ? "now() + interval '60 seconds'" : 'NULL'}, $9, $10, ${o.claimableAfterHours === undefined ? 'NULL' : `now() + interval '${o.claimableAfterHours} hours'`}, $11)`,
          [id, me.accountId, o.item === undefined ? null : itemId, o.role, o.status, o.starter ? me.userId : null, o.runnerId ?? null, running ? 1 : 0, repoId, o.parent ?? null, new Date(T0)],
        );
        return id;
      },
      async parentFailed(reason) {
        const id = uuid('6', n);
        await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, execution_mode, status, dispatch_repo_id, created_at) VALUES ($1, $2, 'executor', 'runner', 'runner_local', 'failed', $3, $4)`, [id, me.accountId, repoId, new Date(T0)]);
        await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload) VALUES ($1, $2, 1, 'run.status_changed', $3::jsonb)`, [me.accountId, id, JSON.stringify({ from: 'running', to: 'failed', failureReason: reason })]);
        return id;
      },
    };
    await c.setup(ctx);
    return { me, itemId, runId };
  }

  const normalise = (insight: unknown): unknown => {
    const i = insight as { run: Record<string, unknown> } & Record<string, unknown>;
    return { ...i, server_time: SERVER_TIME, limits: LIMITS };
  };

  const seeded = new Map<string, { me: { accountId: string; userId: string }; runId: string }>();
  CASES.forEach((c, i) => {
    it(`${c.name}: both reads carry the wait, match their pinned fixture and their schema`, async () => {
      expect(runnerLimitsFor().maxConcurrentRunnerJobs).toBeGreaterThan(1);
      const s = await seedCase(i + 1, c);
      seeded.set(c.name, s);
      const activity = (await getJson(`/api/v1/work-items/${s.itemId}/activity`, s.me)) as { runs: Array<{ wait?: Wait | null }> };
      const insight = normalise(await getJson(`/api/v1/runs/${s.runId}/insight`, s.me)) as { wait?: Wait | null };
      expect(activityResponseSchema.safeParse(activity).success).toBe(true);
      expect(runInsightResponseSchema.safeParse(insight).success).toBe(true);
      pin('getWorkItemActivity', c.name, activity);
      pin('getRunInsight', c.name, insight);
      // The two screens read the same wait, and its sentence is the protocol's own.
      expect(activity.runs[0]!.wait).toEqual(insight.wait);
      if (c.want === null) expect(insight.wait).toBeNull();
      else expect(insight.wait).toEqual({ ...c.want, text: waitText(c.want.reason, c.want.limited_by) });
      expect(JSON.stringify(insight.wait)).not.toMatch(/undefined|NaN/);
    });
  });

  it('the sentence of every reason and every cause is plain words, written once', () => {
    for (const reason of RUN_WAIT_REASONS) {
      const text = waitText(reason, null);
      expect(text, reason).toMatch(/^[A-Z][^_]+$/);
      expect(Object.values(WAIT_LINES)).toContain(text);
    }
    const causes = LIMITED_BY.map((cause) => waitText('waiting_for_runner_slot', cause));
    expect(new Set(causes).size).toBe(LIMITED_BY.length);
    for (const text of causes) expect(text).toMatch(/^[A-Z][^_]+$/);
    // An unknown reason or cause never shows a code.
    expect(waitText('something_new', null)).toBe(WAIT_LINES.waiting_for_runner);
    expect(waitText('waiting_for_runner_slot', 'something_new')).toBe(WAIT_LINES.waiting_for_runner_slot);
  });

  it('only a pending runner run has a wait: a running or finished one, and a sandbox run, carry none', async () => {
    const me = await seedAccountWithMember(admin);
    const itemId = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, kind, provenance, stage, gh_number) VALUES ($1, $2, 'feature', 'internal', 'in_progress', 595)`, [itemId, me.accountId]);
    const make = async (runtime: string, status: string): Promise<string> => {
      const id = randomUUID();
      await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', $4, $5)`, [id, me.accountId, itemId, runtime, status]);
      return id;
    };
    for (const status of ['running', 'succeeded', 'failed']) {
      const insight = (await getJson(`/api/v1/runs/${await make('runner', status)}/insight`, me)) as { wait?: unknown };
      expect(insight.wait, status).toBeNull();
    }
    const sandbox = (await getJson(`/api/v1/runs/${await make('production', 'pending')}/insight`, me)) as Record<string, unknown>;
    expect('wait' in sandbox).toBe(false);
  });

  it("another account's run has no wait to read: the route answers 404 and the reader itself returns nothing", async () => {
    const mine = seeded.get('wait-no-runner')!;
    const other = await seedAccountWithMember(admin);
    await getJson(`/api/v1/runs/${mine.runId}/insight`, other, 404);
    expect(await readRunWait(appUserPool, other.accountId, { id: mine.runId, runtime: 'runner', status: 'pending' })).toBeNull();
    // Its own account still reads it.
    expect(await readRunWait(appUserPool, mine.me.accountId, { id: mine.runId, runtime: 'runner', status: 'pending' })).toMatchObject({ reason: 'waiting_for_runner' });
  });
});
