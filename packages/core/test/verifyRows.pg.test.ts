import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { listDriverEvents, recordDriverEvent } from '../src/work-items/driverEvents.js';
import { readVerifySettings } from '../src/verify/settings.js';
import {
  attachBugItem, canMove, endUnstartedRows, finishVerifyRow, listVerifyRows, markPersonStep, openVerifyRow, readStreak, readVerifyRow, saveVerifySettings,
  startDeploying, startRunning, VERIFY_ROW_STATUSES, type JourneyResult, type VerifyRowStatus,
} from '../src/verify/rows.js';

/** D#6 V1: the verify stage's tables, rules and store against a real Postgres, as app_user, through withTenant. */
const BASE_URL = 'https://app.example';
const sha = (c: string): string => c.repeat(40);

describe('verify stage store', () => {
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

  const asOwner = <T,>(fn: (c: PoolClient) => Promise<T>): Promise<T> => withTenant(appPool, a.accountId, a.userId, fn);
  const asWorker = <T,>(fn: (c: PoolClient) => Promise<T>): Promise<T> => withTenant(appPool, a.accountId, fn);

  async function newRepo(): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, $4, 'team')`, [id, a.accountId, a.installationId, Math.floor(Math.random() * 1e9) + 10]);
    return id;
  }
  async function newItem(repoId: string, stage = 'merged', spec?: string): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'feature', 'internal', $4)`, [id, a.accountId, repoId, stage]);
    if (spec !== undefined) {
      await admin.query(`INSERT INTO spec_versions (account_id, work_item_id, version, body, body_sha256, created_by_kind) VALUES ($1, $2, 1, $3, encode(sha256(convert_to($3, 'UTF8')), 'hex'), 'agent')`, [a.accountId, id, spec]);
    }
    return id;
  }
  async function turnOn(repoId: string, extra: Record<string, unknown> = {}): Promise<void> {
    await asOwner((c) => saveVerifySettings(c, a.accountId, repoId, a.userId, { enabled: true, baseUrl: BASE_URL, eligibility: 'all', ...extra }));
  }
  async function open(itemId: string, mergeSha = sha('a'), pr = 5) {
    return asWorker((c) => openVerifyRow(c, a.accountId, { workItemId: itemId, prNumber: pr, mergeSha }));
  }
  const evidenced = (id: string, over: Partial<JourneyResult> = {}): JourneyResult => ({ id, result: 'pass', steps: [{ did: 'opened the page', dom_fact: 'the heading reads Hello', number: 1 }], console_errors: 0, undo_checked: true, reloaded: true, ...over });
  async function toRunning(rowId: string, commit = sha('a')): Promise<void> {
    await asWorker(async (c) => {
      expect((await startDeploying(c, a.accountId, rowId, true)).moved).toBe(true);
      expect((await startRunning(c, a.accountId, rowId, { method: 'chrome_runner', deployedCommit: commit })).moved).toBe(true);
    });
  }
  const factKinds = (itemId: string): Promise<string[]> => asWorker(async (c) => (await listDriverEvents(c, itemId)).filter((e) => e.kind.startsWith('verify_')).map((e) => `${e.kind}${e.code === null ? '' : `:${e.code}`}`));

  describe('off by default, settings and RLS', () => {
    it('a repository nobody configured is off, and opens no row, batch or fact', async () => {
      const repo = await newRepo();
      const item = await newItem(repo);
      const s = await asWorker((c) => readVerifySettings(c, repo));
      expect(s).toMatchObject({ configured: false, enabled: false, baseUrl: null, eligibility: 'ui_paths', batchSize: 1 });
      expect(await open(item)).toEqual({ opened: false, reason: 'verify_off' });
      const counts = await admin.query(`SELECT (SELECT count(*) FROM verify_rows WHERE repo_id = $1)::int AS r, (SELECT count(*) FROM verify_batches WHERE repo_id = $1)::int AS b, (SELECT count(*) FROM verify_settings WHERE repo_id = $1)::int AS s`, [repo]);
      expect(counts.rows[0]).toEqual({ r: 0, b: 0, s: 0 });
    });

    it('an owner saves settings; a member and a context with no user are refused by the database', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      expect((await asWorker((c) => readVerifySettings(c, repo))).enabled).toBe(true);
      const asMember = withTenant(appPool, a.accountId, memberId, (c) => saveVerifySettings(c, a.accountId, repo, memberId, { enabled: false }));
      await expect(asMember).rejects.toMatchObject({ code: '42501' });
      await expect(asWorker((c) => saveVerifySettings(c, a.accountId, repo, a.userId, { enabled: false }))).rejects.toMatchObject({ code: '42501' });
      expect((await asWorker((c) => readVerifySettings(c, repo))).enabled).toBe(true);
      // A member cannot create the first row of another repository either.
      const other = await newRepo();
      await expect(withTenant(appPool, a.accountId, memberId, (c) => saveVerifySettings(c, a.accountId, other, memberId, { enabled: true, baseUrl: BASE_URL }))).rejects.toMatchObject({ code: '42501' });
    });

    // D#749 V3c (migration 1007): the browser driver is a column of the same table, written under the same admin-only policy and read by the stage.
    it('the browser driver defaults to playwright; an owner sets chrome; a member cannot change it; the application and the table refuse anything else', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      expect((await asWorker((c) => readVerifySettings(c, repo))).browserDriver).toBe('playwright');
      expect((await asOwner((c) => saveVerifySettings(c, a.accountId, repo, a.userId, { browserDriver: 'chrome' }))).settings.browserDriver).toBe('chrome');
      expect((await asWorker((c) => readVerifySettings(c, repo))).browserDriver).toBe('chrome');
      // A save that does not name it keeps it.
      await asOwner((c) => saveVerifySettings(c, a.accountId, repo, a.userId, { eligibility: 'all' }));
      expect((await asWorker((c) => readVerifySettings(c, repo))).browserDriver).toBe('chrome');
      await expect(withTenant(appPool, a.accountId, memberId, (c) => saveVerifySettings(c, a.accountId, repo, memberId, { browserDriver: 'playwright' }))).rejects.toMatchObject({ code: '42501' });
      await expect(asWorker((c) => saveVerifySettings(c, a.accountId, repo, a.userId, { browserDriver: 'playwright' }))).rejects.toMatchObject({ code: '42501' });
      expect((await asWorker((c) => readVerifySettings(c, repo))).browserDriver).toBe('chrome');
      for (const bad of ['firefox', '', 'Chrome', null, 1]) {
        await expect(asOwner((c) => saveVerifySettings(c, a.accountId, repo, a.userId, { browserDriver: bad as never })), String(bad)).rejects.toMatchObject({ code: 'verify_setting_invalid' });
      }
      await expect(admin.query(`UPDATE verify_settings SET browser_driver = 'firefox' WHERE repo_id = $1`, [repo])).rejects.toMatchObject({ constraint: 'verify_settings_browser_driver_check' });
      await expect(admin.query(`UPDATE verify_settings SET browser_driver = NULL WHERE repo_id = $1`, [repo])).rejects.toMatchObject({ code: '23502' });
    });

    it('refuses to switch on without a base URL, in the application and in the table', async () => {
      const repo = await newRepo();
      await expect(asOwner((c) => saveVerifySettings(c, a.accountId, repo, a.userId, { enabled: true }))).rejects.toMatchObject({ code: 'verify_base_url_required' });
      await expect(admin.query(`INSERT INTO verify_settings (account_id, repo_id, enabled) VALUES ($1, $2, true)`, [a.accountId, repo])).rejects.toMatchObject({ constraint: 'verify_settings_enabled_needs_url' });
    });

    it('refuses a base URL that is not an https origin, and what the table would refuse', async () => {
      const repo = await newRepo();
      for (const bad of ['http://app.example', 'https://app.example/path', 'https://user:pw@app.example', 'https://app.example?x=1', 'ftp://app.example', 'app.example', 'https://App.Example/x#y', '']) {
        await expect(asOwner((c) => saveVerifySettings(c, a.accountId, repo, a.userId, { baseUrl: bad })), bad).rejects.toMatchObject({ code: 'verify_base_url_invalid' });
      }
      for (const bad of ['https://app.example/', 'https://[::1]', 'https://UPPER.example', 'https://a b.example']) {
        await expect(admin.query(`INSERT INTO verify_settings (account_id, repo_id, base_url) VALUES ($1, $2, $3)`, [a.accountId, repo, bad]), bad).rejects.toMatchObject({ constraint: 'verify_settings_base_url_check' });
      }
    });

    it('another account sees none of it and cannot write it', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const item = await newItem(repo);
      const opened = await open(item);
      expect(opened.opened).toBe(true);
      await withTenant(appPool, b.accountId, b.userId, async (c) => {
        for (const t of ['verify_settings', 'verify_batches', 'verify_rows']) expect((await c.query(`SELECT 1 FROM ${t} WHERE account_id = $1`, [a.accountId])).rowCount, t).toBe(0);
        expect((await readVerifySettings(c, repo)).configured).toBe(false);
        expect(await readVerifyRow(c, b.accountId, (opened as { rowId: string }).rowId)).toBeNull();
        expect(await listVerifyRows(c, b.accountId, repo)).toEqual([]);
      });
      // Writes naming the other account's id are refused by the policy, in every table.
      await expect(withTenant(appPool, b.accountId, b.userId, (c) => c.query(`INSERT INTO verify_settings (account_id, repo_id) VALUES ($1, $2)`, [a.accountId, repo]))).rejects.toMatchObject({ code: '42501' });
      await expect(withTenant(appPool, b.accountId, b.userId, (c) => c.query(`INSERT INTO verify_batches (account_id, repo_id) VALUES ($1, $2)`, [a.accountId, repo]))).rejects.toMatchObject({ code: '42501' });
      // A tenant-B session cannot open a row for A's item: the item is invisible to it.
      expect(await withTenant(appPool, b.accountId, (c) => openVerifyRow(c, b.accountId, { workItemId: item, prNumber: 9, mergeSha: sha('b') }))).toEqual({ opened: false, reason: 'no_item' });
    });

    it('no login can delete a row, a batch or a setting, or edit the fixed columns', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const item = await newItem(repo);
      const o = (await open(item)) as { rowId: string; batchId: string };
      const deletes: Array<[string, string]> = [[`DELETE FROM verify_rows WHERE id = $1`, o.rowId], [`DELETE FROM verify_batches WHERE id = $1`, o.batchId], [`DELETE FROM verify_settings WHERE repo_id = $1`, repo]];
      for (const [sql, param] of deletes) {
        await expect(asOwner((c) => c.query(sql, [param])), sql).rejects.toMatchObject({ code: '42501' });
      }
      for (const col of ['merge_sha', 'journeys', 'work_item_id', 'pr_number', 'account_id']) {
        await expect(asOwner((c) => c.query(`UPDATE verify_rows SET ${col} = ${col} WHERE id = $1`, [o.rowId])), col).rejects.toMatchObject({ code: '42501' });
      }
    });
  });

  describe('opening a row', () => {
    it('opens once for a merged item with its journeys, in a batch the row closes by size', async () => {
      const repo = await newRepo();
      await turnOn(repo, { standingJourneys: [{ id: 'sign_in', text: 'Sign in as the test account' }] });
      const item = await newItem(repo, 'merged', '## Spec (Acceptance)\n\n1. The page shows a Save button\n2. Saving keeps the value after a reload\n\n## Allowed files\n- apps/web/page.tsx');
      const first = await open(item);
      expect(first).toMatchObject({ opened: true });
      if (!first.opened) throw new Error('unreachable');
      expect(first.journeys).toEqual([
        { id: 'c1', source: 'criterion', text: 'The page shows a Save button' },
        { id: 'c2', source: 'criterion', text: 'Saving keeps the value after a reload' },
        { id: 's_sign_in', source: 'standing', text: 'Sign in as the test account' },
      ]);
      const row = await asWorker((c) => readVerifyRow(c, a.accountId, first.rowId));
      expect(row).toMatchObject({ status: 'pending', method: null, deployed_commit: null, result: null, reason_code: null, pr_number: 5, merge_sha: sha('a'), deploy_by_order: false, person_step: false });
      expect(row!.journeys).toEqual(first.journeys);
      const batch = await admin.query(`SELECT status, closed_by, closed_at IS NOT NULL AS closed FROM verify_batches WHERE id = $1`, [first.batchId]);
      expect(batch.rows[0]).toEqual({ status: 'closed', closed_by: 'size', closed: true });
    });

    it('refuses an item that has not merged, an item with no repository, an unknown item, and a bad merge sha', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      for (const stage of ['triaged', 'pr_opened', 'review_passed', 'needs_human', 'closed_unmerged', 'closed']) {
        expect(await open(await newItem(repo, stage)), stage).toEqual({ opened: false, reason: 'not_merged' });
      }
      expect(await open(randomUUID())).toEqual({ opened: false, reason: 'no_item' });
      const orphan = await newItem(repo);
      await admin.query(`UPDATE work_items SET repo_id = NULL WHERE id = $1`, [orphan]);
      expect(await open(orphan)).toEqual({ opened: false, reason: 'no_repo' });
      const item = await newItem(repo);
      await expect(open(item, 'nothex')).rejects.toMatchObject({ code: 'verify_row_invalid' });
      await expect(asWorker((c) => openVerifyRow(c, a.accountId, { workItemId: item, prNumber: 0, mergeSha: sha('a') }))).rejects.toMatchObject({ code: 'verify_row_invalid' });
    });

    it('an empty Spec gives only the standing journeys; with none either, the row ends at once as unverified: no_visible_journeys, with no deploy or run', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const item = await newItem(repo, 'merged', 'A Spec with prose and no numbered list.');
      const o = (await open(item)) as { rowId: string; journeys: unknown[] };
      expect(o.journeys).toEqual([]);
      const row = (await admin.query(`SELECT status, reason_code, method, finished_at IS NOT NULL AS done FROM verify_rows WHERE id = $1`, [o.rowId])).rows[0];
      expect(row).toEqual({ status: 'unverified', reason_code: 'no_visible_journeys', method: null, done: true });
      // Nothing to start: the row is finished, so it cannot be moved to deploying.
      expect((await asWorker((c) => startDeploying(c, a.accountId, o.rowId, true))).moved).toBe(false);
      expect((await factKinds(item)).at(-1)).toBe('verify_unverified:no_visible_journeys');
    });

    it('only the visible criteria become journeys (ids keep the Spec numbers); the code-level ones are stored as left to the checks', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const item = await newItem(repo, 'merged', ['1. `repoLabel({full_name: "a/b"})` is `"a/b"`', '2. The picker option texts are exactly [A, B]', '3. `pickRepoId([])` returns `null`', '4. [ui] The empty state says so'].join('\n'));
      const o = (await open(item)) as { rowId: string; journeys: { id: string }[] };
      expect(o.journeys.map((j) => j.id)).toEqual(['c2', 'c4']);
      const row = (await admin.query(`SELECT checks_only FROM verify_rows WHERE id = $1`, [o.rowId])).rows[0];
      expect(row.checks_only).toEqual([1, 3]);
      // The stored list cannot be changed by the app role afterwards.
      await expect(asWorker((c) => c.query(`UPDATE verify_rows SET checks_only = '[]'::jsonb WHERE id = $1`, [o.rowId]))).rejects.toThrow();
    });

    it('a Spec in the shape the pipeline stores (criteria inside the quoted block) gives journeys and checks_only', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const real = readFileSync(new URL('./fixtures/verify/realSpecBody.txt', import.meta.url), 'utf8');
      const item = await newItem(repo, 'merged', real);
      const o = (await open(item)) as { rowId: string; journeys: { id: string; source: string; text: string }[] };
      expect(o.journeys).toEqual([
        { id: 'c1', source: 'criterion', text: 'The settings page shows a Save button' },
        { id: 'c2', source: 'criterion', text: 'Saving keeps the value after a reload, shown as in:' },
      ]);
      const row = (await admin.query(`SELECT checks_only FROM verify_rows WHERE id = $1`, [o.rowId])).rows[0];
      expect(row.checks_only).toEqual([3]);
    });

    it('readStreak reads a no_visible_journeys row without counting it (the neutral rule itself is in verifyCriteria.test.ts)', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const item = await newItem(repo, 'merged', '1. `f` returns 1');
      expect(((await open(item)) as { opened: boolean }).opened).toBe(true);
      expect(await asWorker((c) => readStreak(c, a.accountId, repo))).toBe(0);
    });

    it('a replay finds the row it made; two creators at once make one row and one batch', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const item = await newItem(repo);
      const results = await Promise.all([open(item, sha('c')), open(item, sha('c')), open(item, sha('c'))]);
      expect(results.filter((r) => r.opened)).toHaveLength(1);
      const winner = results.find((r) => r.opened) as { rowId: string };
      for (const r of results.filter((r) => !r.opened)) expect(r).toEqual({ opened: false, reason: 'already_open', rowId: winner.rowId });
      const n = await admin.query(`SELECT (SELECT count(*) FROM verify_rows WHERE work_item_id = $1)::int AS r, (SELECT count(*) FROM verify_batches WHERE repo_id = $2)::int AS b`, [item, repo]);
      expect(n.rows[0]).toEqual({ r: 1, b: 1 });
      // A different merge of the same item is a different row.
      expect((await open(item, sha('d'))).opened).toBe(true);
    });

    it('eligibility: ui_paths checks only merges that touched a configured path; unknown paths are checked; all checks everything', async () => {
      const repo = await newRepo();
      await turnOn(repo, { eligibility: 'ui_paths', eligibilityPaths: ['apps/web'] });
      const mk = (paths: string[] | null) => newItem(repo).then((id) => asWorker((c) => openVerifyRow(c, a.accountId, { workItemId: id, prNumber: 3, mergeSha: sha('e'), changedPaths: paths })));
      expect(await mk(['packages/db/x.sql'])).toEqual({ opened: false, reason: 'not_eligible' });
      expect(await mk(['apps/website/x.ts'])).toEqual({ opened: false, reason: 'not_eligible' });
      expect((await mk(['packages/db/x.sql', 'apps/web/page.tsx'])).opened).toBe(true);
      expect((await mk(null)).opened).toBe(true);
      await asOwner((c) => saveVerifySettings(c, a.accountId, repo, a.userId, { eligibility: 'all' }));
      expect((await mk(['docs/readme.md'])).opened).toBe(true);
    });

    it('a failed journey is carried into the row of the bug item it filed, and replaces the same criterion', async () => {
      const repo = await newRepo();
      await turnOn(repo, { standingJourneys: [{ id: 'sign_in', text: 'Sign in' }] });
      const item = await newItem(repo, 'merged', '1. First thing works\n2. Second thing works');
      const o = (await open(item)) as { rowId: string };
      await toRunning(o.rowId);
      await asWorker((c) => finishVerifyRow(c, a.accountId, o.rowId, { status: 'failed', result: [evidenced('c1'), evidenced('c2', { result: 'fail' }), evidenced('s_sign_in')] }));
      const bug = await newItem(repo, 'merged', '1. First thing works\n2. Second thing works, again');
      expect(await asWorker((c) => attachBugItem(c, a.accountId, o.rowId, bug))).toBe(true);
      const next = (await open(bug, sha('f'), 6)) as { journeys: { id: string; source: string; text: string }[] };
      expect(next.journeys.map((j) => `${j.id}:${j.source}`)).toEqual(['c1:criterion', 'c2:recheck', 's_sign_in:standing']);
      expect(next.journeys.find((j) => j.id === 'c2')!.text).toBe('Second thing works');
      // An item with no failed row before it carries nothing.
      const clean = (await open(await newItem(repo, 'merged', '1. Only one'), sha('9'))) as { journeys: { source: string }[] };
      expect(clean.journeys.map((j) => j.source)).toEqual(['criterion', 'standing']);
    });
  });

  describe('the state machine', () => {
    it('runs pending -> deploying -> running -> verified, writes the started and passed facts, and keeps the evidence', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const item = await newItem(repo, 'merged', '1. It works');
      const o = (await open(item)) as { rowId: string };
      await asWorker(async (c) => {
        const d = await startDeploying(c, a.accountId, o.rowId, true);
        expect(d).toMatchObject({ moved: true, row: { status: 'deploying', deploy_by_order: true } });
        const r = await startRunning(c, a.accountId, o.rowId, { method: 'chrome_runner', deployedCommit: sha('a'), runId: a.runId });
        expect(r).toMatchObject({ moved: true, row: { status: 'running', method: 'chrome_runner', deployed_commit: sha('a'), run_id: a.runId } });
        expect((r as { row: { started_at: Date | null } }).row.started_at).not.toBeNull();
        const f = await finishVerifyRow(c, a.accountId, o.rowId, { status: 'verified', result: [evidenced('c1')] });
        expect(f).toMatchObject({ moved: true, row: { status: 'verified', reason_code: null } });
        expect((f as { row: { finished_at: Date | null } }).row.finished_at).not.toBeNull();
      });
      expect(await factKinds(item)).toEqual(['verify_started', 'verify_passed']);
      const fact = await admin.query(`SELECT head_sha, pr_number, run_id FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'verify_passed'`, [item]);
      expect(fact.rows[0]).toEqual({ head_sha: sha('a'), pr_number: 5, run_id: a.runId });
    });

    it('D#749 V4b: the account check is written once, by the move that finishes the row, and the table refuses any other write of it', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const item = await newItem(repo, 'merged', '1. It works');
      const o = (await open(item)) as { rowId: string };
      const setCheck = (v: string | null) => admin.query(`UPDATE verify_rows SET account_check = $2 WHERE id = $1`, [o.rowId, v]);
      // Before it runs, a row cannot be given one (pending and deploying), and neither can a running row without finishing.
      await expect(setCheck('matched')).rejects.toMatchObject({ code: '23514' });
      await toRunning(o.rowId);
      await expect(setCheck('matched')).rejects.toMatchObject({ code: '23514' });
      // The closed values only, and a reason the check contradicts is refused by the store.
      await expect(asWorker((c) => finishVerifyRow(c, a.accountId, o.rowId, { status: 'verified', result: [evidenced('c1')], accountCheck: 'bogus' as never }))).rejects.toMatchObject({ code: 'verify_row_invalid' });
      await expect(asWorker((c) => finishVerifyRow(c, a.accountId, o.rowId, { status: 'unverified', reason: 'run_failed', accountCheck: 'mismatch' }))).rejects.toMatchObject({ code: 'verify_row_invalid' });
      await expect(asWorker((c) => finishVerifyRow(c, a.accountId, o.rowId, { status: 'unverified', reason: 'wrong_account' }))).rejects.toMatchObject({ code: 'verify_row_invalid' });
      await expect(setCheck('someone')).rejects.toMatchObject({ code: '23514' });
      const done = await asWorker((c) => finishVerifyRow(c, a.accountId, o.rowId, { status: 'verified', result: [evidenced('c1')], accountCheck: 'matched' }));
      expect(done).toMatchObject({ moved: true, row: { status: 'verified', account_check: 'matched' } });
      // Finished: it never changes, not to another value and not to null.
      await expect(setCheck('mismatch')).rejects.toMatchObject({ code: '23514' });
      await expect(setCheck(null)).rejects.toMatchObject({ code: '23514' });
      expect((await asWorker((c) => readVerifyRow(c, a.accountId, o.rowId)))?.account_check).toBe('matched');
    });

    it('D#749 V4b: a row finished without a check keeps NULL, and a later settings change does not write one', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const item = await newItem(repo, 'merged', '1. It works');
      const o = (await open(item)) as { rowId: string };
      await toRunning(o.rowId);
      await asWorker((c) => finishVerifyRow(c, a.accountId, o.rowId, { status: 'verified', result: [evidenced('c1')] }));
      await asOwner((c) => saveVerifySettings(c, a.accountId, repo, a.userId, { testAccountLabel: 'verify-bot' }));
      expect((await asWorker((c) => readVerifyRow(c, a.accountId, o.rowId)))?.account_check).toBeNull();
    });

    it('a failed row names its failing journeys in the fact and has no reason; the bug item is attached once', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const item = await newItem(repo, 'merged', '1. One\n2. Two');
      const o = (await open(item)) as { rowId: string };
      await toRunning(o.rowId);
      const f = await asWorker((c) => finishVerifyRow(c, a.accountId, o.rowId, { status: 'failed', result: [evidenced('c1'), evidenced('c2', { result: 'fail' })] }));
      expect(f).toMatchObject({ moved: true, row: { status: 'failed', reason_code: null } });
      expect(await factKinds(item)).toEqual(['verify_started', 'verify_failed']);
      const fact = await admin.query(`SELECT reasons FROM work_item_driver_events WHERE work_item_id = $1 AND kind = 'verify_failed'`, [item]);
      expect(fact.rows[0].reasons).toEqual(['c2']);
      const bug1 = await newItem(repo);
      const bug2 = await newItem(repo);
      expect(await asWorker((c) => attachBugItem(c, a.accountId, o.rowId, bug1))).toBe(true);
      expect(await asWorker((c) => attachBugItem(c, a.accountId, o.rowId, bug2))).toBe(false);
      expect((await asWorker((c) => readVerifyRow(c, a.accountId, o.rowId)))!.bug_item_id).toBe(bug1);
    });

    it('a row that cannot be checked ends unverified with a closed reason, from pending, deploying or running, and never as a pass', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const cases: Array<[string, (rowId: string) => Promise<void>, string]> = [
        ['pending', async () => undefined, 'no_browser'],
        ['deploying', async (id) => void (await asWorker((c) => startDeploying(c, a.accountId, id, true))), 'deploy_failed'],
        ['running', (id) => toRunning(id), 'commit_not_deployed'],
      ];
      for (const [label, prep, reason] of cases) {
        const item = await newItem(repo, 'merged', '1. One');
        const o = (await open(item)) as { rowId: string };
        await prep(o.rowId);
        const f = await asWorker((c) => finishVerifyRow(c, a.accountId, o.rowId, { status: 'unverified', reason: reason as 'no_browser' }));
        expect(f, label).toMatchObject({ moved: true, row: { status: 'unverified', reason_code: reason } });
        expect((await factKinds(item)).at(-1), label).toBe(`verify_unverified:${reason}`);
      }
      const item = await newItem(repo, 'merged', '1. One');
      const o = (await open(item)) as { rowId: string };
      await expect(asWorker((c) => finishVerifyRow(c, a.accountId, o.rowId, { status: 'unverified', reason: 'made_up' as 'no_browser' }))).rejects.toMatchObject({ code: 'verify_row_invalid' });
    });

    it('refuses a verified row whose evidence is hollow, whose journeys do not match, or a failed row with no failure', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const item = await newItem(repo, 'merged', '1. One\n2. Two');
      const o = (await open(item)) as { rowId: string };
      await toRunning(o.rowId);
      const finish = (status: 'verified' | 'failed', result: JourneyResult[]) => asWorker((c) => finishVerifyRow(c, a.accountId, o.rowId, { status, result }));
      const hollow: Array<[string, JourneyResult[]]> = [
        ['no undo check', [evidenced('c1'), evidenced('c2', { undo_checked: false })]],
        ['no reload', [evidenced('c1'), evidenced('c2', { reloaded: false })]],
        ['no page fact or number', [evidenced('c1'), evidenced('c2', { steps: [{ did: 'looked', dom_fact: '' }] })]],
        ['no steps', [evidenced('c1'), evidenced('c2', { steps: [] })]],
        ['a blocked journey', [evidenced('c1'), evidenced('c2', { result: 'blocked' })]],
        ['a journey missing', [evidenced('c1')]],
        ['an unknown journey', [evidenced('c1'), evidenced('c9')]],
        ['a journey twice', [evidenced('c1'), evidenced('c1')]],
      ];
      for (const [label, result] of hollow) await expect(finish('verified', result), label).rejects.toMatchObject({ code: 'verify_row_invalid' });
      await expect(finish('failed', [evidenced('c1'), evidenced('c2')])).rejects.toMatchObject({ code: 'verify_row_invalid' });
      expect((await asWorker((c) => readVerifyRow(c, a.accountId, o.rowId)))!.status).toBe('running');
    });

    it('a replayed move writes nothing twice and answers where the row is', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const item = await newItem(repo, 'merged', '1. One');
      const o = (await open(item)) as { rowId: string };
      await toRunning(o.rowId);
      const ok = [evidenced('c1')];
      expect((await asWorker((c) => finishVerifyRow(c, a.accountId, o.rowId, { status: 'verified', result: ok }))).moved).toBe(true);
      expect(await asWorker((c) => finishVerifyRow(c, a.accountId, o.rowId, { status: 'verified', result: ok }))).toEqual({ moved: false, status: 'verified' });
      expect(await asWorker((c) => finishVerifyRow(c, a.accountId, o.rowId, { status: 'unverified', reason: 'run_failed' }))).toEqual({ moved: false, status: 'verified' });
      expect(await asWorker((c) => startDeploying(c, a.accountId, o.rowId, true))).toEqual({ moved: false, status: 'verified' });
      expect(await asWorker((c) => startRunning(c, a.accountId, o.rowId, { method: 'chrome_runner', deployedCommit: sha('a') }))).toEqual({ moved: false, status: 'verified' });
      expect(await asWorker((c) => finishVerifyRow(c, a.accountId, randomUUID(), { status: 'unverified', reason: 'run_failed' }))).toEqual({ moved: false, status: null });
      expect(await factKinds(item)).toEqual(['verify_started', 'verify_passed']);
    });

    // The table holds the graph too (verify_rows_guard), so a writer that skips these functions is refused.
    const insertAt = async (repo: string, item: string, status: VerifyRowStatus): Promise<string> => {
      const batch = await admin.query(`INSERT INTO verify_batches (account_id, repo_id) VALUES ($1, $2) RETURNING id`, [a.accountId, repo]);
      const finished = ['verified', 'failed', 'unverified'].includes(status);
      const r = await admin.query(
        `INSERT INTO verify_rows (account_id, repo_id, batch_id, work_item_id, pr_number, merge_sha, journeys, status, method, deployed_commit, result, reason_code, started_at, finished_at)
         VALUES ($1, $2, $3, $4, 1, $5, '[{"id":"c1","source":"criterion","text":"One"}]', $6, $7, $8, $9::jsonb, $10, $11, $12) RETURNING id`,
        [a.accountId, repo, batch.rows[0].id, item, sha('a'), status,
          ['running', 'verified', 'failed'].includes(status) ? 'chrome_runner' : null, ['running', 'verified', 'failed'].includes(status) ? sha('a') : null,
          ['verified', 'failed'].includes(status) ? '[]' : null, status === 'unverified' ? 'no_browser' : null,
          status === 'running' || ['verified', 'failed'].includes(status) ? new Date() : null, finished ? new Date() : null],
      );
      return r.rows[0].id;
    };
    const moveSql = (to: VerifyRowStatus): string => {
      const sets = [`status = '${to}'`];
      if (to === 'running') sets.push(`method = 'chrome_runner'`, `deployed_commit = '${sha('a')}'`, `started_at = now()`);
      if (to === 'verified' || to === 'failed') sets.push(`result = '[]'`, `finished_at = now()`);
      if (to === 'unverified') sets.push(`reason_code = 'deploy_failed'`, `finished_at = now()`);
      return `UPDATE verify_rows SET ${sets.join(', ')} WHERE id = $1`;
    };
    it('the table allows exactly the moves ROW_MOVES lists: every from and to', async () => {
      const repo = await newRepo();
      for (const from of VERIFY_ROW_STATUSES) {
        for (const to of VERIFY_ROW_STATUSES) {
          if (from === to) continue;
          const id = await insertAt(repo, await newItem(repo), from);
          const attempt = asWorker((c) => c.query(moveSql(to), [id]));
          if (canMove(from, to)) await expect(attempt, `${from} -> ${to}`).resolves.toBeDefined();
          else await expect(attempt, `${from} -> ${to}`).rejects.toMatchObject({ code: '23514' });
        }
      }
    });

    it('a finished row does not change, except for the bug item (once), the person step (up only) and what the foreign keys clear', async () => {
      const repo = await newRepo();
      const item = await newItem(repo);
      const id = await insertAt(repo, item, 'failed');
      const app = (sql: string, params: unknown[] = []) => asWorker((c) => c.query(sql, [id, ...params]));
      for (const sql of [`UPDATE verify_rows SET status = 'verified' WHERE id = $1`, `UPDATE verify_rows SET method = 'playwright_runner' WHERE id = $1`, `UPDATE verify_rows SET deployed_commit = '${sha('b')}' WHERE id = $1`,
        `UPDATE verify_rows SET result = '[{"id":"c1"}]' WHERE id = $1`, `UPDATE verify_rows SET reason_code = 'no_browser' WHERE id = $1`, `UPDATE verify_rows SET deploy_by_order = true WHERE id = $1`,
        `UPDATE verify_rows SET finished_at = now() + interval '1 day' WHERE id = $1`, `UPDATE verify_rows SET run_id = '${a.runId}' WHERE id = $1`]) {
        await expect(app(sql), sql).rejects.toMatchObject({ code: '23514' });
      }
      const bug = await newItem(repo);
      await app(`UPDATE verify_rows SET bug_item_id = $2 WHERE id = $1`, [bug]);
      await expect(app(`UPDATE verify_rows SET bug_item_id = $2 WHERE id = $1`, [await newItem(repo)])).rejects.toMatchObject({ code: '23514' });
      await app(`UPDATE verify_rows SET person_step = true WHERE id = $1`);
      await expect(app(`UPDATE verify_rows SET person_step = false WHERE id = $1`)).rejects.toMatchObject({ code: '23514' });
      // Deleting the bug item clears the link; the finished row stays whole.
      await admin.query(`DELETE FROM work_items WHERE id = $1`, [bug]);
      expect((await asWorker((c) => readVerifyRow(c, a.accountId, id)))).toMatchObject({ status: 'failed', bug_item_id: null, person_step: true });
    });

    it('the table refuses a finished row that is not whole, and a running row with no method', async () => {
      const repo = await newRepo();
      const batch = (await admin.query(`INSERT INTO verify_batches (account_id, repo_id) VALUES ($1, $2) RETURNING id`, [a.accountId, repo])).rows[0].id as string;
      const ins = async (cols: string, vals: unknown[]) => {
        const item = await newItem(repo);
        return admin.query(`INSERT INTO verify_rows (account_id, repo_id, batch_id, work_item_id, pr_number, merge_sha, journeys, ${cols}) VALUES ($1, $2, $3, $4, 1, $5, '[]', ${vals.map((_v, i) => `$${i + 6}`).join(', ')})`, [a.accountId, repo, batch, item, sha('a'), ...vals]);
      };
      await expect(ins('status, finished_at', ['verified', new Date()])).rejects.toMatchObject({ constraint: 'verify_rows_verified_shape' });
      await expect(ins('status, finished_at, method, deployed_commit', ['verified', new Date(), 'chrome_runner', sha('a')])).rejects.toMatchObject({ constraint: 'verify_rows_verified_shape' });
      await expect(ins('status, finished_at, method, deployed_commit, result, reason_code', ['verified', new Date(), 'chrome_runner', sha('a'), '[]', 'no_browser'])).rejects.toMatchObject({ constraint: 'verify_rows_unverified_shape' });
      await expect(ins('status, finished_at', ['unverified', new Date()])).rejects.toMatchObject({ constraint: 'verify_rows_unverified_shape' });
      await expect(ins('status, reason_code', ['pending', 'no_browser'])).rejects.toMatchObject({ constraint: 'verify_rows_unverified_shape' });
      // A verified row with no journey at all is refused too: a pass of nothing is not a pass.
      await expect(ins('status, finished_at, method, deployed_commit, result', ['verified', new Date(), 'chrome_runner', sha('a'), '[]'])).rejects.toMatchObject({ constraint: 'verify_rows_verified_shape' });
      await expect(ins('status, started_at, method', ['running', new Date(), 'chrome_runner'])).rejects.toMatchObject({ constraint: 'verify_rows_running_shape' });
      await expect(ins('status', ['running'])).rejects.toMatchObject({ constraint: 'verify_rows_running_shape' });
      await expect(ins('status, finished_at', ['pending', new Date()])).rejects.toMatchObject({ constraint: 'verify_rows_finished_shape' });
      await expect(ins('method', ['chrome'])).rejects.toMatchObject({ constraint: 'verify_rows_method_check' });
    });
  });

  describe('the undo path', () => {
    it('turning verification off ends the rows that never started, leaves a running one, opens nothing new, and turning it on again starts clean', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const pending = (await open(await newItem(repo, 'merged', '1. A'), sha('1'))) as { rowId: string };
      const deploying = (await open(await newItem(repo, 'merged', '1. B'), sha('2'))) as { rowId: string };
      await asWorker((c) => startDeploying(c, a.accountId, deploying.rowId, true));
      const running = (await open(await newItem(repo, 'merged', '1. C'), sha('3'))) as { rowId: string };
      await toRunning(running.rowId, sha('3'));
      const done = (await open(await newItem(repo, 'merged', '1. D'), sha('4'))) as { rowId: string };
      await toRunning(done.rowId, sha('4'));
      await asWorker((c) => finishVerifyRow(c, a.accountId, done.rowId, { status: 'verified', result: [evidenced('c1')] }));

      const off = await asOwner((c) => saveVerifySettings(c, a.accountId, repo, a.userId, { enabled: false }));
      expect(off.settings.enabled).toBe(false);
      expect(off.endedRows.sort()).toEqual([pending.rowId, deploying.rowId].sort());
      const status = async (id: string) => (await asWorker((c) => readVerifyRow(c, a.accountId, id)))!;
      expect(await status(pending.rowId)).toMatchObject({ status: 'unverified', reason_code: 'verify_disabled' });
      expect(await status(deploying.rowId)).toMatchObject({ status: 'unverified', reason_code: 'verify_disabled' });
      expect((await status(running.rowId)).status).toBe('running');
      expect((await status(done.rowId)).status).toBe('verified');
      // The running one still finishes by its own run and keeps what it found.
      expect((await asWorker((c) => finishVerifyRow(c, a.accountId, running.rowId, { status: 'verified', result: [evidenced('c1')] }))).moved).toBe(true);

      const later = await newItem(repo, 'merged', '1. E');
      expect(await open(later, sha('5'))).toEqual({ opened: false, reason: 'verify_off' });
      // Saving "off" again ends nothing; on again, new merges open rows, and the history stays.
      expect((await asOwner((c) => saveVerifySettings(c, a.accountId, repo, a.userId, { enabled: false }))).endedRows).toEqual([]);
      await turnOn(repo);
      expect((await open(later, sha('5'))).opened).toBe(true);
      expect((await asWorker((c) => listVerifyRows(c, a.accountId, repo))).length).toBe(5);
      // endUnstartedRows alone is safe to call with nothing to end.
      const emptyRepo = await newRepo();
      expect(await asWorker((c) => endUnstartedRows(c, a.accountId, emptyRepo))).toEqual([]);
    });

    it('a person step is only ever added, and a repository or item that goes takes its rows with it', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const item = await newItem(repo, 'merged', '1. A');
      const o = (await open(item)) as { rowId: string };
      expect(await asWorker((c) => markPersonStep(c, a.accountId, o.rowId))).toBe(true);
      expect(await asWorker((c) => markPersonStep(c, a.accountId, o.rowId))).toBe(false);
      await admin.query(`DELETE FROM work_items WHERE id = $1`, [item]);
      expect((await admin.query(`SELECT 1 FROM verify_rows WHERE id = $1`, [o.rowId])).rowCount).toBe(0);
      const item2 = await newItem(repo, 'merged', '1. A');
      await open(item2, sha('7'));
      await admin.query(`DELETE FROM repos WHERE id = $1`, [repo]);
      const left = await admin.query(`SELECT (SELECT count(*) FROM verify_rows WHERE repo_id = $1)::int AS r, (SELECT count(*) FROM verify_batches WHERE repo_id = $1)::int AS b, (SELECT count(*) FROM verify_settings WHERE repo_id = $1)::int AS s`, [repo]);
      expect(left.rows[0]).toEqual({ r: 0, b: 0, s: 0 });
    });
  });

  describe('the streak, derived from rows and facts', () => {
    async function finishAs(repo: string, i: number, outcome: 'verified' | 'failed' | 'unverified', opts: { byProduct?: boolean; byOrder?: boolean; person?: boolean } = {}): Promise<void> {
      const item = await newItem(repo, 'merged', '1. One');
      const merge = (i + 16).toString(16).padStart(2, '0').repeat(20);
      const o = (await open(item, merge)) as { rowId: string };
      if (opts.byProduct !== false) await asWorker((c) => recordDriverEvent(c, a.accountId, { workItemId: item, kind: 'merged_by_gate', dedupeKey: `m${i}`, code: 'merged', headSha: merge }));
      await asWorker((c) => startDeploying(c, a.accountId, o.rowId, opts.byOrder !== false));
      if (outcome === 'unverified') await asWorker((c) => finishVerifyRow(c, a.accountId, o.rowId, { status: 'unverified', reason: 'deploy_failed' }));
      else {
        await asWorker((c) => startRunning(c, a.accountId, o.rowId, { method: 'chrome_runner', deployedCommit: merge }));
        await asWorker((c) => finishVerifyRow(c, a.accountId, o.rowId, { status: outcome, result: [evidenced('c1', outcome === 'failed' ? { result: 'fail' } : {})] }));
      }
      if (opts.person === true) await asWorker((c) => markPersonStep(c, a.accountId, o.rowId));
    }
    const streak = (repo: string) => asWorker((c) => readStreak(c, a.accountId, repo));

    it('counts clean self-verified merges, resets on a failure and on an unverified row, and starts again from the next clean one', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      expect(await streak(repo)).toBe(0);
      await finishAs(repo, 1, 'verified');
      expect(await streak(repo)).toBe(1);
      await finishAs(repo, 2, 'verified');
      expect(await streak(repo)).toBe(2);
      await finishAs(repo, 3, 'failed');
      expect(await streak(repo)).toBe(0);
      await finishAs(repo, 4, 'verified');
      await finishAs(repo, 5, 'verified');
      expect(await streak(repo)).toBe(2);
      await finishAs(repo, 6, 'unverified');
      expect(await streak(repo)).toBe(0);
      await finishAs(repo, 7, 'verified');
      expect(await streak(repo)).toBe(1);
    });

    it('a person step resets, a merge the product did not make is not part of it, and a verified row deployed by someone else resets', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      await finishAs(repo, 1, 'verified');
      await finishAs(repo, 2, 'verified');
      await finishAs(repo, 3, 'verified', { byProduct: false });
      expect(await streak(repo)).toBe(2);
      await finishAs(repo, 4, 'failed', { byProduct: false });
      expect(await streak(repo)).toBe(2);
      await finishAs(repo, 5, 'verified', { person: true });
      expect(await streak(repo)).toBe(0);
      await finishAs(repo, 6, 'verified');
      await finishAs(repo, 7, 'verified', { byOrder: false });
      expect(await streak(repo)).toBe(0);
    });
  });

  describe('the table holds the rules against every writer (app_user in the tenant context)', () => {
    const asMember = <T,>(fn: (c: PoolClient) => Promise<T>): Promise<T> => withTenant(appPool, a.accountId, memberId, fn);
    const refused = (p: Promise<unknown>, code = '23514') => expect(p).rejects.toMatchObject({ code });
    async function rowAt(status: 'pending' | 'deploying' | 'running' | 'failed' | 'unverified', mergeSha = sha('d')): Promise<{ repo: string; item: string; rowId: string; batchId: string }> {
      const repo = await newRepo();
      await turnOn(repo);
      const item = await newItem(repo, 'merged', '1. A');
      const o = (await open(item, mergeSha)) as { rowId: string; batchId: string };
      if (status === 'deploying') await asWorker((c) => startDeploying(c, a.accountId, o.rowId, true));
      if (status === 'running' || status === 'failed') await toRunning(o.rowId, mergeSha);
      if (status === 'failed') await asWorker((c) => finishVerifyRow(c, a.accountId, o.rowId, { status: 'failed', result: [evidenced('c1', { result: 'fail' })] }));
      if (status === 'unverified') await asWorker((c) => finishVerifyRow(c, a.accountId, o.rowId, { status: 'unverified', reason: 'deploy_failed' }));
      return { repo, item, rowId: o.rowId, batchId: o.batchId };
    }

    it('a row cannot be inserted in any state but pending: the insert grant covers the identity columns and the journeys only', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const item = await newItem(repo, 'merged');
      await asWorker((c) => recordDriverEvent(c, a.accountId, { workItemId: item, kind: 'merged_by_gate', dedupeKey: 'forge', code: 'merged', headSha: sha('e'), prNumber: 9 }));
      const forged = (cols: string, vals: string): Promise<unknown> => asMember(async (c) => {
        const b = (await c.query(`INSERT INTO verify_batches (account_id, repo_id) VALUES ($1, $2) RETURNING id`, [a.accountId, repo])).rows[0].id;
        return c.query(`INSERT INTO verify_rows (account_id, repo_id, batch_id, work_item_id, pr_number, merge_sha, journeys, ${cols}) VALUES ($1, $2, $3, $4, 9, $5, '[]', ${vals})`, [a.accountId, repo, b, item, sha('e')]);
      });
      await refused(forged(`status, method, deployed_commit, result, deploy_by_order, finished_at`, `'verified', 'chrome_runner', '${sha('e')}', '[]', true, now()`), '42501');
      for (const [cols, vals] of [['status', `'running'`], ['deploy_by_order', 'true'], ['person_step', 'true'], ['method', `'chrome_runner'`], ['result', `'[]'`], ['bug_item_id', `'${item}'`], ['started_at', 'now()']] as const) {
        await refused(forged(cols, vals), '42501');
      }
      await refused(asMember((c) => c.query(`INSERT INTO verify_batches (account_id, repo_id, status, closed_by, closed_at) VALUES ($1, $2, 'closed', 'size', now())`, [a.accountId, repo])), '42501');
      expect(await asWorker((c) => readStreak(c, a.accountId, repo))).toBe(0);
      expect(await asWorker((c) => listVerifyRows(c, a.accountId, repo))).toEqual([]);
    });

    it('a row inserted with the granted columns is born pending with every outcome column at its default', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const item = await newItem(repo, 'merged');
      const row = await asMember(async (c) => {
        const b = (await c.query(`INSERT INTO verify_batches (account_id, repo_id) VALUES ($1, $2) RETURNING id`, [a.accountId, repo])).rows[0].id;
        return (await c.query(`INSERT INTO verify_rows (account_id, repo_id, batch_id, work_item_id, pr_number, merge_sha, journeys) VALUES ($1, $2, $3, $4, 9, $5, '[]') RETURNING *`, [a.accountId, repo, b, item, sha('e')])).rows[0];
      });
      expect(row).toMatchObject({ status: 'pending', method: null, deployed_commit: null, result: null, reason_code: null, bug_item_id: null, run_id: null, deploy_by_order: false, person_step: false, started_at: null, finished_at: null });
    });

    it('a person step is never taken back, at any status, and the row then finishes with the streak at 0', async () => {
      for (const status of ['pending', 'deploying', 'running', 'unverified'] as const) {
        const r = await rowAt(status, sha('c'));
        await asWorker((c) => markPersonStep(c, a.accountId, r.rowId));
        await refused(asWorker((c) => c.query(`UPDATE verify_rows SET person_step = false WHERE id = $1`, [r.rowId])));
        expect((await asWorker((c) => readVerifyRow(c, a.accountId, r.rowId)))?.person_step, status).toBe(true);
      }
      const r = await rowAt('running', sha('f'));
      await asWorker((c) => markPersonStep(c, a.accountId, r.rowId));
      await refused(asWorker((c) => c.query(`UPDATE verify_rows SET person_step = false WHERE id = $1`, [r.rowId])));
      await asWorker((c) => recordDriverEvent(c, a.accountId, { workItemId: r.item, kind: 'merged_by_gate', dedupeKey: 'ps', code: 'merged', headSha: sha('f'), prNumber: 5 }));
      expect((await asWorker((c) => finishVerifyRow(c, a.accountId, r.rowId, { status: 'verified', result: [evidenced('c1')] }))).moved).toBe(true);
      expect(await asWorker((c) => readStreak(c, a.accountId, r.repo))).toBe(0);
    });

    it('deploy_by_order is set only on the pending -> deploying move, and is not changed by a later write', async () => {
      const pending = await rowAt('pending');
      await asWorker((c) => c.query(`UPDATE verify_rows SET status = 'deploying', deploy_by_order = true WHERE id = $1`, [pending.rowId]));
      expect((await asWorker((c) => readVerifyRow(c, a.accountId, pending.rowId)))?.deploy_by_order).toBe(true);
      for (const status of ['deploying', 'running', 'failed', 'unverified'] as const) {
        const r = await rowAt(status);
        await refused(asWorker((c) => c.query(`UPDATE verify_rows SET deploy_by_order = NOT deploy_by_order WHERE id = $1`, [r.rowId])));
      }
      const byPerson = await rowAt('pending');
      await asWorker((c) => startDeploying(c, a.accountId, byPerson.rowId, false));
      await refused(asWorker((c) => c.query(`UPDATE verify_rows SET deploy_by_order = true WHERE id = $1`, [byPerson.rowId])));
      await refused(asWorker((c) => c.query(`UPDATE verify_rows SET deploy_by_order = true, status = 'running', method = 'chrome_runner', deployed_commit = $2, started_at = now() WHERE id = $1`, [byPerson.rowId, sha('d')])));
    });

    it('a running row cannot be rewritten: method, deployed commit, start, run and the verdict columns are fixed until the move that sets them', async () => {
      const r = await rowAt('running');
      for (const sql of [`UPDATE verify_rows SET method = 'playwright_runner' WHERE id = $1`, `UPDATE verify_rows SET deployed_commit = '${sha('b')}' WHERE id = $1`,
        `UPDATE verify_rows SET started_at = now() + interval '1 hour' WHERE id = $1`, `UPDATE verify_rows SET run_id = '${a.runId}' WHERE id = $1`,
        `UPDATE verify_rows SET result = '[]' WHERE id = $1`, `UPDATE verify_rows SET finished_at = now() WHERE id = $1`, `UPDATE verify_rows SET status = 'running', reason_code = 'no_browser' WHERE id = $1`]) {
        await refused(asWorker((c) => c.query(sql, [r.rowId])));
      }
      const deploying = await rowAt('deploying');
      await refused(asWorker((c) => c.query(`UPDATE verify_rows SET method = 'chrome_runner' WHERE id = $1`, [deploying.rowId])));
      const pending = await rowAt('pending');
      await refused(asWorker((c) => c.query(`UPDATE verify_rows SET status = 'unverified', reason_code = 'deploy_failed', finished_at = now(), method = 'chrome_runner' WHERE id = $1`, [pending.rowId])));
      expect(await asWorker((c) => readVerifyRow(c, a.accountId, r.rowId))).toMatchObject({ status: 'running', method: 'chrome_runner', deployed_commit: sha('d') });
    });

    it('the bug item is set only on a failed row, only once, and no statement clears it; deleting the item still does', async () => {
      const notFailed = await rowAt('running');
      const other = await newItem(notFailed.repo);
      await refused(asWorker((c) => c.query(`UPDATE verify_rows SET bug_item_id = $2 WHERE id = $1`, [notFailed.rowId, other])));
      const unverified = await rowAt('unverified');
      const other2 = await newItem(unverified.repo);
      await refused(asWorker((c) => c.query(`UPDATE verify_rows SET bug_item_id = $2 WHERE id = $1`, [unverified.rowId, other2])));
      expect(await asWorker((c) => attachBugItem(c, a.accountId, unverified.rowId, other))).toBe(false);

      const failed = await rowAt('failed');
      const bug1 = await newItem(failed.repo);
      const bug2 = await newItem(failed.repo);
      expect(await asWorker((c) => attachBugItem(c, a.accountId, failed.rowId, bug1))).toBe(true);
      await refused(asWorker((c) => c.query(`UPDATE verify_rows SET bug_item_id = NULL WHERE id = $1`, [failed.rowId])));
      await refused(asWorker((c) => c.query(`UPDATE verify_rows SET bug_item_id = $2 WHERE id = $1`, [failed.rowId, bug2])));
      expect(await asWorker((c) => attachBugItem(c, a.accountId, failed.rowId, bug2))).toBe(false);
      expect((await asWorker((c) => readVerifyRow(c, a.accountId, failed.rowId)))?.bug_item_id).toBe(bug1);
      await admin.query(`DELETE FROM work_items WHERE id = $1`, [bug1]);
      expect(await asWorker((c) => readVerifyRow(c, a.accountId, failed.rowId))).toMatchObject({ status: 'failed', bug_item_id: null });
    });

    it('a closed batch cannot be reopened or changed; an open one can close', async () => {
      const r = await rowAt('pending');
      await refused(asWorker((c) => c.query(`UPDATE verify_batches SET status = 'open', closed_by = NULL, closed_at = NULL WHERE id = $1`, [r.batchId])));
      await refused(asWorker((c) => c.query(`UPDATE verify_batches SET closed_by = 'window' WHERE id = $1`, [r.batchId])));
      await refused(asWorker((c) => c.query(`UPDATE verify_batches SET closed_at = now() + interval '1 day' WHERE id = $1`, [r.batchId])));
      const fresh = (await asWorker((c) => c.query(`INSERT INTO verify_batches (account_id, repo_id) VALUES ($1, $2) RETURNING id`, [a.accountId, r.repo]))).rows[0].id as string;
      await asWorker((c) => c.query(`UPDATE verify_batches SET status = 'closed', closed_by = 'window', closed_at = now() WHERE id = $1`, [fresh]));
      expect((await asWorker((c) => c.query(`SELECT status FROM verify_batches WHERE id = $1`, [fresh]))).rows[0].status).toBe('closed');
    });

    it('a verified row needs a stated action beside the page fact or number', async () => {
      const r = await rowAt('running');
      for (const steps of [[{ did: '', dom_fact: '', number: 0 }], [{ did: '', dom_fact: 'the heading reads Hello' }], [{ did: '  ', dom_fact: '', number: 3 }]]) {
        await expect(asWorker((c) => finishVerifyRow(c, a.accountId, r.rowId, { status: 'verified', result: [evidenced('c1', { steps })] }))).rejects.toMatchObject({ code: 'verify_row_invalid' });
      }
      expect((await asWorker((c) => readVerifyRow(c, a.accountId, r.rowId)))?.status).toBe('running');
      expect((await asWorker((c) => finishVerifyRow(c, a.accountId, r.rowId, { status: 'verified', result: [evidenced('c1', { steps: [{ did: 'opened the page', dom_fact: '', number: 3 }] })] }))).moved).toBe(true);
    });

    it('the streak counts a merge by the product only for the row\'s own pull request or merge commit', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const item = await newItem(repo, 'merged', '1. A');
      const o = (await open(item, sha('7'), 77)) as { rowId: string };
      await toRunning(o.rowId, sha('7'));
      await asWorker((c) => recordDriverEvent(c, a.accountId, { workItemId: item, kind: 'merged_by_gate', dedupeKey: 'other', code: 'merged', headSha: sha('1'), prNumber: 12 }));
      await asWorker((c) => finishVerifyRow(c, a.accountId, o.rowId, { status: 'verified', result: [evidenced('c1')] }));
      expect(await asWorker((c) => readStreak(c, a.accountId, repo))).toBe(0);
      await asWorker((c) => recordDriverEvent(c, a.accountId, { workItemId: item, kind: 'merged_via_queue', dedupeKey: 'own', code: 'merged', headSha: sha('2'), prNumber: 77 }));
      expect(await asWorker((c) => readStreak(c, a.accountId, repo))).toBe(1);
    });

    it('the legitimate path still runs end to end: open, deploy by order, run, verify, and the streak counts it', async () => {
      const repo = await newRepo();
      await turnOn(repo);
      const item = await newItem(repo, 'merged', '1. A');
      const o = (await open(item, sha('6'), 66)) as { rowId: string };
      await asWorker((c) => recordDriverEvent(c, a.accountId, { workItemId: item, kind: 'merged_by_gate', dedupeKey: 'ok', code: 'merged', headSha: sha('6'), prNumber: 66 }));
      await toRunning(o.rowId, sha('6'));
      expect((await asWorker((c) => finishVerifyRow(c, a.accountId, o.rowId, { status: 'verified', result: [evidenced('c1')] }))).moved).toBe(true);
      expect(await asWorker((c) => readStreak(c, a.accountId, repo))).toBe(1);
    });

    it('a verified row that passed on a standing journey alone is neutral for the streak', async () => {
      const repo = await newRepo();
      await turnOn(repo, { standingJourneys: [{ id: 'home', text: 'The home page loads' }] });
      const item = await newItem(repo, 'merged', '1. `f` returns 1');
      const o = (await open(item, sha('5'), 55)) as { rowId: string; journeys: { id: string }[] };
      expect(o.journeys.map((j) => j.id)).toEqual(['s_home']);
      await asWorker((c) => recordDriverEvent(c, a.accountId, { workItemId: item, kind: 'merged_by_gate', dedupeKey: 'sj', code: 'merged', headSha: sha('5'), prNumber: 55 }));
      await toRunning(o.rowId, sha('5'));
      expect((await asWorker((c) => finishVerifyRow(c, a.accountId, o.rowId, { status: 'verified', result: [evidenced('s_home')] }))).moved).toBe(true);
      expect(await asWorker((c) => readStreak(c, a.accountId, repo))).toBe(0);
    });
  });
});
