import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { endAnalysis, queueAnalysis, startAnalysis } from '../src/discoveryAnalyses.js';
import { PG_ERROR } from './helpers/pgErrors.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const sha = (n: number): string => n.toString(16).padStart(40, '0');

/** [pg] D#483 S4-f2 (migration 0950): the analysis queue, the analyst's refs, the title normaliser and the list a sweep starts from. */
describe('discovery_analyses, analysis_refs, proposal_title_norm and the due list (0950) [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let writerPool: Pool;
  let A: SeedRefs;
  let B: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    writerPool = createPool(process.env.DATABASE_URL_RUN_WRITER!);
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end(), writerPool.end()]);
  });

  const code = async (p: Promise<unknown>): Promise<string | undefined> => p.then(() => undefined, (e: { code?: string }) => e.code);

  describe('queue (C25-f2-5)', () => {
    it('a second queueAnalysis for the same (repo, head) returns nothing and inserts nothing; a new head queues', async () => {
      const first = await queueAnalysis(appPool, A.accountId, A.repoId, sha(1));
      expect(first).toMatchObject({ repoId: A.repoId, headSha: sha(1) });
      expect(await queueAnalysis(appPool, A.accountId, A.repoId, sha(1))).toBeNull();
      expect((await admin.query(`SELECT 1 FROM discovery_analyses WHERE repo_id = $1 AND head_sha = $2`, [A.repoId, sha(1)])).rowCount).toBe(1);
      expect(await queueAnalysis(appPool, A.accountId, A.repoId, sha(2))).not.toBeNull();
      await expect(queueAnalysis(appPool, A.accountId, A.repoId, 'not-a-sha')).rejects.toThrow('full commit sha');
    });

    it('a direct INSERT in any state but queued is refused (the column is not granted, and the guard refuses it for the owner too)', async () => {
      for (const state of ['running', 'succeeded', 'skipped', 'failed']) {
        expect(await code(withTenant(appPool, A.accountId, (c) => c.query(`INSERT INTO discovery_analyses (account_id, repo_id, head_sha, state) VALUES ($1, $2, $3, $4)`, [A.accountId, A.repoId, sha(50), state])))).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
        expect(await code(admin.query(`INSERT INTO discovery_analyses (account_id, repo_id, head_sha, state, skip_reason, finished_at) VALUES ($1, $2, $3, $4, 'x', now())`, [A.accountId, A.repoId, sha(51), state]))).toBe(PG_ERROR.CHECK_VIOLATION);
      }
      expect((await admin.query(`SELECT 1 FROM discovery_analyses WHERE head_sha IN ($1, $2)`, [sha(50), sha(51)])).rowCount).toBe(0);
    });

    it('moves only forward, ended rows never change, attempts never go down, and nothing is deleted', async () => {
      const q = (await queueAnalysis(appPool, A.accountId, A.repoId, sha(3)))!;
      const upd = (set: string, ...args: unknown[]) => withTenant(appPool, A.accountId, (c) => c.query(`UPDATE discovery_analyses SET ${set} WHERE id = $1`, [q.id, ...args]));
      expect(await code(upd(`state = 'succeeded', finished_at = now()`))).toBe(PG_ERROR.CHECK_VIOLATION);
      expect(await startAnalysis(appPool, A.accountId, q.id)).toBe(true);
      expect(await startAnalysis(appPool, A.accountId, q.id)).toBe(false);
      expect(await code(upd(`state = 'queued'`))).toBe(PG_ERROR.CHECK_VIOLATION);
      expect(await code(upd(`attempts = 0`))).toBe(PG_ERROR.CHECK_VIOLATION);
      expect(await code(upd(`state = 'failed', finished_at = now()`))).toBe(PG_ERROR.CHECK_VIOLATION);
      expect(await endAnalysis(appPool, A.accountId, q.id, 'failed', 'output_rejected', { candidates: 0 })).toBe(true);
      expect(await endAnalysis(appPool, A.accountId, q.id, 'succeeded', null)).toBe(false);
      for (const set of [`state = 'running', finished_at = NULL`, `skip_reason = 'other'`, `counts = '{}'::jsonb`]) expect(await code(upd(set))).toBe(PG_ERROR.CHECK_VIOLATION);
      expect(await code(upd(`head_sha = '${sha(9)}'`))).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
      expect(await code(withTenant(appPool, A.accountId, (c) => c.query(`DELETE FROM discovery_analyses WHERE id = $1`, [q.id])))).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
      const row = (await admin.query(`SELECT state, skip_reason, attempts FROM discovery_analyses WHERE id = $1`, [q.id])).rows[0];
      expect(row).toEqual({ state: 'failed', skip_reason: 'output_rejected', attempts: 1 });
    });

    it('an ended row changes in one way only: its run is deleted and run_id goes to NULL (the foreign key action), everything else the same', async () => {
      const mkRun = async () => {
        const id = randomUUID();
        await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'proposal-verifier', 'local', 'running')`, [id, A.accountId]);
        return id;
      };
      const run = await mkRun();
      const q = (await queueAnalysis(appPool, A.accountId, A.repoId, sha(70)))!;
      await startAnalysis(appPool, A.accountId, q.id, run);
      await endAnalysis(appPool, A.accountId, q.id, 'succeeded', null, { candidates: 2 });
      const before = (await admin.query(`SELECT * FROM discovery_analyses WHERE id = $1`, [q.id])).rows[0];
      expect(before).toMatchObject({ state: 'succeeded', run_id: run });
      await admin.query(`DELETE FROM agent_runs WHERE id = $1`, [run]);
      expect((await admin.query(`SELECT * FROM discovery_analyses WHERE id = $1`, [q.id])).rows[0]).toEqual({ ...before, run_id: null });
      // The allowance is that and no more: a hand-made change of an ended row is still refused.
      const other = await mkRun();
      for (const set of [`counts = '{}'::jsonb`, `run_id = '${other}'`, `state = 'failed', skip_reason = 'x'`, `run_id = NULL, attempts = attempts + 1`]) {
        expect(await code(admin.query(`UPDATE discovery_analyses SET ${set} WHERE id = $1`, [q.id]))).toBe(PG_ERROR.CHECK_VIOLATION);
      }
      // A failed row too.
      const q2 = (await queueAnalysis(appPool, A.accountId, A.repoId, sha(71)))!;
      await startAnalysis(appPool, A.accountId, q2.id, other);
      await endAnalysis(appPool, A.accountId, q2.id, 'failed', 'output_rejected');
      await admin.query(`DELETE FROM agent_runs WHERE id = $1`, [other]);
      expect((await admin.query(`SELECT run_id, state FROM discovery_analyses WHERE id = $1`, [q2.id])).rows[0]).toEqual({ run_id: null, state: 'failed' });
    });

    it('a skipped or failed row must say why, and a queued row may carry its hold reason', async () => {
      const q = (await queueAnalysis(appPool, A.accountId, A.repoId, sha(4)))!;
      const upd = (set: string) => withTenant(appPool, A.accountId, (c) => c.query(`UPDATE discovery_analyses SET ${set} WHERE id = $1`, [q.id]));
      expect(await code(upd(`skip_reason = 'Daily Cap'`))).toBe(PG_ERROR.CHECK_VIOLATION);
      expect(await code(upd(`skip_reason = 'daily_cap'`))).toBeUndefined();
      expect(await code(endAnalysis(appPool, A.accountId, q.id, 'skipped', null))).toBe(PG_ERROR.CHECK_VIOLATION);
      await expect(endAnalysis(appPool, A.accountId, q.id, 'skipped', 'Not A Code')).rejects.toThrow('closed lowercase word');
    });

    it("another account's rows are invisible and cannot be changed or queued for", async () => {
      const q = (await queueAnalysis(appPool, A.accountId, A.repoId, sha(5)))!;
      expect((await withTenant(appPool, B.accountId, (c) => c.query(`SELECT 1 FROM discovery_analyses WHERE id = $1`, [q.id]))).rowCount).toBe(0);
      expect(await startAnalysis(appPool, B.accountId, q.id)).toBe(false);
      expect(await code(queueAnalysis(appPool, B.accountId, A.repoId, sha(6)))).toBeDefined();
      expect((await admin.query(`SELECT state FROM discovery_analyses WHERE id = $1`, [q.id])).rows[0].state).toBe('queued');
    });
  });

  describe('analysis_refs (the one CHECK)', () => {
    /** Written as the import role inside a tenant session, the way the writer does it; a refused row rolls back. */
    const put = (refs: Array<string | null> | null) =>
      withTenant(appPool, A.accountId, async (c) => {
        await c.query('SET LOCAL ROLE plan_importer');
        await c.query(
          `INSERT INTO proposals (account_id, repo_id, dedupe_key, sources, title, provenance, owner_process, analysis_refs)
           VALUES ($1, $2, 'src:' || substr(md5($3), 1, 16), ARRAY['docs'], 'refs', 'internal', 'product', $4::text[])`,
          [A.accountId, A.repoId, randomUUID(), refs],
        );
      });
    it.each([
      [null], [['docs/a.md:3-9']], [['src/a.ts:1-2', 'a b/c.d:10-20']], [Array.from({ length: 10 }, (_, i) => `f${i}.ts:1-${i + 1}`)],
      [['a.ts:1-999999999']], [['dir/.hidden:1-2', 'a..b/c.ts:1-2', 'a:b.ts:1-2']],
    ])('accepts %j', async (refs) => {
      expect(await code(put(refs as string[] | null))).toBeUndefined();
    });
    it.each([
      [[]], [['/etc/passwd:1-2']], [['a/../b:1-2']], [['./a:1-2']], [['a//b:1-2']], [['..:1-2']], [['a\\b:1-2']], [['a\u0001b:1-2']], [['a\nb:1-2']],
      [['a.ts']], [['a.ts:1']], [['a.ts:x-y']], [[':1-2']], [['ok.ts:1-2', 'bad']], [[`${'x'.repeat(241)}:1-2`]], [Array.from({ length: 11 }, (_, i) => `f${i}.ts:1-2`)],
    ])('refuses %j', async (refs) => {
      expect(await code(put(refs as string[]))).toBe(PG_ERROR.CHECK_VIOLATION);
    });
    // One refused case per way the first version of the CHECK let a ref through (review of ed03fe95).
    it.each([
      ['an empty last segment', ['docs/:1-2']],
      ['a trailing slash before the range', ['a/b/:1-2']],
      ['an element holding \\x01 (two refs in one element)', ['a:1-2\u0001b:3-4']],
      ['51 refs hidden in one element by \\x01', [Array.from({ length: 51 }, (_, i) => `f${i}.ts:1-2`).join('\u0001')]],
      ['a NULL element', [null, 'a:1-2']],
      ['a NULL element after a good one', ['a:1-2', null]],
      ['a leading ~/', ['~/x:1-2']],
      ['a bare ~', ['~:1-2']],
      ['a drive letter', ['C:/x:1-2']],
      ['BEL', ['a\u0007b:1-2']],
      ['DEL', ['a\u007fb:1-2']],
      ['NEL (U+0085)', ['a\u0085b:1-2']],
      ['U+2028', ['a\u2028b:1-2']],
      ['U+2029', ['a\u2029b:1-2']],
      ['a 10-digit line number', ['a.ts:1-1234567890']],
      ['a 10-digit start line', ['a.ts:1234567890-2']],
      ['a 5000-digit line number', [`a.ts:1-${'9'.repeat(5000)}`]],
    ] as Array<[string, Array<string | null>]>)('refuses %s', async (_name, refs) => {
      expect(await code(put(refs))).toBe(PG_ERROR.CHECK_VIOLATION);
    });
    it('is a function the writing roles hold and PUBLIC does not', async () => {
      const acl = (await admin.query<{ g: string }>(`SELECT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS g FROM pg_proc p, aclexplode(p.proacl) a WHERE p.proname = 'proposal_analysis_refs_ok'`)).rows.map((r) => r.g);
      expect(acl).not.toContain('PUBLIC');
      expect(acl).toContain('plan_importer');
    });
  });

  describe('proposal_title_norm', () => {
    const norm = async (t: string) => (await admin.query<{ n: string }>(`SELECT proposal_title_norm($1) AS n`, [t])).rows[0]!.n;
    it('lowercases, drops everything but letters, digits and spaces, collapses whitespace and trims', async () => {
      expect(await norm('Add a CLI flag!')).toBe('add a cli flag');
      expect(await norm('  add   a\tCLI\nflag ')).toBe('add a cli flag');
      expect(await norm('Fix: v2.0 -- (beta) #12')).toBe('fix v20 beta 12');
      expect(await norm('!!!')).toBe('');
    });
    it('is IMMUTABLE, executable by named roles only, and indexed by (repo_id, norm)', async () => {
      const f = (await admin.query(`SELECT provolatile, prosecdef, proacl::text AS acl FROM pg_proc WHERE proname = 'proposal_title_norm'`)).rows[0];
      expect(f.provolatile).toBe('i');
      expect(f.prosecdef).toBe(false);
      expect(f.acl).not.toMatch(/^\{=|,=[rX]*\//);
      expect((await admin.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'proposals_title_norm'`)).rowCount).toBe(1);
    });
    it('every role that can write a proposal can execute it (index maintenance evaluates it for the writer), and no login inherits it from PUBLIC', async () => {
      const writers = await admin.query<{ rolname: string; ok: boolean }>(
        `SELECT r.rolname, has_function_privilege(r.oid, 'proposal_title_norm(text)', 'EXECUTE') AS ok FROM pg_roles r
          WHERE has_table_privilege(r.oid, 'proposals', 'INSERT') OR has_table_privilege(r.oid, 'proposals', 'UPDATE')
             OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = 'proposals'::regclass AND a.attnum > 0 AND (has_column_privilege(r.oid, 'proposals', a.attname, 'INSERT') OR has_column_privilege(r.oid, 'proposals', a.attname, 'UPDATE')))`,
      );
      expect(writers.rows.map((w) => w.rolname)).toContain('plan_importer');
      expect(writers.rows.filter((w) => !w.ok && !/^(postgres|fx_migrator|pg_.*)$/.test(w.rolname)).map((w) => w.rolname)).toEqual([]);
      expect((await admin.query(`SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.proname = 'proposal_title_norm' AND a.grantee = 0`)).rowCount).toBe(0);
    });
  });

  describe('discovery_analysis_list_due', () => {
    const due = async () => (await writerPool.query<{ account_id: string; analysis_id: string }>(`SELECT * FROM discovery_analysis_list_due(200)`)).rows;
    it('lists queued and running analyses of live accounts with a connected sandbox product repo, ids only, and nothing that ended', async () => {
      const q = (await queueAnalysis(appPool, B.accountId, B.repoId, sha(20)))!;
      const mine = () => due().then((r) => r.filter((x) => x.account_id === B.accountId));
      expect(await mine()).toEqual([{ account_id: B.accountId, analysis_id: q.id }]);
      expect(Object.keys((await mine())[0]!)).toEqual(['account_id', 'analysis_id']);
      await startAnalysis(appPool, B.accountId, q.id);
      expect(await mine()).toHaveLength(1);
      // 0953 (D#483 S4-f4): a Cloud-verified repository is listed too; a Local-only one is not.
      await admin.query(`UPDATE repos SET execution_mode = 'runner_verified' WHERE id = $1`, [B.repoId]);
      expect(await mine()).toHaveLength(1);
      await admin.query(`UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1`, [B.repoId]);
      expect(await mine()).toHaveLength(0);
      await admin.query(`UPDATE repos SET execution_mode = 'sandbox', installation_id = NULL WHERE id = $1`, [B.repoId]);
      expect(await mine()).toHaveLength(0);
      await admin.query(`UPDATE repos SET installation_id = $2 WHERE id = $1`, [B.repoId, B.installationId]);
      expect(await mine()).toHaveLength(1);
      await admin.query(`UPDATE accounts SET deleted_at = now() WHERE id = $1`, [B.accountId]);
      expect(await mine()).toHaveLength(0);
      await admin.query(`UPDATE accounts SET deleted_at = NULL WHERE id = $1`, [B.accountId]);
      await endAnalysis(appPool, B.accountId, q.id, 'succeeded', null);
      expect(await mine()).toHaveLength(0);
    });
    it('is executable by the run-writer login alone, refuses a bad limit, and the role is NOLOGIN with no members', async () => {
      expect(await code(writerPool.query(`SELECT * FROM discovery_analysis_list_due(0)`))).toBe('22023');
      expect(await code(appPool.query(`SELECT * FROM discovery_analysis_list_due(5)`))).toBe(PG_ERROR.INSUFFICIENT_PRIVILEGE);
      const acl = (await admin.query<{ g: string }>(`SELECT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS g FROM pg_proc p, aclexplode(p.proacl) a WHERE p.proname = 'discovery_analysis_list_due' ORDER BY 1`)).rows.map((r) => r.g);
      expect(acl).toEqual(['agent_run_writer', 'discovery_analysis_lister']);
      expect((await admin.query(`SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'discovery_analysis_lister'`)).rows[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolbypassrls: false });
      expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE roleid = 'discovery_analysis_lister'::regrole OR member = 'discovery_analysis_lister'::regrole`)).rowCount).toBe(0);
    });
  });
});
