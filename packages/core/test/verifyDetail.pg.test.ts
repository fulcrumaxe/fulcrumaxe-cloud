import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { finishVerifyRow, openVerifyRow, saveVerifySettings, startDeploying, startRunning, openVerifyAgainRow, type JourneyResult } from '../src/verify/rows.js';
import { readVerifyAttempt } from '../src/work-items/verifyDetail.js';

/** [pg] D#749 V4b: the journeys and steps of a verify attempt, as app_user through withTenant (row-level security is part of what is tested). */
const sha = (c: string): string => c.repeat(40);
const SPEC = '1. First thing works\n2. Second thing works';
const ev = (id: string, result: JourneyResult['result'] = 'pass'): JourneyResult => ({ id, result, steps: [{ did: 'opened the page', dom_fact: 'the heading reads Hello', number: 1 }], console_errors: 0, undo_checked: true, reloaded: true });

describe('verify attempt detail [pg]', { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let memberId: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    memberId = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [memberId, `${memberId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [a.accountId, memberId]);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
  });

  const owner = <T,>(fn: (c: PoolClient) => Promise<T>): Promise<T> => withTenant(appPool, a.accountId, a.userId, fn);
  const asMember = <T,>(fn: (c: PoolClient) => Promise<T>): Promise<T> => withTenant(appPool, a.accountId, memberId, fn);

  async function newRepo(on = true, label: string | null = null): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, $4, 'team')`, [id, a.accountId, a.installationId, Math.floor(Math.random() * 1e9) + 10]);
    if (on) await owner((c) => saveVerifySettings(c, a.accountId, id, a.userId, { enabled: true, baseUrl: 'https://app.example', eligibility: 'all', ...(label === null ? {} : { testAccountLabel: label }) }));
    return id;
  }
  async function newItem(repoId: string): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'feature', 'internal', 'merged')`, [id, a.accountId, repoId]);
    await admin.query(`INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, $3, encode(sha256(convert_to($3, 'UTF8')), 'hex'), 'agent')`, [a.accountId, id, SPEC]);
    return id;
  }
  async function open(itemId: string, mergeSha = sha('a'), pr = 57): Promise<string> {
    const o = await withTenant(appPool, a.accountId, (c) => openVerifyRow(c, a.accountId, { workItemId: itemId, prNumber: pr, mergeSha }));
    if (!o.opened) throw new Error(`not opened: ${o.reason}`);
    return o.rowId;
  }
  const worker = <T,>(fn: (c: PoolClient) => Promise<T>): Promise<T> => withTenant(appPool, a.accountId, fn);
  async function toRunning(rowId: string, method: 'chrome_runner' | 'playwright_runner' = 'playwright_runner'): Promise<void> {
    await worker(async (c) => {
      await startDeploying(c, a.accountId, rowId, true);
      await startRunning(c, a.accountId, rowId, { method, deployedCommit: sha('a') });
    });
  }
  const read = (itemId: string, attempt?: number) => asMember((c) => readVerifyAttempt(c, itemId, attempt));
  const finish = (row: string, input: Parameters<typeof finishVerifyRow>[3]) => worker((c) => finishVerifyRow(c, a.accountId, row, input));

  it('shows each journey with its status, steps and evidence; the last step of a failed journey is the failed one', async () => {
    const item = await newItem(await newRepo(true));
    const row = await open(item);
    await toRunning(row);
    const failing: JourneyResult = { id: 'c2', result: 'fail', steps: [{ did: 'opened the page', dom_fact: 'the heading reads Hello' }, { did: 'pressed Save', dom_fact: 'an error banner says: Could not save' }], console_errors: 2, undo_checked: false, reloaded: false };
    await finish(row, { status: 'failed', result: [ev('c1'), failing] });
    const v = (await read(item))!;
    expect(v).toMatchObject({ attempt: 1, status: 'failed', method: 'playwright_runner', attempts: [{ attempt: 1, status: 'failed' }] });
    expect(v.started_at).not.toBeNull();
    expect(v.finished_at).not.toBeNull();
    expect(v.journeys[0]).toMatchObject({ id: 'c1', source: 'criterion', criterion: 1, status: 'passed', reason: null, steps_done: 1, evidence: { page_fact: true, undo_checked: true, reloaded: true } });
    expect(v.journeys[0]!.steps).toEqual([{ index: 1, label: 'opened the page', result: 'passed', reason: null, note: null }]);
    expect(v.journeys[1]).toMatchObject({ id: 'c2', status: 'failed', reason: 'defect_found', steps_done: 2, console_errors: 2, evidence: { undo_checked: false, reloaded: false } });
    expect(v.journeys[1]!.steps.map((s) => [s.result, s.reason, s.note])).toEqual([['passed', null, null], ['failed', 'defect_found', 'an error banner says: Could not save']]);
  });

  it('a journey the tester never answered is skipped; a hollow pass is unproven; a blocked one is blocked', async () => {
    const item = await newItem(await newRepo(true));
    const row = await open(item);
    await toRunning(row);
    await finish(row, { status: 'unverified', reason: 'journey_blocked', result: [{ id: 'c1', result: 'blocked', steps: [{ did: 'opened', dom_fact: 'a sign-in page' }], console_errors: 0, undo_checked: false, reloaded: false }, { id: 'c2', result: 'unverified', steps: [], console_errors: 0, undo_checked: false, reloaded: false }] });
    expect((await read(item))!.journeys.map((j) => [j.id, j.status, j.reason])).toEqual([['c1', 'blocked', 'blocked'], ['c2', 'unproven', 'no_evidence']]);
    const early = await newItem(await newRepo(true));
    const r2 = await open(early);
    await finish(r2, { status: 'unverified', reason: 'no_browser' });
    expect((await read(early))).toMatchObject({ status: 'unverified', reason: 'no_browser', journeys: [{ status: 'skipped', reason: 'not_answered', steps: [] }, { status: 'skipped', reason: 'not_answered' }] });
  });

  it('the last step of a blocked journey is the one the tester stopped on: not passed, reason blocked, with its page note; the earlier steps stay recorded', async () => {
    const item = await newItem(await newRepo(true));
    const row = await open(item);
    await toRunning(row);
    await finish(row, { status: 'unverified', reason: 'journey_blocked', result: [{ id: 'c1', result: 'blocked', steps: [{ did: 'opened the page', dom_fact: 'the home page' }, { did: 'pressed Save', dom_fact: 'a sign-in form is shown' }], console_errors: 0, undo_checked: false, reloaded: false }, ev('c2')] });
    const j = (await read(item))!.journeys[0]!;
    expect(j).toMatchObject({ status: 'blocked', reason: 'blocked' });
    expect(j.steps.map((s) => [s.result, s.reason, s.note])).toEqual([['passed', null, null], ['not_passed', 'blocked', 'a sign-in form is shown']]);
  });

  it('a pass without the evidence the rule asks for is unproven, and page_fact needs an action on the same step', async () => {
    const item = await newItem(await newRepo(true));
    const row = await open(item);
    await toRunning(row);
    const noAction: JourneyResult = { id: 'c1', result: 'pass', steps: [{ did: '', dom_fact: 'the heading reads Hello' }, { did: 'opened the page', dom_fact: '' }], console_errors: 0, undo_checked: true, reloaded: true };
    await finish(row, { status: 'unverified', reason: 'journey_blocked', result: [noAction, ev('c2')] });
    const v = (await read(item))!;
    expect(v.journeys[0]).toMatchObject({ status: 'unproven', reason: 'no_evidence', evidence: { page_fact: false, undo_checked: true, reloaded: true } });
    expect(v.journeys[1]).toMatchObject({ status: 'passed', evidence: { page_fact: true } });
  });

  it.each([['wrong_account', 'mismatch'], ['account_unverifiable', 'unverifiable']] as const)('a row that ended %s judged nothing: its answered journeys are not_judged with the row reason, never passed, and show no page note', async (reason, accountCheck) => {
    const label = 'tester';
    const item = await newItem(await newRepo(true, label));
    const row = await open(item);
    await toRunning(row);
    const hollow: JourneyResult = { id: 'c1', result: 'pass', steps: [{ did: 'opened the page', dom_fact: '' }], console_errors: 0, undo_checked: false, reloaded: false };
    const full = ev('c2');
    await finish(row, { status: 'unverified', reason, accountCheck, result: [hollow, full] });
    const v = (await read(item))!;
    expect(v).toMatchObject({ status: 'unverified', reason });
    for (const j of v.journeys) {
      expect(j).toMatchObject({ status: 'not_judged', reason });
      expect(j.steps.every((s) => s.note === null)).toBe(true);
    }
    expect(v.journeys.some((j) => j.status === 'passed')).toBe(false);
  });

  it('bounds and cleans model text: control and invisible characters, markdown links and length', async () => {
    const item = await newItem(await newRepo(true));
    const row = await open(item);
    await toRunning(row);
    const hostile = `[click](http://evil.example/x)\u0007\u202e<img src=x onerror=alert(1)>` + 'x'.repeat(500);
    await finish(row, { status: 'failed', result: [{ id: 'c1', result: 'fail', steps: [{ did: hostile, dom_fact: hostile }], console_errors: 0, undo_checked: true, reloaded: true }, ev('c2')] });
    const step = (await read(item))!.journeys[0]!.steps[0]!;
    expect(step.label.length).toBeLessThanOrEqual(120);
    expect(step.note!.length).toBeLessThanOrEqual(200);
    for (const t of [step.label, step.note!]) expect(t).not.toMatch(/evil\.example|[\u0000-\u001f\u202e]/);
  });

  it('Verify again keeps the old attempt: both are listed and each can be read', async () => {
    const item = await newItem(await newRepo(true));
    const row = await open(item);
    await toRunning(row);
    await finish(row, { status: 'failed', result: [ev('c1', 'fail'), ev('c2')] });
    const again = await withTenant(appPool, a.accountId, a.userId, (c) => openVerifyAgainRow(c, a.accountId, item));
    expect(again.opened).toBe(true);
    const newest = (await read(item))!;
    expect(newest).toMatchObject({ attempt: 2, status: 'pending' });
    expect(newest.attempts.map((x) => [x.attempt, x.status])).toEqual([[1, 'failed'], [2, 'pending']]);
    expect(newest.journeys.every((j) => j.status === 'skipped' && j.reason === null)).toBe(true);
    expect((await read(item, 1))).toMatchObject({ attempt: 1, status: 'failed', journeys: [{ status: 'failed' }, { status: 'passed' }] });
    expect(await read(item, 3)).toBeNull();
  });

  it('is absent when the check is off, when there is no row, and for another account', async () => {
    const repo = await newRepo(true);
    const item = await newItem(repo);
    expect(await read(item)).toBeNull();
    await open(item);
    expect(await withTenant(appPool, b.accountId, b.userId, (c) => readVerifyAttempt(c, item))).toBeNull();
    await admin.query('DELETE FROM verify_settings WHERE repo_id = $1', [repo]);
    expect(await read(item)).toBeNull();
  });
});
