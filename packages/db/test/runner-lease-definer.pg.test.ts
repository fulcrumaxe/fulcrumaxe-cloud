import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../src/migrate.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { provisionEphemeralPostgres, type EphemeralPostgres } from './support/ephemeral-pg.js';
import { guardPoolTeardown, type PoolTeardownGuard } from './support/pool-teardown.js';

const MIGRATION = '0754_runner_leases.sql';
const ROLE = 'runner_lease_definer';

/** The six definers 0754 hands to the role, with the logins that may run each. */
const DEFINERS: Record<string, string[]> = {
  'agent_run_runner_claim(uuid,uuid,uuid,timestamp with time zone,integer)': ['agent_run_writer'],
  'agent_run_runner_lease(uuid,uuid,uuid,integer,timestamp with time zone,integer,bigint)': ['agent_run_writer'],
  'agent_run_list_running_runner_runs(integer,bigint)': ['agent_run_writer'],
  'agent_run_list_jobless_runner_runs(integer)': ['agent_run_writer'],
  'runner_follow_up_run(uuid)': ['agent_run_writer'],
  'runner_claim_throttle(integer)': ['app_user'],
};

/** Everything the role holds, exactly (C21 section 11: column grants only on what the bodies read and write). */
const EXPECTED_PRIVILEGES = [
  ...['id', 'account_id', 'work_item_id', 'parent_run_id', 'role', 'runtime', 'status', 'head_sha', 'execution_mode', 'dispatch_repo_id', 'dispatch_pr_number', 'spec_version_id', 'resolved_exposure', 'exposure_digest', 'initiated_by', 'approved_by', 'runner_id', 'lease_generation', 'lease_expires_at', 'claimable_after', 'started_at', 'created_at', 'job_signed'].map((c) => `column agent_runs.${c} SELECT`),
  ...['runner_id', 'lease_generation', 'lease_expires_at', 'updated_at', 'claimable_after', 'approved_by'].map((c) => `column agent_runs.${c} UPDATE`),
  'column runners.id SELECT', 'column runners.account_id SELECT', 'column runners.revoked_at SELECT', 'column runners.last_seen_at UPDATE',
  'column runner_claim_stamps.runner_id SELECT', 'column runner_claim_stamps.account_id SELECT', 'column runner_claim_stamps.last_claim_at SELECT',
  'column runner_claim_stamps.runner_id INSERT', 'column runner_claim_stamps.account_id INSERT', 'column runner_claim_stamps.last_claim_at INSERT',
  'column runner_claim_stamps.last_claim_at UPDATE',
  ...['account_id', 'run_id', 'seq', 'kind', 'payload'].map((c) => `column run_events.${c} SELECT`),
  'column accounts.id SELECT', 'column accounts.deleted_at SELECT',
  'schema public USAGE',
].sort();

describe(`migration 0754: ${ROLE}, the lease guard and the row policies (D#6 R2b-3, C21 sections 4 and 11)`, () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let refs: SeedRefs;
  let runner: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    refs = await seedAccount(admin, randomUUID());
    runner = await insertRunner(admin, refs.accountId, refs.userId);
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
  });

  async function newRun(o: { runnerId?: string | null; generation?: number; lease?: string | null; status?: string } = {}): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, runner_id, lease_generation, lease_expires_at)
       VALUES ($1, $2, 'executor', 'runner', $3, 'runner_local', $4, $5, $6)`,
      [id, refs.accountId, o.status ?? 'pending', o.runnerId ?? null, o.generation ?? 0, o.lease ?? null],
    );
    return id;
  }

  describe('the role', () => {
    it('is NOLOGIN and unprivileged, has no member and is a member of nothing, and owns exactly its six functions', async () => {
      const { rows } = await admin.query(
        `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit FROM pg_roles WHERE rolname = $1`,
        [ROLE],
      );
      expect(rows[0]).toMatchObject({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
      const members = await admin.query(`SELECT 1 FROM pg_auth_members WHERE roleid = $1::regrole`, [ROLE]);
      expect(members.rowCount, 'members').toBe(0);
      const memberOf = await admin.query(`SELECT 1 FROM pg_auth_members WHERE member = $1::regrole`, [ROLE]);
      expect(memberOf.rowCount, 'member of').toBe(0);
      const owned = await admin.query<{ sig: string }>(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proowner = $1::regrole ORDER BY 1`, [ROLE]);
      expect(owned.rows.map((r) => r.sig).sort()).toEqual(Object.keys(DEFINERS).sort());
      const objects = await admin.query(`SELECT 1 FROM pg_class WHERE relowner = $1::regrole UNION ALL SELECT 1 FROM pg_namespace WHERE nspowner = $1::regrole UNION ALL SELECT 1 FROM pg_type WHERE typowner = $1::regrole AND typtype <> 'c' AND typcategory <> 'A'`, [ROLE]);
      expect(objects.rowCount, 'other objects').toBe(0);
      const create = await admin.query(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS ok`, [ROLE]);
      expect(create.rows[0].ok).toBe(false);
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

    it('has a row policy of its own on each row-secured table it touches, and only those', async () => {
      const { rows } = await admin.query<{ tablename: string; cmd: string }>(
        `SELECT tablename, cmd FROM pg_policies WHERE schemaname = 'public' AND $1 = ANY(roles) ORDER BY tablename, cmd`,
        [ROLE],
      );
      expect(rows.map((r) => `${r.tablename} ${r.cmd}`)).toEqual([
        'accounts SELECT',
        'agent_runs SELECT',
        'agent_runs UPDATE',
        'run_events SELECT',
        'runner_claim_stamps INSERT',
        'runner_claim_stamps SELECT',
        'runner_claim_stamps UPDATE',
        'runners SELECT',
        'runners UPDATE',
      ]);
      const policies = await admin.query<{ roles: string[] }>(`SELECT roles::text[] AS roles FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE 'runner_lease_definer%'`);
      for (const p of policies.rows) expect(p.roles).toEqual([ROLE]);
    });

    it('the new table is row-secured and forced, and no web-tier role can touch it', async () => {
      const { rows } = await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'runner_claim_stamps'::regclass`);
      expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      for (const who of ['app_user', 'platform_ops', 'partner_user', 'agent_run_writer']) {
        const { rows: priv } = await admin.query(`SELECT has_any_column_privilege($1, 'runner_claim_stamps', 'SELECT, INSERT, UPDATE, REFERENCES') AS ok`, [who]);
        expect(priv[0].ok, who).toBe(false);
      }
    });
  });

  describe('the definers', () => {
    it('are SECURITY DEFINER with a pinned search_path, and EXECUTE only for the login that calls each (no PUBLIC, no grant option)', async () => {
      for (const [sig, logins] of Object.entries(DEFINERS)) {
        const { rows } = await admin.query<{ prosecdef: boolean; proconfig: string[] | null; proacl: string[] | null; grantees: string[]; grantable: boolean }>(
          `SELECT p.prosecdef, p.proconfig, p.proacl::text[] AS proacl,
                  coalesce((SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END)
                              FROM aclexplode(p.proacl) a WHERE a.grantee <> p.proowner), '{}') AS grantees,
                  coalesce((SELECT bool_or(a.is_grantable) FROM aclexplode(p.proacl) a), false) AS grantable
             FROM pg_proc p WHERE p.oid = $1::regprocedure`,
          [sig],
        );
        expect(rows[0].prosecdef, sig).toBe(true);
        expect(rows[0].proconfig, sig).toEqual(['search_path=pg_catalog, public, pg_temp']);
        expect([...rows[0].grantees].sort(), sig).toEqual([...logins].sort());
        expect(rows[0].grantable, sig).toBe(false);
        for (const who of ['platform_ops', 'partner_user', 'app_user', 'agent_run_writer'].filter((w) => !logins.includes(w))) {
          const { rows: ok } = await admin.query(`SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok`, [who, sig]);
          expect(ok[0].ok, `${who} ${sig}`).toBe(false);
        }
      }
    });

    it('none is owned by platform_ops', async () => {
      const { rows } = await admin.query<{ proowner: string }>(`SELECT pg_get_userbyid(proowner) AS proowner FROM pg_proc WHERE oid = ANY($1::regprocedure[])`, [Object.keys(DEFINERS)]);
      expect(rows).toHaveLength(Object.keys(DEFINERS).length);
      for (const r of rows) expect(r.proowner).toBe(ROLE);
    });
  });

  describe('the lease guard', () => {
    const probe = 'lease_guard_probe';

    beforeAll(async () => {
      // A role that gets past the column grants and the row policies, so the TRIGGER is what is under test.
      await admin.query(`DROP ROLE IF EXISTS ${probe}`);
      await admin.query(`CREATE ROLE ${probe} NOLOGIN NOSUPERUSER BYPASSRLS`);
      await admin.query(`GRANT USAGE ON SCHEMA public TO ${probe}`);
      await admin.query(`GRANT SELECT, INSERT, UPDATE ON agent_runs TO ${probe}`);
      await admin.query(`GRANT SELECT ON runners, repos, work_items, accounts TO ${probe}`);
      // 0750's insert trigger calls this helper as the inserting role.
      await admin.query(`GRANT EXECUTE ON FUNCTION work_item_halt_lock(uuid, uuid) TO ${probe}`);
    });
    afterAll(async () => {
      await admin.query(`REVOKE EXECUTE ON FUNCTION work_item_halt_lock(uuid, uuid) FROM ${probe}`);
      await admin.query(`REVOKE ALL ON agent_runs, runners, repos, work_items, accounts FROM ${probe}`);
      await admin.query(`REVOKE USAGE ON SCHEMA public FROM ${probe}`);
      await admin.query(`DROP ROLE ${probe}`);
    });

    /** Runs `sql` as the probe inside a transaction that is always rolled back. */
    async function asProbe(sql: string, params: unknown[] = []): Promise<void> {
      await admin.query('BEGIN');
      try {
        await admin.query(`SET LOCAL ROLE ${probe}`);
        await admin.query(sql, params);
      } finally {
        await admin.query('ROLLBACK');
      }
    }

    it.each([
      ['runner_id', 'UPDATE agent_runs SET runner_id = $2 WHERE id = $1'],
      ['lease_expires_at', "UPDATE agent_runs SET lease_expires_at = now() + interval '1 day' WHERE id = $1"],
      ['claimable_after', "UPDATE agent_runs SET claimable_after = now() + interval '1 day' WHERE id = $1"],
      ['lease_generation', 'UPDATE agent_runs SET lease_generation = lease_generation + 1 WHERE id = $1'],
    ])('refuses a role that is neither the definer nor a superuser an update of %s', async (_column, sql) => {
      const id = await newRun();
      await expect(asProbe(sql, [id, runner].slice(0, sql.includes('$2') ? 2 : 1))).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/written only by the runner lease definers/) });
    });

    it('refuses such a role an insert that sets any of the four columns, and lets an ordinary insert through', async () => {
      const columns = [['claimable_after', "now() + interval '1 hour'"], ['lease_expires_at', "now() + interval '1 hour'"], ['lease_generation', '3'], ['runner_id', `'${runner}'`]];
      for (const [column, value] of columns) {
        await expect(
          asProbe(`INSERT INTO agent_runs (account_id, role, runtime, status, execution_mode, ${column}) VALUES ($1, 'executor', 'runner', 'pending', 'runner_local', ${value})`, [refs.accountId]),
          column,
        ).rejects.toMatchObject({ code: '42501' });
      }
      await asProbe(`INSERT INTO agent_runs (account_id, role, runtime, status, execution_mode) VALUES ($1, 'executor', 'runner', 'pending', 'runner_local')`, [refs.accountId]);
    });

    it('lets the definer role write the columns (the definers run as it), and a superuser session too', async () => {
      const id = await newRun({ status: 'running' });
      await admin.query('BEGIN');
      try {
        await admin.query(`SELECT set_config('app.account_id', $1, true)`, [refs.accountId]);
        await admin.query(`SET LOCAL ROLE ${ROLE}`);
        const { rowCount } = await admin.query(`UPDATE agent_runs SET runner_id = $2, lease_generation = 1, lease_expires_at = now() + interval '90 seconds' WHERE id = $1 AND account_id = $3`, [id, runner, refs.accountId]);
        expect(rowCount).toBe(1);
      } finally {
        await admin.query('ROLLBACK');
      }
      await admin.query(`UPDATE agent_runs SET claimable_after = now() WHERE id = $1`, [id]);
    });

    it('lets the foreign-key action that clears runner_id through for a role that is not a superuser, and nothing else nested', async () => {
      // The action runs as the table owner, which on the Neon shape is not a superuser. A trigger on a scratch table makes the
      // same nested UPDATE (trigger depth 2) from a function owned by the probe.
      const id = await newRun({ status: 'running', runnerId: runner, generation: 1, lease: new Date(Date.now() + 90_000).toISOString() });
      await admin.query(`CREATE TABLE IF NOT EXISTS lease_guard_scratch (id uuid PRIMARY KEY, mode text)`);
      await admin.query(`
        CREATE OR REPLACE FUNCTION lease_guard_scratch_fn() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
        BEGIN
          IF NEW.mode = 'clear' THEN UPDATE public.agent_runs SET runner_id = NULL WHERE id = NEW.id;
          ELSIF NEW.mode = 'lease' THEN UPDATE public.agent_runs SET runner_id = NULL, lease_expires_at = now() WHERE id = NEW.id;
          ELSIF NEW.mode = 'claimable' THEN UPDATE public.agent_runs SET runner_id = NULL, claimable_after = now() WHERE id = NEW.id;
          END IF;
          RETURN NEW;
        END $$`);
      await admin.query(`ALTER FUNCTION lease_guard_scratch_fn() OWNER TO ${probe}`);
      await admin.query(`CREATE OR REPLACE TRIGGER lease_guard_scratch_t BEFORE INSERT ON lease_guard_scratch FOR EACH ROW EXECUTE FUNCTION lease_guard_scratch_fn()`);
      try {
        await admin.query('BEGIN');
        await admin.query(`INSERT INTO lease_guard_scratch (id, mode) VALUES ($1, 'clear')`, [id]);
        expect((await admin.query('SELECT runner_id FROM agent_runs WHERE id = $1', [id])).rows[0].runner_id).toBeNull();
        await admin.query('ROLLBACK');
        for (const mode of ['lease', 'claimable']) {
          await admin.query('BEGIN');
          await expect(admin.query(`INSERT INTO lease_guard_scratch (id, mode) VALUES ($1, $2)`, [id, mode]), mode).rejects.toMatchObject({ code: '42501' });
          await admin.query('ROLLBACK');
        }
      } finally {
        await admin.query('ROLLBACK').catch(() => undefined);
        await admin.query(`DROP TABLE lease_guard_scratch`);
        await admin.query(`DROP FUNCTION lease_guard_scratch_fn()`);
      }
    });

    it('lease_generation never goes down and a claimed run keeps its runner, for the definer role as for any other', async () => {
      const id = await newRun({ status: 'running', runnerId: runner, generation: 2, lease: new Date(Date.now() + 90_000).toISOString() });
      await expect(admin.query('UPDATE agent_runs SET lease_generation = 1 WHERE id = $1', [id])).rejects.toMatchObject({ code: '23514' });
      await expect(admin.query('UPDATE agent_runs SET runner_id = $2 WHERE id = $1', [id, await insertRunner(admin, refs.accountId, refs.userId)])).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('the follow-up index', () => {
    it('is unique on (account, parent) for runner runs with a parent, and only those', async () => {
      const { rows } = await admin.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'agent_runs_runner_follow_up_key'`);
      expect(rows[0].indexdef).toMatch(/UNIQUE INDEX agent_runs_runner_follow_up_key ON public\.agent_runs USING btree \(account_id, parent_run_id\) WHERE \(\(runtime = 'runner'::text\) AND \(parent_run_id IS NOT NULL\)\)/);
    });
  });
});

/**
 * C21 section 11: "A test diffs platform_ops's privileges on agent_runs and runners against main, and requires the difference
 * to be empty." This migrates a throwaway cluster to everything EXCEPT 0754, snapshots what platform_ops holds, applies 0754 on the
 * same database and snapshots again. The snapshot is the table grants, every column grant of every kind (read off the catalog
 * the way Postgres evaluates them, so a table-wide grant that Postgres would extend to a new column shows up as one), the row
 * policies that name platform_ops, the functions it owns and the roles it belongs to.
 */
describe('migration 0754 gives platform_ops nothing', () => {
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
    definersOwnedByPlatformOps: string[];
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
      definersOwnedByPlatformOps: await q(`SELECT p.proname AS x FROM pg_proc p WHERE p.prosecdef AND p.proowner = 'platform_ops'::regrole AND p.proname ~ '^(agent_run_runner_|runner_follow_up_run|runner_claim_throttle|agent_run_list_running_runner_runs|agent_run_list_jobless_runner_runs)' ORDER BY 1`),
    };
  }

  beforeAll(async () => {
    pg = await provisionEphemeralPostgres({ database: 'fx_0754_ops_diff_test', tmpPrefix: 'fx-0754-diff-' });
    pool = createPool(pg.url);
    guard = guardPoolTeardown(pool, 'platformOpsDiffPool');
    beforeDir = mkdtempSync(path.join(tmpdir(), 'fx-0754-diff-migrations-'));
    for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR).filter((name) => name.endsWith('.sql') && name !== MIGRATION)) {
      copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(beforeDir, f));
    }
    await runMigrations(pool, beforeDir);
    before = await snapshot();
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR); // applies exactly 0754: everything else is already recorded
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

  it('platform_ops holds exactly what it held on agent_runs and runners: table grants, column grants (new columns included) and row policies', () => {
    expect(after.tableGrants).toEqual(before.tableGrants);
    expect(after.columnGrants).toEqual(before.columnGrants);
    expect(after.policies).toEqual(before.policies);
    // The new column on agent_runs is not among platform_ops' column privileges: nothing table-wide reaches it.
    expect(after.columnGrants.filter((g) => g.includes('claimable_after'))).toEqual([]);
  });

  it('platform_ops owns no new function and joins no new role, and no definer of this file is owned by it', () => {
    expect(after.ownedFunctions).toEqual(before.ownedFunctions);
    expect(after.memberships).toEqual(before.memberships);
    expect(after.definersOwnedByPlatformOps).toEqual([]);
  });

  it('migration 0754 never grants platform_ops a privilege, revokes one from it or makes it an owner (it holds the role only inside a bracket)', () => {
    const sql = readFileSync(path.join(DEFAULT_MIGRATIONS_DIR, MIGRATION), 'utf8')
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    for (const statement of sql.split(';')) {
      if (/\b(GRANT|REVOKE|OWNER\s+TO)\b/i.test(statement)) expect(statement, statement.trim().slice(0, 80)).not.toMatch(/\b(TO|FROM)\s+platform_ops\b/i);
    }
  });
});
