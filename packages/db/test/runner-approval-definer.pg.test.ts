import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../src/migrate.js';
import { seedF2, type F2Fixture } from './helpers/members.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { seedAccount } from './helpers/seed.js';
import { provisionEphemeralPostgres, type EphemeralPostgres } from './support/ephemeral-pg.js';
import { guardPoolTeardown, type PoolTeardownGuard } from './support/pool-teardown.js';

const MIGRATION = '0757_runner_limits_and_approval.sql';
const ROLE = 'runner_approval_definer';

/** The two definers 0757 hands to the role, each callable by the web tier's login alone. */
const DEFINERS = ['agent_run_approve(uuid)', 'repo_execution_mode_audit(uuid,text,text,boolean)'];

/** Everything the role holds, exactly (C21 section 11: column grants only on what the bodies read and write). */
const EXPECTED_PRIVILEGES = [
  ...['id', 'account_id', 'status', 'runtime', 'execution_mode', 'approved_by'].map((c) => `column agent_runs.${c} SELECT`),
  'column agent_runs.approved_by UPDATE',
  'column agent_runs.updated_at UPDATE',
  ...['id', 'account_id', 'registered_by', 'credential_mode', 'revoked_at'].map((c) => `column runners.${c} SELECT`),
  ...['account_id', 'user_id', 'role'].map((c) => `column account_members.${c} SELECT`),
  'column repos.id SELECT',
  'column repos.account_id SELECT',
  ...['account_id', 'actor', 'action', 'payload', 'created_at'].map((c) => `column audit_log.${c} INSERT`),
  'column accounts.id SELECT',
  'column accounts.deleted_at SELECT',
  'schema public USAGE',
].sort();

describe(`migration 0757: ${ROLE} and its row policies (D#6 R2b-3 part ii, C21 section 11)`, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let f: F2Fixture;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    f = await seedF2(admin);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
  });

  describe('the role', () => {
    it('is NOLOGIN and unprivileged, has no member and is a member of nothing, and owns exactly its two functions', async () => {
      const { rows } = await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1`, [ROLE]);
      expect(rows[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
      expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE roleid = $1::regrole`, [ROLE])).rowCount, 'members').toBe(0);
      expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE member = $1::regrole`, [ROLE])).rowCount, 'member of').toBe(0);
      const owned = await admin.query<{ sig: string }>(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proowner = $1::regrole`, [ROLE]);
      expect(owned.rows.map((r) => r.sig).sort()).toEqual([...DEFINERS].sort());
      const objects = await admin.query(`SELECT 1 FROM pg_class WHERE relowner = $1::regrole UNION ALL SELECT 1 FROM pg_namespace WHERE nspowner = $1::regrole`, [ROLE]);
      expect(objects.rowCount, 'other objects').toBe(0);
      expect((await admin.query(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS ok`, [ROLE])).rows[0].ok).toBe(false);
    });

    it('holds exactly the column grants its bodies need, and nothing table-wide', async () => {
      const { rows } = await admin.query<{ x: string }>(
        `WITH r AS (SELECT oid FROM pg_roles WHERE rolname = $1)
         SELECT 'table ' || c.relname || ' ' || a.privilege_type AS x FROM pg_class c, aclexplode(c.relacl) a, r WHERE a.grantee = r.oid AND c.relnamespace = 'public'::regnamespace
         UNION ALL SELECT 'column ' || c.relname || '.' || t.attname || ' ' || a.privilege_type
           FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a, r WHERE a.grantee = r.oid AND c.relnamespace = 'public'::regnamespace
         UNION ALL SELECT 'schema ' || n.nspname || ' ' || a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a, r WHERE a.grantee = r.oid AND n.nspname = 'public'`,
        [ROLE],
      );
      expect(rows.map((r) => r.x).sort()).toEqual(EXPECTED_PRIVILEGES);
    });

    it('has a row policy of its own on each row-secured table it touches, and only those, each for this role alone', async () => {
      const { rows } = await admin.query<{ tablename: string; cmd: string; roles: string[] }>(
        `SELECT tablename, cmd, roles::text[] AS roles FROM pg_policies WHERE schemaname = 'public' AND $1 = ANY(roles) ORDER BY tablename, cmd`,
        [ROLE],
      );
      expect(rows.map((r) => `${r.tablename} ${r.cmd}`)).toEqual(['account_members SELECT', 'accounts SELECT', 'agent_runs SELECT', 'agent_runs UPDATE', 'audit_log INSERT', 'repos SELECT', 'runners SELECT']);
      for (const r of rows) expect(r.roles).toEqual([ROLE]);
    });
  });

  describe('the definers', () => {
    it('are SECURITY DEFINER with a pinned search_path, owned by the role, and EXECUTE for app_user alone (no PUBLIC, no platform_ops, no grant option)', async () => {
      for (const sig of DEFINERS) {
        const { rows } = await admin.query<{ prosecdef: boolean; proconfig: string[] | null; owner: string; grantees: string[]; grantable: boolean }>(
          `SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
                  coalesce((SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END)
                              FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner), '{}') AS grantees,
                  coalesce((SELECT bool_or(a.is_grantable) FROM aclexplode(p.proacl) a), false) AS grantable
             FROM pg_proc p WHERE p.oid = $1::regprocedure`,
          [sig],
        );
        expect(rows[0].prosecdef, sig).toBe(true);
        expect(rows[0].owner, sig).toBe(ROLE);
        expect(rows[0].proconfig, sig).toEqual(['search_path=pg_catalog, public, pg_temp']);
        expect(rows[0].grantees, sig).toEqual(['app_user']);
        expect(rows[0].grantable, sig).toBe(false);
        for (const who of ['platform_ops', 'partner_user', 'agent_run_writer']) {
          expect((await admin.query(`SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok`, [who, sig])).rows[0].ok, `${who} ${sig}`).toBe(false);
        }
      }
    });
  });

  /** What the role can reach, tried as the role itself under a tenant context (the superuser session may SET ROLE to it). */
  describe('the row policies hold the role to the caller\'s tenant and to the one kind of row it may approve', () => {
    async function asRole<T>(userId: string | null, body: () => Promise<T>, accountId: string = f.accountId): Promise<T> {
      await admin.query('BEGIN');
      try {
        await admin.query(`SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)`, [accountId, userId ?? '']);
        await admin.query(`SET LOCAL ROLE ${ROLE}`);
        return await body();
      } finally {
        await admin.query('ROLLBACK');
      }
    }
    const newRun = async (status = 'pending', mode = 'runner_local', runtime = 'runner'): Promise<string> => {
      const id = randomUUID();
      await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode) VALUES ($1, $2, 'executor', $3, $4, $5)`, [id, f.accountId, runtime, status, mode]);
      return id;
    };

    it('shows only the caller\'s own membership row, and none with no user in context', async () => {
      const own = await asRole(f.a1, async () => (await admin.query<{ user_id: string }>('SELECT user_id FROM account_members')).rows.map((r) => r.user_id));
      expect(own).toEqual([f.a1]);
      expect(await asRole(null, async () => (await admin.query('SELECT 1 FROM account_members')).rowCount)).toBe(0);
    });

    it('shows its own account\'s runs and runners and nothing of another account\'s (runs, runners, repos)', async () => {
      const mine = await newRun();
      await insertRunner(admin, f.accountId, f.a1);
      const other = await seedAccount(admin, randomUUID());
      const theirRunner = await insertRunner(admin, other.accountId, other.userId);
      const theirRun = randomUUID();
      await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode) VALUES ($1, $2, 'executor', 'runner', 'pending', 'runner_local')`, [theirRun, other.accountId]);
      const ids = (table: string) => asRole(f.a1, async () => (await admin.query<{ id: string }>(`SELECT id FROM ${table}`)).rows.map((r) => r.id));
      expect(await ids('agent_runs')).toContain(mine);
      expect(await ids('agent_runs')).not.toContain(theirRun);
      expect((await ids('runners')).length).toBeGreaterThan(0);
      expect(await ids('runners')).not.toContain(theirRunner);
      expect(await ids('repos')).not.toContain(other.repoId);
      // the other account's repo is visible from the other account's own context, so the empty answer above is the policy's
      const own = await asRole(other.userId, async () => (await admin.query<{ id: string }>('SELECT id FROM repos')).rows.map((r) => r.id), other.accountId);
      expect(own).toContain(other.repoId);
    });

    it('may write approved_by on a pending runner_local runner run, and on no other kind of run', async () => {
      const ok = await newRun();
      expect(await asRole(f.a1, async () => (await admin.query('UPDATE agent_runs SET approved_by = $2 WHERE id = $1', [ok, f.a1])).rowCount)).toBe(1);
      for (const [status, mode, runtime] of [['running', 'runner_local', 'runner'], ['succeeded', 'runner_local', 'runner'], ['pending', 'sandbox', 'runner']] as const) {
        const id = await newRun(status, mode, runtime);
        expect(await asRole(f.a1, async () => (await admin.query('UPDATE agent_runs SET approved_by = $2 WHERE id = $1', [id, f.a1])).rowCount), `${status}/${mode}/${runtime}`).toBe(0);
      }
    });

    it('may write no column of agent_runs but approved_by and updated_at, and cannot delete or insert a run', async () => {
      const id = await newRun();
      for (const sql of ["UPDATE agent_runs SET status = 'failed' WHERE id = $1", "UPDATE agent_runs SET runner_id = NULL, lease_generation = 9 WHERE id = $1", 'DELETE FROM agent_runs WHERE id = $1']) {
        await expect(asRole(f.a1, async () => admin.query(sql, [id])), sql).rejects.toMatchObject({ code: '42501' });
      }
      await expect(asRole(f.a1, async () => admin.query(`INSERT INTO agent_runs (account_id, role, runtime) VALUES ($1, 'executor', 'runner')`, [f.accountId]))).rejects.toMatchObject({ code: '42501' });
    });

    it('may insert an audit row of its two actions for the caller\'s account, and no other row', async () => {
      const insert = (account: string, action: string) => admin.query(`INSERT INTO audit_log (account_id, actor, action, payload, created_at) VALUES ($1, 'x', $2, '{}'::jsonb, now())`, [account, action]);
      await asRole(f.a1, async () => insert(f.accountId, 'runner.run_approved'));
      await asRole(f.a1, async () => insert(f.accountId, 'repo.execution_mode.changed'));
      await expect(asRole(f.a1, async () => insert(f.accountId, 'account.deleted'))).rejects.toMatchObject({ code: '42501' });
      await expect(asRole(f.a1, async () => insert(randomUUID(), 'runner.run_approved'))).rejects.toMatchObject({ code: '42501' });
    });
  });
});

/**
 * C21 section 11: "A test diffs platform_ops's privileges on agent_runs and runners against main, and requires the difference
 * to be empty." This migrates a throwaway cluster to everything EXCEPT 0757, snapshots what platform_ops holds, applies 0757 on
 * the same database and snapshots again. The snapshot is the table grants, every column grant of every kind (read off the
 * catalog the way Postgres evaluates them), the row policies that name platform_ops, the functions it owns and the roles it
 * belongs to. The one difference allowed is runner_register: an existing platform_ops definer that 0757 replaces with a
 * four-argument version (the old three-argument one is dropped), so it owns one function before and one after.
 */
describe('migration 0757 gives platform_ops nothing', () => {
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
    approvalDefinersOwnedByPlatformOps: string[];
  }

  async function snapshot(): Promise<Snapshot> {
    const q = async (sql: string) => (await pool.query<{ x: string }>(sql)).rows.map((r) => r.x);
    return {
      tableGrants: await q(`
        SELECT c.relname || ' ' || p.privilege_type AS x FROM pg_class c
          CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(privilege_type)
         WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('agent_runs', 'runners') AND has_table_privilege('platform_ops', c.oid, p.privilege_type)
         ORDER BY 1`),
      columnGrants: await q(`
        SELECT c.relname || '.' || a.attname || ' ' || p.privilege_type AS x FROM pg_class c
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
          CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) AS p(privilege_type)
         WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('agent_runs', 'runners') AND has_column_privilege('platform_ops', c.oid, a.attnum, p.privilege_type)
         ORDER BY 1`),
      policies: await q(`
        SELECT tablename || ' ' || policyname || ' ' || cmd || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '') AS x FROM pg_policies
         WHERE schemaname = 'public' AND tablename IN ('agent_runs', 'runners') AND 'platform_ops' = ANY(roles) ORDER BY 1`),
      ownedFunctions: await q(`SELECT p.oid::regprocedure::text AS x FROM pg_proc p WHERE p.proowner = 'platform_ops'::regrole ORDER BY 1`),
      memberships: await q(`SELECT pg_get_userbyid(roleid) || ' ' || admin_option::text || ' ' || coalesce(inherit_option::text, '') || ' ' || coalesce(set_option::text, '') AS x FROM pg_auth_members WHERE member = 'platform_ops'::regrole ORDER BY 1`),
      approvalDefinersOwnedByPlatformOps: await q(`SELECT p.proname AS x FROM pg_proc p WHERE p.proowner = 'platform_ops'::regrole AND p.proname IN ('agent_run_approve', 'repo_execution_mode_audit') ORDER BY 1`),
    };
  }

  beforeAll(async () => {
    pg = await provisionEphemeralPostgres({ database: 'fx_0757_ops_diff_test', tmpPrefix: 'fx-0757-diff-' });
    pool = createPool(pg.url);
    guard = guardPoolTeardown(pool, 'platformOpsDiff0757Pool');
    beforeDir = mkdtempSync(path.join(tmpdir(), 'fx-0757-diff-migrations-'));
    for (const file of readdirSync(DEFAULT_MIGRATIONS_DIR).filter((name) => name.endsWith('.sql') && name !== MIGRATION && name !== '0771_runner_verified_repo_mode.sql' /* replaces 0757's notice lister */)) {
      copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, file), path.join(beforeDir, file));
    }
    await runMigrations(pool, beforeDir);
    before = await snapshot();
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR); // applies exactly 0757: everything else is already recorded
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

  it('platform_ops holds exactly what it held on agent_runs and runners: table grants, column grants and row policies', () => {
    expect(after.tableGrants).toEqual(before.tableGrants);
    expect(after.columnGrants).toEqual(before.columnGrants);
    expect(after.policies).toEqual(before.policies);
    // The old 0757 granted it SELECT and UPDATE on approved_by; it must not hold either now.
    expect(after.columnGrants.filter((g) => g.includes('approved_by') && g.endsWith('UPDATE'))).toEqual([]);
  });

  it('platform_ops joins no role and owns no function but the replaced runner_register, and neither approval definer is owned by it', () => {
    const swap = (list: string[]) => list.map((sig) => sig.replace(/^runner_register\(.*\)$/, 'runner_register(...)'));
    expect(swap(after.ownedFunctions)).toEqual(swap(before.ownedFunctions));
    expect(after.ownedFunctions.filter((sig) => sig.startsWith('runner_register('))).toEqual(['runner_register(text,jsonb,text,integer)']);
    expect(after.memberships).toEqual(before.memberships);
    expect(after.approvalDefinersOwnedByPlatformOps).toEqual([]);
  });

  it('migration 0757 gives platform_ops a privilege in exactly one way: the temporary CREATE on the schema, taken back in the same file (and the role brackets)', () => {
    const sql = readFileSync(path.join(DEFAULT_MIGRATIONS_DIR, MIGRATION), 'utf8')
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    const mentions = sql
      .split(';')
      .map((statement) => statement.trim().replace(/\s+/g, ' '))
      .filter((statement) => /\b(GRANT|REVOKE|OWNER\s+TO)\b/i.test(statement) && /\bplatform_ops\b/i.test(statement));
    // The two bracket statements hand the ROLE platform_ops to the migration role for the file and reset it; they give platform_ops nothing.
    expect(mentions).toEqual([
      'DO $$ BEGIN IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE',
      'GRANT CREATE ON SCHEMA public TO platform_ops',
      'ALTER FUNCTION runner_register(text, jsonb, text, integer) OWNER TO platform_ops',
      'REVOKE CREATE ON SCHEMA public FROM platform_ops',
      'GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE',
    ]);
  });
});
