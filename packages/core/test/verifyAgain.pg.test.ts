import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { setPendingHooks } from '../src/pendingWork.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { recordDriverEvent } from '../src/work-items/driverEvents.js';
import { operatorActionsFor, readOperatorFacts } from '../src/work-items/operatorActions.js';
import { OperatorRefusedError, verifyAgainWorkItem, type OperatorMoveCtx } from '../src/work-items/operatorMoves.js';
import { fileBugItem } from '../src/verify/bugItem.js';
import { readItemVerify } from '../src/work-items/itemVerify.js';
import {
  finishVerifyRow, listVerifyRows, openVerifyRow, readStreak, readVerifyAgain, readVerifyRow, saveVerifySettings, startDeploying, startRunning,
  type JourneyResult, type VerifyRow,
} from '../src/verify/rows.js';

/** D#749: a person's "Verify again" on a finished post-merge check, against a real Postgres as app_user: the rows, the audit row, the hint, and the streak. */
const BASE_URL = 'https://app.example';
const sha = (c: string): string => c.repeat(40);
const HINT = 'pending:proposal-verify-sweep';
const MERGE_G = `1a${'1'.repeat(38)}`;

describe('Verify again [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let a: SeedRefs;
  let memberId: string;
  let markers: Map<string, number>;
  let kicked: string[];

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
    memberId = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [memberId, `${memberId}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'member')`, [a.accountId, memberId]);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appPool.end();
  });
  beforeEach(() => {
    markers = new Map();
    kicked = [];
    setPendingHooks({ store: { get: async (k) => markers.get(k) ?? null, set: async (k, v) => void markers.set(k, v), delete: async (k) => void markers.delete(k) }, kick: (name) => void kicked.push(name) });
  });
  afterEach(() => setPendingHooks(null));

  const asOwner = <T,>(fn: (c: PoolClient) => Promise<T>): Promise<T> => withTenant(appPool, a.accountId, a.userId, fn);
  const asWorker = <T,>(fn: (c: PoolClient) => Promise<T>): Promise<T> => withTenant(appPool, a.accountId, fn);
  const ctx = (who: 'owner' | 'member' = 'owner', role?: string): OperatorMoveCtx => ({
    pool: appPool,
    principal: { accountId: a.accountId, userId: who === 'owner' ? a.userId : memberId, role: role ?? (who === 'owner' ? 'owner' : 'member') },
  });

  async function newRepo(): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, $4, 'team')`, [id, a.accountId, a.installationId, Math.floor(Math.random() * 1e9) + 10]);
    return id;
  }
  async function newItem(repoId: string, stage = 'merged'): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'feature', 'internal', $4)`, [id, a.accountId, repoId, stage]);
    await admin.query(`INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, '1. Open the page', encode(sha256(convert_to('1. Open the page', 'UTF8')), 'hex'), 'agent')`, [a.accountId, id]);
    return id;
  }
  const turnOn = (repoId: string) => asOwner((c) => saveVerifySettings(c, a.accountId, repoId, a.userId, { enabled: true, baseUrl: BASE_URL, eligibility: 'all' }));
  const evidenced = (id: string, over: Partial<JourneyResult> = {}): JourneyResult => ({ id, result: 'pass', steps: [{ did: 'opened the page', dom_fact: 'the heading reads Hello', number: 1 }], console_errors: 0, undo_checked: true, reloaded: true, ...over });

  /** A merged item with a row for `merge`, the product's merge fact, taken to `outcome`. */
  async function itemWithRow(repo: string, merge: string, outcome: 'pending' | 'deploying' | 'running' | 'verified' | 'failed' | 'unverified', pr = 41): Promise<{ item: string; rowId: string }> {
    const item = await newItem(repo);
    const o = (await asWorker((c) => openVerifyRow(c, a.accountId, { workItemId: item, prNumber: pr, mergeSha: merge }))) as { opened: true; rowId: string };
    expect(o.opened).toBe(true);
    await asWorker((c) => recordDriverEvent(c, a.accountId, { workItemId: item, kind: 'merged_by_gate', dedupeKey: `m-${merge}`, code: 'merged', headSha: merge, prNumber: pr }));
    await advanceRow(o.rowId, merge, outcome);
    return { item, rowId: o.rowId };
  }
  async function advanceRow(rowId: string, merge: string, outcome: 'pending' | 'deploying' | 'running' | 'verified' | 'failed' | 'unverified'): Promise<void> {
    if (outcome === 'pending') return;
    await asWorker((c) => startDeploying(c, a.accountId, rowId, true));
    if (outcome === 'deploying') return;
    if (outcome === 'unverified') {
      await asWorker((c) => finishVerifyRow(c, a.accountId, rowId, { status: 'unverified', reason: 'deployment_unreachable' }));
      return;
    }
    await asWorker((c) => startRunning(c, a.accountId, rowId, { method: 'chrome_runner', deployedCommit: merge }));
    if (outcome === 'running') return;
    const row = (await asWorker((c) => readVerifyRow(c, a.accountId, rowId)))!;
    const result = row.journeys.map((j) => evidenced(j.id, outcome === 'failed' ? { result: 'fail' } : {}));
    await asWorker((c) => finishVerifyRow(c, a.accountId, rowId, { status: outcome, result }));
  }
  const rowsOf = (item: string): Promise<VerifyRow[]> => asWorker(async (c) => (await c.query<VerifyRow>(`SELECT * FROM verify_rows WHERE work_item_id = $1 ORDER BY attempt`, [item])).rows);
  const audits = async (item: string) => (await admin.query<{ actor: string; action: string; payload: Record<string, unknown> }>(`SELECT actor, action, payload FROM audit_log WHERE account_id = $1 AND action = 'work_item.sent_back' AND payload ->> 'action' = 'verify_again' AND payload ->> 'work_item_id' = $2 ORDER BY created_at`, [a.accountId, item])).rows;

  describe('which states allow it', () => {
    const cases: Array<[string, boolean]> = [['pending', false], ['deploying', false], ['running', false], ['verified', false], ['failed', true], ['unverified', true]];
    it.each(cases)('a newest row that is %s: allowed = %s', async (status, allowed) => {
      const repo = await newRepo();
      await turnOn(repo);
      const { item } = await itemWithRow(repo, sha('1'), status as 'pending');
      expect((await asWorker((c) => readVerifyAgain(c, item))) !== null).toBe(allowed);
      expect(await asWorker(async (c) => operatorActionsFor((await readOperatorFacts(c, item, 'owner'))!).includes('verify_again'))).toBe(allowed);
      if (!allowed) {
        await expect(verifyAgainWorkItem(ctx(), item)).rejects.toBeInstanceOf(OperatorRefusedError);
        expect(await rowsOf(item)).toHaveLength(1);
        expect(markers.has(HINT)).toBe(false);
        expect(kicked).toEqual([]);
        expect(await audits(item)).toEqual([]);
      }
    });

    it('is refused when verification is off for the repository, when the item is not merged, and for a member', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const { item } = await itemWithRow(repo, sha('2'), 'unverified');
      await asOwner((c) => saveVerifySettings(c, a.accountId, repo, a.userId, { enabled: false }));
      expect(await asWorker((c) => readVerifyAgain(c, item))).toBeNull();
      await expect(verifyAgainWorkItem(ctx(), item)).rejects.toBeInstanceOf(OperatorRefusedError);
      await turnOn(repo);
      expect(await asWorker((c) => readVerifyAgain(c, item))).not.toBeNull();
      // A member (and a context that claims no role) is refused by the table before anything is written.
      await expect(verifyAgainWorkItem(ctx('member'), item)).rejects.toBeInstanceOf(OperatorRefusedError);
      await expect(verifyAgainWorkItem(ctx('owner', 'viewer'), item)).rejects.toBeInstanceOf(OperatorRefusedError);
      expect(await rowsOf(item)).toHaveLength(1);
      // Not merged any more (the stage moved): nothing to check again.
      await admin.query(`UPDATE work_items SET stage = 'closed' WHERE id = $1`, [item]);
      expect(await asWorker((c) => readVerifyAgain(c, item))).toBeNull();
      await expect(verifyAgainWorkItem(ctx(), item)).rejects.toBeInstanceOf(OperatorRefusedError);
    });

    it('an item with no row, an unknown item and another account\'s item are refused', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const bare = await newItem(repo);
      expect(await asWorker((c) => readVerifyAgain(c, bare))).toBeNull();
      await expect(verifyAgainWorkItem(ctx(), bare)).rejects.toBeInstanceOf(OperatorRefusedError);
      await expect(verifyAgainWorkItem(ctx(), randomUUID())).rejects.toThrow('not found');
      const other = await seedAccount(admin, randomUUID());
      const stranger: OperatorMoveCtx = { pool: appPool, principal: { accountId: other.accountId, userId: other.userId, role: 'owner' } };
      const { item } = await itemWithRow(repo, sha('3'), 'failed');
      await expect(verifyAgainWorkItem(stranger, item)).rejects.toThrow('not found');
      expect(await rowsOf(item)).toHaveLength(1);
    });
  });

  describe('the press on a Spec in the shape the pipeline stores', () => {
    it('the new row has the Spec criteria as journeys, not an empty list', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const { item } = await itemWithRow(repo, sha('7'), 'unverified', 47);
      const real = readFileSync(new URL('./fixtures/verify/realSpecBody.txt', import.meta.url), 'utf8');
      await admin.query(`UPDATE spec_versions SET body = $2, body_sha256 = encode(sha256(convert_to($2, 'UTF8')), 'hex') WHERE work_item_id = $1`, [item, real]);
      const out = await verifyAgainWorkItem(ctx(), item);
      const row = (await rowsOf(item)).find((r) => r.id === out.rowId)!;
      expect(row.journeys.map((j) => j.id)).toEqual(['c1', 'c2']);
      expect(row.checks_only).toEqual([3]);
    });
  });

  describe('the press', () => {
    it('opens a new pending row for the same merge, keeps the finished row untouched, marks the hint and writes the audit row', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const { item, rowId } = await itemWithRow(repo, sha('4'), 'unverified', 44);
      const before = (await rowsOf(item))[0]!;
      expect(before).toMatchObject({ attempt: 1, status: 'unverified', reason_code: 'deployment_unreachable' });

      const out = await verifyAgainWorkItem(ctx(), item);
      expect(out.attempt).toBe(2);
      expect(out.rowId).not.toBe(rowId);

      const rows = await rowsOf(item);
      expect(rows).toHaveLength(2);
      // The old row is exactly as it was (history), the new one is a fresh pending row for the same merge commit and pull request.
      expect(rows[0]).toEqual(before);
      expect(rows[1]).toMatchObject({ id: out.rowId, attempt: 2, status: 'pending', merge_sha: sha('4'), pr_number: 44, repo_id: repo, reason_code: null, result: null, method: null, person_step: false });
      expect(rows[1]!.journeys.length).toBeGreaterThan(0);
      expect((await admin.query(`SELECT count(*)::int AS n FROM verify_batches WHERE id = $1 AND status = 'closed'`, [rows[1]!.batch_id])).rows[0].n).toBe(1);

      // Push, not poll: the verify sweep's hint was set, for the sweep that already runs; the sweep reads the rows.
      expect(markers.has(HINT)).toBe(true);
      // ... and the sweep was kicked, so the new row is read within seconds rather than at the next tick.
      expect(kicked).toEqual(['proposal-verify-sweep']);

      // The audit row names who asked and which rows.
      expect(await audits(item)).toEqual([expect.objectContaining({ actor: a.userId, payload: expect.objectContaining({ work_item_id: item, action: 'verify_again', verify_row_id: out.rowId, attempt: 2 }) })]);

      // The card's read now shows the new row (waiting), the old one still stands in the table, and the action is no longer offered.
      expect(await asWorker((c) => readItemVerify(c, item))).toMatchObject({ status: 'pending', reason: null });
      expect(await asWorker((c) => readVerifyAgain(c, item))).toBeNull();
      expect(await asWorker((c) => listVerifyRows(c, a.accountId, repo))).toHaveLength(2);
    });

    it('a second press while the new row is in flight is refused and writes nothing; a double press at once opens one row', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const { item } = await itemWithRow(repo, sha('5'), 'failed', 45);
      const settled = await Promise.allSettled([verifyAgainWorkItem(ctx(), item), verifyAgainWorkItem(ctx(), item)]);
      expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
      const lost = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason).toBeInstanceOf(OperatorRefusedError);
      expect(await rowsOf(item)).toHaveLength(2);
      expect(await audits(item)).toHaveLength(1);
      await expect(verifyAgainWorkItem(ctx(), item)).rejects.toBeInstanceOf(OperatorRefusedError);
      expect(await rowsOf(item)).toHaveLength(2);
    });

    it('can be pressed again after the new row also ends unverified or failed (attempt 3); never after it verifies', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const { item } = await itemWithRow(repo, sha('6'), 'unverified', 46);
      const second = await verifyAgainWorkItem(ctx(), item);
      await advanceRow(second.rowId, sha('6'), 'failed');
      const third = await verifyAgainWorkItem(ctx(), item);
      expect(third.attempt).toBe(3);
      // The failed row's failing journeys are checked again by the new one.
      expect((await rowsOf(item))[2]!.journeys.length).toBeGreaterThan(0);
      await advanceRow(third.rowId, sha('6'), 'verified');
      expect(await asWorker((c) => readVerifyAgain(c, item))).toBeNull();
      await expect(verifyAgainWorkItem(ctx(), item)).rejects.toBeInstanceOf(OperatorRefusedError);
      expect((await rowsOf(item)).map((r) => r.status)).toEqual(['unverified', 'failed', 'verified']);
    });

    it('the sweep\'s intake still sees the merge as taken: a replay of openVerifyRow finds a row and opens no new one', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const { item } = await itemWithRow(repo, sha('7'), 'unverified', 47);
      await verifyAgainWorkItem(ctx(), item);
      const replay = await asWorker((c) => openVerifyRow(c, a.accountId, { workItemId: item, prNumber: 47, mergeSha: sha('7') }));
      expect(replay).toMatchObject({ opened: false, reason: 'already_open' });
      expect(await rowsOf(item)).toHaveLength(2);
    });
  });

  describe('the new row is planned afresh from the Spec as it stands', () => {
    const setSpec = (item: string, body: string) => admin.query(`UPDATE spec_versions SET body = $2, body_sha256 = encode(sha256(convert_to($2, 'UTF8')), 'hex') WHERE work_item_id = $1`, [item, body]);
    const checksOf = async (rowId: string) => (await admin.query<{ checks_only: number[] }>(`SELECT checks_only FROM verify_rows WHERE id = $1`, [rowId])).rows[0]!.checks_only;

    it('a criterion that was visible and is now code-level only: the new row ends at once unverified / no_visible_journeys and lists it in checks_only', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const { item, rowId } = await itemWithRow(repo, sha('3'), 'unverified', 71);
      expect((await rowsOf(item))[0]!.journeys.map((j) => j.id)).toEqual(['c1']);
      expect(await checksOf(rowId)).toEqual([]);
      await setSpec(item, '1. `repoLabel()` returns the full name');
      const out = await verifyAgainWorkItem(ctx(), item);
      const second = (await rowsOf(item))[1]!;
      expect(second).toMatchObject({ id: out.rowId, attempt: 2, status: 'unverified', reason_code: 'no_visible_journeys', journeys: [] });
      expect(await checksOf(out.rowId)).toEqual([1]);
      // The first row keeps what it was planned with.
      expect((await rowsOf(item))[0]!.journeys.map((j) => j.id)).toEqual(['c1']);
      expect(await checksOf(rowId)).toEqual([]);
    });

    it('a new visible criterion appears on the new row as a c<n> journey, and the code-level one is left to the checks', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const { item } = await itemWithRow(repo, sha('4'), 'unverified', 72);
      await setSpec(item, '1. `repoLabel()` returns the full name\n2. [ui] The empty state says so');
      const out = await verifyAgainWorkItem(ctx(), item);
      const second = (await rowsOf(item))[1]!;
      expect(second).toMatchObject({ id: out.rowId, attempt: 2, status: 'pending' });
      expect(second.journeys.map((j) => j.id)).toEqual(['c2']);
      expect(await checksOf(out.rowId)).toEqual([1]);
    });
  });

  describe('the bug item', () => {
    it('fail, Verify again, fail again: the second failure attaches the first one\'s bug item and files no second', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const { item, rowId } = await itemWithRow(repo, sha('2'), 'failed', 61);
      const first = await asWorker((c) => fileBugItem(c, a.accountId, rowId, ['c1']));
      expect(first.filed).toBe(true);
      const again = await verifyAgainWorkItem(ctx(), item);
      await advanceRow(again.rowId, sha('2'), 'failed');
      const second = await asWorker((c) => fileBugItem(c, a.accountId, again.rowId, ['c1']));
      expect(second).toEqual({ filed: false, itemId: first.itemId });
      const rows = await rowsOf(item);
      expect(rows.map((r) => r.bug_item_id)).toEqual([first.itemId, first.itemId]);
      const items = await admin.query(`SELECT id FROM work_items WHERE account_id = $1 AND title LIKE 'Verify failed after PR #61:%'`, [a.accountId]);
      expect(items.rows).toHaveLength(1);
      // A replay files nothing either.
      expect(await asWorker((c) => fileBugItem(c, a.accountId, again.rowId, ['c1']))).toEqual({ filed: false, itemId: first.itemId });
    });
  });

  describe('the table', () => {
    it('keeps one row per attempt of a merge and at most one unfinished row per merge', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const { item } = await itemWithRow(repo, sha('8'), 'unverified', 48);
      const first = (await rowsOf(item))[0]!;
      const insert = (attempt: number) =>
        admin.query(`INSERT INTO verify_rows (account_id, repo_id, batch_id, work_item_id, pr_number, merge_sha, journeys, attempt) VALUES ($1, $2, $3, $4, 48, $5, '[]'::jsonb, $6)`, [a.accountId, repo, first.batch_id, item, sha('8'), attempt]);
      // The same attempt twice is the old one-per-merge rule, kept per attempt.
      await expect(insert(1)).rejects.toMatchObject({ code: '23505' });
      await insert(2);
      // A second unfinished row for the merge, whatever its attempt.
      await expect(insert(3)).rejects.toMatchObject({ code: '23505', constraint: 'verify_rows_one_unfinished_per_merge' });
      await expect(admin.query(`INSERT INTO verify_rows (account_id, repo_id, batch_id, work_item_id, pr_number, merge_sha, journeys, attempt) VALUES ($1, $2, $3, $4, 48, $5, '[]'::jsonb, 0)`, [a.accountId, repo, first.batch_id, item, sha('9')])).rejects.toMatchObject({ code: '23514' });
    });

    it('a finished row still cannot be changed, and the attempt cannot be moved by the application login', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const { item, rowId } = await itemWithRow(repo, sha('a'), 'unverified', 49);
      await expect(asWorker((c) => c.query(`UPDATE verify_rows SET status = 'pending', reason_code = NULL, finished_at = NULL WHERE id = $1`, [rowId]))).rejects.toMatchObject({ code: '23514' });
      await expect(asWorker((c) => c.query(`UPDATE verify_rows SET attempt = 9 WHERE id = $1`, [rowId]))).rejects.toMatchObject({ code: '42501' });
      expect((await rowsOf(item))[0]).toMatchObject({ attempt: 1, status: 'unverified' });
    });
  });

  describe('the streak', () => {
    const streak = (repo: string) => asWorker((c) => readStreak(c, a.accountId, repo));

    it('a merge that needed Verify again is not a hands-free pass, even when the new row verifies; its outcome is still recorded; the next clean merge counts again', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      await itemWithRow(repo, sha('b'), 'verified', 51);
      expect(await streak(repo)).toBe(1);

      const { item } = await itemWithRow(repo, sha('c'), 'unverified', 52);
      expect(await streak(repo)).toBe(0);
      const again = await verifyAgainWorkItem(ctx(), item);
      // The new row is deployed by the stage's own order and driven by a gate method, exactly as a first row would be: it verifies cleanly.
      await advanceRow(again.rowId, sha('c'), 'verified');
      const rows = await rowsOf(item);
      expect(rows.map((r) => [r.attempt, r.status])).toEqual([[1, 'unverified'], [2, 'verified']]);
      expect(rows[1]).toMatchObject({ deploy_by_order: true, method: 'chrome_runner', person_step: false });
      // The outcome is recorded and shown ...
      expect(await asWorker((c) => readItemVerify(c, item))).toMatchObject({ status: 'verified', method: 'chrome_runner' });
      // ... but it does not count toward the switchover gate: the streak is 0, not 1.
      expect(await streak(repo)).toBe(0);

      await itemWithRow(repo, sha('d'), 'verified', 53);
      expect(await streak(repo)).toBe(1);
    });

    it('a Verify again that fails again keeps the streak at 0, and a first-attempt clean merge before it is wiped, as for any failure', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      await itemWithRow(repo, sha('e'), 'verified', 54);
      await itemWithRow(repo, sha('f'), 'verified', 55);
      expect(await streak(repo)).toBe(2);
      const { item } = await itemWithRow(repo, MERGE_G, 'failed', 56);
      expect(await streak(repo)).toBe(0);
      const again = await verifyAgainWorkItem(ctx(), item);
      await advanceRow(again.rowId, MERGE_G, 'failed');
      expect(await streak(repo)).toBe(0);
    });
  });
});
