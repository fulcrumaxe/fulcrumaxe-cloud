import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../src/migrate.js';
import { provisionEphemeralPostgres, type EphemeralPostgres } from './support/ephemeral-pg.js';
import { guardPoolTeardown, type PoolTeardownGuard } from './support/pool-teardown.js';

const MIGRATION = '0767_runner_plan_consent.sql';
/** The tables the new bodies read or write, and that already exist before 0767. */
const TABLES = ['agent_runs', 'runners', 'account_members', 'decision_settings', 'decision_receipts', 'audit_log', 'accounts'];

/**
 * C31 section 2.3: "platform_ops gains nothing". Migrates a throwaway cluster to everything except 0767, snapshots what platform_ops holds,
 * applies 0767 on the same database and snapshots again: the table and column grants on every table the new bodies touch, the row policies
 * that name platform_ops, the functions it owns, the roles it belongs to. The difference must be empty, platform_ops must hold nothing on the
 * new table, and neither new definer may be owned by it.
 */
describe('migration 0767 gives platform_ops nothing', () => {
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
    const q = async (sql: string, params: unknown[] = []) => (await pool.query<{ x: string }>(sql, params)).rows.map((r) => r.x);
    return {
      tableGrants: await q(
        `SELECT c.relname || ' ' || p.privilege_type AS x FROM pg_class c
           CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(privilege_type)
          WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1) AND has_table_privilege('platform_ops', c.oid, p.privilege_type) ORDER BY 1`,
        [TABLES],
      ),
      columnGrants: await q(
        `SELECT c.relname || '.' || a.attname || ' ' || p.privilege_type AS x FROM pg_class c
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
           CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) AS p(privilege_type)
          WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1) AND has_column_privilege('platform_ops', c.oid, a.attnum, p.privilege_type) ORDER BY 1`,
        [TABLES],
      ),
      policies: await q(
        `SELECT tablename || ' ' || policyname || ' ' || cmd || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '') AS x FROM pg_policies
          WHERE schemaname = 'public' AND tablename = ANY($1) AND 'platform_ops' = ANY(roles) ORDER BY 1`,
        [TABLES],
      ),
      ownedFunctions: await q(`SELECT p.oid::regprocedure::text AS x FROM pg_proc p WHERE p.proowner = 'platform_ops'::regrole ORDER BY 1`),
      memberships: await q(`SELECT pg_get_userbyid(roleid) || ' ' || admin_option::text || ' ' || coalesce(inherit_option::text, '') || ' ' || coalesce(set_option::text, '') AS x FROM pg_auth_members WHERE member = 'platform_ops'::regrole ORDER BY 1`),
    };
  }

  beforeAll(async () => {
    pg = await provisionEphemeralPostgres({ database: 'fx_0767_ops_diff_test', tmpPrefix: 'fx-0767-diff-' });
    pool = createPool(pg.url);
    guard = guardPoolTeardown(pool, 'platformOpsDiff0767Pool');
    beforeDir = mkdtempSync(path.join(tmpdir(), 'fx-0767-diff-migrations-'));
    for (const file of readdirSync(DEFAULT_MIGRATIONS_DIR).filter((name) => name.endsWith('.sql') && name !== MIGRATION && name !== '0774_runner_verified_approvals.sql' /* replaces 0767's auto-approve definer and its row policy */)) {
      copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, file), path.join(beforeDir, file));
    }
    await runMigrations(pool, beforeDir);
    before = await snapshot();
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR); // applies exactly 0767: everything else is already recorded
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
    expect(before.tableGrants.length).toBeGreaterThan(0);
    expect(before.columnGrants.length).toBeGreaterThan(20);
    expect(before.policies.length).toBeGreaterThan(0);
    expect(before.ownedFunctions.length).toBeGreaterThan(5);
  });

  it('platform_ops holds exactly what it held on every table the new bodies touch: table grants, column grants and row policies', () => {
    expect(after.tableGrants).toEqual(before.tableGrants);
    expect(after.columnGrants).toEqual(before.columnGrants);
    expect(after.policies).toEqual(before.policies);
  });

  it('platform_ops joins no role and owns no new function, and neither definer role is owned by or granted to it', async () => {
    expect(after.ownedFunctions).toEqual(before.ownedFunctions);
    expect(after.memberships).toEqual(before.memberships);
    const members = await pool.query(`SELECT 1 FROM pg_auth_members WHERE member = 'platform_ops'::regrole AND roleid = ANY (ARRAY['runner_consent_definer', 'runner_auto_approve_definer']::regrole[])`);
    expect(members.rowCount).toBe(0);
  });

  it('platform_ops holds no privilege at all on the new table and no policy names it', async () => {
    const privileges = await pool.query(`SELECT p FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p WHERE has_table_privilege('platform_ops', 'runner_plan_consents', p)`);
    expect(privileges.rowCount).toBe(0);
    const columns = await pool.query(`SELECT 1 FROM pg_attribute WHERE attrelid = 'runner_plan_consents'::regclass AND attnum > 0 AND (has_column_privilege('platform_ops', attrelid, attnum, 'SELECT') OR has_column_privilege('platform_ops', attrelid, attnum, 'INSERT') OR has_column_privilege('platform_ops', attrelid, attnum, 'UPDATE'))`);
    expect(columns.rowCount).toBe(0);
    const policies = await pool.query(`SELECT 1 FROM pg_policies WHERE tablename = 'runner_plan_consents' AND 'platform_ops' = ANY(roles)`);
    expect(policies.rowCount).toBe(0);
  });

  it('the migration file never grants, revokes or transfers anything to or from platform_ops', () => {
    const sql = readFileSync(path.join(DEFAULT_MIGRATIONS_DIR, MIGRATION), 'utf8')
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    const mentions = sql
      .split(';')
      .map((statement) => statement.trim().replace(/\s+/g, ' '))
      .filter((statement) => /\b(GRANT|REVOKE|OWNER\s+TO)\b/i.test(statement) && /\bplatform_ops\b/i.test(statement));
    expect(mentions).toEqual([]);
  });
});
