import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHECK_JOB_MIN_PROTOCOL } from '@fulcrumaxe/runner-protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertRunner } from '@fx/db/test/helpers/runnerFixtures.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { runInsightResponseSchema } from '../src/routes/run-insight.js';
import { seedAccountWithMember } from './helpers/seed.js';

const FX_SESSION_SECRET = 's'.repeat(32);
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'v1');
const T0 = Date.parse('2026-10-03T10:00:00.000Z');
const at = (seconds: number): Date => new Date(T0 + seconds * 1000);
const SERVER_TIME = '2026-10-03T12:00:00.000Z';
const LIMITS = { max_run_minutes: 60, max_model_calls: 300, per_run_usd: 40, max_turns: 100, silence_minutes: 15, max_extensions: 2, max_resumes: 2, auto_resume: true };
const uuid = (n: number): string => `00000000-0000-4000-8000-9${String(n).padStart(11, '0')}`;
const pretty = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const CHECK = { argv: ['pnpm', 'run', 'check', '--', 'a  b'], dev_shell: true, timeout_s: 1800 };

interface Row {
  exit_code: number | null;
  duration_ms: number;
  timed_out: boolean;
  skipped_tests: number | null;
  summary: string;
  /** D#6 R-CHK-3d: the runner's closed reason code; absent for a runner that sent none. */
  reason?: string;
}
interface Case {
  name: string;
  status: string;
  /** The signed job's check; undefined means the job carried none. */
  check?: typeof CHECK;
  row?: Row;
  noDevShell?: boolean;
  /** D#6 CHECK-FAILFILES-TO-CLOUD: the payload of the `run.check_ended` event the done route wrote (the failing test files, as stored). */
  ended_payload?: Record<string, unknown>;
  /** The runner's run_ended check_failed event (no detail), whose line the route words with the check's command. */
  ended?: boolean;
  /** The only runner covering the repo speaks this protocol: below the check's minimum, the run waits (pending). */
  oldRunner?: boolean;
}

const CASES: Case[] = [
  { name: 'check-not-set', status: 'succeeded' },
  { name: 'check-not-run', status: 'failed', check: CHECK },
  { name: 'check-running', status: 'running', check: CHECK },
  { name: 'check-passed', status: 'succeeded', check: CHECK, row: { exit_code: 0, duration_ms: 95_400, timed_out: false, skipped_tests: 3, summary: 'check files changed by this branch: scripts/check.sh\nTests  12 passed | 3 skipped (15)' } },
  { name: 'check-failed', status: 'failed', check: CHECK, ended: true, row: { exit_code: 1, duration_ms: 61_000, timed_out: false, skipped_tests: null, summary: 'FAIL src/a.test.ts\n  expected 1 to be 2 <b>x</b>' } },
  { name: 'check-timed-out', status: 'failed', check: CHECK, row: { exit_code: null, duration_ms: 1_800_000, timed_out: true, skipped_tests: null, summary: 'still running when it was stopped' } },
  { name: 'check-no-dev-shell', status: 'failed', check: CHECK, noDevShell: true, row: { exit_code: null, duration_ms: 0, timed_out: false, skipped_tests: null, summary: '' } },
  { name: 'check-not-safe', status: 'failed', check: CHECK, row: { exit_code: null, duration_ms: 12, timed_out: false, skipped_tests: null, summary: "the check was not run: these files could not be pinned (a link or a non-file on the path): scripts/check.sh" } },
  // D#6 R-CHK-3d: a result with a reason code, one per way the check can be refused; the first has the runner's refusal words too, the last ran and was stopped from counting.
  { name: 'check-unsafe-sandbox-refused', status: 'failed', check: CHECK, ended: true, row: { exit_code: null, duration_ms: 9, timed_out: false, skipped_tests: null, summary: 'no seccomp filter on this platform', reason: 'sandbox_refused' } },
  { name: 'check-unsafe-pin-failed', status: 'failed', check: CHECK, ended: true, row: { exit_code: null, duration_ms: 12, timed_out: false, skipped_tests: null, summary: 'the check was not run: these files could not be pinned (a link or a non-file on the path): scripts/check.sh', reason: 'pin_failed' } },
  { name: 'check-unsafe-protected-changed', status: 'failed', check: CHECK, ended: true, row: { exit_code: 0, duration_ms: 31_000, timed_out: false, skipped_tests: null, summary: 'the check changed paths it may not (put back where possible): pnpm-lock.yaml', reason: 'protected_changed' } },
  { name: 'check-runner-too-old', status: 'pending', check: CHECK, oldRunner: true },
  { name: 'check-failed-files', status: 'failed', check: CHECK, ended: true, ended_payload: { exit_code: 1, timed_out: false, duration_ms: 61_000, failed_files: ['apps/ops/test/scan.test.ts', 'packages/db/test/a.pg.test.ts'], failed_files_more: 3 }, row: { exit_code: 1, duration_ms: 61_000, timed_out: false, skipped_tests: null, summary: 'failed test files (5): apps/ops/test/scan.test.ts, packages/db/test/a.pg.test.ts (and 3 more)\nFAIL x' } },
];

/** D#6 R-CHK-3b against real Postgres: the check on the run detail, read through the real route for every state the screen draws, pinned as fixtures. */
describe('the run check through getRunInsight (D#6 R-CHK-3b)', { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  let me: { accountId: string; userId: string };
  let repoId: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = FX_SESSION_SECRET;
    me = await seedAccountWithMember(admin);
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

  async function insight(runId: string, identity = me): Promise<Record<string, unknown>> {
    const token = await signSession(identity);
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${token}` });
    const res = await handleApiRequest(new Request(`http://localhost/api/v1/runs/${runId}/insight`, { headers }), appUserPool, platformOpsPool, ROUTES);
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  async function seed(c: Case, n: number, minProtocol: number | null = null): Promise<string> {
    const runId = uuid(n);
    const live = c.status === 'running';
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, execution_mode, status, initiated_by, approved_by, dispatch_repo_id, created_at, started_at, ended_at, job_signed, min_protocol_version)
       VALUES ($1, $2, 'executor', 'runner', 'runner_local', $3, $4, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
      [runId, me.accountId, c.status, me.userId, repoId, at(0), c.status === 'pending' ? null : at(1), live || c.status === 'pending' ? null : at(60), c.check ? JSON.stringify({ job: { check: c.check } }) : JSON.stringify({ job: {} }), minProtocol],
    );
    if (c.ended) {
      await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload, created_at) VALUES ($1, $2, 1, 'runner.event', $3::jsonb, $4)`, [me.accountId, runId, JSON.stringify({ type: 'run_ended', reason: 'check_failed' }), at(2)]);
    }
    if (c.noDevShell) {
      await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload, created_at) VALUES ($1, $2, 1, 'runner.event', $3::jsonb, $4)`, [me.accountId, runId, JSON.stringify({ type: 'run_ended', reason: 'check_failed', detail: 'check_no_dev_shell' }), at(2)]);
    }
    if (c.ended_payload) {
      await admin.query(`INSERT INTO run_events (account_id, run_id, seq, kind, payload, created_at) VALUES ($1, $2, 2, 'run.check_ended', $3::jsonb, $4)`, [me.accountId, runId, JSON.stringify(c.ended_payload), at(59)]);
    }
    if (c.row) {
      await admin.query(`INSERT INTO run_checks (account_id, run_id, exit_code, duration_ms, timed_out, skipped_tests, summary, reason) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [me.accountId, runId, c.row.exit_code, c.row.duration_ms, c.row.timed_out, c.row.skipped_tests, c.row.summary, c.row.reason ?? null]);
    }
    return runId;
  }

  function pin(name: string, actual: unknown): void {
    const file = path.join(FIXTURES, 'getRunInsight', `200-${name}.json`);
    if (process.env.FX_WRITE_FIXTURES === '1') {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, pretty(actual));
    }
    expect(existsSync(file), `${file} is missing: run with FX_WRITE_FIXTURES=1 and read the diff`).toBe(true);
    expect(pretty(actual)).toBe(readFileSync(file, 'utf8'));
  }
  const normalise = (body: Record<string, unknown>): Record<string, unknown> => {
    const run = body.run as Record<string, unknown>;
    return { ...body, server_time: SERVER_TIME, run: { ...run, started_at: run.started_at === null ? null : at(1).toISOString(), ended_at: run.ended_at === null ? null : at(60).toISOString() }, limits: LIMITS };
  };

  const bodies = new Map<string, Record<string, unknown>>();
  CASES.forEach((c, i) => {
    it(`${c.name}: the read matches its pinned fixture and the response schema`, async () => {
      if (c.oldRunner) {
        const runner = await insertRunner(admin, me.accountId, me.userId, { credentialMode: 'api_key' });
        await admin.query(`UPDATE runners SET last_seen_at = now(), protocol_version = ${CHECK_JOB_MIN_PROTOCOL - 1}, allowed_repo_ids = $2::uuid[] WHERE id = $1`, [runner, [repoId]]);
      }
      const runId = await seed(c, i + 1, c.oldRunner ? CHECK_JOB_MIN_PROTOCOL : null);
      const body = normalise(await insight(runId));
      expect(runInsightResponseSchema.safeParse(body).success).toBe(true);
      bodies.set(c.name, body);
      pin(c.name, body);
    });
  });

  it('what each state reads', () => {
    const check = (name: string) => bodies.get(name)!.check as { argv: string[]; no_dev_shell: boolean; result: Row | null } | undefined;
    // No check in the job: no field at all, which is how "not set" is told from "not run".
    expect('check' in bodies.get('check-not-set')!).toBe(false);
    expect(check('check-not-run')).toMatchObject({ argv: CHECK.argv, no_dev_shell: false, result: null });
    expect(check('check-running')!.result).toBeNull();
    expect(check('check-passed')!.result).toMatchObject({ exit_code: 0, timed_out: false, skipped_tests: 3 });
    expect(check('check-timed-out')!.result).toMatchObject({ exit_code: null, timed_out: true });
    expect(check('check-no-dev-shell')!.no_dev_shell).toBe(true);
    // D#6 R-CHK-3d: the reason code is on the result as the closed code, null when the runner sent none (a failing exit, a pass, a legacy row), and the end line names the check.
    expect(check('check-unsafe-sandbox-refused')!.result).toMatchObject({ reason: 'sandbox_refused' });
    expect(check('check-unsafe-pin-failed')!.result).toMatchObject({ reason: 'pin_failed' });
    expect(check('check-unsafe-protected-changed')!.result).toMatchObject({ exit_code: 0, reason: 'protected_changed' });
    for (const name of ['check-passed', 'check-failed', 'check-timed-out', 'check-not-safe']) expect(check(name)!.result, name).toMatchObject({ reason: null });
    const endLine = (name: string): string | undefined => (bodies.get(name)!.lines as Array<{ text: string }>).find((l) => /approved check/.test(l.text))?.text;
    expect(endLine('check-failed')).toBe('The approved check (pnpm run check -- a  b) failed, so this run ended without a pull request.');
    for (const name of ['check-unsafe-sandbox-refused', 'check-unsafe-pin-failed', 'check-unsafe-protected-changed']) expect(endLine(name), name).toBe('The approved check (pnpm run check -- a  b) could not run safely, so this run ended without a pull request.');
    expect(endLine('check-passed')).toBeUndefined();
    // The argument with two spaces reaches the screen exactly as approved.
    expect(check('check-failed')!.argv[4]).toBe('a  b');
    // The too-old runner is told by the wait, which the screen reads next to the check.
    expect((bodies.get('check-runner-too-old')!.wait as { reason: string }).reason).toBe('runner_too_old_for_check');
  });

  it('D#6 CHECK-FAILFILES-TO-CLOUD: the card gets the names and the count of the rest; a stored list that fails the strict reader is not shown, and the result still is', async () => {
    const files = (name: string) => (bodies.get(name)!.check as { result: Row & { failed_files?: string[]; failed_files_more?: number } }).result;
    expect(files('check-failed-files')).toMatchObject({ failed_files: ['apps/ops/test/scan.test.ts', 'packages/db/test/a.pg.test.ts'], failed_files_more: 3 });
    expect('failed_files' in files('check-failed')).toBe(false);
    const base = { name: 'x', status: 'failed', check: CHECK, row: { exit_code: 1, duration_ms: 1, timed_out: false, skipped_tests: null, summary: 'FAIL' } } as Case;
    let n = 100;
    for (const bad of [['/abs/x.test.ts'], ['../x.test.ts'], ['a/../b.ts'], [7], 'a.test.ts', Array.from({ length: 21 }, (_, i) => `t/${String(i)}.test.ts`), ['a.test.ts', 'a.test.ts'], ['x'.repeat(201)]]) {
      const runId = await seed({ ...base, ended_payload: { failed_files: bad } }, (n += 1));
      const result = ((await insight(runId)).check as { result: Record<string, unknown> }).result;
      expect(result, JSON.stringify(bad).slice(0, 30)).toMatchObject({ exit_code: 1 });
      expect('failed_files' in result, JSON.stringify(bad).slice(0, 30)).toBe(false);
    }
  });

  it("a sandbox run and another account's read see no check", async () => {
    const sandboxId = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, job_signed) VALUES ($1, $2, 'executor', 'production', 'succeeded', $3::jsonb)`, [sandboxId, me.accountId, JSON.stringify({ job: { check: CHECK } })]);
    expect('check' in (await insight(sandboxId))).toBe(false);
    const other = await seedAccountWithMember(admin);
    const token = await signSession(other);
    const res = await handleApiRequest(new Request(`http://localhost/api/v1/runs/${uuid(4)}/insight`, { headers: new Headers({ cookie: `${SESSION_COOKIE_NAME}=${token}` }) }), appUserPool, platformOpsPool, ROUTES);
    expect(res.status).toBe(404);
  });
});
