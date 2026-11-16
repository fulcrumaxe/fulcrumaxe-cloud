import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { finishVerifyRow, openVerifyRow, readVerifyRow, saveVerifySettings, startDeploying, startRunning, type JourneyResult } from '../src/verify/rows.js';
import { readVerifyAttempt } from '../src/work-items/verifyDetail.js';

/** [pg] D#749 VERIFY-RELOAD-ONLY-FOR-PERSISTED: a view-only journey is closed and shown as passed without a reload; a persisted one is not. */
const sha = (c: string): string => c.repeat(40);
const VIEW_SPEC = '1. [ui] Choosing a role filters the list by that role.';
const SAVE_SPEC = '1. [ui] Saving the nickname keeps it.';
const noReload = (id: string): JourneyResult => ({ id, result: 'pass', steps: [{ did: 'picked the role', dom_fact: 'every row shown is that role' }], console_errors: 0, undo_checked: true, reloaded: false });

describe('view-only journeys need no reload [pg]', { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let a: SeedRefs;
  let repoId: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    repoId = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, $4, 'team')`, [repoId, a.accountId, a.installationId, Math.floor(Math.random() * 1e9) + 10]);
    await withTenant(appPool, a.accountId, a.userId, (c) => saveVerifySettings(c, a.accountId, repoId, a.userId, { enabled: true, baseUrl: 'https://app.example', eligibility: 'all' }));
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
  });

  const worker = <T,>(fn: (c: PoolClient) => Promise<T>): Promise<T> => withTenant(appPool, a.accountId, fn);

  async function runningRow(spec: string): Promise<{ item: string; row: string }> {
    const item = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'feature', 'internal', 'merged')`, [item, a.accountId, repoId]);
    await admin.query(`INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, $3, encode(sha256(convert_to($3, 'UTF8')), 'hex'), 'agent')`, [a.accountId, item, spec]);
    const o = await worker((c) => openVerifyRow(c, a.accountId, { workItemId: item, prNumber: 57, mergeSha: sha('a') }));
    if (!o.opened) throw new Error(`not opened: ${o.reason}`);
    await worker(async (c) => {
      await startDeploying(c, a.accountId, o.rowId, true);
      await startRunning(c, a.accountId, o.rowId, { method: 'playwright_runner', deployedCommit: sha('a') });
    });
    return { item, row: o.rowId };
  }
  const detail = (item: string) => worker((c) => readVerifyAttempt(c, item));

  it('a stored view-only journey with a passed step, page fact and undo and no reload ends verified, and the detail shows it passed', async () => {
    const { item, row } = await runningRow(VIEW_SPEC);
    const stored = await worker((c) => readVerifyRow(c, a.accountId, row));
    expect(stored?.journeys).toMatchObject([{ id: 'c1', persistence: 'view_only' }]);
    expect((await worker((c) => finishVerifyRow(c, a.accountId, row, { status: 'verified', result: [noReload('c1')] }))).moved).toBe(true);
    const v = (await detail(item))!;
    expect(v.status).toBe('verified');
    expect(v.journeys[0]).toMatchObject({ id: 'c1', status: 'passed', reason: null, evidence: { page_fact: true, undo_checked: true, reloaded: false } });
  });

  it('a view-only journey still needs its undo check to close verified', async () => {
    const { row } = await runningRow(VIEW_SPEC);
    await expect(worker((c) => finishVerifyRow(c, a.accountId, row, { status: 'verified', result: [{ ...noReload('c1'), undo_checked: false }] }))).rejects.toMatchObject({ code: 'verify_row_invalid' });
  });

  it('a journey with no classification (a persisted change) cannot close verified without a reload, and the detail shows it unproven', async () => {
    const { item, row } = await runningRow(SAVE_SPEC);
    const stored = await worker((c) => readVerifyRow(c, a.accountId, row));
    expect(stored?.journeys[0]?.persistence).toBeUndefined();
    await expect(worker((c) => finishVerifyRow(c, a.accountId, row, { status: 'verified', result: [noReload('c1')] }))).rejects.toMatchObject({ code: 'verify_row_invalid' });
    expect((await worker((c) => finishVerifyRow(c, a.accountId, row, { status: 'unverified', reason: 'hollow_pass', result: [noReload('c1')] }))).moved).toBe(true);
    const v = (await detail(item))!;
    expect(v).toMatchObject({ status: 'unverified', reason: 'hollow_pass' });
    expect(v.journeys[0]).toMatchObject({ id: 'c1', status: 'unproven', reason: 'no_evidence', evidence: { page_fact: true, undo_checked: true, reloaded: false } });
  });
});
