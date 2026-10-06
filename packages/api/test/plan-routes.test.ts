import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { insertApiToken, type Scope } from '@fx/core/src/tokens/service.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import type { PlanSource } from '@fx/core/src/plan/index.js';
import { generateToken } from '../src/tokens/format.js';
import { hashToken } from '../src/tokens/resolve.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { planImportDeps } from '../src/routes/plan.js';
import { runActionDeps } from '../src/routes/run-actions.js';
import { seedAccountWithMember } from './helpers/seed.js';

interface Identity {
  accountId: string;
  userId: string;
}
interface ErrBody {
  error: { code: string };
}

/**
 * D#483 S3 (live build L1): the three plan routes through the real dispatcher against real Postgres, with a fake read-only
 * source standing in for GitHub. Allowed paths, every refusal, and that nothing but the plan tables is written.
 */
const FIXTURES = new URL('../../core/test/fixtures/plan/', import.meta.url);
const COMPARE = fileURLToPath(new URL('../../../scripts/ops/plan-compare.mjs', import.meta.url));
const SHA = 'e'.repeat(40);

function fakeSource(files: Record<string, string>, pulls: Array<{ number: number; title: string; state: 'open' | 'merged' | 'closed'; dLines: string[] }> = []): PlanSource {
  return {
    async head() {
      return { defaultBranch: 'main', sha: SHA };
    },
    async file(p) {
      return files[p] ?? null;
    },
    async pulls() {
      return { pulls, truncated: false };
    },
    evidence() {
      return { requests: [{ method: 'GET', path: '/repos/acme/widgets/issues', status: 200 }], tokenPermissions: { metadata: 'read', contents: 'read', issues: 'read', discussions: 'read' } };
    },
  };
}
const smallRoadmap = JSON.stringify({
  milestones: { m1: { definition: 'First milestone. More.', tasks: ['D#1:A', 'D#1:B'] } },
  task_status: { 'D#1:A': { milestone: 'm1', planned_prs: 1, prs: [10] }, 'D#1:B': { milestone: 'm1', planned_prs: 1, prs: [] } },
});

describe('plan routes (D#483 S3)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  const pending: Promise<unknown>[] = [];
  let source: PlanSource | null;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    admin.release();
    await Promise.all([adminPool.end(), platformOpsPool.end(), appUserPool.end()]);
  });
  beforeEach(() => {
    pending.length = 0;
    source = fakeSource({ 'roadmap.json': smallRoadmap }, [{ number: 10, title: 'A', state: 'merged', dLines: [] }]);
    planImportDeps.openSource = () => source!;
    planImportDeps.schedule = (work) => {
      pending.push(work());
    };
  });
  afterEach(() => {
    planImportDeps.openSource = null;
    planImportDeps.schedule = (work) => {
      void work();
    };
  });

  const person = (role: 'owner' | 'admin' | 'member') => seedAccountWithMember(admin, { role });
  async function repoFor(who: Identity, o: { connected?: boolean } = {}): Promise<string> {
    const inst = randomUUID();
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, floor(random() * 2000000000)::bigint + 1, 'team_readonly')`, [inst, who.accountId]);
    const id = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, $4, 'team', 'acme', 'widgets')`, [id, who.accountId, o.connected === false ? null : inst, Math.floor(Math.random() * 1e9) + 5]);
    return id;
  }
  async function call(who: Identity | string | null, method: string, urlPath: string): Promise<Response> {
    const h = new Headers();
    if (typeof who === 'string') h.set('authorization', `Bearer ${who}`);
    else if (who) h.set('cookie', `${SESSION_COOKIE_NAME}=${await signSession(who)}`);
    return handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { method, headers: h }), appUserPool, platformOpsPool, ROUTES);
  }
  const start = (who: Identity | string | null, repoId: string) => call(who, 'POST', `/repos/${repoId}/plan-imports`);
  const settle = async () => {
    await Promise.all(pending);
    pending.length = 0;
  };
  const code = async (res: Response) => ((await res.json()) as ErrBody).error.code;
  async function tokenFor(who: Identity, scopes: Scope[]): Promise<string> {
    const plaintext = generateToken();
    await insertApiToken(appUserPool, { accountId: who.accountId, createdBy: who.userId, tokenHash: hashToken(plaintext), displayHint: 'fxat_...test', scopes, expiresAt: new Date(Date.now() + 86_400_000) });
    return plaintext;
  }
  const counts = async (who: Identity) => ({
    work_items: (await admin.query('SELECT count(*)::int n FROM work_items WHERE account_id = $1', [who.accountId])).rows[0].n,
    agent_runs: (await admin.query('SELECT count(*)::int n FROM agent_runs WHERE account_id = $1', [who.accountId])).rows[0].n,
    run_action_requests: (await admin.query('SELECT count(*)::int n FROM run_action_requests WHERE account_id = $1', [who.accountId])).rows[0].n,
  });

  it('an owner starts an import: 202 at once, the import runs after the response, and the plan and latest import read back', async () => {
    const who = await person('owner');
    const repoId = await repoFor(who);
    const before = await counts(who);
    runActionDeps.getRunActionSignal = () => {
      throw new Error('an import must not ask for a run action');
    };
    try {
      const res = await start(who, repoId);
      expect(res.status).toBe(202);
      const body = (await res.json()) as { import_id: string; action_id: null; state: string };
      expect(body).toMatchObject({ action_id: null, state: 'running' });
      // the row is there and running before the work is awaited; the work runs only after the response
      expect((await admin.query('SELECT state FROM plan_imports WHERE id = $1', [body.import_id])).rows[0].state).toBe('running');
      await settle();

      const latest = await call(who, 'GET', `/repos/${repoId}/plan-imports/latest`);
      expect(latest.status).toBe(200);
      expect(await latest.json()).toMatchObject({ id: body.import_id, state: 'succeeded', level: 'roadmap_file', source_path: 'roadmap.json', source_sha: SHA, truncated: false, error_code: null, token_permissions: { contents: 'read' } });

      const plan = await call(who, 'GET', `/repos/${repoId}/plan`);
      expect(plan.status).toBe(200);
      const view = (await plan.json()) as { milestones: unknown[]; totals: unknown; tasks: Array<{ task_key: string; status: string }>; next_cursor: string | null; imported_from: { id: string } };
      expect(view.totals).toEqual({ tasks: 2, done: 1, remaining: 1 });
      expect(view.milestones).toEqual([{ key: 'm1', title: 'm1: First milestone.', position: 0, tasks: 2, done: 1, remaining: 1 }]);
      expect(view.tasks.map((t) => [t.task_key, t.status])).toEqual([['D#1:A', 'done'], ['D#1:B', 'not_started']]);
      expect(view.imported_from.id).toBe(body.import_id);

      expect(await counts(who)).toEqual(before);
    } finally {
      runActionDeps.getRunActionSignal = () => null;
    }
  });

  it('refuses a member (403), a token even with every scope (403), and no credential (401); nothing is written', async () => {
    const owner = await person('owner');
    const repoId = await repoFor(owner);
    const memberId = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [memberId, `${memberId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [owner.accountId, memberId]);
    const res = await start({ accountId: owner.accountId, userId: memberId }, repoId);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('insufficient_role');
    const tok = await tokenFor(owner, ['read', 'work_items:write', 'runs:cancel', 'audit:read']);
    const viaToken = await start(tok, repoId);
    expect(viaToken.status).toBe(403);
    expect(await code(viaToken)).toBe('session_required');
    expect((await start(null, repoId)).status).toBe(401);
    expect(pending).toHaveLength(0);
    expect((await admin.query('SELECT count(*)::int n FROM plan_imports WHERE repo_id = $1', [repoId])).rows[0].n).toBe(0);
  });

  it('an admin may start; an unknown repo and another tenant\'s repo are 404; a detached repo is 409 repo_not_connected', async () => {
    const admin1 = await person('admin');
    const repoId = await repoFor(admin1);
    expect((await start(admin1, repoId)).status).toBe(202);
    await settle();
    const other = await person('owner');
    expect((await start(other, repoId)).status).toBe(404);
    expect((await start(admin1, randomUUID())).status).toBe(404);
    expect((await start(admin1, 'not-a-uuid')).status).toBe(404);
    const detached = await repoFor(admin1, { connected: false });
    const res = await start(admin1, detached);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('repo_not_connected');
  });

  it('one import at a time: a second start while one runs is 409 import_running, then allowed once it ends', async () => {
    const who = await person('owner');
    const repoId = await repoFor(who);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = fakeSource({ 'roadmap.json': smallRoadmap });
    const inner = slow.head.bind(slow);
    slow.head = async () => {
      await gate;
      return inner();
    };
    source = slow;
    expect((await start(who, repoId)).status).toBe(202);
    const second = await start(who, repoId);
    expect(second.status).toBe(409);
    expect(await code(second)).toBe('import_running');
    release();
    await settle();
    expect((await start(who, repoId)).status).toBe(202);
    await settle();
  });

  it('with no GitHub reader registered the start is 503 plan_import_unavailable and writes nothing', async () => {
    const who = await person('owner');
    const repoId = await repoFor(who);
    planImportDeps.openSource = null;
    const res = await start(who, repoId);
    expect(res.status).toBe(503);
    expect(await code(res)).toBe('plan_import_unavailable');
    expect((await admin.query('SELECT count(*)::int n FROM plan_imports WHERE repo_id = $1', [repoId])).rows[0].n).toBe(0);
  });

  it('the seventh start in an hour for one repository is 429 rate_limited with Retry-After, for a session', async () => {
    const who = await person('owner');
    const repoId = await repoFor(who);
    for (let i = 0; i < 6; i += 1) {
      expect((await start(who, repoId)).status).toBe(202);
      await settle();
    }
    const res = await start(who, repoId);
    expect(res.status).toBe(429);
    expect(await code(res)).toBe('rate_limited');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('a failed import is visible as failed with its code, and says why in words; the previous plan stays', async () => {
    const who = await person('owner');
    const repoId = await repoFor(who);
    await start(who, repoId);
    await settle();
    source = fakeSource({ 'roadmap.json': JSON.stringify({ milestones: { a: { tasks: ['X'] }, b: { tasks: ['X'] } }, task_status: { X: { planned_prs: 1 } } }) });
    await start(who, repoId);
    await settle();
    const latest = (await (await call(who, 'GET', `/repos/${repoId}/plan-imports/latest`)).json()) as { state: string; error_code: string; error_detail: string };
    expect(latest).toMatchObject({ state: 'failed', error_code: 'plan_file_inconsistent' });
    expect(latest.error_detail).toContain('X');
    const view = (await (await call(who, 'GET', `/repos/${repoId}/plan`)).json()) as { totals: unknown; latest_import: { state: string }; imported_from: { state: string } };
    expect(view.totals).toEqual({ tasks: 2, done: 1, remaining: 1 });
    expect(view.latest_import.state).toBe('failed');
    expect(view.imported_from.state).toBe('succeeded');
  });

  it('GET latest: 404 never_imported for a repo with no import, 404 not_found for another tenant; a read token may read, a member may read', async () => {
    const who = await person('owner');
    const repoId = await repoFor(who);
    const never = await call(who, 'GET', `/repos/${repoId}/plan-imports/latest`);
    expect(never.status).toBe(404);
    expect(await code(never)).toBe('never_imported');
    expect(await (await call(who, 'GET', `/repos/${repoId}/plan`)).json()).toMatchObject({ latest_import: null, imported_from: null, tasks: [], next_cursor: null });
    await start(who, repoId);
    await settle();
    const other = await person('owner');
    const hidden = await call(other, 'GET', `/repos/${repoId}/plan-imports/latest`);
    expect(hidden.status).toBe(404);
    expect(await code(hidden)).toBe('not_found');
    expect((await call(other, 'GET', `/repos/${repoId}/plan`)).status).toBe(404);
    const read = await tokenFor(who, ['read']);
    expect((await call(read, 'GET', `/repos/${repoId}/plan-imports/latest`)).status).toBe(200);
    expect((await call(read, 'GET', `/repos/${repoId}/plan`)).status).toBe(200);
    const noScope = await tokenFor(who, ['runs:cancel']);
    expect((await call(noScope, 'GET', `/repos/${repoId}/plan`)).status).toBe(403);
  });

  it('GET plan: filters by milestone and status, pages by cursor, and rejects a bad status', async () => {
    const who = await person('owner');
    const repoId = await repoFor(who);
    const tasks: Record<string, unknown> = {};
    for (let i = 0; i < 5; i += 1) tasks[`D#1:T${i}`] = { milestone: 'm1', planned_prs: 1, prs: i % 2 === 0 ? [i + 1] : [] };
    source = fakeSource(
      { 'roadmap.json': JSON.stringify({ milestones: { m1: { tasks: Object.keys(tasks).slice(0, 3) }, m2: { tasks: Object.keys(tasks).slice(3) } }, task_status: tasks }) },
      [1, 3, 5].map((n) => ({ number: n, title: `p${n}`, state: 'merged' as const, dLines: [] })),
    );
    await start(who, repoId);
    await settle();
    const page = (await (await call(who, 'GET', `/repos/${repoId}/plan?limit=2`)).json()) as { tasks: Array<{ task_key: string }>; next_cursor: string };
    expect(page.tasks.map((t) => t.task_key)).toEqual(['D#1:T0', 'D#1:T1']);
    const next = (await (await call(who, 'GET', `/repos/${repoId}/plan?limit=2&cursor=${encodeURIComponent(page.next_cursor)}`)).json()) as { tasks: Array<{ task_key: string }> };
    expect(next.tasks.map((t) => t.task_key)).toEqual(['D#1:T2', 'D#1:T3']);
    const done = (await (await call(who, 'GET', `/repos/${repoId}/plan?status=done&milestone=m1`)).json()) as { tasks: Array<{ task_key: string }> };
    expect(done.tasks.map((t) => t.task_key)).toEqual(['D#1:T0', 'D#1:T2']);
    expect((await call(who, 'GET', `/repos/${repoId}/plan?status=wat`)).status).toBe(422);
  });

  /** Imports the frozen fixture over HTTP and returns the `?format=full` answer text. */
  async function importFixtureFull(): Promise<string> {
    const who = await person('owner');
    const repoId = await repoFor(who);
    const roadmap = readFileSync(new URL('roadmap.json', FIXTURES), 'utf8');
    const pulls = (JSON.parse(readFileSync(new URL('pulls.json', FIXTURES), 'utf8')) as { pulls: Array<{ number: number; title: string; state: 'open' | 'merged' | 'closed'; dLines: string[] }> }).pulls;
    source = fakeSource({ '.autonomous-team/roadmap.json': roadmap }, pulls);
    expect((await start(who, repoId)).status).toBe(202);
    await settle();
    const full = await call(who, 'GET', `/repos/${repoId}/plan?format=full`);
    expect(full.status).toBe(200);
    return full.text();
  }

  it('A1 over HTTP: the frozen fixture imported, ?format=full carries every task and the expected totals', async () => {
    const text = await importFixtureFull();
    const parsed = JSON.parse(text) as { totals: unknown; tasks: unknown[]; next_cursor: string | null };
    expect(parsed.totals).toEqual({ tasks: 19, done: 7, remaining: 12 });
    expect(parsed.tasks).toHaveLength(19);
    expect(parsed.next_cursor).toBeNull();
  });

  // scripts/ops/ is a private overlay directory: the comparison script is absent from the public tree.
  it.skipIf(!existsSync(COMPARE))('A1 end to end: the ?format=full answer piped into the comparison script, which exits 0', async () => {
    const text = await importFixtureFull();
    const dir = mkdtempSync(path.join(tmpdir(), 's3l1_a1_'));
    try {
      const planFile = path.join(dir, 'plan.json');
      writeFileSync(planFile, text);
      const roadmapFile = fileURLToPath(new URL('roadmap.json', FIXTURES));
      // The import read the highest merged pull request the fixture holds; the file says the same (40).
      const r = spawnSync('node', [COMPARE, '--plan', planFile, '--roadmap', roadmapFile], { encoding: 'utf8' });
      expect(r.status, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain('A1: PASS');
      expect(r.stdout).toMatch(/TOTAL\s+19\s+7\s+12/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
