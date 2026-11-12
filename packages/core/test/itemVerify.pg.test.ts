import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { fileBugItem } from '../src/verify/bugItem.js';
import { finishVerifyRow, openVerifyRow, saveVerifySettings, setVerifyHold, startDeploying, startRunning, VERIFY_REASON_CODES, type JourneyResult } from '../src/verify/rows.js';
import { readItemVerify } from '../src/work-items/itemVerify.js';

/** [pg] D#749 V4b: the verify section of the item activity read, as app_user through withTenant (row-level security is part of what is tested). */
const sha = (c: string): string => c.repeat(40);
const SPEC = '1. First thing works\n2. Second thing works';
const ev = (id: string, result: JourneyResult['result'] = 'pass'): JourneyResult => ({ id, result, steps: [{ did: 'opened the page', dom_fact: 'the heading reads Hello', number: 1 }], console_errors: 0, undo_checked: true, reloaded: true });

describe('item verify section [pg]', { timeout: 120_000 }, () => {
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
  const read = (itemId: string) => asMember((c) => readItemVerify(c, itemId));

  it('a repository that never turned it on has no section, even with a row on file', async () => {
    const repo = await newRepo(true);
    const item = await newItem(repo);
    await open(item);
    await admin.query(`DELETE FROM verify_settings WHERE repo_id = $1`, [repo]);
    expect(await read(item)).toBeNull();
    const never = await newItem(await newRepo(false));
    expect(await read(never)).toBeNull();
  });

  it('an item with no row has no section', async () => {
    const item = await newItem(await newRepo(true));
    expect(await read(item)).toBeNull();
  });

  it('a row that has not started is pending, with no reason, no method, no counts and no account', async () => {
    const item = await newItem(await newRepo(true, 'verify-bot'));
    await open(item);
    expect(await read(item)).toMatchObject({ status: 'pending', reason: null, method: null, journeys: null, account: null, bug_item_id: null, pr_number: 57 });
  });

  it('a deploying row is not started either, and a running row names its method', async () => {
    const item = await newItem(await newRepo(true));
    const row = await open(item);
    await worker((c) => startDeploying(c, a.accountId, row, true));
    expect(await read(item)).toMatchObject({ status: 'deploying', reason: null, method: null });
    await worker((c) => startRunning(c, a.accountId, row, { method: 'chrome_runner', deployedCommit: sha('a') }));
    expect(await read(item)).toMatchObject({ status: 'running', method: 'chrome_runner', journeys: null });
  });

  it('a held row carries its reason and the start of the wait, for a member too; a pending row has none; a start takes it away', async () => {
    const item = await newItem(await newRepo(true));
    const row = await open(item);
    expect((await read(item))?.hold).toBeUndefined();
    await worker((c) => startDeploying(c, a.accountId, row, true));
    await worker((c) => setVerifyHold(c, a.accountId, row, 'daily_cap'));
    const since = (await admin.query<{ hold_since: Date }>('SELECT hold_since FROM verify_rows WHERE id = $1', [row])).rows[0]!.hold_since;
    expect(await read(item)).toMatchObject({ status: 'deploying', hold: { reason: 'daily_cap', since: since.toISOString() } });
    await worker((c) => startRunning(c, a.accountId, row, { method: 'playwright_runner', deployedCommit: sha('a') }));
    expect((await read(item))?.hold).toBeUndefined();
  });

  it('defence in depth: a hold on a row that is not waiting is never sent, whatever the row says', async () => {
    const stale = { status: 'running', method: null, reason_code: null, result: null, bug_item_id: null, pr_number: 1, finished_at: null, created_at: new Date(), account_check: null, journeys: [], checks_only: [], hold_reason: 'daily_cap', hold_since: new Date() };
    for (const status of ['running', 'verified', 'failed', 'unverified']) {
      expect((await readItemVerify({ query: (async () => ({ rows: [{ ...stale, status }] })) as never }, randomUUID()))?.hold, status).toBeUndefined();
    }
    const unknown = { ...stale, status: 'deploying', hold_reason: 'from_the_future' };
    expect((await readItemVerify({ query: (async () => ({ rows: [unknown] })) as never }, randomUUID()))?.hold).toBeUndefined();
    expect((await readItemVerify({ query: (async () => ({ rows: [{ ...stale, status: 'deploying' }] })) as never }, randomUUID()))?.hold).toMatchObject({ reason: 'daily_cap' });
  });

  it('a verified row counts its journeys and reports the account as matched when the stage stored that proof', async () => {
    const item = await newItem(await newRepo(true, 'verify-bot'));
    const row = await open(item);
    await toRunning(row);
    await worker((c) => finishVerifyRow(c, a.accountId, row, { status: 'verified', result: ['c1', 'c2'].map((id) => ev(id)), accountCheck: 'matched' }));
    expect(await read(item)).toMatchObject({ status: 'verified', reason: null, method: 'playwright_runner', journeys: { total: 2, passed: 2, failed: 0, other: 0 }, account: 'matched' });
  });

  it('a test account added AFTER the row finished does not change the account word: the proof is the stored one, not the current label', async () => {
    const repo = await newRepo(true);
    const item = await newItem(repo);
    const row = await open(item);
    await toRunning(row, 'chrome_runner');
    await worker((c) => finishVerifyRow(c, a.accountId, row, { status: 'verified', result: ['c1', 'c2'].map((id) => ev(id)) }));
    await owner((c) => saveVerifySettings(c, a.accountId, repo, a.userId, { testAccountLabel: 'verify-bot' }));
    expect((await read(item))?.account).toBeNull();
    const failedItem = await newItem(repo);
    const failedRow = await open(failedItem, sha('c'));
    await toRunning(failedRow, 'chrome_runner');
    await worker((c) => finishVerifyRow(c, a.accountId, failedRow, { status: 'failed', result: [ev('c1'), ev('c2', 'fail')] }));
    expect((await read(failedItem))?.account).toBeNull();
  });

  it('the stored word is what is read, with the label removed afterwards', async () => {
    const repo = await newRepo(true, 'verify-bot');
    const item = await newItem(repo);
    const row = await open(item);
    await toRunning(row);
    await worker((c) => finishVerifyRow(c, a.accountId, row, { status: 'verified', result: ['c1', 'c2'].map((id) => ev(id)), accountCheck: 'matched' }));
    await owner((c) => saveVerifySettings(c, a.accountId, repo, a.userId, { testAccountLabel: null }));
    expect((await read(item))?.account).toBe('matched');
  });

  it('a verified row on a repository with no test account says nothing about the account', async () => {
    const item = await newItem(await newRepo(true));
    const row = await open(item);
    await toRunning(row);
    await worker((c) => finishVerifyRow(c, a.accountId, row, { status: 'verified', result: ['c1', 'c2'].map((id) => ev(id)) }));
    expect((await read(item))?.account).toBeNull();
  });

  it('a failed row counts passed and failed journeys and names the bug item it filed', async () => {
    const item = await newItem(await newRepo(true, 'verify-bot'));
    const row = await open(item);
    await toRunning(row, 'chrome_runner');
    await worker((c) => finishVerifyRow(c, a.accountId, row, { status: 'failed', result: [ev('c1'), ev('c2', 'fail')] }));
    const filed = await worker((c) => fileBugItem(c, a.accountId, row, ['c2']));
    expect(filed.filed).toBe(true);
    expect(await read(item)).toMatchObject({ status: 'failed', method: 'chrome_runner', journeys: { total: 2, passed: 1, failed: 1, other: 0 }, bug_item_id: filed.itemId });
  });

  it('every closed reason comes through on an unverified row, and its results are not counted', async () => {
    for (const reason of VERIFY_REASON_CODES) {
      const item = await newItem(await newRepo(true, 'verify-bot'));
      const row = await open(item);
      await toRunning(row);
      const accountCheck = reason === 'wrong_account' ? 'mismatch' : reason === 'account_unverifiable' ? 'unverifiable' : undefined;
      await worker((c) => finishVerifyRow(c, a.accountId, row, { status: 'unverified', reason, result: ['c1', 'c2'].map((id) => ev(id)), ...(accountCheck === undefined ? {} : { accountCheck }) }));
      const v = await read(item);
      expect(v, reason).toMatchObject({ status: 'unverified', reason, journeys: null, bug_item_id: null });
      expect(v?.account, reason).toBe(reason === 'wrong_account' ? 'mismatch' : reason === 'account_unverifiable' ? 'unverifiable' : null);
    }
  });

  it('the card says which criteria the browser covered and which were left to the checks (numbers only)', async () => {
    const item = await newItem(await newRepo(true));
    const row = await open(item);
    expect((await read(item))?.criteria).toEqual({ browser: [1, 2], checks: [] });
    await toRunning(row);
    await admin.query(`UPDATE verify_rows SET checks_only = '[3,5]'::jsonb WHERE id = $1`, [row]);
    expect((await read(item))?.criteria).toEqual({ browser: [1, 2], checks: [3, 5] });
  });

  it('the newest row of the item wins', async () => {
    const item = await newItem(await newRepo(true));
    const first = await open(item, sha('a'), 57);
    await worker((c) => finishVerifyRow(c, a.accountId, first, { status: 'unverified', reason: 'deploy_failed' }));
    await open(item, sha('b'), 58);
    expect(await read(item)).toMatchObject({ status: 'pending', pr_number: 58 });
  });

  it('undo: turning the setting off takes the section away, turning it on brings the row back', async () => {
    const repo = await newRepo(true);
    const item = await newItem(repo);
    const row = await open(item);
    await toRunning(row);
    expect((await read(item))?.status).toBe('running');
    await owner((c) => saveVerifySettings(c, a.accountId, repo, a.userId, { enabled: false }));
    expect(await read(item)).toBeNull();
    await owner((c) => saveVerifySettings(c, a.accountId, repo, a.userId, { enabled: true }));
    expect((await read(item))?.status).toBe('running');
  });

  it('the answer holds closed values only: no address, no account name, no journey text', async () => {
    const item = await newItem(await newRepo(true, 'verify-bot'));
    const row = await open(item);
    await toRunning(row);
    await worker((c) => finishVerifyRow(c, a.accountId, row, { status: 'verified', result: ['c1', 'c2'].map((id) => ev(id)) }));
    const text = JSON.stringify(await read(item));
    expect(text).not.toMatch(/app\.example|verify-bot|First thing|opened the page|heading reads/);
    expect(Object.keys((await read(item))!).sort()).toEqual(['account', 'at', 'bug_item_id', 'criteria', 'detail', 'journeys', 'method', 'pr_number', 'reason', 'status']);
  });

  it('another account cannot read the row', async () => {
    const item = await newItem(await newRepo(true));
    await open(item);
    expect(await withTenant(appPool, b.accountId, b.userId, (c) => readItemVerify(c, item))).toBeNull();
  });
});
