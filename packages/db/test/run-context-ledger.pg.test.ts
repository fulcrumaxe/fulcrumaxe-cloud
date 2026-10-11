import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { DEFAULT_MIGRATIONS_DIR } from '../src/migrate.js';

const MIGRATION = '0792_run_context_ledger.sql';
const ROLE = 'run_context_ledger_definer';
const FN = 'run_context_ledger_record(uuid,uuid,jsonb,bigint,bigint,bigint,bigint,bigint,jsonb,integer,text)';

/** Everything the role holds, exactly. */
const EXPECTED_PRIVILEGES = [
  'column agent_runs.account_id SELECT',
  'column agent_runs.id SELECT',
  'schema public USAGE',
  'table run_context_ledger INSERT',
  'table run_context_ledger SELECT',
  'table run_context_ledger UPDATE',
].sort();

/** [pg] D#600 CX-1a migration 0792: the shape of the role, the table and the function. Behaviour is tested in packages/runner (contextLedger.pg.test.ts). */
describe(`migration 0792: ${ROLE}, run_context_ledger and its function (D#600 CX-1a)`, () => {
  let adminPool: Pool;
  let admin: PoolClient;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
  });

  it('the role is NOLOGIN and unprivileged, a member of nothing, with exactly the listed privileges, and owns exactly the one function', async () => {
    const attrs = await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1`, [ROLE]);
    expect(attrs.rows).toEqual([{ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false }]);
    expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE member = $1::regrole OR roleid = $1::regrole`, [ROLE])).rows).toEqual([]);
    const held = await admin.query<{ x: string }>(
      `WITH r AS (SELECT oid FROM pg_roles WHERE rolname = $1)
       SELECT 'table ' || c.relname || ' ' || a.privilege_type AS x FROM pg_class c, aclexplode(c.relacl) a, r WHERE a.grantee = r.oid
       UNION ALL SELECT 'column ' || c.relname || '.' || t.attname || ' ' || a.privilege_type FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a, r WHERE a.grantee = r.oid
       UNION ALL SELECT 'schema ' || n.nspname || ' ' || a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a, r WHERE a.grantee = r.oid AND n.nspname = 'public'`,
      [ROLE],
    );
    expect(held.rows.map((x) => x.x).sort()).toEqual(EXPECTED_PRIVILEGES);
    const owned = await admin.query<{ fn: string }>(`SELECT p.oid::regprocedure::text AS fn FROM pg_proc p WHERE p.proowner = $1::regrole ORDER BY 1`, [ROLE]);
    expect(owned.rows.map((x) => x.fn)).toEqual([FN]);
    expect((await admin.query(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS c`, [ROLE])).rows[0].c).toBe(false);
  });

  it('the function is SECURITY DEFINER with a pinned search_path, owned by the role, and EXECUTE is held by agent_run_writer and the owner only', async () => {
    const { rows } = await admin.query(
      `SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
              coalesce((SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END) FROM aclexplode(p.proacl) a), '{}') AS grantees,
              coalesce((SELECT bool_or(a.is_grantable) FROM aclexplode(p.proacl) a), false) AS grantable
         FROM pg_proc p WHERE p.oid = $1::regprocedure`,
      [FN],
    );
    expect(rows[0]).toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], owner: ROLE, grantees: [ROLE, 'agent_run_writer'].sort(), grantable: false });
    for (const who of ['app_user', 'platform_ops', 'partner_user', 'run_binding_resolver']) {
      expect((await admin.query(`SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok`, [who, FN])).rows[0].ok, who).toBe(false);
    }
  });

  it('the table has row security forced, one SELECT policy for app_user, SELECT only, and cascades on its run', async () => {
    const flags = await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'run_context_ledger'`);
    expect(flags.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const policies = await admin.query<{ roles: string[]; cmd: string }>(`SELECT roles::text[] AS roles, cmd FROM pg_policies WHERE tablename = 'run_context_ledger' AND 'app_user' = ANY (roles)`);
    expect(policies.rows).toEqual([{ roles: ['app_user'], cmd: 'SELECT' }]);
    const grants = await admin.query<{ privilege_type: string }>(`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = 'run_context_ledger' AND grantee = 'app_user'`);
    expect(grants.rows).toEqual([{ privilege_type: 'SELECT' }]);
    const fk = await admin.query(`SELECT confdeltype FROM pg_constraint WHERE conrelid = 'run_context_ledger'::regclass AND contype = 'f'`);
    expect(fk.rows).toEqual([{ confdeltype: 'c' }]);
  });

  it('the migration never grants platform_ops a privilege, revokes one from it or makes it an owner', () => {
    const sql = readFileSync(path.join(DEFAULT_MIGRATIONS_DIR, MIGRATION), 'utf8')
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    for (const statement of sql.split(';')) {
      if (/\b(GRANT|REVOKE|OWNER\s+TO)\b/i.test(statement)) expect(statement, statement.trim().slice(0, 80)).not.toMatch(/\b(TO|FROM)\s+platform_ops\b/i);
    }
  });

  it('platform_ops holds no privilege on the table', async () => {
    const { rows } = await admin.query(`SELECT has_table_privilege('platform_ops', 'run_context_ledger', 'SELECT') AS s, has_table_privilege('platform_ops', 'run_context_ledger', 'INSERT') AS i`);
    expect(rows[0]).toEqual({ s: false, i: false });
  });
});
