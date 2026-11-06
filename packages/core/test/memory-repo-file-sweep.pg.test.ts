import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { seedAccount, type SeedRefs } from '@fx/db/test/helpers/seed.js';
import { withTenant } from '../src/tenancy/withTenant.js';
import { MEMORY_IMPORT_MAX_BYTES, repoScopeRef } from '../src/memory/index.js';
import {
  REPO_FILE_MAX_PER_TICK,
  REPO_FILE_ONE_MS,
  REPO_FILE_TRUNCATED_NOTICE,
  markRepoFilesDue,
  sweepRepoInstructionFiles,
  truncatedRepoFiles,
  type RepoFileRead,
} from '../src/memory/repoFileSweep.js';

/**
 * [pg] D#601 MEM-5b: the due mark, the sweep that reads a file and imports it, the per-file state and the truncation notice, against a real Postgres as the real
 * roles (the sweep runs on the run-writer login, every write under the account's tenant). The GitHub read is injected; the import is the real one.
 */
const RUNNER_LOGIN = 'fx_repofile_sweep_test';
const COMMIT = 'a'.repeat(40);
const sha = (c: string): string => c.repeat(40);
const four = ['# Build', 'Run pnpm test before you push.', '## Style', 'Prefer named exports.', '## Review', 'Every change needs a second pair of eyes.', '## Deploy', 'Staging first, then production.'].join('\n');
const big = (): string => Array.from({ length: 1200 }, (_, i) => `## Section ${i}\nLine of guidance number ${i} that fills the file out to a size past the limit.`).join('\n');

describe('repo instruction file sweep (D#601 MEM-5b) [pg]', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let runner: Pool;
  let A: SeedRefs;
  let B: SeedRefs;
  let n = 0;

  async function repo(account: SeedRefs = A, nodeId = true): Promise<string> {
    n += 1;
    const repoId = randomUUID();
    const installId = randomUUID();
    const gh = 8_800_000 + n + Math.floor(Math.random() * 1e6);
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, 'team')`, [installId, account.accountId, gh]);
    await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product, gh_owner, gh_name) VALUES ($1, $2, $3, $4, 'team', 'acme', $5)`, [repoId, account.accountId, installId, gh, `widgets${n}`]);
    if (nodeId) await admin.query(`UPDATE repos SET gh_node_id = $2 WHERE id = $1`, [repoId, `R_kgDOSweep${n}x${gh}`]);
    return repoId;
  }
  const mark = (repoIds: string[], paths: Array<'CLAUDE.md' | 'AGENTS.md'> = ['CLAUDE.md'], account: SeedRefs = A) =>
    withTenant(runner, account.accountId, (c) => markRepoFilesDue(c, { accountId: account.accountId, repoIds, paths }));
  const dueNow = () => admin.query(`UPDATE repo_instruction_files SET due_at = now() - interval '1 second' WHERE due_at IS NOT NULL`);
  const state = async (repoId: string, path = 'CLAUDE.md') => (await admin.query(`SELECT * FROM repo_instruction_files WHERE repo_id = $1 AND path = $2`, [repoId, path])).rows[0];
  const proposals = async (repoId: string) =>
    (await admin.query(`SELECT m.* FROM memory_entries m JOIN repos r ON m.scope_ref = $2 WHERE r.id = $1 AND m.scope = 'repo' ORDER BY m.created_at, m.id`, [repoId, await refOf(repoId)])).rows;
  async function refOf(repoId: string): Promise<string> {
    const r = (await admin.query(`SELECT r.gh_node_id, i.gh_installation_id FROM repos r JOIN installations i ON i.id = r.installation_id WHERE r.id = $1`, [repoId])).rows[0];
    return repoScopeRef(r.gh_node_id, Number(r.gh_installation_id));
  }
  const reading = (text: string | null, fileSha = sha('c')): RepoFileRead => async () => ({ commit: COMMIT, file: text === null ? null : { sha: fileSha, text } });
  const sweep = (read: RepoFileRead, extra: Partial<Parameters<typeof sweepRepoInstructionFiles>[0]> = {}) =>
    sweepRepoInstructionFiles({ pool: runner, read, liveSecrets: () => [], log: () => undefined, ...extra });

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RUNNER_LOGIN}') THEN
          CREATE ROLE ${RUNNER_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
        END IF;
      END $$`);
    await admin.query(`GRANT app_user, agent_run_writer TO ${RUNNER_LOGIN}`);
    const u = new URL(process.env.DATABASE_URL_APP_USER!);
    u.username = RUNNER_LOGIN;
    u.password = '';
    runner = createPool(u.toString());
    A = await seedAccount(admin, randomUUID());
    B = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), runner.end()]);
  });
  beforeEach(async () => {
    await admin.query('DELETE FROM repo_instruction_files');
  });

  it('the mark is a due row 60 seconds ahead, keeps an earlier time, ignores another account\'s repository and an empty list', async () => {
    const r = await repo();
    const other = await repo(B);
    expect(await mark([r], ['CLAUDE.md', 'AGENTS.md'])).toBe(2);
    const s = (await admin.query(`SELECT extract(epoch FROM due_at - now()) AS s FROM repo_instruction_files WHERE repo_id = $1 AND path = 'CLAUDE.md'`, [r])).rows[0].s;
    expect(Number(s)).toBeGreaterThan(50);
    expect(Number(s)).toBeLessThanOrEqual(60);
    await admin.query(`UPDATE repo_instruction_files SET due_at = now() + interval '5 seconds' WHERE repo_id = $1`, [r]);
    await mark([r]);
    expect(Number((await admin.query(`SELECT extract(epoch FROM due_at - now()) AS s FROM repo_instruction_files WHERE repo_id = $1 AND path = 'CLAUDE.md'`, [r])).rows[0].s)).toBeLessThan(6);
    expect(await mark([other])).toBe(0);
    expect(await mark([])).toBe(0);
    expect(await mark([r], [])).toBe(0);
    expect((await admin.query('SELECT 1 FROM repo_instruction_files')).rowCount).toBe(2);
  });

  it('Acceptance 1: a file with four sections becomes four import proposals carrying the file sha and the commit, and the file is no longer due', async () => {
    const r = await repo();
    await mark([r]);
    await dueNow();
    const counts = await sweep(reading(four));
    expect(counts).toMatchObject({ listed: 1, imported: 1, failed: 0, skipped: 0 });
    const rows = await proposals(r);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.author_kind).toBe('import');
      expect(row.status).toBe('proposed');
      expect(row.provenance).toMatchObject({ source_path: 'CLAUDE.md', source_commit: COMMIT, file_sha: sha('c') });
    }
    const st = await state(r);
    expect(st).toMatchObject({ file_sha: sha('c'), source_commit: COMMIT, truncated: false, last_error: null, error_streak: 0, due_at: null });
    expect((await sweep(reading(four))).listed).toBe(0);
  });

  it('Acceptance 2: a push that edits one section proposes one new proposal; an unchanged file proposes none', async () => {
    const r = await repo();
    await mark([r]);
    await dueNow();
    await sweep(reading(four));
    await mark([r]);
    await dueNow();
    await sweep(reading(four, sha('d')));
    expect(await proposals(r)).toHaveLength(4);
    await mark([r]);
    await dueNow();
    await sweep(reading(four.replace('Prefer named exports.', 'Prefer default exports.'), sha('e')));
    const rows = await proposals(r);
    expect(rows).toHaveLength(5);
    expect(rows[4]!.body).toContain('default exports');
    expect(rows[4]!.provenance).toMatchObject({ file_sha: sha('e') });
    expect((await state(r)).file_sha).toBe(sha('e'));
  });

  it('Acceptance 3: a 40 KiB file is imported up to 32 KiB, the state says truncated, and the notice names the file in the fixed words; a later short file clears it', async () => {
    const r = await repo();
    const text = big();
    expect(Buffer.byteLength(text)).toBeGreaterThan(40 * 1024);
    await mark([r], ['AGENTS.md']);
    await dueNow();
    await sweep(reading(text));
    expect((await state(r, 'AGENTS.md')).truncated).toBe(true);
    const seen = await withTenant(runner, A.accountId, (c) => truncatedRepoFiles(c));
    expect(seen).toEqual([{ repoId: r, repo: expect.stringMatching(/^acme\/widgets/), path: 'AGENTS.md', text: 'File truncated at 32 KiB' }]);
    expect(REPO_FILE_TRUNCATED_NOTICE).toBe(`File truncated at ${MEMORY_IMPORT_MAX_BYTES / 1024} KiB`);
    expect(await withTenant(runner, B.accountId, (c) => truncatedRepoFiles(c))).toEqual([]);
    expect(await withTenant(runner, A.accountId, (c) => truncatedRepoFiles(c, [randomUUID()]))).toEqual([]);
    await mark([r], ['AGENTS.md']);
    await dueNow();
    await sweep(reading(four, sha('f')));
    expect(await withTenant(runner, A.accountId, (c) => truncatedRepoFiles(c))).toEqual([]);
  });

  it('a file that is not there records no error and no sha, and keeps no stale truncation notice', async () => {
    const r = await repo();
    await mark([r]);
    await dueNow();
    await sweep(reading(big()));
    await mark([r]);
    await dueNow();
    await sweep(reading(null));
    expect(await state(r)).toMatchObject({ file_sha: null, truncated: false, last_error: null, due_at: null });
  });

  it('a read that cannot pass records its closed code and waits for a push: it is not listed again, and nothing is proposed', async () => {
    const r = await repo();
    await mark([r]);
    await dueNow();
    const counts = await sweep(async () => {
      throw Object.assign(new Error('GET https://api.github.com/repos/acme/x?token=SECRET failed'), { code: 'plan_file_too_large' });
    });
    expect(counts.failed).toBe(1);
    expect(await state(r)).toMatchObject({ last_error: 'plan_file_too_large', error_streak: 1, due_at: null, file_sha: null });
    expect((await sweep(reading(four))).listed).toBe(0);
    expect(await proposals(r)).toHaveLength(0);
    await mark([r]);
    expect((await state(r)).error_streak).toBe(0);
  });

  it('a read that may pass backs off 5 minutes and then 30, stops after eight, and an unknown error is github_unavailable without its text', async () => {
    const r = await repo();
    await mark([r]);
    await dueNow();
    await sweep(async () => {
      throw new Error('socket hang up for https://x.example/?secret=1');
    });
    let st = await state(r);
    expect(st).toMatchObject({ last_error: 'github_unavailable', error_streak: 1 });
    const secs = async () => Number((await admin.query(`SELECT extract(epoch FROM due_at - now()) AS s FROM repo_instruction_files WHERE repo_id = $1`, [r])).rows[0].s);
    expect(await secs()).toBeGreaterThan(250);
    expect(await secs()).toBeLessThanOrEqual(300);
    await dueNow();
    await sweep(async () => { throw Object.assign(new Error('x'), { code: 'rate_limited_by_github' }); });
    await dueNow();
    await sweep(async () => { throw Object.assign(new Error('x'), { code: 'rate_limited_by_github' }); });
    expect(await secs()).toBeGreaterThan(1700);
    await admin.query(`UPDATE repo_instruction_files SET error_streak = 7`);
    await dueNow();
    await sweep(async () => { throw new Error('x'); });
    st = await state(r);
    expect(st).toMatchObject({ error_streak: 8, due_at: null });
    expect(JSON.stringify(st)).not.toMatch(/SECRET|secret|socket/);
  });

  it('a repository with no memory key yet records repo_unready and backs off', async () => {
    const r = await repo(A, false);
    await mark([r]);
    await dueNow();
    await sweep(reading(four));
    expect(await state(r)).toMatchObject({ last_error: 'repo_unready', error_streak: 1 });
    expect(Number((await admin.query(`SELECT extract(epoch FROM due_at - now()) AS s FROM repo_instruction_files WHERE repo_id = $1`, [r])).rows[0].s)).toBeGreaterThan(250);
  });

  it('a push that lands while the file is being read keeps its own time, and the old good state survives a failure', async () => {
    const r = await repo();
    await mark([r]);
    await dueNow();
    await sweep(reading(four));
    await mark([r]);
    await dueNow();
    await sweep(async () => {
      await mark([r]);
      throw Object.assign(new Error('x'), { code: 'github_unavailable' });
    });
    const st = await state(r);
    expect(st).toMatchObject({ file_sha: sha('c'), source_commit: COMMIT, last_error: 'github_unavailable' });
    const s = Number((await admin.query(`SELECT extract(epoch FROM due_at - now()) AS s FROM repo_instruction_files WHERE repo_id = $1`, [r])).rows[0].s);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(60);
  });

  it('a file not yet due is not read; a tick starts at most ten files and reports when it looks again; a deadline too close starts none', async () => {
    const ids = [] as string[];
    for (let i = 0; i < REPO_FILE_MAX_PER_TICK + 2; i += 1) ids.push(await repo());
    await mark(ids);
    let reads = 0;
    const read: RepoFileRead = async () => (reads += 1, { commit: COMMIT, file: null });
    expect(await sweep(read)).toMatchObject({ listed: ids.length, imported: 0 });
    expect(reads).toBe(0);
    await dueNow();
    const late = await sweep(read, { deadlineAt: Date.now() + REPO_FILE_ONE_MS - 1000 });
    expect(late).toMatchObject({ listed: ids.length, imported: 0 });
    expect(reads).toBe(0);
    expect(late.nextDueAt).not.toBeNull();
    const counts = await sweep(read);
    expect(reads).toBe(REPO_FILE_MAX_PER_TICK);
    expect(counts.imported).toBe(REPO_FILE_MAX_PER_TICK);
    expect(counts.nextDueAt).not.toBeNull();
  });

  it('a tick that listed a file before another tick finished it finds the lease or the clear mark and skips it', async () => {
    const r = await repo();
    await mark([r]);
    await dueNow();
    let reads = 0;
    const read: RepoFileRead = async () => (reads += 1, { commit: COMMIT, file: null });
    const listed = await runner.query('SELECT account_id, repo_id, path, (extract(epoch FROM due_at) * 1000)::bigint AS due_ms, due_now FROM repo_instruction_list_due($1::integer)', [50]);
    expect(listed.rows).toHaveLength(1);
    // The second tick's list is the one taken before the first tick ran.
    const stale = new Proxy(runner, {
      get: (t, k) => (k === 'query' ? async (sql: string, p?: unknown[]) => (/repo_instruction_list_due/.test(sql) ? listed : t.query(sql, p)) : typeof t[k as keyof Pool] === 'function' ? (t[k as keyof Pool] as (...a: unknown[]) => unknown).bind(t) : t[k as keyof Pool]),
    });
    expect((await sweep(read)).imported).toBe(1);
    const second = await sweep(read, { pool: stale as Pool });
    expect(reads).toBe(1);
    expect(second).toMatchObject({ listed: 1, imported: 0, skipped: 1 });
  });

  it('the app login can read its own files and not another account\'s, and cannot delete them', async () => {
    const r = await repo();
    await mark([r]);
    expect((await withTenant(runner, A.accountId, (c) => c.query('SELECT 1 FROM repo_instruction_files'))).rowCount).toBe(1);
    expect((await withTenant(runner, B.accountId, (c) => c.query('SELECT 1 FROM repo_instruction_files'))).rowCount).toBe(0);
    await expect(withTenant(runner, A.accountId, (c) => c.query('DELETE FROM repo_instruction_files'))).rejects.toThrow(/permission denied/);
  });
});
