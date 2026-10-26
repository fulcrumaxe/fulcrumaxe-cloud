import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { SESSION_COOKIE_NAME, signSession } from '@fx/core/src/auth/session.js';
import { handleApiRequest } from '../src/handler.js';
import { ROUTES } from '../src/routes/index.js';

/**
 * R6: GET /api/v1/stalled-items through the real `handleApiRequest` against real Postgres (RLS, membership). Each account is its own, so this file shares
 * nothing with another test file. The list is derived: facts are written the way the stage driver writes them, and nothing here stores "this item is
 * stalled". The cases are the live ones from cloud#673 (2026-10-25) and every reason an item must NOT be listed.
 */
interface Identity {
  accountId: string;
  userId: string;
}
interface Item {
  work_item_id: string;
  title: string | null;
  stage: string;
  code: string;
  why: string;
  action_label: string | null;
  can_act: boolean;
  since: string;
}
interface Body {
  items: Item[];
  not_shown: number;
}
const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/v1/listStalledItems/200-ok.json', import.meta.url), 'utf8')) as Body;
const TERMINAL = ['succeeded', 'failed', 'timed_out', 'killed_spend', 'refused_spend', 'cancelled'];

describe('R6: stalled items list', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let platformOpsPool: Pool;

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

  const call = async (who: Identity): Promise<Response> =>
    handleApiRequest(new Request('http://localhost/api/v1/stalled-items', { method: 'GET', headers: new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(who)}` }) }), appUserPool, platformOpsPool, ROUTES);
  const read = async (who: Identity): Promise<Body> => (await (await call(who)).json()) as Body;

  async function fixture(role: 'member' | 'admin' = 'admin') {
    const refs: SeedRefs = await seedAccount(admin, randomUUID());
    // The seed's own item has a running run; it is ended so only the items made below matter.
    await admin.query(`UPDATE agent_runs SET status = 'succeeded' WHERE account_id = $1`, [refs.accountId]);
    await admin.query(`UPDATE work_items SET stage = 'closed' WHERE id = $1`, [refs.workItemId]);
    const userId = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)`, [refs.accountId, userId, role]);
    return { refs, who: { accountId: refs.accountId, userId } };
  }
  async function item(refs: SeedRefs, stage: string, title = 'Use the shared pushing-roles list', opts: { provenance?: string; ghNumber?: number | null; spec?: boolean } = {}): Promise<string> {
    const id = randomUUID();
    const gh = opts.ghNumber === undefined ? Math.floor(Math.random() * 1e6) + 1 : opts.ghNumber;
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, title, stage, gh_number) VALUES ($1, $2, $3, 'small', $4, $5, $6, $7)`, [id, refs.accountId, refs.repoId, opts.provenance ?? 'internal', title, stage, gh]);
    // The stage driver's table needs a discussion and a published Spec before it advances an item: without them the card offers no top button.
    if (opts.spec !== false) {
      const discussion = randomUUID();
      await admin.query(
        `INSERT INTO discussions (id, account_id, number, kind, title, root_work_item_id, provenance, created_by_kind) VALUES ($1, $2, $3, 'small', 'A discussion', $4, 'internal', 'system')`,
        [discussion, refs.accountId, Math.floor(Math.random() * 1e9), id],
      );
      await admin.query(`UPDATE work_items SET discussion_id = $1 WHERE id = $2`, [discussion, id]);
      await admin.query(`INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, 'spec', $3, 'system')`, [refs.accountId, id, createHash('sha256').update('spec').digest('hex')]);
    }
    return id;
  }
  // The table stamps created_at with the database clock on insert whatever the row says; the facts are aged afterwards, as the other suites do.
  async function fact(refs: SeedRefs, workItemId: string, kind: string, over: { code?: string | null; reasons?: string[]; pr?: number; ageMinutes?: number; stage?: string; attempt?: number } = {}): Promise<void> {
    const key = randomUUID();
    await admin.query(
      `INSERT INTO work_item_driver_events (account_id, work_item_id, kind, code, reasons, pr_number, stage, attempt, dedupe_key) VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9)`,
      [refs.accountId, workItemId, kind, over.code ?? null, over.reasons ?? [], over.pr ?? null, over.stage ?? null, over.attempt ?? null, key],
    );
    await admin.query(`UPDATE work_item_driver_events SET created_at = now() - make_interval(mins => $2::int) WHERE work_item_id = $1 AND dedupe_key = $3`, [workItemId, over.ageMinutes ?? 5, key]);
  }
  async function run(refs: SeedRefs, workItemId: string, status: string): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status) VALUES ($1, $2, $3, 'executor', 'local', $4)`, [id, refs.accountId, workItemId, status]);
    return id;
  }

  it('is empty when nothing stopped', async () => {
    const f = await fixture();
    await item(f.refs, 'pr_opened'); // no fact and no silence: a workflow is plausibly in flight
    expect(await read(f.who)).toEqual({ items: [], not_shown: 0 });
  });

  it('cloud#673, the review that stopped: a reviewer refused for the runner daily limit leaves the item listed with the Approve and review button, in the contract shape', async () => {
    const f = await fixture();
    const id = await item(f.refs, 'pr_opened', 'Use the shared pushing-roles list');
    await fact(f.refs, id, 'review_started', { ageMinutes: 70 });
    await fact(f.refs, id, 'stopped', { code: 'not_started_runner_daily_limit', pr: 675, ageMinutes: 60 });
    const res = await call(f.who);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.items).toHaveLength(1);
    const row = body.items[0]!;
    expect(row).toMatchObject({ work_item_id: id, title: 'Use the shared pushing-roles list', stage: 'pr_opened', code: 'stopped', action_label: 'Approve and review', can_act: true });
    expect(row.why).toContain('daily limit');
    expect(Object.keys(row).sort()).toEqual(Object.keys(FIXTURE.items[0]!).sort());
    expect(Object.keys(body).sort()).toEqual(Object.keys(FIXTURE).sort());
    expect(Number.isNaN(Date.parse(row.since))).toBe(false);
  });

  it('cloud#673, the review that ended with no follow-on: a gate answer "ready" with a draft, red-or-pending checks and no public copy is listed with Check the merge, and is NOT a merge-ready row', async () => {
    const f = await fixture();
    const id = await item(f.refs, 'review_passed');
    await fact(f.refs, id, 'merge_gate', { code: 'ready_human_merges', reasons: ['pr_draft', 'local_reviews_passed_advisory', 'local_review_not_enabled', 'ci_not_green', 'public_pr_not_open'], pr: 675 });
    const stalled = await read(f.who);
    expect(stalled.items).toHaveLength(1);
    expect(stalled.items[0]).toMatchObject({ work_item_id: id, stage: 'review_passed', code: 'gate_not_ready', action_label: 'Check the merge', can_act: true });
    const merge = await (await handleApiRequest(new Request('http://localhost/api/v1/merge-ready', { method: 'GET', headers: new Headers({ cookie: `${SESSION_COOKIE_NAME}=${await signSession(f.who)}` }) }), appUserPool, platformOpsPool, ROUTES)).json();
    expect(merge).toEqual({ items: [], not_shown: 0 });
  });

  it('a gate answer that is really ready is a merge-ready row and not a stalled one', async () => {
    const f = await fixture();
    const id = await item(f.refs, 'review_passed');
    await fact(f.refs, id, 'merge_gate', { code: 'ready_human_merges', reasons: ['local_review_not_enabled'], pr: 675 });
    expect(await read(f.who)).toEqual({ items: [], not_shown: 0 });
  });

  it('a ready-for-a-person gate answer that is hours old is a merge-ready row only, never also a stalled one', async () => {
    const f = await fixture();
    const id = await item(f.refs, 'review_passed');
    await admin.query(`UPDATE work_items SET updated_at = now() - interval '5 hours' WHERE id = $1`, [id]);
    await fact(f.refs, id, 'merge_gate', { code: 'ready_human_merges', reasons: ['local_review_not_enabled'], pr: 675, ageMinutes: 300 });
    expect(await read(f.who)).toEqual({ items: [], not_shown: 0 });
    const delegated = await item(f.refs, 'review_passed');
    await admin.query(`UPDATE work_items SET updated_at = now() - interval '5 hours' WHERE id = $1`, [delegated]);
    await fact(f.refs, delegated, 'merge_gate', { code: 'merge_delegated', pr: 676, ageMinutes: 300 });
    expect(await read(f.who)).toEqual({ items: [], not_shown: 0 });
  });

  it('the earlier "Needs a person" after a failed fix round is listed with Build again', async () => {
    const f = await fixture();
    const id = await item(f.refs, 'needs_human');
    await fact(f.refs, id, 'stopped', { code: 'build_run_failed' });
    const body = await read(f.who);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ work_item_id: id, stage: 'needs_human', code: 'stopped', action_label: 'Build again', can_act: true });
  });

  it('a build the worker refused at Spec ready is listed with the build button', async () => {
    const f = await fixture();
    const id = await item(f.refs, 'spec_ready');
    await fact(f.refs, id, 'build_refused', { code: 'no_model' });
    const body = await read(f.who);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ work_item_id: id, code: 'refused', action_label: 'Approve the Spec and build' });
  });

  it('a wait nobody refreshes any more is listed; a fresh one is not', async () => {
    const f = await fixture();
    const stale = await item(f.refs, 'spec_ready');
    await fact(f.refs, stale, 'stage_waiting', { code: 'one_build_per_repo_until_d598', stage: 'build', attempt: 1, ageMinutes: 45 });
    const fresh = await item(f.refs, 'spec_ready');
    await fact(f.refs, fresh, 'stage_waiting', { code: 'one_build_per_repo_until_d598', stage: 'build', attempt: 1, ageMinutes: 1 });
    expect((await read(f.who)).items.map((i) => i.work_item_id)).toEqual([stale]);
  });

  it('silence for longer than the longest silent wait lists an item that should be moving; less does not', async () => {
    const f = await fixture();
    const quiet = await item(f.refs, 'pr_opened');
    await admin.query(`UPDATE work_items SET updated_at = now() - interval '4 hours' WHERE id = $1`, [quiet]);
    await fact(f.refs, quiet, 'review_started', { ageMinutes: 240 });
    const recent = await item(f.refs, 'pr_opened');
    await fact(f.refs, recent, 'review_started', { ageMinutes: 30 });
    const body = await read(f.who);
    expect(body.items.map((i) => [i.work_item_id, i.code])).toEqual([[quiet, 'silent']]);
  });

  it.each(['pending', 'running', 'paused'])('an item with a %s run is not listed', async (status) => {
    const f = await fixture();
    const id = await item(f.refs, 'pr_opened');
    await fact(f.refs, id, 'stopped', { code: 'not_started_runner_daily_limit' });
    await run(f.refs, id, status);
    expect((await read(f.who)).items).toEqual([]);
  });

  it('an item whose runs have all ended is still listed', async () => {
    const f = await fixture();
    const id = await item(f.refs, 'pr_opened');
    for (const s of TERMINAL) await run(f.refs, id, s);
    await fact(f.refs, id, 'stopped', { code: 'not_started_runner_daily_limit' });
    expect((await read(f.who)).items.map((i) => i.work_item_id)).toEqual([id]);
  });

  it('an open question, a request in flight and a halt each take the item off the list', async () => {
    const f = await fixture();
    const asked = await item(f.refs, 'in_progress');
    await fact(f.refs, asked, 'stopped', { code: 'waiting_on_answer' });
    const askRun = await run(f.refs, asked, 'succeeded');
    await admin.query(
      `INSERT INTO decision_asks (account_id, repo_id, work_item_id, run_id, decision_type, options, proposed, rationale, input_trust_classes, answer_due_at, timeout_outcome)
       VALUES ($1, $2, $3, $4, 'test_strategy_choice', $5::jsonb, 'keep', 'why', '[]'::jsonb, now() + interval '1 day', 'stop_and_flag')`,
      [f.refs.accountId, f.refs.repoId, asked, askRun, JSON.stringify([{ id: 'keep', label: 'Keep' }, { id: 'split', label: 'Split' }])],
    );
    const requested = await item(f.refs, 'pr_opened');
    await fact(f.refs, requested, 'stopped', { code: 'not_started_runner_daily_limit' });
    await admin.query(
      `INSERT INTO run_action_requests (account_id, kind, target_id, requested_by, principal_kind, idempotency_key, request_hash)
       VALUES ($1, 'advance_work_item', $2, $3, 'session', $4, $5)`,
      [f.refs.accountId, requested, f.who.userId, randomUUID(), 'h'.repeat(8)],
    );
    const halted = await item(f.refs, 'pr_opened');
    await fact(f.refs, halted, 'stopped', { code: 'not_started_runner_daily_limit' });
    await admin.query(`UPDATE work_items SET halted_at = now(), halt_action_id = $2, halt_epoch = halt_epoch + 1 WHERE id = $1`, [halted, randomUUID()]);
    expect((await read(f.who)).items).toEqual([]);
    // The request is performed: the item is the person's next press away again.
    await admin.query(`UPDATE run_action_requests SET state = 'done', finished_at = now() WHERE account_id = $1 AND target_id = $2`, [f.refs.accountId, requested]);
    expect((await read(f.who)).items.map((i) => i.work_item_id)).toEqual([requested]);
  });

  it('an item that moved on leaves by itself: the pull request merged, or a later fact shows the workflow running again', async () => {
    const f = await fixture();
    const id = await item(f.refs, 'pr_opened');
    await fact(f.refs, id, 'stopped', { code: 'not_started_runner_daily_limit', ageMinutes: 10 });
    expect((await read(f.who)).items).toHaveLength(1);
    await fact(f.refs, id, 'review_started', { ageMinutes: 1 });
    expect((await read(f.who)).items).toEqual([]);
    await fact(f.refs, id, 'stopped', { code: 'review_key_missing', ageMinutes: 0 });
    expect((await read(f.who)).items).toHaveLength(1);
    await admin.query(`UPDATE work_items SET stage = 'merged' WHERE id = $1`, [id]);
    expect((await read(f.who)).items).toEqual([]);
  });

  it('an external item or one with no issue behind it is not listed: the approve route would refuse it', async () => {
    const f = await fixture();
    const external = await item(f.refs, 'pr_opened', 'x', { provenance: 'external' });
    await fact(f.refs, external, 'stopped', { code: 'review_key_missing' });
    const noIssue = await item(f.refs, 'pr_opened', 'y', { ghNumber: null });
    await fact(f.refs, noIssue, 'stopped', { code: 'review_key_missing' });
    expect((await read(f.who)).items).toEqual([]);
  });

  it('a member sees the row but with no button; a stage that cannot advance (no Spec to build from) has none either', async () => {
    const f = await fixture('member');
    const id = await item(f.refs, 'pr_opened');
    await fact(f.refs, id, 'stopped', { code: 'review_key_missing' });
    const noSpec = await item(f.refs, 'needs_human', 'No Spec', { spec: false });
    await fact(f.refs, noSpec, 'escalated', { code: 'max_fix_rounds' });
    const body = await read(f.who);
    expect(body.items.map((i) => i.work_item_id).sort()).toEqual([id, noSpec].sort());
    expect(body.items.every((i) => i.can_act === false)).toBe(true);
    const admins = await fixture('admin');
    const own = await item(admins.refs, 'needs_human', 'No Spec', { spec: false });
    await fact(admins.refs, own, 'escalated', { code: 'max_fix_rounds' });
    const row = (await read(admins.who)).items[0]!;
    expect(row).toMatchObject({ work_item_id: own, action_label: null, can_act: false });
  });

  it('one account never sees another account\'s items', async () => {
    const a = await fixture();
    const b = await fixture();
    const id = await item(a.refs, 'pr_opened');
    await fact(a.refs, id, 'stopped', { code: 'review_key_missing' });
    expect((await read(b.who)).items).toEqual([]);
    expect((await read(a.who)).items).toHaveLength(1);
  });

  it('lists the newest stop first and counts the ones it does not show', async () => {
    const f = await fixture();
    const older = await item(f.refs, 'pr_opened');
    await fact(f.refs, older, 'stopped', { code: 'review_key_missing', ageMinutes: 90 });
    const newer = await item(f.refs, 'pr_opened');
    await fact(f.refs, newer, 'stopped', { code: 'review_key_missing', ageMinutes: 10 });
    expect((await read(f.who)).items.map((i) => i.work_item_id)).toEqual([newer, older]);
  });
});
