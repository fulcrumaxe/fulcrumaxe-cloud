import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../src/migrate.js';
import { seedF2, type F2Fixture } from './helpers/members.js';
import { seedAccount } from './helpers/seed.js';
import { provisionEphemeralPostgres, type EphemeralPostgres } from './support/ephemeral-pg.js';
import { guardPoolTeardown, type PoolTeardownGuard } from './support/pool-teardown.js';

const MIGRATION = '0759_execution_mode_cancel.sql';
const ROLE = 'runner_mode_switch_definer';
const CANCEL = 'repo_cancel_pending_runner_runs(uuid)';
const AUDIT = 'repo_execution_mode_switch_audit(uuid,text,text,boolean,integer)';
const DEFINERS = [CANCEL, AUDIT];

/** Everything the role holds, exactly: column grants only on what its two bodies read and write. */
const EXPECTED_PRIVILEGES = [
  ...['id', 'account_id', 'status', 'runtime', 'execution_mode', 'dispatch_repo_id'].map((c) => `column agent_runs.${c} SELECT`),
  'column agent_runs.updated_at UPDATE',
  ...['account_id', 'user_id', 'role'].map((c) => `column account_members.${c} SELECT`),
  ...['id', 'account_id', 'execution_mode'].map((c) => `column repos.${c} SELECT`),
  'column accounts.id SELECT',
  'column accounts.deleted_at SELECT',
  ...['account_id', 'actor', 'action', 'payload', 'created_at'].map((c) => `column audit_log.${c} INSERT`),
  'schema public USAGE',
].sort();

describe(`migration 0759: ${ROLE} and its two definers (D#6 R2b, C24 section 2)`, () => {
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

    it('holds exactly the column grants its bodies need, nothing table-wide, and EXECUTE on agent_run_set_status and nothing else callable', async () => {
      const { rows } = await admin.query<{ x: string }>(
        `WITH r AS (SELECT oid FROM pg_roles WHERE rolname = $1)
         SELECT 'table ' || c.relname || ' ' || a.privilege_type AS x FROM pg_class c, aclexplode(c.relacl) a, r WHERE a.grantee = r.oid AND c.relnamespace = 'public'::regnamespace
         UNION ALL SELECT 'column ' || c.relname || '.' || t.attname || ' ' || a.privilege_type
           FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a, r WHERE a.grantee = r.oid AND c.relnamespace = 'public'::regnamespace
         UNION ALL SELECT 'schema ' || n.nspname || ' ' || a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a, r WHERE a.grantee = r.oid AND n.nspname = 'public'`,
        [ROLE],
      );
      expect(rows.map((r) => r.x).sort()).toEqual(EXPECTED_PRIVILEGES);
      const exec = await admin.query<{ sig: string }>(
        `SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proowner <> $1::regrole
            AND EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = $1::regrole AND a.privilege_type = 'EXECUTE')`,
        [ROLE],
      );
      expect(exec.rows.map((r) => r.sig)).toEqual(['agent_run_set_status(uuid,uuid,text,text,jsonb,bigint,bigint,numeric,text,integer)']);
    });

    it('has a row policy of its own on each row-secured table it touches, and only those, each for this role alone', async () => {
      const { rows } = await admin.query<{ tablename: string; cmd: string; roles: string[] }>(
        `SELECT tablename, cmd, roles::text[] AS roles FROM pg_policies WHERE schemaname = 'public' AND $1 = ANY(roles) ORDER BY tablename, cmd`,
        [ROLE],
      );
      expect(rows.map((r) => `${r.tablename} ${r.cmd}`)).toEqual(['account_members SELECT', 'accounts SELECT', 'agent_runs SELECT', 'agent_runs UPDATE', 'audit_log INSERT', 'repos SELECT']);
      for (const r of rows) expect(r.roles).toEqual([ROLE]);
    });
  });

  describe('the definers', () => {
    it('are SECURITY DEFINER with a pinned search_path, owned by the role, and EXECUTE for app_user alone (no PUBLIC, no platform_ops, no run-writer, no grant option)', async () => {
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

  describe('behaviour, called as the web tier\'s login under a tenant context', () => {
    async function repo(accountId: string, mode: string): Promise<string> {
      const id = randomUUID();
      await admin.query("INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, 'team', 'Acme', 'widgets', $4)", [id, accountId, Math.floor(Math.random() * 1e12), mode]);
      return id;
    }
    async function run(accountId: string, repoId: string, status = 'pending', runtime = 'runner'): Promise<string> {
      const id = randomUUID();
      await admin.query(
        `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id) VALUES ($1, $2, 'code-reviewer', $3, $4, $5, $6)`,
        [id, accountId, runtime, status, runtime === 'runner' ? 'runner_local' : 'sandbox', repoId],
      );
      return id;
    }
    /** One transaction, rolled back: the tenant context, then `SET LOCAL ROLE app_user` (the session user stays the superuser, so the definers' own platform_ops refusal does not fire). */
    async function asApp<T>(userId: string, accountId: string, body: () => Promise<T>): Promise<T> {
      await admin.query('BEGIN');
      try {
        await admin.query(`SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)`, [accountId, userId]);
        await admin.query('SET LOCAL ROLE app_user');
        return await body();
      } finally {
        await admin.query('ROLLBACK');
      }
    }
    /** A refusal aborts the transaction; a savepoint lets the next check run in the same one. */
    const sp = async <T>(fn: () => Promise<T>): Promise<T> => {
      await admin.query('SAVEPOINT s');
      try {
        return await fn();
      } catch (error) {
        await admin.query('ROLLBACK TO SAVEPOINT s');
        throw error;
      }
    };
    const cancel = async (repoId: string) => (await admin.query<{ run_id: string }>('SELECT run_id FROM repo_cancel_pending_runner_runs($1)', [repoId])).rows.map((r) => r.run_id);
    const statusOf = async (id: string) => (await admin.query('SELECT status FROM agent_runs WHERE id = $1', [id])).rows[0].status as string;

    it('moves each pending runner run of a repo that is off runner_local to cancelled and answers their ids; running, finished, sandbox and other repos\' runs stay', async () => {
      const id = await repo(f.accountId, 'sandbox');
      const other = await repo(f.accountId, 'sandbox');
      const queued = [await run(f.accountId, id), await run(f.accountId, id)];
      const running = await run(f.accountId, id, 'running');
      const finished = await run(f.accountId, id, 'succeeded');
      const sandboxRun = await run(f.accountId, id, 'pending', 'production');
      const elsewhere = await run(f.accountId, other);
      await asApp(f.a1, f.accountId, async () => {
        expect((await cancel(id)).sort()).toEqual([...queued].sort());
        for (const r of queued) expect(await statusOf(r)).toBe('cancelled');
        for (const [r, want] of [[running, 'running'], [finished, 'succeeded'], [sandboxRun, 'pending'], [elsewhere, 'pending']] as const) expect(await statusOf(r), r).toBe(want);
        expect(await cancel(id)).toEqual([]);
      });
    });

    it('refuses a repo that is still on a runner (55000) and moves nothing', async () => {
      const id = await repo(f.accountId, 'runner_local');
      const queued = await run(f.accountId, id);
      await asApp(f.a1, f.accountId, async () => {
        await expect(sp(() => cancel(id))).rejects.toMatchObject({ code: '55000' });
      });
      expect(await statusOf(queued)).toBe('pending');
    });

    it('refuses a member who is not an owner or admin (42501), no user in context (42501), another account\'s repo and an unknown repo (P0002), and a null repo (22023)', async () => {
      const id = await repo(f.accountId, 'sandbox');
      const queued = await run(f.accountId, id);
      const other = await seedAccount(admin, randomUUID());
      const theirs = await repo(other.accountId, 'sandbox');
      const theirRun = await run(other.accountId, theirs);
      await asApp(f.m1, f.accountId, async () => {
        await expect(sp(() => cancel(id))).rejects.toMatchObject({ code: '42501' });
      });
      await asApp('', f.accountId, async () => {
        await expect(sp(() => cancel(id))).rejects.toMatchObject({ code: '42501' });
      });
      await asApp(f.a1, f.accountId, async () => {
        await expect(sp(() => cancel(theirs))).rejects.toMatchObject({ code: 'P0002' });
        await expect(sp(() => cancel(randomUUID()))).rejects.toMatchObject({ code: 'P0002' });
        await expect(sp(() => admin.query('SELECT run_id FROM repo_cancel_pending_runner_runs(NULL)'))).rejects.toMatchObject({ code: '22023' });
      });
      // the other account's admin cannot reach this account's repo either
      await asApp(other.userId, other.accountId, async () => {
        await expect(sp(() => cancel(id))).rejects.toMatchObject({ code: 'P0002' });
      });
      expect(await statusOf(queued)).toBe('pending');
      expect(await statusOf(theirRun)).toBe('pending');
    });

    it('cannot be called by the run-writer login, platform_ops or the public', async () => {
      const id = await repo(f.accountId, 'sandbox');
      for (const who of ['agent_run_writer', 'platform_ops', 'partner_user']) {
        await admin.query('BEGIN');
        try {
          await admin.query(`SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)`, [f.accountId, f.a1]);
          await admin.query(`SET LOCAL ROLE ${who}`);
          await expect(sp(() => admin.query('SELECT run_id FROM repo_cancel_pending_runner_runs($1)', [id])), who).rejects.toMatchObject({ code: '42501' });
        } finally {
          await admin.query('ROLLBACK');
        }
      }
    });

    describe('the audit definer', () => {
      const audit = (repoId: string, from: string, to: string, off: boolean, n: number) => admin.query('SELECT repo_execution_mode_switch_audit($1, $2, $3, $4, $5)', [repoId, from, to, off, n]);
      const rows = async (repoId: string) => (await admin.query("SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'repo.execution_mode.changed' AND payload ->> 'repo_id' = $2", [f.accountId, repoId])).rows;

      it('writes one row with the count, stamped with the caller as actor', async () => {
        const id = await repo(f.accountId, 'sandbox');
        await asApp(f.a1, f.accountId, async () => {
          await audit(id, 'runner_local', 'sandbox', true, 3);
          expect(await rows(id)).toEqual([{ actor: f.a1, payload: { repo_id: id, from: 'runner_local', to: 'sandbox', auto_merge_turned_off: true, cancelled_runs: 3 } }]);
        });
      });

      it('refuses a count on a switch that does not leave runner_local, a negative or null count, bad modes, a member, and another account\'s repo', async () => {
        const id = await repo(f.accountId, 'sandbox');
        const other = await seedAccount(admin, randomUUID());
        const theirs = await repo(other.accountId, 'sandbox');
        await asApp(f.a1, f.accountId, async () => {
          for (const args of [
            [id, 'sandbox', 'runner_local', false, 1],
            [id, 'runner_local', 'sandbox', false, -1],
            [id, 'runner_local', 'runner_local', false, 0],
            [id, 'runner_local', 'container', false, 0],
          ] as const) {
            await expect(sp(() => audit(args[0], args[1], args[2], args[3], args[4])), JSON.stringify(args)).rejects.toMatchObject({ code: '22023' });
          }
          await expect(sp(() => admin.query('SELECT repo_execution_mode_switch_audit($1, $2, $3, $4, NULL)', [id, 'runner_local', 'sandbox', false]))).rejects.toMatchObject({ code: '22023' });
        });
        await asApp(f.a1, f.accountId, async () => {
          await expect(audit(theirs, 'runner_local', 'sandbox', false, 0)).rejects.toMatchObject({ code: 'P0002' });
        });
        await asApp(f.m1, f.accountId, async () => {
          await expect(audit(id, 'runner_local', 'sandbox', false, 0)).rejects.toMatchObject({ code: '42501' });
        });
      });
    });
  });
});

/**
 * C21 section 11 for this file too: platform_ops gains nothing. This migrates a throwaway cluster to everything EXCEPT 0759,
 * snapshots what platform_ops holds, applies 0759 on the same database and snapshots again. The snapshot is the table grants,
 * every column grant of every kind on the tables the new role touches, the row policies that name platform_ops, the functions it
 * owns and the roles it belongs to. All of it must be unchanged, and neither new definer is owned by platform_ops.
 */
describe('migration 0759 gives platform_ops nothing', () => {
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
    newDefinersOwnedByPlatformOps: string[];
  }
  const TABLES = `('agent_runs', 'runners', 'repos', 'account_members', 'accounts', 'audit_log', 'run_events', 'domain_events')`;

  async function snapshot(): Promise<Snapshot> {
    const q = async (sql: string) => (await pool.query<{ x: string }>(sql)).rows.map((r) => r.x);
    return {
      tableGrants: await q(`
        SELECT c.relname || ' ' || p.privilege_type AS x FROM pg_class c
          CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(privilege_type)
         WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ${TABLES} AND has_table_privilege('platform_ops', c.oid, p.privilege_type)
         ORDER BY 1`),
      columnGrants: await q(`
        SELECT c.relname || '.' || a.attname || ' ' || p.privilege_type AS x FROM pg_class c
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
          CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) AS p(privilege_type)
         WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ${TABLES} AND has_column_privilege('platform_ops', c.oid, a.attnum, p.privilege_type)
         ORDER BY 1`),
      policies: await q(`
        SELECT tablename || ' ' || policyname || ' ' || cmd || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '') AS x FROM pg_policies
         WHERE schemaname = 'public' AND tablename IN ${TABLES} AND 'platform_ops' = ANY(roles) ORDER BY 1`),
      ownedFunctions: await q(`SELECT p.oid::regprocedure::text AS x FROM pg_proc p WHERE p.proowner = 'platform_ops'::regrole ORDER BY 1`),
      memberships: await q(`SELECT pg_get_userbyid(roleid) || ' ' || admin_option::text || ' ' || coalesce(inherit_option::text, '') || ' ' || coalesce(set_option::text, '') AS x FROM pg_auth_members WHERE member = 'platform_ops'::regrole ORDER BY 1`),
      newDefinersOwnedByPlatformOps: await q(`SELECT p.proname AS x FROM pg_proc p WHERE p.proowner = 'platform_ops'::regrole AND p.proname IN ('repo_cancel_pending_runner_runs', 'repo_execution_mode_switch_audit') ORDER BY 1`),
    };
  }

  beforeAll(async () => {
    pg = await provisionEphemeralPostgres({ database: 'fx_0759_ops_diff_test', tmpPrefix: 'fx-0759-diff-' });
    pool = createPool(pg.url);
    guard = guardPoolTeardown(pool, 'platformOpsDiff0759Pool');
    beforeDir = mkdtempSync(path.join(tmpdir(), 'fx-0759-diff-migrations-'));
    for (const file of readdirSync(DEFAULT_MIGRATIONS_DIR).filter((name) => name.endsWith('.sql') && name !== MIGRATION)) {
      copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, file), path.join(beforeDir, file));
    }
    await runMigrations(pool, beforeDir);
    before = await snapshot();
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR); // applies exactly 0759: everything else is already recorded
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

  it('platform_ops holds exactly what it held: table grants, column grants, row policies, owned functions and role memberships', () => {
    expect(after.tableGrants).toEqual(before.tableGrants);
    expect(after.columnGrants).toEqual(before.columnGrants);
    expect(after.policies).toEqual(before.policies);
    expect(after.ownedFunctions).toEqual(before.ownedFunctions);
    expect(after.memberships).toEqual(before.memberships);
    expect(after.newDefinersOwnedByPlatformOps).toEqual([]);
  });

  it('migration 0759 mentions platform_ops in exactly the ways 0754 and 0757 do: the temporary CREATE on the schema, taken back in the same file, and the role brackets', () => {
    const sql = readFileSync(path.join(DEFAULT_MIGRATIONS_DIR, MIGRATION), 'utf8')
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    const mentions = sql
      .split(';')
      .map((statement) => statement.trim().replace(/\s+/g, ' '))
      .filter((statement) => /\b(GRANT|REVOKE|OWNER\s+TO)\b/i.test(statement) && /\bplatform_ops\b/i.test(statement));
    expect(mentions).toEqual([
      'DO $$ BEGIN IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE',
      'GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE',
    ]);
  });
});
