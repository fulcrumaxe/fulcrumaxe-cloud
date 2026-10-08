import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { findRlsViolations } from '../src/rlsInventory.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/** D#483 S3-a: the plan and proposal tables, their roles, guards and definers (0723). */
const TABLES = ['plan_imports', 'plan_milestones', 'plan_tasks', 'proposals'] as const;
const DEFINERS = ['plan_import_begin(uuid)', 'approve_proposal(uuid, uuid)', 'reject_proposal(uuid, text)', 'restore_proposal(uuid)', 'withdraw_approval(uuid)'];

describe('plan import and proposals (0723)', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let opsPool: Pool;
  let admin: PoolClient;
  let a: SeedRefs;
  let b: SeedRefs;
  let adminUser: string;
  let memberUser: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    admin = await adminPool.connect();
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    adminUser = await addMember(a.accountId, 'admin');
    memberUser = await addMember(a.accountId, 'member');
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end(), opsPool.end()]);
  });

  async function addMember(accountId: string, role: string): Promise<string> {
    const id = randomUUID();
    await admin.query('INSERT INTO users (id, email) VALUES ($1, $2)', [id, `${id}@example.test`]);
    await admin.query('INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, $3)', [accountId, id, role]);
    return id;
  }
  async function newRepo(r: SeedRefs, connected = true): Promise<string> {
    const id = randomUUID();
    await admin.query('INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, $4, $5)', [
      id, r.accountId, connected ? r.installationId : null, Math.floor(Math.random() * 1e9) + 10, 'team',
    ]);
    return id;
  }
  async function newWorkItem(r: SeedRefs, repoId: string): Promise<string> {
    const { rows } = await admin.query(`INSERT INTO work_items (account_id, repo_id, kind, gh_number, provenance) VALUES ($1, $2, 'issue', 1, 'internal') RETURNING id`, [r.accountId, repoId]);
    return rows[0].id;
  }
  async function newImport(r: SeedRefs, repoId: string, state = 'succeeded'): Promise<string> {
    const finished = state === 'succeeded' || state === 'failed';
    const { rows } = await admin.query(
      `INSERT INTO plan_imports (account_id, repo_id, state, finished_at, error_code) VALUES ($1, $2, $3, ${finished ? 'now()' : 'NULL'}, ${state === 'failed' ? "'github_unavailable'" : 'NULL'}) RETURNING id`,
      [r.accountId, repoId, state],
    );
    return rows[0].id;
  }
  async function newProposal(r: SeedRefs, repoId: string, over: Record<string, unknown> = {}): Promise<string> {
    const row = { dedupe_key: `plan:T${randomUUID().slice(0, 8)}`, sources: ['plan_task'], title: 'A task', provenance: 'internal', owner_process: 'product', state: 'new', ...over };
    const cols = Object.keys(row);
    const { rows } = await admin.query(
      `INSERT INTO proposals (account_id, repo_id, ${cols.join(', ')}) VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}) RETURNING id`,
      [r.accountId, repoId, ...Object.values(row)],
    );
    return rows[0].id;
  }
  async function mintToken(r: SeedRefs, scopes: string[]): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO api_tokens (account_id, created_by, token_hash, display_hint, scopes, expires_at) VALUES ($1, $2, $3, 'fxat_x', $4, now() + interval '1 day') RETURNING id`,
      [r.accountId, r.userId, randomUUID(), scopes],
    );
    return rows[0].id;
  }
  const as = <T>(r: SeedRefs, user: string, fn: (c: PoolClient) => Promise<T>, token?: string): Promise<T> => withTenant(appPool, r.accountId, user, token, fn);
  /** The import's write transaction: SET LOCAL ROLE plan_importer inside a tenant transaction. */
  const asImporter = <T>(r: SeedRefs, fn: (c: PoolClient) => Promise<T>): Promise<T> =>
    withTenant(appPool, r.accountId, r.userId, async (c) => {
      await c.query('SET LOCAL ROLE plan_importer');
      return fn(c);
    });

  describe('schema and isolation', () => {
    it('every table has RLS enabled and forced, one tenant_isolation policy, and the rls inventory is clean', async () => {
      expect(await findRlsViolations(admin)).toEqual([]);
      for (const t of TABLES) {
        const { rows } = await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = $1::regclass`, [t]);
        expect(rows[0], t).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
        const pol = await admin.query(`SELECT policyname, roles::text[] AS roles FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 ORDER BY policyname`, [t]);
        const iso = pol.rows.filter((p) => p.policyname === 'tenant_isolation');
        expect(iso, t).toHaveLength(1);
        expect(iso[0].roles.sort(), t).toEqual(['app_user', 'plan_importer']);
        for (const p of pol.rows) expect(p.roles, `${t} ${p.policyname}`).not.toContain('public');
      }
    });

    it('platform_ops has one tenant-bound policy on plan_imports and proposals only, false for a direct login', async () => {
      const { rows } = await admin.query(`SELECT tablename, qual FROM pg_policies WHERE schemaname = 'public' AND 'platform_ops' = ANY (roles) AND tablename = ANY ($1)`, [[...TABLES]]);
      expect(rows.map((r) => r.tablename).sort()).toEqual(['plan_imports', 'proposals']);
      for (const r of rows) expect(String(r.qual).toLowerCase()).toContain("session_user <> 'platform_ops'");
    });

    it('F2-5: plan_imports.error_code accepts request_budget_exhausted (0755) and the other twelve codes, refuses any other word, and 0723 still lacks it', async () => {
      const codes = [
        'repo_not_connected', 'app_permission_missing', 'discussions_disabled', 'plan_file_inconsistent', 'plan_file_too_large', 'token_not_read_only',
        'github_unavailable', 'rate_limited_by_github', 'request_budget_exhausted', 'plan_file_missing', 'plan_file_shape', 'interrupted', 'internal_error',
      ];
      const r = await seedAccount(admin, randomUUID());
      for (const code of codes) {
        const repoId = await newRepo(r);
        await admin.query(`INSERT INTO plan_imports (account_id, repo_id, state, finished_at, error_code) VALUES ($1, $2, 'failed', now(), $3)`, [r.accountId, repoId, code]);
      }
      const repoId = await newRepo(r);
      await expect(admin.query(`INSERT INTO plan_imports (account_id, repo_id, state, finished_at, error_code) VALUES ($1, $2, 'failed', now(), 'request_budget_exceeded')`, [r.accountId, repoId])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      // a failed import still needs a code
      await expect(admin.query(`INSERT INTO plan_imports (account_id, repo_id, state, finished_at) VALUES ($1, $2, 'failed', now())`, [r.accountId, repoId])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      const { rows } = await admin.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'plan_imports'::regclass AND conname = 'plan_imports_error_code_check'`);
      expect(rows).toHaveLength(1);
      for (const code of codes) expect(rows[0].def, code).toContain(`'${code}'`);
      expect(readFileSync(new URL('../migrations/0723_plan_import.sql', import.meta.url), 'utf8')).not.toContain('request_budget_exhausted');
    });

    it('F3-7: plan_imports.error_code accepts plan_source_too_large (0758) and the other thirteen codes, refuses any other word, and 0723 and 0755 still lack it', async () => {
      const codes = [
        'repo_not_connected', 'app_permission_missing', 'discussions_disabled', 'plan_file_inconsistent', 'plan_file_too_large', 'token_not_read_only',
        'github_unavailable', 'rate_limited_by_github', 'request_budget_exhausted', 'plan_source_too_large', 'plan_file_missing', 'plan_file_shape', 'interrupted', 'internal_error',
      ];
      const r = await seedAccount(admin, randomUUID());
      for (const code of codes) {
        const repoId = await newRepo(r);
        await admin.query(`INSERT INTO plan_imports (account_id, repo_id, state, finished_at, error_code) VALUES ($1, $2, 'failed', now(), $3)`, [r.accountId, repoId, code]);
      }
      const repoId = await newRepo(r);
      await expect(admin.query(`INSERT INTO plan_imports (account_id, repo_id, state, finished_at, error_code) VALUES ($1, $2, 'failed', now(), 'plan_source_too_big')`, [r.accountId, repoId])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      const { rows } = await admin.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'plan_imports'::regclass AND conname = 'plan_imports_error_code_check'`);
      expect(rows).toHaveLength(1);
      for (const code of codes) expect(rows[0].def, code).toContain(`'${code}'`);
      for (const file of ['0723_plan_import.sql', '0755_plan_import_budget_code.sql']) {
        expect(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'), file).not.toContain('plan_source_too_large');
      }
    });

    it("a tenant reads its own rows in all four tables and never another tenant's; with no tenant set it reads nothing", async () => {
      const repoA = await newRepo(a);
      const repoB = await newRepo(b);
      const rows: Array<[string, string]> = [];
      for (const [r, repo] of [[a, repoA], [b, repoB]] as const) {
        const imp = await newImport(r, repo);
        await admin.query(`INSERT INTO plan_milestones (account_id, repo_id, key, title, position) VALUES ($1, $2, 'm1', 'M one', 0)`, [r.accountId, repo]);
        await admin.query(`INSERT INTO plan_tasks (account_id, repo_id, task_key, milestone_key, title, planned_prs, status, owner_process, first_import_id, last_import_id) VALUES ($1, $2, 'D#1:T1', 'm1', 'T', 1, 'not_started', 'product', $3, $3)`, [r.accountId, repo, imp]);
        await newProposal(r, repo);
        rows.push([r.accountId, repo]);
      }
      for (const t of TABLES) {
        const own = await as(a, a.userId, async (c) => (await c.query(`SELECT DISTINCT account_id FROM ${t}`)).rows.map((x) => x.account_id));
        expect(own, t).toEqual([a.accountId]);
        const other = await as(a, a.userId, async (c) => (await c.query(`SELECT 1 FROM ${t} WHERE repo_id = $1`, [repoB])).rowCount);
        expect(other, t).toBe(0);
        const none = await appPool.connect();
        try {
          expect((await none.query(`SELECT 1 FROM ${t}`)).rowCount, t).toBe(0);
        } finally {
          none.release();
        }
      }
    });

    it('a suspended (soft-deleted) account reads none of its plan rows', async () => {
      const c = await seedAccount(admin, randomUUID());
      const repo = await newRepo(c);
      await newProposal(c, repo);
      const count = () => withTenant(appPool, c.accountId, async (cl) => (await cl.query('SELECT 1 FROM proposals')).rowCount);
      expect(await count()).toBe(1);
      await admin.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [c.accountId]);
      expect(await count()).toBe(0);
    });

    it('app_user can read the four tables and write none of them', async () => {
      const repo = await newRepo(a);
      for (const sql of [
        `INSERT INTO plan_imports (account_id, repo_id, state) VALUES ('${a.accountId}', '${repo}', 'running')`,
        `UPDATE plan_imports SET truncated = true`,
        `INSERT INTO plan_milestones (account_id, repo_id, key, title, position) VALUES ('${a.accountId}', '${repo}', 'x', 'x', 0)`,
        `UPDATE plan_milestones SET title = 'x'`,
        `INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, title, provenance, owner_process) VALUES ('${a.accountId}', '${repo}', 'plan:x', '{plan_task}', 't', 'internal', 'product')`,
        `UPDATE proposals SET state = 'rejected'`,
        `DELETE FROM proposals`,
        `DELETE FROM plan_tasks`,
      ]) {
        await expect(as(a, a.userId, (c) => c.query(sql)), sql).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });

    it('a repo delete removes its plan rows; detaching the repo (no installation) keeps them', async () => {
      const repo = await newRepo(a);
      const imp = await newImport(a, repo);
      await newProposal(a, repo);
      await admin.query(`INSERT INTO plan_milestones (account_id, repo_id, key, title, position) VALUES ($1, $2, 'm1', 'M', 0)`, [a.accountId, repo]);
      await admin.query('UPDATE repos SET installation_id = NULL WHERE id = $1', [repo]);
      for (const t of ['plan_imports', 'plan_milestones', 'proposals']) expect((await admin.query(`SELECT 1 FROM ${t} WHERE repo_id = $1`, [repo])).rowCount, t).toBe(1);
      await admin.query('DELETE FROM repos WHERE id = $1', [repo]);
      for (const t of ['plan_imports', 'plan_milestones', 'proposals']) expect((await admin.query(`SELECT 1 FROM ${t} WHERE repo_id = $1`, [repo])).rowCount, t).toBe(0);
      expect(imp).toBeTruthy();
    });
  });

  describe('table checks', () => {
    it('E5: an approved proposal must be product-owned, hold a position and be stamped', async () => {
      const repo = await newRepo(a);
      const wi = await newWorkItem(a, repo);
      const check = (e: Record<string, unknown>) => expect(newProposal(a, repo, e)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await check({ state: 'approved', owner_process: 'internal_loop', roadmap_position: 1, decided_at: new Date(), work_item_id: wi });
      await check({ state: 'approved', owner_process: 'product', decided_at: new Date(), work_item_id: wi });
      await check({ state: 'new', roadmap_position: 2 });
      await check({ state: 'rejected' });
      await check({ state: 'approved', owner_process: 'product', roadmap_position: 3, work_item_id: wi });
      await newProposal(a, repo, { state: 'approved', owner_process: 'product', roadmap_position: 9, decided_at: new Date(), work_item_id: wi });
    });

    it('owner_process is required and fixed to its two values; sources, dedupe keys and tasks are checked', async () => {
      const repo = await newRepo(a);
      const bad = (e: Record<string, unknown>) => expect(newProposal(a, repo, e)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await bad({ owner_process: 'somebody' });
      await bad({ sources: ['nowhere'] });
      await bad({ sources: [] });
      await bad({ dedupe_key: 'issue:12' });
      await bad({ reject_note: 'a note on a new one' });
      await expect(admin.query(`INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, title, provenance) VALUES ($1, $2, 'plan:x', '{plan_task}', 't', 'internal')`, [a.accountId, repo])).rejects.toMatchObject({ code: '23502' });
      await admin.query(`INSERT INTO plan_milestones (account_id, repo_id, key, title, position) VALUES ($1, $2, 'm1', 'M', 0)`, [a.accountId, repo]);
      const task = (status: string, planned: number, merged: number[]) =>
        admin.query(`INSERT INTO plan_tasks (account_id, repo_id, task_key, milestone_key, title, planned_prs, merged_prs, status, owner_process) VALUES ($1, $2, $3, 'm1', 'T', $4, $5, $6, 'product')`, [a.accountId, repo, `K${randomUUID()}`, planned, merged, status]);
      await expect(task('done', 1, [])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(task('done', 0, [5])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(task('done', 2, [5])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await task('done', 1, [5, 6]);
      await expect(admin.query(`INSERT INTO plan_tasks (account_id, repo_id, task_key, milestone_key, title, planned_prs, status, owner_process) VALUES ($1, $2, 'K1', 'nope', 'T', 1, 'not_started', 'product')`, [a.accountId, repo])).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    });

    it('one import per repo can be queued or running; a task cannot name a milestone or import of another tenant', async () => {
      const repo = await newRepo(a);
      await newImport(a, repo, 'running');
      await expect(newImport(a, repo, 'queued')).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
      await newImport(a, repo, 'succeeded');
      const repoB = await newRepo(b);
      await expect(admin.query(`INSERT INTO plan_imports (account_id, repo_id, state, finished_at) VALUES ($1, $2, 'succeeded', now())`, [a.accountId, repoB])).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
      const impB = await newImport(b, repoB);
      await expect(admin.query(`INSERT INTO plan_milestones (account_id, repo_id, key, title, position, last_import_id) VALUES ($1, $2, 'mx', 'M', 0, $3)`, [a.accountId, repo, impB])).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
    });
  });

  describe('E4: the import role', () => {
    it('can write the four tables and nothing else: no grant on work_items, agent_runs or run_action_requests', async () => {
      const repo = await newRepo(a);
      const importId = await newImport(a, repo, 'running');
      await asImporter(a, async (c) => {
        await c.query(`INSERT INTO plan_milestones (account_id, repo_id, key, title, position, last_import_id) VALUES ($1, $2, 'm1', 'M', 0, $3)`, [a.accountId, repo, importId]);
        await c.query(`INSERT INTO plan_tasks (account_id, repo_id, task_key, milestone_key, title, planned_prs, status, owner_process, first_import_id, last_import_id) VALUES ($1, $2, 'D#1:T', 'm1', 'T', 1, 'not_started', 'product', $3, $3)`, [a.accountId, repo, importId]);
        await c.query(`INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, title, provenance, owner_process, state, last_import_id) VALUES ($1, $2, 'plan:D#1:T', '{plan_task}', 'T', 'internal', 'internal_loop', 'new', $3)`, [a.accountId, repo, importId]);
        await c.query(`UPDATE plan_imports SET state = 'succeeded', finished_at = now(), counts = '{"tasks": 1}'::jsonb WHERE id = $1`, [importId]);
      });
      expect((await admin.query('SELECT state FROM plan_imports WHERE id = $1', [importId])).rows[0].state).toBe('succeeded');
      const denied = [
        `INSERT INTO work_items (account_id, repo_id, kind, provenance) VALUES ('${a.accountId}', '${repo}', 'issue', 'internal')`,
        `UPDATE work_items SET stage = 'closed'`,
        `SELECT 1 FROM work_items`,
        `INSERT INTO agent_runs (account_id, role, runtime, status) VALUES ('${a.accountId}', 'executor', 'local', 'pending')`,
        `SELECT 1 FROM agent_runs`,
        `INSERT INTO run_action_requests (account_id, kind, target_id, requested_by, principal_kind, request_hash) VALUES ('${a.accountId}', 'advance_work_item', '${randomUUID()}', 'x', 'session', '${'h'.repeat(64)}')`,
        `SELECT 1 FROM run_action_requests`,
        `DELETE FROM proposals`,
        `DELETE FROM plan_tasks`,
        `DELETE FROM plan_milestones`,
        `INSERT INTO audit_log (account_id, action) VALUES ('${a.accountId}', 'x')`,
      ];
      // "permission denied for table": the missing grant itself, not a row policy that would also refuse an insert.
      for (const sql of denied) {
        await expect(asImporter(a, (c) => c.query(sql)), sql).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE, message: expect.stringMatching(/permission denied/) });
      }
    });

    it('cannot decide a proposal, undo a decision or touch the decision columns', async () => {
      const repo = await newRepo(a);
      const wi = await newWorkItem(a, repo);
      const rejected = await newProposal(a, repo, { state: 'rejected', decided_at: new Date(), reject_note: 'no' });
      const approved = await newProposal(a, repo, { state: 'approved', roadmap_position: 77, decided_at: new Date(), work_item_id: wi });
      const fresh = await newProposal(a, repo, {});
      const cases: Array<[string, string]> = [
        [`UPDATE proposals SET state = 'approved' WHERE id = '${fresh}'`, 'importer approves'],
        [`UPDATE proposals SET state = 'rejected' WHERE id = '${fresh}'`, 'importer rejects'],
        [`UPDATE proposals SET state = 'new' WHERE id = '${rejected}'`, 'importer restores'],
        [`UPDATE proposals SET state = 'withdrawn' WHERE id = '${approved}'`, 'importer withdraws an approved one'],
        [`UPDATE proposals SET owner_process = 'internal_loop' WHERE id = '${approved}'`, 'importer changes the owner of an approved one'],
        [`UPDATE proposals SET decided_at = now() WHERE id = '${fresh}'`, 'decision column'],
        [`UPDATE proposals SET roadmap_position = 5 WHERE id = '${fresh}'`, 'position column'],
        [`UPDATE proposals SET work_item_id = '${wi}' WHERE id = '${fresh}'`, 'work item column'],
        [`INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, title, provenance, owner_process, state, decided_at, roadmap_position) VALUES ('${a.accountId}', '${repo}', 'plan:ins', '{plan_task}', 't', 'internal', 'product', 'approved', now(), 4)`, 'insert approved'],
        // only granted columns, a state the table's own checks allow: the guard alone refuses it
        [`INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, title, provenance, owner_process, state) VALUES ('${a.accountId}', '${repo}', 'plan:ins2', '{plan_task}', 't', 'internal', 'product', 'withdrawn')`, 'insert withdrawn'],
      ];
      for (const [sql, label] of cases) {
        await expect(asImporter(a, (c) => c.query(sql)), label).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
      // the derived moves are allowed
      await asImporter(a, async (c) => {
        await c.query(`UPDATE proposals SET state = 'withdrawn' WHERE id = '${fresh}'`);
        await c.query(`UPDATE proposals SET state = 'new' WHERE id = '${fresh}'`);
      });
    });

    // S3-H (0753): the owner is fixed when the row is created. Before, a `new` row could be flipped to product and approved.
    it('cannot change the owner of a proposal in any state, either way; its ordinary upserts still pass', async () => {
      const repo = await newRepo(a);
      const loop = await newProposal(a, repo, { owner_process: 'internal_loop' });
      const prod = await newProposal(a, repo, { owner_process: 'product' });
      const withdrawn = await newProposal(a, repo, { owner_process: 'internal_loop', state: 'withdrawn' });
      for (const [id, to] of [[loop, 'product'], [prod, 'internal_loop'], [withdrawn, 'product']] as const) {
        await expect(asImporter(a, (c) => c.query(`UPDATE proposals SET owner_process = '${to}' WHERE id = '${id}'`)), `${id} to ${to}`).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE, message: expect.stringMatching(/owner/) });
      }
      // the same value written again is not a change, and title, summary and sources move freely
      await asImporter(a, async (c) => {
        await c.query(`UPDATE proposals SET owner_process = 'internal_loop', title = 'Renamed', summary = 'S', sources = '{plan_task,github_issue}', updated_at = now() WHERE id = '${loop}'`);
      });
      expect((await admin.query('SELECT owner_process, title, summary, sources FROM proposals WHERE id = $1', [loop])).rows[0]).toEqual({ owner_process: 'internal_loop', title: 'Renamed', summary: 'S', sources: ['plan_task', 'github_issue'] });
      expect((await admin.query('SELECT owner_process FROM proposals WHERE id = $1', [prod])).rows[0].owner_process).toBe('product');
      // the guard is the importer's: a tenant-side owner is not touched by it (app_user cannot write the table at all)
      await expect(as(a, a.userId, (c) => c.query(`UPDATE proposals SET owner_process = 'product' WHERE id = '${loop}'`))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('cannot change a finished import, and cannot reach another tenant', async () => {
      const repo = await newRepo(a);
      const done = await newImport(a, repo, 'succeeded');
      await expect(asImporter(a, (c) => c.query(`UPDATE plan_imports SET truncated = true WHERE id = $1`, [done]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const repoB = await newRepo(b);
      await expect(asImporter(a, (c) => c.query(`INSERT INTO plan_milestones (account_id, repo_id, key, title, position) VALUES ($1, $2, 'm', 'M', 0)`, [b.accountId, repoB]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await asImporter(a, async (c) => (await c.query('SELECT 1 FROM proposals WHERE repo_id = $1', [repoB])).rowCount)).toBe(0);
    });

    it('app_user holds the role without inheriting it: without SET ROLE it still writes nothing', async () => {
      const { rows } = await admin.query(`SELECT inherit_option, set_option FROM pg_auth_members WHERE roleid = 'plan_importer'::regrole AND member = 'app_user'::regrole`);
      expect(rows).toEqual([{ inherit_option: false, set_option: true }]);
    });
  });

  describe('plan_import_begin', () => {
    const begin = (r: SeedRefs, user: string, repo: string, token?: string) => as(r, user, async (c) => (await c.query<{ id: string }>('SELECT plan_import_begin($1) AS id', [repo])).rows[0]!.id, token);

    it('an owner or admin session starts one running import, stamped and audited', async () => {
      const repo = await newRepo(a);
      const id = await begin(a, a.userId, repo);
      const row = (await admin.query('SELECT state, requested_by_user_id, started_at FROM plan_imports WHERE id = $1', [id])).rows[0];
      expect(row.state).toBe('running');
      expect(row.requested_by_user_id).toBe(a.userId);
      expect(row.started_at).not.toBeNull();
      expect((await admin.query(`SELECT count(*)::int n FROM audit_log WHERE account_id = $1 AND action = 'plan_import.started' AND payload->>'import_id' = $2`, [a.accountId, id])).rows[0].n).toBe(1);
      const repo2 = await newRepo(a);
      expect(await begin(a, adminUser, repo2)).toBeTruthy();
    });

    it('refuses a member, a token, no user, another tenant\'s repo, an unconnected repo and a second active import', async () => {
      const repo = await newRepo(a);
      await expect(begin(a, memberUser, repo)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const tok = await mintToken(a, ['read', 'work_items:write']);
      await expect(begin(a, a.userId, repo, tok)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(withTenant(appPool, a.accountId, async (c) => c.query('SELECT plan_import_begin($1)', [repo]))).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const repoB = await newRepo(b);
      await expect(begin(a, a.userId, repoB)).rejects.toMatchObject({ code: 'P0002' });
      const detached = await newRepo(a, false);
      await expect(begin(a, a.userId, detached)).rejects.toMatchObject({ code: '55000', message: 'repo_not_connected' });
      await begin(a, a.userId, repo);
      await expect(begin(a, a.userId, repo)).rejects.toMatchObject({ code: '55000', message: 'import_running' });
      expect((await admin.query('SELECT count(*)::int n FROM plan_imports WHERE repo_id = $1', [repo])).rows[0].n).toBe(1);
    });

    it('closes an import whose request died (running for over 10 minutes) as interrupted, then starts a new one', async () => {
      const repo = await newRepo(a);
      const first = await begin(a, a.userId, repo);
      await admin.query(`UPDATE plan_imports SET started_at = now() - interval '11 minutes' WHERE id = $1`, [first]);
      const second = await begin(a, a.userId, repo);
      expect(second).not.toBe(first);
      expect((await admin.query('SELECT state, error_code FROM plan_imports WHERE id = $1', [first])).rows[0]).toEqual({ state: 'failed', error_code: 'interrupted' });
    });

    it('limits starts to 6 per repo per hour and 20 per account per hour, with the seconds to wait in the HINT', async () => {
      const repo = await newRepo(a);
      for (let i = 0; i < 6; i += 1) {
        await admin.query(`UPDATE plan_imports SET state = 'succeeded', finished_at = now() WHERE repo_id = $1 AND state = 'running'`, [repo]);
        await begin(a, a.userId, repo);
      }
      await admin.query(`UPDATE plan_imports SET state = 'succeeded', finished_at = now() WHERE repo_id = $1 AND state = 'running'`, [repo]);
      const err = await begin(a, a.userId, repo).catch((e: unknown) => e as { code: string; message: string; hint?: string });
      expect(err).toMatchObject({ code: '53400', message: 'rate_limited' });
      expect(Number((err as { hint: string }).hint)).toBeGreaterThan(0);
      expect(Number((err as { hint: string }).hint)).toBeLessThanOrEqual(3600);

      const c = await seedAccount(admin, randomUUID());
      for (let i = 0; i < 20; i += 1) {
        const r = await newRepo(c);
        await begin(c, c.userId, r);
      }
      const r21 = await newRepo(c);
      await expect(begin(c, c.userId, r21)).rejects.toMatchObject({ code: '53400', message: 'rate_limited' });
    });

    it('a direct platform_ops login cannot call it, and cannot write the tables', async () => {
      const repo = await newRepo(a);
      const client = await opsPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)`, [a.accountId, a.userId]);
        await client.query('SAVEPOINT s');
        await expect(client.query('SELECT plan_import_begin($1)', [repo])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await client.query('ROLLBACK TO SAVEPOINT s');
        await expect(client.query(`INSERT INTO plan_imports (account_id, repo_id, state, started_at) VALUES ($1, $2, 'running', now())`, [a.accountId, repo])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await client.query('ROLLBACK TO SAVEPOINT s');
        expect((await client.query('SELECT 1 FROM proposals')).rowCount).toBe(0);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });
  });

  describe('the write guard on its own (row security switched off in a rolled-back transaction)', () => {
    // The platform_ops policies already refuse a direct login; this proves the trigger guard refuses it too, with the policy out of the way.
    it.each(TABLES)('a platform_ops session cannot insert into %s', async (table) => {
      const repo = await newRepo(a);
      const wi = await newWorkItem(a, repo);
      const sql: Record<string, string> = {
        plan_imports: `INSERT INTO plan_imports (account_id, repo_id, state, started_at) VALUES ('${a.accountId}', '${repo}', 'running', now())`,
        plan_milestones: `INSERT INTO plan_milestones (account_id, repo_id, key, title, position) VALUES ('${a.accountId}', '${repo}', 'm', 'M', 0)`,
        plan_tasks: `INSERT INTO plan_tasks (account_id, repo_id, task_key, milestone_key, title, planned_prs, status, owner_process) VALUES ('${a.accountId}', '${repo}', 'T', 'm', 'T', 1, 'not_started', 'product')`,
        proposals: `INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, title, provenance, owner_process) VALUES ('${a.accountId}', '${repo}', 'plan:x', '{plan_task}', 't', 'internal', 'product')`,
      };
      expect(wi).toBeTruthy();
      // plan_tasks and plan_milestones have no platform_ops grant at all, so they are also refused at the grant; the guard is still the same function.
      const client = await adminPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
        await client.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
        await client.query(`GRANT INSERT ON ${table} TO platform_ops`);
        await client.query(`SELECT set_config('app.account_id', '${a.accountId}', true)`);
        if (table === 'plan_tasks') await client.query(`INSERT INTO plan_milestones (account_id, repo_id, key, title, position) VALUES ('${a.accountId}', '${repo}', 'm', 'M', 0)`);
        await client.query('SET SESSION AUTHORIZATION platform_ops');
        await expect(client.query(sql[table]!)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE, message: expect.stringContaining('platform_ops may not write directly') });
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.query('RESET SESSION AUTHORIZATION').catch(() => undefined);
        client.release();
      }
    });

    it('the definers refuse a platform_ops session on their own, with the policies out of the way', async () => {
      const repo = await newRepo(a);
      const client = await adminPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.account_id', '${a.accountId}', true), set_config('app.user_id', '${a.userId}', true)`);
        await client.query('SET SESSION AUTHORIZATION platform_ops');
        await client.query('SAVEPOINT s');
        await expect(client.query('SELECT plan_import_begin($1)', [repo])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE, message: expect.stringContaining('platform_ops may not call this directly') });
        await client.query('ROLLBACK TO SAVEPOINT s');
        await expect(client.query('SELECT proposal_decider($1)', ['x'])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE, message: expect.stringContaining('platform_ops may not call this directly') });
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.query('RESET SESSION AUTHORIZATION').catch(() => undefined);
        client.release();
      }
    });
  });

  describe('proposal definers', () => {
    const approve = (r: SeedRefs, user: string, proposal: string, wi: string, token?: string) =>
      as(r, user, async (c) => (await c.query('SELECT * FROM approve_proposal($1, $2)', [proposal, wi])).rows[0], token);

    it('approve links the work item created in the same transaction, takes the next position, and a replay changes nothing', async () => {
      const repo = await newRepo(a);
      const p1 = await newProposal(a, repo);
      const p2 = await newProposal(a, repo);
      const result = await as(a, a.userId, async (c) => {
        const wi = (await c.query(`INSERT INTO work_items (account_id, repo_id, kind, gh_number, provenance) VALUES ($1, $2, 'issue', 12, 'internal') RETURNING id, stage`, [a.accountId, repo])).rows[0];
        const r = (await c.query('SELECT * FROM approve_proposal($1, $2)', [p1, wi.id])).rows[0];
        return { wi, r };
      });
      expect(result.wi.stage).toBe('triaged');
      expect(result.r).toMatchObject({ state: 'approved', roadmap_position: 1, work_item_id: result.wi.id, replayed: false });
      const stamped = (await admin.query('SELECT decided_by_user_id, decided_at FROM proposals WHERE id = $1', [p1])).rows[0];
      expect(stamped.decided_by_user_id).toBe(a.userId);
      expect(stamped.decided_at).not.toBeNull();
      const again = await approve(a, a.userId, p1, result.wi.id);
      expect(again).toMatchObject({ state: 'approved', roadmap_position: 1, replayed: true });
      expect((await admin.query(`SELECT count(*)::int n FROM audit_log WHERE account_id = $1 AND action = 'proposal.approved' AND payload->>'proposal_id' = $2`, [a.accountId, p1])).rows[0].n).toBe(1);
      const wi2 = await newWorkItem(a, repo);
      expect(await approve(a, adminUser, p2, wi2)).toMatchObject({ roadmap_position: 2, replayed: false });
      // the same work item cannot back a second proposal; a different one cannot re-approve
      const p3 = await newProposal(a, repo);
      await expect(approve(a, a.userId, p3, wi2)).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
      await expect(approve(a, a.userId, p1, wi2)).rejects.toMatchObject({ code: '55000', message: 'not_new' });
    });

    it('E5: an internal_loop proposal cannot be approved (owned_by_internal_loop); a rejected or withdrawn one is not new', async () => {
      const repo = await newRepo(a);
      const wi = await newWorkItem(a, repo);
      const loop = await newProposal(a, repo, { owner_process: 'internal_loop' });
      await expect(approve(a, a.userId, loop, wi)).rejects.toMatchObject({ code: '55000', message: 'owned_by_internal_loop' });
      expect((await admin.query('SELECT state, work_item_id FROM proposals WHERE id = $1', [loop])).rows[0]).toEqual({ state: 'new', work_item_id: null });
      for (const state of ['withdrawn']) {
        const p = await newProposal(a, repo, { state });
        await expect(approve(a, a.userId, p, wi)).rejects.toMatchObject({ code: '55000', message: 'not_new' });
      }
      const detached = await newRepo(a, false);
      const dp = await newProposal(a, detached);
      await expect(approve(a, a.userId, dp, wi)).rejects.toMatchObject({ code: '55000', message: 'repo_not_connected' });
    });

    // S3-H (0753): the work item is the caller's argument, so the definer checks it.
    it('refuses a work item of another repo (work_item_wrong_repo) or one past triaged (work_item_wrong_stage), and changes nothing', async () => {
      const repo = await newRepo(a);
      const other = await newRepo(a);
      const p = await newProposal(a, repo);
      const unchanged = async () => expect((await admin.query('SELECT state, work_item_id, roadmap_position FROM proposals WHERE id = $1', [p])).rows[0]).toEqual({ state: 'new', work_item_id: null, roadmap_position: null });
      await expect(approve(a, a.userId, p, await newWorkItem(a, other))).rejects.toMatchObject({ code: '55000', message: 'work_item_wrong_repo' });
      // a work item that does not exist, and one of another tenant, read the same way
      await expect(approve(a, a.userId, p, randomUUID())).rejects.toMatchObject({ code: '55000', message: 'work_item_wrong_repo' });
      const foreign = await newWorkItem(b, await newRepo(b));
      await expect(approve(a, a.userId, p, foreign)).rejects.toMatchObject({ code: '55000', message: 'work_item_wrong_repo' });
      for (const stage of ['discussing', 'in_progress', 'merged', 'closed']) {
        const wi = await newWorkItem(a, repo);
        await admin.query('UPDATE work_items SET stage = $2 WHERE id = $1', [wi, stage]);
        await expect(approve(a, a.userId, p, wi), stage).rejects.toMatchObject({ code: '55000', message: 'work_item_wrong_stage' });
      }
      await unchanged();
      // the item of the right repo at triaged still works, and a replay of it is still the same answer
      const good = await newWorkItem(a, repo);
      expect(await approve(a, a.userId, p, good)).toMatchObject({ state: 'approved', work_item_id: good, replayed: false });
      expect(await approve(a, a.userId, p, good)).toMatchObject({ state: 'approved', work_item_id: good, replayed: true });
    });

    it('a member session and a token without work_items:write are refused; a token with it is allowed; another tenant sees not found', async () => {
      const repo = await newRepo(a);
      const wi = await newWorkItem(a, repo);
      const p = await newProposal(a, repo);
      await expect(approve(a, memberUser, p, wi)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      const weak = await mintToken(a, ['read']);
      await expect(approve(a, a.userId, p, wi, weak)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(approve(b, b.userId, p, wi)).rejects.toMatchObject({ code: 'P0002' });
      const strong = await mintToken(a, ['read', 'work_items:write']);
      expect(await approve(a, a.userId, p, wi, strong)).toMatchObject({ state: 'approved', replayed: false });
      expect((await admin.query('SELECT decided_by_user_id FROM proposals WHERE id = $1', [p])).rows[0].decided_by_user_id).toBeNull();
      for (const fn of ['reject_proposal($1, NULL)', 'restore_proposal($1)', 'withdraw_approval($1)']) {
        await expect(as(a, memberUser, (c) => c.query(`SELECT * FROM ${fn}`, [p])), fn).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await expect(as(a, a.userId, (c) => c.query(`SELECT * FROM ${fn}`, [p]), weak), fn).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });

    it('reject takes a note up to 500 characters, restore puts it back, and the wrong state is refused', async () => {
      const repo = await newRepo(a);
      const p = await newProposal(a, repo);
      const reject = (note: string | null) => as(a, a.userId, async (c) => (await c.query('SELECT * FROM reject_proposal($1, $2)', [p, note])).rows[0]);
      await expect(reject('x'.repeat(501))).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      expect(await reject('not now')).toMatchObject({ state: 'rejected', replayed: false });
      expect((await admin.query('SELECT state, reject_note, decided_by_user_id FROM proposals WHERE id = $1', [p])).rows[0]).toEqual({ state: 'rejected', reject_note: 'not now', decided_by_user_id: a.userId });
      expect(await reject('not now')).toMatchObject({ replayed: true });
      await expect(reject('a different note')).rejects.toMatchObject({ code: '55000', message: 'not_new' });
      const restore = () => as(a, a.userId, async (c) => (await c.query('SELECT * FROM restore_proposal($1)', [p])).rows[0]);
      expect(await restore()).toEqual({ state: 'new' });
      expect((await admin.query('SELECT state, reject_note, decided_at FROM proposals WHERE id = $1', [p])).rows[0]).toEqual({ state: 'new', reject_note: null, decided_at: null });
      await expect(restore()).rejects.toMatchObject({ code: '55000', message: 'not_rejected' });
      expect(await reject(null)).toMatchObject({ state: 'rejected' });
    });

    it('withdraw returns an approved proposal to new while its work item is at triaged with no run, and the caller then closes the item', async () => {
      const repo = await newRepo(a);
      const p = await newProposal(a, repo);
      const wi = await newWorkItem(a, repo);
      await approve(a, a.userId, p, wi);
      const out = await as(a, a.userId, async (c) => {
        const r = (await c.query('SELECT * FROM withdraw_approval($1)', [p])).rows[0];
        // the ordinary stage writer then closes the item (triaged -> closed is a legal edge)
        await c.query(`INSERT INTO work_item_transitions (account_id, work_item_id, from_stage, to_stage, at, source, source_ref) VALUES ($1, $2, 'triaged', 'closed', now(), 'control_plane', 'withdraw:test')`, [a.accountId, r.work_item_id]);
        await c.query(`UPDATE work_items SET stage = 'closed' WHERE id = $1`, [r.work_item_id]);
        return r;
      });
      expect(out).toEqual({ state: 'new', work_item_id: wi });
      expect((await admin.query('SELECT state, roadmap_position, work_item_id, decided_at FROM proposals WHERE id = $1', [p])).rows[0]).toEqual({ state: 'new', roadmap_position: null, work_item_id: null, decided_at: null });
      expect((await admin.query('SELECT stage FROM work_items WHERE id = $1', [wi])).rows[0].stage).toBe('closed');
      await expect(as(a, a.userId, (c) => c.query('SELECT * FROM withdraw_approval($1)', [p]))).rejects.toMatchObject({ code: '55000', message: 'not_approved' });
    });

    it('withdraw answers work_started once a run exists or the item left triaged, and changes nothing', async () => {
      const repo = await newRepo(a);
      const withdraw = (p: string) => as(a, a.userId, (c) => c.query('SELECT * FROM withdraw_approval($1)', [p]));

      const p1 = await newProposal(a, repo);
      const wi1 = await newWorkItem(a, repo);
      await approve(a, a.userId, p1, wi1);
      await admin.query(`INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status) VALUES ($1, $2, 'executor', 'local', 'failed')`, [a.accountId, wi1]);
      await expect(withdraw(p1)).rejects.toMatchObject({ code: '55000', message: 'work_started' });

      const p2 = await newProposal(a, repo);
      const wi2 = await newWorkItem(a, repo);
      await approve(a, a.userId, p2, wi2);
      await admin.query(`UPDATE work_items SET stage = 'discussing' WHERE id = $1`, [wi2]);
      await expect(withdraw(p2)).rejects.toMatchObject({ code: '55000', message: 'work_started' });

      for (const [p, wi] of [[p1, wi1], [p2, wi2]] as const) {
        expect((await admin.query('SELECT state, work_item_id FROM proposals WHERE id = $1', [p])).rows[0]).toEqual({ state: 'approved', work_item_id: wi });
      }
    });
  });

  describe('definer shape', () => {
    it('every new function pins search_path, the definers are owned by platform_ops with EXECUTE for app_user only, and no guard is owned by platform_ops', async () => {
      const { rows } = await admin.query(
        `SELECT p.proname, p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig, p.oid::regprocedure::text AS sig
           FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
            AND p.proname IN ('plan_import_begin','approve_proposal','reject_proposal','restore_proposal','withdraw_approval','proposal_decider','plan_tables_write_guard','proposals_importer_guard','plan_imports_importer_guard')`,
      );
      expect(rows).toHaveLength(9);
      for (const r of rows) {
        expect(r.proconfig, r.proname).toContain('search_path=pg_catalog, public, pg_temp');
        if (r.prosecdef) expect(r.owner, r.proname).toBe('platform_ops');
        else expect(r.owner, `${r.proname} is a guard`).not.toBe('platform_ops');
      }
      for (const sig of DEFINERS) {
        expect((await admin.query(`SELECT has_function_privilege('app_user', $1::regprocedure, 'EXECUTE') AS ok, has_function_privilege('plan_importer', $1::regprocedure, 'EXECUTE') AS imp, has_function_privilege(0, $1::regprocedure, 'EXECUTE') AS pub`, [sig])).rows[0], sig).toEqual({ ok: true, imp: false, pub: false });
      }
      expect((await admin.query(`SELECT has_function_privilege('app_user', 'proposal_decider(text)'::regprocedure, 'EXECUTE') AS ok`)).rows[0].ok).toBe(false);
    });

    // The authorization helper must not be owned by platform_ops: as owner it could mark it IMMUTABLE, and a pooled
    // connection would then reuse the first caller's answer for everyone after (security review of live/s3, 2026-10-05).
    it('proposal_decider is a VOLATILE invoker helper that a direct platform_ops login cannot alter, drop or replace', async () => {
      const { rows } = await admin.query(
        `SELECT pg_get_userbyid(proowner) AS owner, prosecdef, provolatile FROM pg_proc WHERE oid = 'proposal_decider(text)'::regprocedure`,
      );
      expect(rows[0]).toMatchObject({ prosecdef: false, provolatile: 'v' });
      expect(rows[0].owner).not.toBe('platform_ops');
      const attempts = [
        'ALTER FUNCTION proposal_decider(text) IMMUTABLE',
        'ALTER FUNCTION proposal_decider(text) STABLE',
        'ALTER FUNCTION proposal_decider(text) SECURITY DEFINER',
        'ALTER FUNCTION proposal_decider(text) RESET ALL',
        'ALTER FUNCTION proposal_decider(text) OWNER TO platform_ops',
        'DROP FUNCTION proposal_decider(text) CASCADE',
        `CREATE OR REPLACE FUNCTION proposal_decider(p_fn text) RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$`,
      ];
      const client = await opsPool.connect();
      try {
        for (const sql of attempts) {
          await client.query('BEGIN');
          await expect(client.query(sql), sql).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
          await client.query('ROLLBACK');
        }
      } finally {
        client.release();
      }
      // And the definers still reach it as platform_ops.
      expect((await admin.query(`SELECT has_function_privilege('platform_ops', 'proposal_decider(text)'::regprocedure, 'EXECUTE') AS ok`)).rows[0].ok).toBe(true);
    });
  });
});
