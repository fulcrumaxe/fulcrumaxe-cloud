import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';
import { publicChangeDeps } from '../src/routes/work-item-actions.js';
import { seedAccountWithMember } from './helpers/seed.js';

const SHA = 'a'.repeat(40);
const TIP = 'b'.repeat(40);

type Role = 'owner' | 'admin' | 'member';
interface Seed {
  state: string;
  code?: string;
  /** Push attempts and the runtime of the latest one. */
  attempts?: { runtime: 'runner' | 'sandbox'; count: number };
  managed?: boolean;
}

/** D#598 P1f-6b through the real dispatcher against real Postgres: `retry_push` and `open_pr` for every state of a change, each refusal writing nothing. */
describe('retry_push and open_pr routes (D#598 P1f-6b)', { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;
  const started: Array<{ accountId: string; userId: string; workItemId: string }> = [];
  const opened: Array<{ accountId: string; workItemId: string }> = [];
  let openAnswer: Awaited<ReturnType<NonNullable<typeof publicChangeDeps.openPublicPullRequest>>> = { kind: 'opened', prNumber: 9 };
  let startFails = false;

  beforeAll(async () => {
    adminPool = createPool(process.env.API_DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.API_DATABASE_URL_APP_USER!);
    platformOpsPool = createPool(process.env.API_DATABASE_URL_PLATFORM_OPS!);
    process.env.FX_SESSION_SECRET = 's'.repeat(32);
  });
  afterAll(async () => {
    delete process.env.FX_SESSION_SECRET;
    publicChangeDeps.startRetryPush = null;
    publicChangeDeps.openPublicPullRequest = null;
    admin.release();
    await adminPool.end();
    await appUserPool.end();
    await platformOpsPool.end();
  });
  beforeEach(() => {
    started.length = 0;
    opened.length = 0;
    startFails = false;
    openAnswer = { kind: 'opened', prNumber: 9 };
    publicChangeDeps.startRetryPush = async (a) => {
      if (startFails) throw new Error('workflow service down');
      started.push(a);
    };
    publicChangeDeps.openPublicPullRequest = async (a) => {
      opened.push(a);
      return openAnswer;
    };
  });

  const person = (role: Role) => seedAccountWithMember(admin, { role });
  async function post(who: { accountId: string; userId: string }, urlPath: string): Promise<Response> {
    const headers = new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(who)}` });
    return handleApiRequest(new Request(`http://localhost/api/v1${urlPath}`, { method: 'POST', headers }), appUserPool, platformOpsPool, ROUTES);
  }
  const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

  async function seed(accountId: string, s: Seed): Promise<string> {
    const repoId = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, settings) VALUES ($1, $2, $3, 'team', 'acme', 'docs', '{}'::jsonb)`, [repoId, accountId, Math.floor(Math.random() * 1e9)]);
    const itemId = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage, gh_number) VALUES ($1, $2, $3, 'feature', 'internal', 'in_progress', 595)`, [itemId, accountId, repoId]);
    const pushId = randomUUID();
    const shaped = ['pushed', 'pr_opened', 'pushed_pr_not_opened'].includes(s.state);
    const pr = s.state === 'pr_opened';
    await admin.query(
      `INSERT INTO plane_pushes (id, account_id, work_item_id, repo_id, code_repo, pairing_digest, head_sha, tip_sha, pr_number, pr_url, state, code, managed_by_person_at)
       VALUES ($1, $2, $3, $4, 'acme/docs-public', $5, $6, $7, $8, $9, $10, $11, $12)`,
      [pushId, accountId, itemId, repoId, 'c'.repeat(64), shaped ? SHA : null, shaped ? TIP : null, pr ? 88 : null, pr ? 'https://github.com/acme/docs-public/pull/88' : null, s.state, s.code ?? null, s.managed ? new Date() : null],
    );
    for (let k = 1; k <= (s.attempts?.count ?? 0); k++) {
      await admin.query(
        `INSERT INTO plane_push_attempts (account_id, plane_push_id, runtime, lease_generation, kind, attempt_no, outcome) VALUES ($1, $2, $3, $4, 'push', $5, 'refused')`,
        [accountId, pushId, s.attempts!.runtime, s.attempts!.runtime === 'runner' ? k : null, k],
      );
    }
    return itemId;
  }
  const audits = async (accountId: string) => (await admin.query<{ payload: Record<string, unknown>; actor: string }>(`SELECT payload, actor FROM audit_log WHERE account_id = $1 AND action = 'work_item.sent_back'`, [accountId])).rows;
  const pushRow = async (itemId: string) => (await admin.query<{ state: string; code: string | null }>('SELECT state, code FROM plane_pushes WHERE work_item_id = $1', [itemId])).rows[0];
  const attemptCount = async (accountId: string) => Number((await admin.query<{ n: string }>('SELECT count(*) AS n FROM plane_push_attempts WHERE account_id = $1', [accountId])).rows[0]!.n);

  const REFUSED: Seed = { state: 'refused', code: 'public_unavailable', attempts: { runtime: 'sandbox', count: 1 } };

  it.each([
    ['owner', REFUSED],
    ['admin', { ...REFUSED, attempts: { runtime: 'sandbox' as const, count: 2 } }],
  ] as const)('an %s on a refused push of a sandbox build: 202 started, one job started with plain ids, one audit row, and the route itself writes no attempt and moves no state', async (role, seedIt) => {
    const p = await person(role);
    const item = await seed(p.accountId, seedIt);
    const before = await attemptCount(p.accountId);
    const res = await post(p, `/work-items/${item}/retry-push`);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ work_item_id: item, state: 'started' });
    expect(started).toEqual([{ accountId: p.accountId, userId: p.userId, workItemId: item }]);
    const rows = await audits(p.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ work_item_id: item, action: 'retry_push', public_change_state: 'refused' });
    expect(rows[0]!.actor).toBe(p.userId);
    expect(await attemptCount(p.accountId)).toBe(before);
    expect(await pushRow(item)).toEqual({ state: 'refused', code: 'public_unavailable' });
  });

  const NOT_RETRYABLE: Array<[string, Seed]> = [
    ['building', { state: 'building' }],
    ['scanning', { state: 'scanning' }],
    ['pushed', { state: 'pushed' }],
    ['pr_opened', { state: 'pr_opened' }],
    ['no_public_change', { state: 'no_public_change' }],
    ['pushed_pr_not_opened', { state: 'pushed_pr_not_opened' }],
    ['refused after three attempts', { state: 'refused', code: 'retry_limit', attempts: { runtime: 'sandbox', count: 3 } }],
    ['refused on a run on the person’s machine', { state: 'refused', code: 'public_unavailable', attempts: { runtime: 'runner', count: 1 } }],
    ['refused, branch taken over', { ...REFUSED, managed: true }],
  ];
  it.each(NOT_RETRYABLE)('retry_push on %s answers 409 action_not_available, starts nothing and audits nothing', async (_name, s) => {
    const p = await person('owner');
    const item = await seed(p.accountId, s);
    const res = await post(p, `/work-items/${item}/retry-push`);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('action_not_available');
    expect(started).toEqual([]);
    expect(await audits(p.accountId)).toEqual([]);
  });

  const NOT_OPENABLE: Array<[string, Seed]> = [
    ['building', { state: 'building' }],
    ['pushed', { state: 'pushed' }],
    ['pr_opened', { state: 'pr_opened' }],
    ['refused', REFUSED],
    ['pushed_pr_not_opened, branch taken over', { state: 'pushed_pr_not_opened', managed: true }],
  ];
  it.each(NOT_OPENABLE)('open_pr on %s answers 409 action_not_available, opens nothing and audits nothing', async (_name, s) => {
    const p = await person('owner');
    const item = await seed(p.accountId, s);
    const res = await post(p, `/work-items/${item}/open-pr`);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('action_not_available');
    expect(opened).toEqual([]);
    expect(await audits(p.accountId)).toEqual([]);
  });

  it('open_pr on pushed_pr_not_opened: 200 with the number, one audit row, called once with ids', async () => {
    const p = await person('owner');
    const item = await seed(p.accountId, { state: 'pushed_pr_not_opened' });
    const res = await post(p, `/work-items/${item}/open-pr`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ work_item_id: item, result: 'opened', code: null, pr_number: 9 });
    expect(opened).toEqual([{ accountId: p.accountId, workItemId: item }]);
    expect((await audits(p.accountId))[0]!.payload).toMatchObject({ action: 'open_pr', public_change_state: 'pushed_pr_not_opened' });
  });

  it('open_pr that GitHub refuses answers 200 refused with a fixed code, and the pushed state stays', async () => {
    const p = await person('owner');
    const item = await seed(p.accountId, { state: 'pushed_pr_not_opened' });
    openAnswer = { kind: 'refused', code: 'pr_failed' };
    const res = await post(p, `/work-items/${item}/open-pr`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ work_item_id: item, result: 'refused', code: 'pr_failed', pr_number: null });
    expect((await pushRow(item))!.state).toBe('pushed_pr_not_opened');
  });

  it('open_pr when the worker says the item moved on is 409; with no worker it is 503', async () => {
    const p = await person('owner');
    const item = await seed(p.accountId, { state: 'pushed_pr_not_opened' });
    openAnswer = { kind: 'skipped' };
    expect((await post(p, `/work-items/${item}/open-pr`)).status).toBe(409);
    openAnswer = { kind: 'not_configured' };
    expect((await post(p, `/work-items/${item}/open-pr`)).status).toBe(503);
  });

  it('a member is 403 on both and nothing is audited or started', async () => {
    const p = await person('member');
    const a = await seed(p.accountId, REFUSED);
    const b = await seed(p.accountId, { state: 'pushed_pr_not_opened' });
    for (const res of [await post(p, `/work-items/${a}/retry-push`), await post(p, `/work-items/${b}/open-pr`)]) {
      expect(res.status).toBe(403);
      expect(await code(res)).toBe('insufficient_role');
    }
    expect(started).toEqual([]);
    expect(opened).toEqual([]);
    expect(await audits(p.accountId)).toEqual([]);
  });

  it('another account’s item is 404', async () => {
    const mine = await person('owner');
    const theirs = await person('owner');
    const item = await seed(theirs.accountId, REFUSED);
    expect((await post(mine, `/work-items/${item}/retry-push`)).status).toBe(404);
    expect(started).toEqual([]);
  });

  it('while an agent run of the item is live (a publish run included) the answer is 409 already_running and nothing is started', async () => {
    const p = await person('owner');
    const item = await seed(p.accountId, REFUSED);
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'production', 'running')`, [randomUUID(), p.accountId, item]);
    const res = await post(p, `/work-items/${item}/retry-push`);
    expect(res.status).toBe(409);
    expect(await code(res)).toBe('already_running');
    expect(started).toEqual([]);
    expect(await audits(p.accountId)).toEqual([]);
  });

  it('with no job starter registered, or one that rejects, the answer is 503 and no attempt row is made', async () => {
    const p = await person('owner');
    const item = await seed(p.accountId, REFUSED);
    const before = await attemptCount(p.accountId);
    publicChangeDeps.startRetryPush = null;
    expect((await post(p, `/work-items/${item}/retry-push`)).status).toBe(503);
    expect(await audits(p.accountId)).toEqual([]);
    publicChangeDeps.startRetryPush = async () => {
      throw new Error('workflow service down');
    };
    expect((await post(p, `/work-items/${item}/retry-push`)).status).toBe(503);
    expect(await attemptCount(p.accountId)).toBe(before);
  });

  it('a malformed id is 404', async () => {
    const p = await person('owner');
    expect((await post(p, '/work-items/not-a-uuid/retry-push')).status).toBe(404);
    expect((await post(p, '/work-items/not-a-uuid/open-pr')).status).toBe(404);
  });
});
