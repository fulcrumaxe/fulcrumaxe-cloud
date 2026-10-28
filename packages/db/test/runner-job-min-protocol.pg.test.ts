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

const MIGRATION = '0805_runner_job_min_protocol.sql';

describe('migration 0805: agent_runs.min_protocol_version (D#599 PL-2b-1)', () => {
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

  const q = async (sql: string) => (await admin.query<{ ok: boolean }>(sql)).rows[0]!.ok;
  const run = async (min: number | null): Promise<string> => {
    const id = randomUUID();
    await admin.query("INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, min_protocol_version) VALUES ($1, $2, 'executor', 'runner', 'pending', 'runner_local', $3)", [id, accountId, min]);
    return id;
  };

  it('holds NULL (any runner) or a positive integer', async () => {
    await run(null);
    await run(3);
    for (const bad of [0, -1]) await expect(run(bad), String(bad)).rejects.toThrow(/agent_runs_min_protocol_version_check/);
  });

  it('can be set on a row that has no job only by the insert; an update of it is refused, and so is any change after the job is set', async () => {
    const id = await run(null);
    await expect(admin.query('UPDATE agent_runs SET min_protocol_version = 3 WHERE id = $1', [id])).rejects.toMatchObject({ code: '23514' });
    const gated = await run(3);
    await expect(admin.query('UPDATE agent_runs SET min_protocol_version = 4 WHERE id = $1', [gated])).rejects.toMatchObject({ code: '23514' });
    await expect(admin.query('UPDATE agent_runs SET min_protocol_version = NULL WHERE id = $1', [gated])).rejects.toMatchObject({ code: '23514' });
  });

  it("is copied from the transaction-local value in the UPDATE that first sets the job, and from nothing else", async () => {
    const id = await run(null);
    const job = JSON.stringify({ job: {}, signature: 'x' });
    await admin.query('BEGIN');
    try {
      await admin.query("SELECT set_config('fx.job_min_protocol', '3', true)");
      await admin.query('UPDATE agent_runs SET job_signed = $2::jsonb WHERE id = $1', [id, job]);
      expect((await admin.query<{ v: number | null }>('SELECT min_protocol_version AS v FROM agent_runs WHERE id = $1', [id])).rows[0]!.v).toBe(3);
    } finally {
      await admin.query('ROLLBACK');
    }
    const ungated = await run(null);
    await admin.query('UPDATE agent_runs SET job_signed = $2::jsonb WHERE id = $1', [ungated, job]);
    expect((await admin.query<{ v: number | null }>('SELECT min_protocol_version AS v FROM agent_runs WHERE id = $1', [ungated])).rows[0]!.v).toBeNull();
  });

  it('refuses a first job write in the cross-side shape (null session id, or a pull request number) with no minimum, and accepts it with one', async () => {
    const nullSession = JSON.stringify({ job: { continues: { parent_run_id: randomUUID(), session_id: null, branch: 'fx/x' } }, signature: 'x' });
    const withNumber = JSON.stringify({ job: { continues: { parent_run_id: randomUUID(), session_id: null, branch: 'fx/issue-12', pr_number: 41 } }, signature: 'x' });
    const plain = JSON.stringify({ job: { continues: { parent_run_id: randomUUID(), session_id: 's1', branch: 'fx/x' } }, signature: 'x' });
    for (const job of [nullSession, withNumber]) {
      const id = await run(null);
      await expect(admin.query('UPDATE agent_runs SET job_signed = $2::jsonb WHERE id = $1', [id, job])).rejects.toMatchObject({ code: '23514' });
      await admin.query('BEGIN');
      try {
        await admin.query("SELECT set_config('fx.job_min_protocol', '3', true)");
        await admin.query('UPDATE agent_runs SET job_signed = $2::jsonb WHERE id = $1', [id, job]);
      } finally {
        await admin.query('ROLLBACK');
      }
    }
    const id = await run(null);
    await admin.query('UPDATE agent_runs SET job_signed = $2::jsonb WHERE id = $1', [id, plain]);
  });

  // 0887 (D#6 R-CHK-1): a job that carries the repo's approved check is never written without the check floor, protocol 8.
  it('refuses a first job write that carries a check with no minimum or one below 8, and accepts it with 8 or more', async () => {
    const withCheck = JSON.stringify({ job: { check: { argv: ['bash', 'scripts/check.sh'], dev_shell: true, timeout_s: 5400 } }, signature: 'x' });
    for (const minimum of [null, '7']) {
      const id = await run(null);
      await admin.query('BEGIN');
      try {
        if (minimum !== null) await admin.query("SELECT set_config('fx.job_min_protocol', $1, true)", [minimum]);
        await expect(admin.query('UPDATE agent_runs SET job_signed = $2::jsonb WHERE id = $1', [id, withCheck])).rejects.toMatchObject({ code: '23514' });
      } finally {
        await admin.query('ROLLBACK');
      }
    }
    const id = await run(null);
    await admin.query('BEGIN');
    try {
      await admin.query("SELECT set_config('fx.job_min_protocol', '8', true)");
      await admin.query('UPDATE agent_runs SET job_signed = $2::jsonb WHERE id = $1', [id, withCheck]);
      expect((await admin.query<{ v: number }>('SELECT min_protocol_version AS v FROM agent_runs WHERE id = $1', [id])).rows[0]!.v).toBe(8);
    } finally {
      await admin.query('ROLLBACK');
    }
  });

  it('app_user reads it and cannot write it; platform_ops and the public hold nothing on the column', async () => {
    expect(await q("SELECT has_column_privilege('app_user', 'public.agent_runs', 'min_protocol_version', 'SELECT') AS ok")).toBe(true);
    for (const priv of ['UPDATE', 'INSERT']) expect(await q(`SELECT has_column_privilege('app_user', 'public.agent_runs', 'min_protocol_version', '${priv}') AS ok`), priv).toBe(false);
    for (const priv of ['SELECT', 'UPDATE', 'INSERT']) expect(await q(`SELECT has_column_privilege('platform_ops', 'public.agent_runs', 'min_protocol_version', '${priv}') AS ok`), priv).toBe(false);
    expect(await q("SELECT NOT EXISTS (SELECT 1 FROM pg_attribute t, aclexplode(t.attacl) a WHERE t.attrelid = 'public.agent_runs'::regclass AND t.attname = 'min_protocol_version' AND a.grantee = 0) AS ok")).toBe(true);
  });
});

/**
 * C21 section 11 for this file too: platform_ops gains nothing. This migrates a throwaway cluster to everything EXCEPT 0805, snapshots what
 * platform_ops holds on agent_runs, applies 0805 on the same database and snapshots again. The two must be equal.
 */
describe('migration 0805 gives platform_ops nothing', () => {
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
         WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'agent_runs' AND has_table_privilege('platform_ops', c.oid, p.privilege_type)
         ORDER BY 1`),
      columnGrants: await q(`
        SELECT a.attname || ' ' || p.privilege_type AS x FROM pg_class c
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
          CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) AS p(privilege_type)
         WHERE c.relnamespace = 'public'::regnamespace AND c.relname = 'agent_runs' AND a.attname <> 'min_protocol_version' AND has_column_privilege('platform_ops', c.oid, a.attnum, p.privilege_type)
         ORDER BY 1`),
      policies: await q(`SELECT policyname || ' ' || cmd || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '') AS x FROM pg_policies WHERE schemaname = 'public' AND tablename = 'agent_runs' AND 'platform_ops' = ANY(roles) ORDER BY 1`),
      // 0844 (S5-f) re-creates reject_proposal with two more parameters and adds resurface_proposals, both platform_ops-owned like the other
      // proposal definers. Those two exact signatures are the only difference allowed (reject_proposal compared by name, resurface_proposals
      // left out); any other change to what platform_ops owns still fails this test.
      ownedFunctions: await q(`SELECT CASE WHEN p.proname = 'reject_proposal' THEN 'reject_proposal(...)' ELSE p.oid::regprocedure::text END AS x FROM pg_proc p
         WHERE p.proowner = 'platform_ops'::regrole AND p.oid::regprocedure::text NOT IN ('resurface_proposals(uuid,uuid)', 'decision_ask_next_due(timestamp with time zone)', 'resume_decision_reconcile(integer)', 'run_action_defer_resume(uuid,integer)') ORDER BY 1`),
      memberships: await q(`SELECT pg_get_userbyid(roleid) || ' ' || admin_option::text AS x FROM pg_auth_members WHERE member = 'platform_ops'::regrole ORDER BY 1`),
    };
  }

  beforeAll(async () => {
    pg = await provisionEphemeralPostgres({ database: 'fx_0805_ops_diff_test', tmpPrefix: 'fx-0805-diff-' });
    pool = createPool(pg.url);
    guard = guardPoolTeardown(pool, 'platformOpsDiff0805Pool');
    beforeDir = mkdtempSync(path.join(tmpdir(), 'fx-0805-diff-migrations-'));
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
    expect(before.columnGrants).toContain('job_signed UPDATE');
    expect(before.ownedFunctions.length).toBeGreaterThan(5);
  });

  it('platform_ops holds exactly what it held on agent_runs, owns the same functions and has the same memberships, and has no privilege on the new column', async () => {
    expect(after).toEqual(before);
    for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) {
      expect((await pool.query<{ ok: boolean }>(`SELECT has_column_privilege('platform_ops', 'public.agent_runs', 'min_protocol_version', '${priv}') AS ok`)).rows[0]!.ok, priv).toBe(false);
    }
  });

  it('the file adds the column, three SELECT grants (app_user, and the claim definer role for the two columns it reads), and replaces two functions: nothing for platform_ops', () => {
    const sql = readFileSync(path.join(DEFAULT_MIGRATIONS_DIR, MIGRATION), 'utf8')
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    expect([...sql.matchAll(/\bGRANT\b[^;]*;/gi)].map((m) => m[0].replace(/\s+/g, ' ')).filter((g) => !/GRANT runner_lease_definer TO CURRENT_USER/.test(g))).toEqual([
      'GRANT SELECT (min_protocol_version) ON agent_runs TO app_user;',
      'GRANT SELECT (min_protocol_version) ON agent_runs TO runner_lease_definer;',
      'GRANT SELECT (protocol_version) ON runners TO runner_lease_definer;',
    ]);
    expect([...sql.matchAll(/\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(\w+)/gi)].map((m) => m[1])).toEqual(['agent_runs_runner_columns_guard', 'agent_run_runner_claim']);
  });

  it('runner_lease_definer holds SELECT on exactly the two new columns and no UPDATE', async () => {
    for (const [table, column] of [['agent_runs', 'min_protocol_version'], ['runners', 'protocol_version']]) {
      expect((await pool.query<{ ok: boolean }>(`SELECT has_column_privilege('runner_lease_definer', 'public.${table}', '${column}', 'SELECT') AS ok`)).rows[0]!.ok, column).toBe(true);
      expect((await pool.query<{ ok: boolean }>(`SELECT has_column_privilege('runner_lease_definer', 'public.${table}', '${column}', 'UPDATE') AS ok`)).rows[0]!.ok, column).toBe(false);
    }
  });
});
