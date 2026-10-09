import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedF2, type F2Fixture } from './helpers/members.js';

const ROLE = 'runner_allowance_definer';
const FN = 'repo_runner_sandbox_allowances_write(uuid,text,jsonb,integer,text)';
const TABLE = 'repo_runner_sandbox_allowances';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const ENTRIES = [{ kind: 'domain', value: 'registry.npmjs.org', access: 'connect', reason: 'pnpm install' }];

/** 0770 (D#6 R7a, C35): the append-only allowance table and the one definer that writes it. */
describe('migration 0770: repo_runner_sandbox_allowances and repo_runner_sandbox_allowances_write', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let writerPool: Pool;
  let platformOpsPool: Pool;
  let admin: PoolClient;
  let f: F2Fixture;
  let repo: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    writerPool = createPool(process.env.DATABASE_URL_RUN_WRITER!);
    platformOpsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    admin = await adminPool.connect();
    f = await seedF2(admin);
    repo = await newRepo(f.accountId);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end(), writerPool.end(), platformOpsPool.end()]);
  });

  async function newRepo(accountId: string): Promise<string> {
    const id = randomUUID();
    await admin.query("INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, 'team', 'Acme', 'widgets', 'runner_local')", [id, accountId, Math.floor(Math.random() * 1e12)]);
    return id;
  }
  /** Calls the writer as the web tier's login, as `user` of the account. */
  const write = (user: string, repoId: string, action: string, entries: unknown, timeout: number | null, sha: string | null, accountId = f.accountId) =>
    withTenant(appPool, accountId, user, async (client) =>
      (await client.query<{ changed: boolean; set_version: number }>(`SELECT changed, set_version FROM ${FN.split('(')[0]}($1, $2, $3::jsonb, $4, $5)`, [repoId, action, entries === null ? null : JSON.stringify(entries), timeout, sha])).rows[0],
    );
  const approve = (user: string, repoId: string, entries: unknown[] = ENTRIES, timeout: number | null = 900, sha = SHA_A) => write(user, repoId, 'approve', entries, entries.length === 0 ? null : timeout, sha);
  const rows = async (repoId = repo) =>
    (await admin.query<{ version: number; set_aside: boolean; set_sha256: string; approved_by: string; n: number }>(`SELECT version, set_aside, set_sha256, approved_by, jsonb_array_length(entries) AS n FROM ${TABLE} WHERE repo_id = $1 ORDER BY version`, [repoId])).rows;
  const audits = async (repoId = repo) =>
    (await admin.query<{ actor: string; action: string; payload: Record<string, unknown> }>("SELECT actor, action, payload FROM audit_log WHERE action LIKE 'repo.runner_sandbox_allowances.%' AND payload->>'repo_id' = $1 ORDER BY created_at, id", [repoId])).rows;
  const sqlstate = async (run: () => Promise<unknown>): Promise<string | undefined> => run().then(() => undefined, (e: { code?: string }) => e.code);

  it('the role is NOLOGIN and unprivileged, has no member, is a member of nothing, and owns exactly this function', async () => {
    const { rows: attrs } = await admin.query('SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1', [ROLE]);
    expect(attrs[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
    expect((await admin.query('SELECT 1 FROM pg_auth_members WHERE roleid = $1::regrole OR member = $1::regrole', [ROLE])).rowCount).toBe(0);
    const owned = await admin.query<{ sig: string }>('SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proowner = $1::regrole', [ROLE]);
    expect(owned.rows.map((r) => r.sig)).toEqual([FN]);
    expect((await admin.query("SELECT has_schema_privilege($1, 'public', 'CREATE') AS ok", [ROLE])).rows[0].ok).toBe(false);
  });

  it('platform_ops holds nothing on the table or the function; app_user and the run writer can read it and write nothing', async () => {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
      expect((await admin.query('SELECT has_table_privilege($1, $2, $3) AS ok', ['platform_ops', TABLE, privilege])).rows[0].ok, privilege).toBe(false);
    }
    expect((await admin.query("SELECT has_any_column_privilege('platform_ops', $1, 'SELECT, INSERT, UPDATE, REFERENCES') AS ok", [TABLE])).rows[0].ok).toBe(false);
    expect((await admin.query("SELECT has_function_privilege('platform_ops', $1::regprocedure, 'EXECUTE') AS ok", [FN])).rows[0].ok).toBe(false);
    for (const login of ['app_user', 'agent_run_writer']) {
      expect((await admin.query("SELECT has_any_column_privilege($1, $2, 'INSERT, UPDATE, REFERENCES') AS ok", [login, TABLE])).rows[0].ok, login).toBe(false);
      expect((await admin.query("SELECT has_table_privilege($1, $2, 'DELETE, TRUNCATE, TRIGGER') AS ok", [login, TABLE])).rows[0].ok, login).toBe(false);
    }
    expect((await admin.query("SELECT has_function_privilege('agent_run_writer', $1::regprocedure, 'EXECUTE') AS ok", [FN])).rows[0].ok).toBe(false);
    expect((await admin.query("SELECT has_function_privilege('app_user', $1::regprocedure, 'EXECUTE') AS ok", [FN])).rows[0].ok).toBe(true);
  });

  it('an owner and an admin approve a set: version 1, one audit row with the hash, who approved it, and the entry count', async () => {
    expect(await approve(f.o1, repo)).toEqual({ changed: true, set_version: 1 });
    expect(await rows()).toEqual([{ version: 1, set_aside: false, set_sha256: SHA_A, approved_by: f.o1, n: 1 }]);
    expect(await audits()).toEqual([
      { actor: f.o1, action: 'repo.runner_sandbox_allowances.approved', payload: { repo_id: repo, version: 1, set_sha256: SHA_A, entry_count: 1, command_timeout_s: 900, previous_set_sha256: null } },
    ]);
    const other = await newRepo(f.accountId);
    expect(await approve(f.a1, other)).toEqual({ changed: true, set_version: 1 });
  });

  it('the set already in force writes nothing; a different set is the next version and names the one it replaced', async () => {
    expect(await approve(f.a1, repo)).toEqual({ changed: false, set_version: 1 });
    expect(await approve(f.a1, repo, ENTRIES, 1200, SHA_B)).toEqual({ changed: true, set_version: 2 });
    expect((await rows()).map((r) => r.version)).toEqual([1, 2]);
    const last = (await audits()).at(-1)!;
    expect(last.payload).toMatchObject({ version: 2, set_sha256: SHA_B, previous_set_sha256: SHA_A, command_timeout_s: 1200 });
    expect((await audits()).length).toBe(2);
  });

  it('an empty set is allowed, needs no timeout and still writes an audit row; repeating it writes nothing', async () => {
    const r = await newRepo(f.accountId);
    expect(await approve(f.o1, r)).toMatchObject({ changed: true });
    expect(await write(f.o1, r, 'approve', [], null, SHA_B)).toEqual({ changed: true, set_version: 2 });
    expect(await write(f.o1, r, 'approve', [], null, SHA_B)).toEqual({ changed: false, set_version: 2 });
    expect(await audits(r)).toHaveLength(2);
    expect((await audits(r))[1]!.payload).toMatchObject({ entry_count: 0, command_timeout_s: null, previous_set_sha256: SHA_A });
  });

  it('set_aside keeps the set on record and ignores it; the same set approved again is a new version', async () => {
    const r = await newRepo(f.accountId);
    await approve(f.o1, r);
    expect(await write(f.o1, r, 'set_aside', null, null, null)).toEqual({ changed: true, set_version: 2 });
    expect(await rows(r)).toEqual([
      { version: 1, set_aside: false, set_sha256: SHA_A, approved_by: f.o1, n: 1 },
      { version: 2, set_aside: true, set_sha256: SHA_A, approved_by: f.o1, n: 1 },
    ]);
    expect((await audits(r)).at(-1)).toMatchObject({ action: 'repo.runner_sandbox_allowances.set_aside', payload: { version: 2, set_sha256: SHA_A } });
    expect(await write(f.o1, r, 'set_aside', null, null, null)).toEqual({ changed: false, set_version: 2 });
    expect(await approve(f.o1, r)).toEqual({ changed: true, set_version: 3 });
    expect((await rows(r)).at(-1)).toMatchObject({ version: 3, set_aside: false });
  });

  it('set_aside with nothing in force writes nothing', async () => {
    const r = await newRepo(f.accountId);
    expect(await write(f.o1, r, 'set_aside', null, null, null)).toEqual({ changed: false, set_version: 0 });
    await write(f.o1, r, 'approve', [], null, SHA_A);
    expect(await write(f.o1, r, 'set_aside', null, null, null)).toEqual({ changed: false, set_version: 1 });
    expect(await rows(r)).toHaveLength(1);
  });

  it('a member, a stranger, an unknown user and a platform_ops login are refused with 42501 and nothing is written', async () => {
    const r = await newRepo(f.accountId);
    expect(await sqlstate(() => approve(f.m1, r))).toBe('42501');
    expect(await sqlstate(() => write(f.m1, r, 'set_aside', null, null, null))).toBe('42501');
    expect(await sqlstate(() => approve(randomUUID(), r))).toBe('42501');
    const g = await seedF2(admin);
    expect(await sqlstate(() => write(g.o1, r, 'approve', ENTRIES, 900, SHA_A, f.accountId))).toBe('42501');
    expect(await sqlstate(() => withTenant(platformOpsPool, f.accountId, f.o1, (c) => c.query(`SELECT * FROM ${FN.split('(')[0]}($1, 'approve', '[]', NULL, $2)`, [r, SHA_A])))).toBeDefined();
    expect(await rows(r)).toEqual([]);
    expect(await audits(r)).toEqual([]);
  });

  it('another account\'s repo and an unknown repo answer P0002', async () => {
    const g = await seedF2(admin);
    const theirs = await newRepo(g.accountId);
    expect(await sqlstate(() => approve(f.o1, theirs))).toBe('P0002');
    expect(await sqlstate(() => approve(f.o1, randomUUID()))).toBe('P0002');
    expect(await rows(theirs)).toEqual([]);
  });

  it('refuses a bad action, a malformed hash, a non-array, over 64 entries, and a timeout that does not match the entries (22023)', async () => {
    const r = await newRepo(f.accountId);
    const many = Array.from({ length: 65 }, () => ENTRIES[0]);
    for (const args of [
      ['nope', ENTRIES, 900, SHA_A],
      ['approve', ENTRIES, 900, 'A'.repeat(64)],
      ['approve', ENTRIES, 900, 'abc'],
      ['approve', ENTRIES, 900, null],
      ['approve', {}, null, SHA_A],
      ['approve', null, null, SHA_A],
      ['approve', many, 900, SHA_A],
      ['approve', ENTRIES, null, SHA_A],
      ['approve', ENTRIES, 0, SHA_A],
      ['approve', ENTRIES, 1801, SHA_A],
      ['approve', [], 60, SHA_A],
      ['set_aside', ENTRIES, null, null],
      ['set_aside', null, 60, null],
      ['set_aside', null, null, SHA_A],
    ] as Array<[string, unknown, number | null, string | null]>) {
      expect(await sqlstate(() => write(f.o1, r, ...args)), JSON.stringify(args).slice(0, 60)).toBe('22023');
    }
    expect(await rows(r)).toEqual([]);
  });

  it('the table itself holds the shape: a timeout without entries, entries without a timeout, a bad hash and a duplicate version are refused', async () => {
    const r = await newRepo(f.accountId);
    const insert = (entries: unknown, timeout: number | null, sha: string, version: number) =>
      admin.query(`INSERT INTO ${TABLE} (account_id, repo_id, version, entries, command_timeout_s, set_sha256, approved_by) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`, [f.accountId, r, version, JSON.stringify(entries), timeout, sha, f.o1]);
    expect(await sqlstate(() => insert([], 60, SHA_A, 1))).toBe('23514');
    expect(await sqlstate(() => insert(ENTRIES, null, SHA_A, 1))).toBe('23514');
    expect(await sqlstate(() => insert(ENTRIES, 1801, SHA_A, 1))).toBe('23514');
    expect(await sqlstate(() => insert(ENTRIES, 60, 'zz', 1))).toBe('23514');
    expect(await sqlstate(() => insert({}, 60, SHA_A, 1))).toBe('23514');
    await insert(ENTRIES, 60, SHA_A, 1);
    expect(await sqlstate(() => insert(ENTRIES, 60, SHA_A, 1))).toBe('23505');
  });

  it('app_user cannot write the table, and sees only its own tenant; so does the run writer, which reads and cannot write', async () => {
    const g = await seedF2(admin);
    const theirs = await newRepo(g.accountId);
    await write(g.o1, theirs, 'approve', ENTRIES, 900, SHA_A, g.accountId);
    const attempt = (sql: string) => sqlstate(() => withTenant(appPool, f.accountId, f.o1, (c) => c.query(sql, [])));
    expect(await attempt(`INSERT INTO ${TABLE} (account_id, repo_id, version, entries, set_sha256, approved_by) SELECT account_id, repo_id, 9, '[]', set_sha256, approved_by FROM ${TABLE} LIMIT 1`)).toBe('42501');
    expect(await attempt(`UPDATE ${TABLE} SET set_aside = true`)).toBe('42501');
    expect(await attempt(`DELETE FROM ${TABLE}`)).toBe('42501');
    const ids = async (pool: Pool, accountId: string) => (await withTenant(pool, accountId, async (c) => (await c.query<{ repo_id: string }>(`SELECT DISTINCT repo_id FROM ${TABLE}`)).rows.map((x) => x.repo_id)));
    expect(await ids(appPool, f.accountId)).not.toContain(theirs);
    expect(await ids(appPool, g.accountId)).toEqual([theirs]);
    expect(await ids(writerPool, g.accountId)).toEqual([theirs]);
    expect(await ids(writerPool, f.accountId)).not.toContain(theirs);
    expect(await sqlstate(() => withTenant(writerPool, g.accountId, (c) => c.query(`UPDATE ${TABLE} SET set_aside = true`)))).toBe('42501');
  });

  it('deleting the repo removes its rows (the cascade is the only way a row goes)', async () => {
    const r = await newRepo(f.accountId);
    await approve(f.o1, r);
    expect(await rows(r)).toHaveLength(1);
    await admin.query('DELETE FROM repos WHERE id = $1', [r]);
    expect(await rows(r)).toEqual([]);
  });
});
