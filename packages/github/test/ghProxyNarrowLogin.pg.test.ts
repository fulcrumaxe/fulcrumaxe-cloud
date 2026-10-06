import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '@fx/db/src/pool.js';
import { RUN_STATUS_TRANSITIONS } from '@fx/runner';
import { createRunResolver } from '../src/runResolver.js';
import { ensureGhProxyTestLogin, GH_PROXY_TEST_LOGIN } from './helpers/ghProxyLogin.js';
import { seedAccountWithRepo, seedAgentRun, setRepoGithubNames, type SeedRefs } from './helpers/seed.js';

/**
 * Migration 0696: the gh-proxy's own narrow login. Two halves.
 *   1. The resolver answers exactly what the old platform_ops query answered
 *      (live, ended, foreign-account and unknown runs).
 *   2. The login holds nothing but EXECUTE on the one function.
 */

/** The query the proxy ran as platform_ops before 0696, kept here as the oracle. */
const OLD_QUERY = `
  SELECT ar.role, ar.status, r.product, r.gh_owner, r.gh_name, i.gh_installation_id, i.app_kind,
         EXISTS (SELECT 1 FROM onboarding_previews p WHERE p.run_id = ar.id AND p.account_id = ar.account_id) AS is_preview
    FROM agent_runs ar
    JOIN repos r ON r.id = ar.dispatch_repo_id AND r.account_id = ar.account_id
    JOIN installations i ON i.id = r.installation_id AND i.account_id = r.account_id
   WHERE ar.sandbox_name = $1
     AND NOT EXISTS (SELECT 1 FROM installations i2 WHERE i2.gh_installation_id = i.gh_installation_id AND i2.id <> i.id)
`;
const NEW_QUERY = `SELECT role, product, gh_owner, gh_name, gh_installation_id, app_kind, is_preview
                     FROM public.resolve_sandbox_run($1)`;

const isLive = (status: string) => (RUN_STATUS_TRANSITIONS as Record<string, readonly string[]>)[status]!.length > 0;

describe('gh-proxy narrow login (0696)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let opsPool: Pool;
  let appPool: Pool;
  let proxyPool: Pool;
  let proxyUrl: string;
  let refs: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.GITHUB_DATABASE_URL!);
    admin = await adminPool.connect();
    opsPool = createPool(process.env.GITHUB_DATABASE_URL_PLATFORM_OPS!);
    appPool = createPool(process.env.GITHUB_DATABASE_URL_APP_USER!);
    proxyUrl = await ensureGhProxyTestLogin(process.env.GITHUB_DATABASE_URL!);
    proxyPool = createPool(proxyUrl);
    refs = await seedAccountWithRepo(admin, 6262);
    await setRepoGithubNames(admin, refs.repoId, 'acme-corp', 'widgets');
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([opsPool.end(), appPool.end(), proxyPool.end()]);
    await adminPool.end();
  });

  async function sqlState(pool: Pool, sql: string, params: unknown[] = []): Promise<string | null> {
    try {
      await pool.query(sql, params);
      return null;
    } catch (err) {
      return (err as { code?: string }).code ?? 'unknown';
    }
  }

  describe('same answers as the platform_ops query it replaces', () => {
    /** What the old code did with the old query's rows: one row, non-terminal status. */
    async function oldAnswer(sandboxName: string) {
      const { rows } = await opsPool.query(OLD_QUERY, [sandboxName]);
      return (rows.length === 1 ? rows : []).filter((r) => isLive(r.status)).map(({ status: _s, ...rest }) => rest);
    }
    async function newAnswer(sandboxName: string) {
      return (await proxyPool.query(NEW_QUERY, [sandboxName])).rows;
    }

    it('a live run: the same row', async () => {
      const sandboxName = `sbx-narrow-live-${randomUUID()}`;
      await seedAgentRun(admin, refs.accountId, { sandboxName, role: 'executor', status: 'running', dispatchRepoId: refs.repoId });
      const expected = await oldAnswer(sandboxName);
      expect(expected).toHaveLength(1);
      expect(await newAnswer(sandboxName)).toEqual(expected);
    });

    it.each(Object.keys(RUN_STATUS_TRANSITIONS))('status %s: resolves exactly when the run state machine says it is not terminal', async (status) => {
      const sandboxName = `sbx-narrow-${status}-${randomUUID()}`;
      await seedAgentRun(admin, refs.accountId, { sandboxName, status, dispatchRepoId: refs.repoId });
      const rows = await newAnswer(sandboxName);
      expect(rows).toHaveLength(isLive(status) ? 1 : 0);
      expect(rows).toEqual(await oldAnswer(sandboxName));
    });

    it('an ended run: the old query still saw it, the new function sees nothing', async () => {
      const sandboxName = `sbx-narrow-ended-${randomUUID()}`;
      await seedAgentRun(admin, refs.accountId, { sandboxName, status: 'succeeded', dispatchRepoId: refs.repoId });
      expect((await opsPool.query(OLD_QUERY, [sandboxName])).rows).toHaveLength(1);
      expect(await newAnswer(sandboxName)).toEqual([]);
      expect(await createRunResolver(proxyPool)(sandboxName)).toBeNull();
    });

    /** 0707: the new rule, stated directly. Ended runs on the name are ignored; the live ones must be exactly one. */
    async function seedRuns(statuses: string[]) {
      const sandboxName = `sbx-narrow-dup-${randomUUID()}`;
      for (const status of statuses) {
        await seedAgentRun(admin, refs.accountId, { sandboxName, status, dispatchRepoId: refs.repoId, role: 'executor' });
      }
      return sandboxName;
    }

    it.each([
      ['one live run and an ended run', ['succeeded', 'running']],
      ['one paused run and two ended runs', ['failed', 'paused', 'cancelled']],
    ])('0707: %s share a name: the live one resolves', async (_label, statuses) => {
      const sandboxName = await seedRuns(statuses);
      // The old query still saw every row and denied; the new function answers with the live run.
      expect((await opsPool.query(OLD_QUERY, [sandboxName])).rows).toHaveLength(statuses.length);
      const rows = await newAnswer(sandboxName);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ role: 'executor', product: 'team', gh_owner: 'acme-corp', gh_name: 'widgets' });
      expect(await createRunResolver(proxyPool)(sandboxName)).not.toBeNull();
    });

    it.each([
      ['two live runs', ['running', 'paused']],
      ['two live runs and an ended run', ['running', 'succeeded', 'pending']],
    ])('0707: %s share a name: nothing (fails closed)', async (_label, statuses) => {
      const sandboxName = await seedRuns(statuses);
      expect(await newAnswer(sandboxName)).toEqual([]);
      expect(await createRunResolver(proxyPool)(sandboxName)).toBeNull();
    });

    it.each([
      ['one ended run', ['succeeded']],
      ['two ended runs', ['failed', 'cancelled']],
    ])('0707: only ended runs (%s): nothing', async (_label, statuses) => {
      const sandboxName = await seedRuns(statuses);
      expect(await newAnswer(sandboxName)).toEqual([]);
      expect(await createRunResolver(proxyPool)(sandboxName)).toBeNull();
    });

    it('an unknown sandbox name: nothing', async () => {
      const sandboxName = `sbx-narrow-unknown-${randomUUID()}`;
      expect(await newAnswer(sandboxName)).toEqual([]);
      expect(await oldAnswer(sandboxName)).toEqual([]);
    });

    it('a run whose dispatch repo belongs to another account: nothing', async () => {
      const victim = await seedAccountWithRepo(admin, 6263);
      await setRepoGithubNames(admin, victim.repoId, 'victim-corp', 'victim-repo');
      const attackerAccountId = randomUUID();
      await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [
        attackerAccountId,
        `cus_test_${attackerAccountId}`,
      ]);
      const sandboxName = `sbx-narrow-foreign-${randomUUID()}`;
      // 0605's same-tenant trigger refuses this row; forge it the way the security review did.
      await admin.query('SET session_replication_role = replica');
      try {
        await admin.query(
          `INSERT INTO agent_runs (id, account_id, role, runtime, status, sandbox_name, dispatch_repo_id)
           VALUES ($1, $2, 'executor', 'production', 'running', $3, $4)`,
          [randomUUID(), attackerAccountId, sandboxName, victim.repoId],
        );
      } finally {
        await admin.query('SET session_replication_role = DEFAULT');
      }
      expect(await newAnswer(sandboxName)).toEqual([]);
      expect(await oldAnswer(sandboxName)).toEqual([]);
    });

    it('a preview run is flagged, and the columns returned are exactly the ones the proxy uses', async () => {
      const sandboxName = `sbx-narrow-preview-${randomUUID()}`;
      const runId = await seedAgentRun(admin, refs.accountId, { sandboxName, status: 'running', dispatchRepoId: refs.repoId });
      await admin.query(
        `INSERT INTO onboarding_previews (account_id, installation_id, repo_id, gh_user_id, gh_installation_id, gh_owner, run_action_id, state, run_id, started_at)
         VALUES ($1, $2, $3, $4, $5, 'acme-corp', $6, 'running', $7, now())`,
        [refs.accountId, refs.installationId, refs.repoId, 20_000_000 + Math.floor(Math.random() * 1_000_000_000), refs.ghInstallationId, randomUUID(), runId],
      );
      const result = await proxyPool.query(NEW_QUERY, [sandboxName]);
      expect(result.rows).toEqual(await oldAnswer(sandboxName));
      expect(result.rows[0].is_preview).toBe(true);
      const cols = await adminPool.query(
        `SELECT a.attname FROM pg_proc p, unnest(p.proargnames) WITH ORDINALITY a(attname, n)
          WHERE p.proname = 'resolve_sandbox_run' AND a.n > 1 ORDER BY a.n`,
      );
      expect(cols.rows.map((r) => r.attname)).toEqual(['role', 'product', 'gh_owner', 'gh_name', 'gh_installation_id', 'app_kind', 'is_preview']);
    });
  });

  describe('the login can do nothing but call the function', () => {
    it('is a LOGIN whose only role is run_binding_resolver, and the group role is NOLOGIN and unprivileged', async () => {
      const members = await adminPool.query(
        `SELECT g.rolname FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
          WHERE m.member = $1::regrole ORDER BY 1`,
        [GH_PROXY_TEST_LOGIN],
      );
      expect(members.rows.map((r) => r.rolname)).toEqual(['run_binding_resolver']);
      const attrs = await adminPool.query(
        `SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = 'run_binding_resolver'`,
      );
      expect(attrs.rows).toEqual([
        { rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false },
      ]);
    });

    it('holds no privilege of any kind on any table, view or sequence, nor on any column', async () => {
      const rel = await adminPool.query(
        `SELECT c.relname FROM pg_class c, aclexplode(c.relacl) a
          WHERE c.relnamespace = 'public'::regnamespace AND a.grantee = 'run_binding_resolver'::regrole::oid`,
      );
      expect(rel.rows).toEqual([]);
      const col = await adminPool.query(
        `SELECT c.relname, t.attname FROM pg_attribute t JOIN pg_class c ON c.oid = t.attrelid, aclexplode(t.attacl) a
          WHERE c.relnamespace = 'public'::regnamespace AND a.grantee = 'run_binding_resolver'::regrole::oid`,
      );
      expect(col.rows).toEqual([]);
      const effective = await adminPool.query(
        `SELECT c.relname FROM pg_class c
          WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND (has_any_column_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
                 OR has_table_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'))`,
        [GH_PROXY_TEST_LOGIN],
      );
      expect(effective.rows).toEqual([]);
    });

    it.each(['agent_runs', 'repos', 'installations', 'accounts', 'onboarding_previews'])('SELECT on %s is refused', async (table) => {
      expect(await sqlState(proxyPool, `SELECT 1 FROM ${table} LIMIT 1`)).toBe('42501');
    });

    it('cannot execute any other function of the schema, beyond the three pure-or-invoker ones every role gets from PUBLIC', async () => {
      // Trigger functions cannot be called by hand, so they are left out.
      const others = await adminPool.query(
        `SELECT p.oid::regprocedure::text AS fn, p.prosecdef FROM pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace AND p.proname <> 'resolve_sandbox_run'
            AND p.prorettype <> 'trigger'::regtype
            AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
            AND has_function_privilege($1, p.oid, 'EXECUTE') ORDER BY 1`,
        [GH_PROXY_TEST_LOGIN],
      );
      // Pinned: a new PUBLIC-executable function, or any SECURITY DEFINER one, turns this red.
      expect(others.rows.map((r) => [r.fn.split('(')[0], r.prosecdef])).toEqual([
        ['account_is_active', false],
        ['compute_account_status', false],
        ['env_secret_credential_shaped', false],
      ]);
      // account_is_active runs with the caller's rights, and the login has no SELECT on accounts.
      expect(await sqlState(proxyPool, `SELECT public.account_is_active(gen_random_uuid())`)).toBe('42501');
    });

    it('cannot create objects', async () => {
      const t = `fx_probe_${randomUUID().slice(0, 8)}`;
      expect(await sqlState(proxyPool, `CREATE TABLE public.${t} (x int)`)).toBe('42501');
      expect(await sqlState(proxyPool, `CREATE FUNCTION public.${t}() RETURNS int LANGUAGE sql AS 'SELECT 1'`)).toBe('42501');
      expect(await sqlState(proxyPool, `CREATE SCHEMA ${t}`)).toBe('42501');
      const priv = await adminPool.query(
        `SELECT has_schema_privilege($1, 'public', 'CREATE') AS schema_create, has_database_privilege($1, current_database(), 'CREATE') AS db_create`,
        [GH_PROXY_TEST_LOGIN],
      );
      expect(priv.rows).toEqual([{ schema_create: false, db_create: false }]);
    });
  });

  describe('a role that already exists when 0696 runs (F2)', () => {
    /** The guard block of the migration: the first DO block that declares variables. */
    const guard = (() => {
      const sql = readFileSync(path.join(__dirname, '../../db/migrations/0696_run_binding_resolver.sql'), 'utf8');
      const m = /DO \$\$\nDECLARE[\s\S]*?\n\$\$;/.exec(sql);
      if (!m) throw new Error('guard block not found in 0696');
      return m[0];
    })();

    async function guardOutcome(setup: string | null): Promise<string | null> {
      const c = await adminPool.connect();
      try {
        await c.query('BEGIN');
        if (setup) await c.query(setup);
        try {
          await c.query(guard);
          return null;
        } catch (err) {
          return (err as Error).message;
        }
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    }

    it('passes on the role as the migration leaves it', async () => {
      expect(await guardOutcome(null)).toBeNull();
    });

    it.each([
      ['a membership', 'GRANT app_user TO run_binding_resolver', 'is a member of another role'],
      ['a table grant', 'GRANT SELECT ON agent_runs TO run_binding_resolver', 'holds a table privilege'],
      ['a column grant', 'GRANT SELECT (id) ON accounts TO run_binding_resolver', 'holds a column privilege'],
      ['EXECUTE on another function', 'GRANT EXECUTE ON FUNCTION public.account_is_active(uuid) TO run_binding_resolver', 'EXECUTE on a function other than'],
      ['a login attribute', 'ALTER ROLE run_binding_resolver LOGIN', 'rolcanlogin'],
    ])('refuses a role that holds %s', async (_label, setup, message) => {
      expect(await guardOutcome(setup)).toContain(message);
    });
  });

  describe('who may call the function', () => {
    it('is a security definer owned by platform_ops with a pinned search_path', async () => {
      const { rows } = await adminPool.query(
        `SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig FROM pg_proc p WHERE p.proname = 'resolve_sandbox_run'`,
      );
      expect(rows).toEqual([{ prosecdef: true, owner: 'platform_ops', proconfig: ['search_path=pg_catalog, public, pg_temp'] }]);
    });

    it('EXECUTE belongs to the owner and run_binding_resolver only: nothing for PUBLIC', async () => {
      const { rows } = await adminPool.query(
        `SELECT CASE a.grantee WHEN 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee
           FROM pg_proc p, aclexplode(p.proacl) a
          WHERE p.proname = 'resolve_sandbox_run' AND a.privilege_type = 'EXECUTE' ORDER BY 1`,
      );
      expect(rows.map((r) => r.grantee)).toEqual(['platform_ops', 'run_binding_resolver']);
    });

    it('app_user and partner_user cannot call it', async () => {
      expect(await sqlState(appPool, NEW_QUERY, ['x'])).toBe('42501');
      const fn = 'public.resolve_sandbox_run(text)';
      const priv = await adminPool.query(
        `SELECT has_function_privilege('app_user', $1, 'EXECUTE') AS app_user,
                has_function_privilege('partner_user', $1, 'EXECUTE') AS partner_user`,
        [fn],
      );
      expect(priv.rows).toEqual([{ app_user: false, partner_user: false }]);
    });
  });
});
