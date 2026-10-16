import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../src/migrate.js';
import { seedAccount } from './helpers/seed.js';
import { provisionEphemeralPostgres, type EphemeralPostgres } from './support/ephemeral-pg.js';
import { guardPoolTeardown, type PoolTeardownGuard } from './support/pool-teardown.js';

const MIGRATION = '0795_repo_verified_consent.sql';
const HASH = 'a'.repeat(64);

describe(`migration 0795: repos.verified_copy_sha256 (D#599 PL-2)`, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let accountId: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    accountId = randomUUID();
    await seedAccount(admin, accountId);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
  });

  async function repo(mode: string, hash: string | null): Promise<string> {
    const id = randomUUID();
    await admin.query('INSERT INTO repos (id, account_id, gh_repo_id, product, execution_mode, verified_copy_sha256) VALUES ($1, $2, $3, $4, $5, $6)', [id, accountId, Math.floor(Math.random() * 1e12), 'team', mode, hash]);
    return id;
  }

  it('holds a SHA-256 only while the repo is runner_verified: any other mode, a short value and an upper-case value are refused by the CHECK', async () => {
    await expect(repo('runner_verified', HASH)).resolves.toBeTruthy();
    await expect(repo('runner_verified', null)).resolves.toBeTruthy();
    for (const [mode, hash] of [['sandbox', HASH], ['runner_local', HASH], ['runner_verified', 'abc'], ['runner_verified', HASH.toUpperCase()], ['runner_verified', `${HASH}0`], ['runner_verified', '']] as const) {
      await expect(repo(mode, hash), `${mode}/${hash.slice(0, 6)}`).rejects.toThrow(/repos_verified_copy_sha256_check/);
    }
    await expect(repo('sandbox', null)).resolves.toBeTruthy();
  });

  it('a repo cannot leave runner_verified and keep the consent: the same UPDATE has to clear it', async () => {
    const id = await repo('runner_verified', HASH);
    await expect(admin.query("UPDATE repos SET execution_mode = 'runner_local' WHERE id = $1", [id])).rejects.toThrow(/repos_verified_copy_sha256_check/);
    await admin.query("UPDATE repos SET execution_mode = 'runner_local', verified_copy_sha256 = NULL WHERE id = $1", [id]);
  });

  it('app_user reads and writes it through its table-wide grants; platform_ops and the public hold nothing on the column', async () => {
    const q = async (sql: string) => (await admin.query<{ ok: boolean }>(sql)).rows[0]!.ok;
    for (const priv of ['SELECT', 'UPDATE']) expect(await q(`SELECT has_column_privilege('app_user', 'public.repos', 'verified_copy_sha256', '${priv}') AS ok`), priv).toBe(true);
    for (const priv of ['SELECT', 'UPDATE', 'INSERT']) expect(await q(`SELECT has_column_privilege('platform_ops', 'public.repos', 'verified_copy_sha256', '${priv}') AS ok`), priv).toBe(false);
    expect(await q(`SELECT NOT EXISTS (SELECT 1 FROM pg_attribute t, aclexplode(t.attacl) a WHERE t.attrelid = 'public.repos'::regclass AND t.attname = 'verified_copy_sha256' AND a.grantee = 0) AS ok`)).toBe(true);
  });
});

/**
 * C21 section 11 for this file too: platform_ops gains nothing. This migrates a throwaway cluster to everything EXCEPT 0795, snapshots what
 * platform_ops holds on the tables the file touches, applies 0795 on the same database and snapshots again. The two must be equal.
 */
describe('migration 0795 gives platform_ops nothing', () => {
  let pg: EphemeralPostgres;
  let pool: Pool;
  let guard: PoolTeardownGuard | undefined;
  let beforeDir: string;
  let before: Snapshot;
  let after: Snapshot;

  interface Snapshot {
    tableGrants: string[];
    columnGrants: string[];
    policies: string[];
    ownedFunctions: string[];
    memberships: string[];
  }

  async function snapshot(): Promise<Snapshot> {
    const q = async (sql: string) => (await pool.query<{ x: string }>(sql)).rows.map((r) => r.x);
    return {
      tableGrants: await q(`
        SELECT c.relname || ' ' || p.privilege_type AS x FROM pg_class c
          CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(privilege_type)
         WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'repos' AND has_table_privilege('platform_ops', c.oid, p.privilege_type)
         ORDER BY 1`),
      columnGrants: await q(`
        SELECT a.attname || ' ' || p.privilege_type AS x FROM pg_class c
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
          CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) AS p(privilege_type)
         WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'repos' AND a.attname <> 'verified_copy_sha256' AND has_column_privilege('platform_ops', c.oid, a.attnum, p.privilege_type)
         ORDER BY 1`),
      policies: await q(`SELECT policyname || ' ' || cmd || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '') AS x FROM pg_policies WHERE schemaname = 'public' AND tablename = 'repos' AND 'platform_ops' = ANY(roles) ORDER BY 1`),
      // 0844 (S5-f) re-creates reject_proposal with two more parameters and adds resurface_proposals, both platform_ops-owned like the other
      // proposal definers. Those two exact signatures are the only difference allowed (reject_proposal compared by name, resurface_proposals
      // left out); any other change to what platform_ops owns still fails this test.
      ownedFunctions: await q(`SELECT CASE WHEN p.proname = 'reject_proposal' THEN 'reject_proposal(...)' ELSE p.oid::regprocedure::text END AS x FROM pg_proc p
         WHERE p.proowner = 'platform_ops'::regrole AND p.oid::regprocedure::text <> 'resurface_proposals(uuid,uuid)' ORDER BY 1`),
      memberships: await q(`SELECT pg_get_userbyid(roleid) || ' ' || admin_option::text AS x FROM pg_auth_members WHERE member = 'platform_ops'::regrole ORDER BY 1`),
    };
  }

  beforeAll(async () => {
    pg = await provisionEphemeralPostgres({ database: 'fx_0795_ops_diff_test', tmpPrefix: 'fx-0795-diff-' });
    pool = createPool(pg.url);
    guard = guardPoolTeardown(pool, 'platformOpsDiff0795Pool');
    beforeDir = mkdtempSync(path.join(tmpdir(), 'fx-0795-diff-migrations-'));
    for (const file of readdirSync(DEFAULT_MIGRATIONS_DIR).filter((name) => name.endsWith('.sql') && name < MIGRATION)) {
      copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, file), path.join(beforeDir, file));
    }
    await runMigrations(pool, beforeDir);
    before = await snapshot();
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR);
    after = await snapshot();
  }, 120_000);

  afterAll(async () => {
    try {
      guard?.assertNoCheckedOutClients();
      await guard?.endAndWaitForSockets();
    } finally {
      pg?.cleanup();
      if (beforeDir) rmSync(beforeDir, { recursive: true, force: true });
    }
  });

  it('the snapshot is not empty, so an empty difference means something', () => {
    expect(before.columnGrants.length).toBeGreaterThan(0);
    expect(before.ownedFunctions.length).toBeGreaterThan(5);
  });

  it('platform_ops holds exactly what it held on repos, owns the same functions and has the same memberships, and has no privilege on the new column', async () => {
    expect(after).toEqual(before);
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
      expect((await pool.query<{ ok: boolean }>(`SELECT has_column_privilege('platform_ops', 'public.repos', 'verified_copy_sha256', '${priv}') AS ok`)).rows[0]!.ok, priv).toBe(false);
    }
  });

  it('the file grants and revokes nothing at all (no grant to add: app_user already holds the table-wide ones)', () => {
    const sql = readFileSync(path.join(DEFAULT_MIGRATIONS_DIR, MIGRATION), 'utf8')
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    expect(sql).not.toMatch(/\b(GRANT|REVOKE|OWNER\s+TO|CREATE\s+ROLE|SECURITY\s+DEFINER)\b/i);
  });
});
