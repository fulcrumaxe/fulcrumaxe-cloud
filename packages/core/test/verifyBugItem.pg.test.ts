import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { BugItemNotAttachedError, bugItemTitle, fileBugItem, insertAndAttach } from '../src/verify/bugItem.js';
import { analysisRunKey, overRepoDailyUsd, proposalVerifyKey, verifyHold, verifyStageRunKey } from '../src/plan/proposalVerifyLimits.js';
import { finishVerifyRow, openVerifyRow, readVerifyRow, saveVerifySettings, startDeploying, startRunning, type JourneyResult } from '../src/verify/rows.js';

/** [pg] D#749 V3b: the bug item a failed verify row files (one item, no orphan, under a replay and a race), and the daily counter that now includes the tester's runs. */
const sha = (c: string): string => c.repeat(40);
const evidenced = (id: string, result: JourneyResult['result'] = 'pass'): JourneyResult => ({ id, result, steps: [{ did: 'opened the page', dom_fact: 'the heading reads Hello', number: 1 }], console_errors: 0, undo_checked: true, reloaded: true });

describe('verify bug item and daily counter [pg]', { timeout: 120_000 }, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
  });
  const as = <T,>(who: SeedRefs, fn: (c: PoolClient) => Promise<T>): Promise<T> => withTenant(appPool, who.accountId, fn);

  async function newRepo(who: SeedRefs): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, $4, 'team')`, [id, who.accountId, who.installationId, Math.floor(Math.random() * 1e9) + 10]);
    await withTenant(appPool, who.accountId, who.userId, (c) => saveVerifySettings(c, who.accountId, id, who.userId, { enabled: true, baseUrl: 'https://app.example', eligibility: 'all' }));
    return id;
  }
  /** A row that ran and ended `failed` on journeys c1 and c2 (the item's Spec holds two criteria). */
  async function failedRow(who: SeedRefs, repo: string, pr = 5): Promise<{ rowId: string; itemId: string }> {
    const itemId = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'feature', 'external', 'merged')`, [itemId, who.accountId, repo]);
    const spec = '1. Open the page\n2. Save a note';
    await admin.query(`INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, $3, encode(sha256(convert_to($3, 'UTF8')), 'hex'), 'agent')`, [who.accountId, itemId, spec]);
    const opened = await as(who, (c) => openVerifyRow(c, who.accountId, { workItemId: itemId, prNumber: pr, mergeSha: sha('a') }));
    if (!opened.opened) throw new Error('not opened');
    await as(who, async (c) => {
      await startDeploying(c, who.accountId, opened.rowId, true);
      await startRunning(c, who.accountId, opened.rowId, { method: 'chrome_runner', deployedCommit: sha('a') });
      await finishVerifyRow(c, who.accountId, opened.rowId, { status: 'failed', result: [evidenced('c1', 'fail'), evidenced('c2', 'fail')] });
    });
    return { rowId: opened.rowId, itemId };
  }
  const itemsFor = async (repo: string) => (await admin.query(`SELECT id, kind, provenance, title, repo_id FROM work_items WHERE repo_id = $1 AND title LIKE 'Verify failed%' ORDER BY created_at, id`, [repo])).rows;

  it('files one item for a failed row, in the parent repository with the parent provenance, and attaches it', async () => {
    const repo = await newRepo(a);
    const { rowId } = await failedRow(a, repo, 41);
    const r = await as(a, (c) => fileBugItem(c, a.accountId, rowId, ['c1', 'c2']));
    expect(r).toEqual({ filed: true, itemId: expect.any(String) });
    const items = await itemsFor(repo);
    expect(items).toEqual([{ id: (r as { itemId: string }).itemId, kind: 'small', provenance: 'external', title: 'Verify failed after PR #41: c1, c2', repo_id: repo }]);
    expect((await as(a, (c) => readVerifyRow(c, a.accountId, rowId)))!.bug_item_id).toBe(items[0]!.id);
  });

  it('a replay files nothing and answers the same item', async () => {
    const repo = await newRepo(a);
    const { rowId } = await failedRow(a, repo);
    const first = await as(a, (c) => fileBugItem(c, a.accountId, rowId, ['c1', 'c2']));
    const again = await as(a, (c) => fileBugItem(c, a.accountId, rowId, ['c1', 'c2']));
    expect(again).toEqual({ filed: false, itemId: (first as { itemId: string }).itemId });
    expect(await itemsFor(repo)).toHaveLength(1);
  });

  it('two racing filers make exactly one item and neither fails', async () => {
    const repo = await newRepo(a);
    const { rowId } = await failedRow(a, repo);
    const results = await Promise.all([1, 2, 3].map(() => as(a, (c) => fileBugItem(c, a.accountId, rowId, ['c1', 'c2']))));
    expect(results.filter((r) => r.filed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.itemId)).size).toBe(1);
    expect(await itemsFor(repo)).toHaveLength(1);
  });

  it('a filer that starts while another has filed but not yet committed waits for it, files nothing, fails nothing, and leaves one item', async () => {
    const repo = await newRepo(a);
    const { rowId } = await failedRow(a, repo);
    let second: Promise<unknown> = Promise.resolve();
    const first = await as(a, async (c) => {
      const r = await fileBugItem(c, a.accountId, rowId, ['c1', 'c2']);
      // The first transaction is still open here: its item and attach are invisible to the second, so only the lock can make the second wait.
      second = as(a, (c2) => fileBugItem(c2, a.accountId, rowId, ['c1', 'c2']));
      await new Promise((resolve) => setTimeout(resolve, 400));
      return r;
    });
    expect(first.filed).toBe(true);
    expect(await second).toEqual({ filed: false, itemId: (first as { itemId: string }).itemId });
    expect(await itemsFor(repo)).toHaveLength(1);
  });

  it('an attach the table refuses throws and the insert rolls back with the transaction: no orphan item', async () => {
    const repo = await newRepo(a);
    const { rowId } = await failedRow(a, repo);
    await as(a, (c) => fileBugItem(c, a.accountId, rowId, ['c1']));
    const row = (await admin.query(`SELECT pr_number, repo_id, work_item_id FROM verify_rows WHERE id = $1`, [rowId])).rows[0];
    await expect(as(a, (c) => insertAndAttach(c, a.accountId, rowId, row, ['c1']))).rejects.toBeInstanceOf(BugItemNotAttachedError);
    expect(await itemsFor(repo)).toHaveLength(1);
  });

  it('files nothing for a row that did not fail, an unknown row or another account, and refuses ids that are not plain journey ids', async () => {
    const repo = await newRepo(a);
    const itemId = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'feature', 'internal', 'merged')`, [itemId, a.accountId, repo]);
    const opened = await as(a, (c) => openVerifyRow(c, a.accountId, { workItemId: itemId, prNumber: 3, mergeSha: sha('c') }));
    if (!opened.opened) throw new Error('not opened');
    expect(await as(a, (c) => fileBugItem(c, a.accountId, opened.rowId, ['c1']))).toEqual({ filed: false, itemId: null });
    expect(await as(a, (c) => fileBugItem(c, a.accountId, randomUUID(), ['c1']))).toEqual({ filed: false, itemId: null });
    const { rowId } = await failedRow(a, repo);
    expect(await as(b, (c) => fileBugItem(c, b.accountId, rowId, ['c1']))).toEqual({ filed: false, itemId: null });
    for (const bad of [[], ['C1'], ['c1', 'x y'], ['c1\n[a](https://evil.example)']]) {
      await expect(as(a, (c) => fileBugItem(c, a.accountId, rowId, bad)), JSON.stringify(bad)).rejects.toMatchObject({ code: 'verify_row_invalid' });
    }
    expect(await itemsFor(repo)).toEqual([]);
  });

  it('the title is ids and a number only, and bounded', () => {
    expect(bugItemTitle(7, ['c1', 's_login'])).toBe('Verify failed after PR #7: c1, s_login');
    const many = Array.from({ length: 12 }, (_, i) => `c${i + 1}`);
    expect(bugItemTitle(7, many)).toBe('Verify failed after PR #7: c1, c2, c3, c4, c5, c6, c7, c8 and 4 more');
    expect(Array.from(bugItemTitle(7, Array.from({ length: 8 }, () => 'x'.repeat(40)))).length).toBeLessThanOrEqual(120);
  });

  describe('the daily counters are split: the tester has its own, the claim verifier and the analyst share the other', () => {
    /** A tester run of the repository started today holding `usd` in the ledger. */
    async function testerSpend(who: SeedRefs, repo: string, usd: number): Promise<string> {
      const { rowId } = await failedRow(who, repo);
      const runId = randomUUID();
      await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, ended_at) VALUES ($1, $2, 'deploy-verifier', 'local', 'succeeded', now())`, [runId, who.accountId]);
      const key = verifyStageRunKey(rowId);
      await admin.query(`INSERT INTO agent_run_idempotency_keys (account_id, idempotency_key, run_id, request_hash) VALUES ($1, $2, $3, $4)`, [who.accountId, key, runId, 'd'.repeat(64)]);
      await admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'model', 'customer_gateway', $2, $3, 'model')`, [who.accountId, usd, runId]);
      return key;
    }
    let n = 0;
    /** A claim verifier run of the repository started today holding `usd` in the ledger. */
    async function verifierSpend(who: SeedRefs, repo: string, usd: number): Promise<void> {
      const { rows } = await admin.query<{ id: string }>(
        `INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, gh_number, title, provenance, owner_process) VALUES ($1, $2, $3, '{github_issue}', $4, 'spent', 'internal', 'internal_loop') RETURNING id`,
        [who.accountId, repo, `gh:issue:${9000 + ++n}`, 9000 + n],
      );
      const runId = randomUUID();
      await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, ended_at) VALUES ($1, $2, 'proposal-verifier', 'local', 'succeeded', now())`, [runId, who.accountId]);
      await admin.query(`INSERT INTO agent_run_idempotency_keys (account_id, idempotency_key, run_id, request_hash) VALUES ($1, $2, $3, $4)`, [who.accountId, `proposal-verify:${rows[0]!.id}:aaaaaaaa:0`, runId, 'd'.repeat(64)]);
      await admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'model', 'customer_gateway', $2, $3, 'model')`, [who.accountId, usd, runId]);
    }
    /** An analyst run of the repository started today holding `usd` in the ledger. */
    async function analysisSpend(who: SeedRefs, repo: string, usd: number): Promise<void> {
      const { rows } = await admin.query<{ id: string }>(`INSERT INTO discovery_analyses (account_id, repo_id, head_sha, trigger) VALUES ($1, $2, $3, 'sweep') RETURNING id`, [who.accountId, repo, (++n).toString(16).padStart(40, '0')]);
      const runId = randomUUID();
      await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, ended_at) VALUES ($1, $2, 'discovery-analyst', 'local', 'succeeded', now())`, [runId, who.accountId]);
      await admin.query(`INSERT INTO agent_run_idempotency_keys (account_id, idempotency_key, run_id, request_hash) VALUES ($1, $2, $3, $4)`, [who.accountId, analysisRunKey(rows[0]!.id, 1), runId, 'd'.repeat(64)]);
      await admin.query(`INSERT INTO ledger (account_id, kind, source, usd, run_id, budget) VALUES ($1, 'model', 'customer_gateway', $2, $3, 'model')`, [who.accountId, usd, runId]);
    }
    /** An open reservation held by a run of the given kind: `claims` is a verifier run, `tester` a tester run. */
    async function reservation(who: SeedRefs, repo: string, side: 'claims' | 'tester', usd: number): Promise<void> {
      const runId = randomUUID();
      await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, $3, 'local', 'running')`, [runId, who.accountId, side === 'tester' ? 'deploy-verifier' : 'proposal-verifier']);
      if (side === 'tester') {
        const { rowId } = await failedRow(who, repo, 20 + ++n);
        await admin.query(`INSERT INTO agent_run_idempotency_keys (account_id, idempotency_key, run_id, request_hash) VALUES ($1, $2, $3, $4)`, [who.accountId, verifyStageRunKey(rowId), runId, 'd'.repeat(64)]);
      } else {
        const { rows } = await admin.query<{ id: string }>(
          `INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, gh_number, title, provenance, owner_process) VALUES ($1, $2, $3, '{github_issue}', $4, 'held', 'internal', 'internal_loop') RETURNING id`,
          [who.accountId, repo, `gh:issue:${9000 + ++n}`, 9000 + n],
        );
        await admin.query(`INSERT INTO agent_run_idempotency_keys (account_id, idempotency_key, run_id, request_hash) VALUES ($1, $2, $3, $4)`, [who.accountId, `proposal-verify:${rows[0]!.id}:aaaaaaaa:0`, runId, 'd'.repeat(64)]);
      }
      await admin.query(`INSERT INTO spend_reservations (account_id, run_id, budget, usd_reserved, state) VALUES ($1, $2, 'model', $3, 'open')`, [who.accountId, runId, usd]);
    }
    const pending = (repo: string) => ({ id: randomUUID(), repo_id: repo, provenance: 'internal', title: 'p', summary: null, gh_number: null, discussion_number: null, verify_attempts: 0, verify_requeues: 0, analysis_refs: null });
    const limits = (perRepoDailyUsd: number) => ({ perRepoDailyUsd, verifyPerProposalUsd: 0.4, externalVerifiesPerRepoPerDay: 99 });

    it('a tester run today counts on the tester side against its repository, not another repository or account, and not yesterday', async () => {
      const repo = await newRepo(a);
      const other = await newRepo(a);
      const key = await testerSpend(a, repo, 1.7);
      expect(await as(a, (c) => overRepoDailyUsd(c, a.accountId, repo, 0.4, 2.0, 'tester'))).toBe(true);
      expect(await as(a, (c) => overRepoDailyUsd(c, a.accountId, repo, 0.4, 2.2, 'tester'))).toBe(false);
      expect(await as(a, (c) => overRepoDailyUsd(c, a.accountId, other, 0.4, 2.0, 'tester'))).toBe(false);
      expect(await as(b, (c) => overRepoDailyUsd(c, b.accountId, repo, 0.4, 2.0, 'tester'))).toBe(false);
      await admin.query(`UPDATE agent_run_idempotency_keys SET created_at = now() - interval '1 day' WHERE account_id = $1 AND idempotency_key = $2`, [a.accountId, key]);
      expect(await as(a, (c) => overRepoDailyUsd(c, a.accountId, repo, 0.4, 2.0, 'tester'))).toBe(false);
    });

    it('tester spend and tester reservations over the shared cap leave the claim verifier (verifyHold null) and the analyst (claims side) unheld', async () => {
      const repo = await newRepo(a);
      await testerSpend(a, repo, 7);
      await reservation(a, repo, 'tester', 3.3);
      // The same figures that hold the tester (7 + 3.3 + 0.4 > 2) say nothing against the claims side.
      expect(await as(a, (c) => overRepoDailyUsd(c, a.accountId, repo, 0.4, 2.0, 'tester'))).toBe(true);
      expect(await as(a, (c) => overRepoDailyUsd(c, a.accountId, repo, 0.4, 2.0, 'claims'))).toBe(false);
      expect(await as(a, (c) => verifyHold(c, a.accountId, pending(repo), limits(2.0)))).toBeNull();
    });

    it('claim verifier and analyst spend and reservations do not hold the tester, and each side is still held at its own cap', async () => {
      const repo = await newRepo(a);
      await verifierSpend(a, repo, 4);
      await analysisSpend(a, repo, 3);
      await reservation(a, repo, 'claims', 2.5);
      // 9.5 of claim spend: the claims side is held by 2 and by 9.8 (9.5 + 0.4 > 9.8 is false, so 9.9 is room), the tester side sees none of it.
      expect(await as(a, (c) => overRepoDailyUsd(c, a.accountId, repo, 0.4, 2.0, 'claims'))).toBe(true);
      expect(await as(a, (c) => verifyHold(c, a.accountId, pending(repo), limits(2.0)))).toBe('daily_spend');
      expect(await as(a, (c) => overRepoDailyUsd(c, a.accountId, repo, 0.4, 9.8, 'claims'))).toBe(true);
      expect(await as(a, (c) => overRepoDailyUsd(c, a.accountId, repo, 0.4, 9.9, 'claims'))).toBe(false);
      expect(await as(a, (c) => overRepoDailyUsd(c, a.accountId, repo, 0.4, 0.5, 'tester'))).toBe(false);
      // The tester's own spend holds it at its own cap, to the cent.
      await testerSpend(a, repo, 1.6);
      expect(await as(a, (c) => overRepoDailyUsd(c, a.accountId, repo, 0.4, 1.9, 'tester'))).toBe(true);
      expect(await as(a, (c) => overRepoDailyUsd(c, a.accountId, repo, 0.4, 2.0, 'tester'))).toBe(false);
    });

    it('a claim run key and a tester run key never cross: a proposal key is not a tester run, a verify-stage key is not a claim run', async () => {
      const repo = await newRepo(a);
      await testerSpend(a, repo, 5);
      const p = pending(repo);
      // A key of the proposal-verify shape for this id does not exist yet, so the hold is decided by spend alone.
      expect(proposalVerifyKey(p).startsWith('proposal-verify:')).toBe(true);
      expect(await as(a, (c) => verifyHold(c, a.accountId, p, limits(0.5)))).toBeNull();
    });
  });
});
