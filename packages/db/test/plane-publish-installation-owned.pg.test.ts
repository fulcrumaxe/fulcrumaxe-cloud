import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { nextGhInstallationId } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

const ROLE = 'plane_publish_owner_definer';
const FN = 'plane_publish_installation_owned(text, bigint)';
const PROXY_LOGIN = 'fx_ppown_test_login';

/** Everything the role holds, exactly: column SELECT on what the body reads, and the schema. */
const EXPECTED_PRIVILEGES = [
  ...['account_id', 'role', 'status', 'sandbox_name'].map((c) => `column agent_runs.${c} SELECT`),
  ...['account_id', 'gh_installation_id', 'app_kind'].map((c) => `column installations.${c} SELECT`),
  ...['gh_installation_id', 'app_kind', 'deleted_at', 'suspended_at'].map((c) => `column installation_installers.${c} SELECT`),
  'schema public USAGE',
].sort();

describe('migration 0908: plane_publish_installation_owned (D#598 PUSH-OWNER-SANDBOX-DEFINER)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let proxyPool: Pool;
  let opsPool: Pool;
  let appPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DROP ROLE IF EXISTS ${PROXY_LOGIN}`);
    await admin.query(`CREATE ROLE ${PROXY_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    await admin.query(`GRANT run_binding_resolver TO ${PROXY_LOGIN}`);
    const u = new URL(process.env.DATABASE_URL!);
    u.username = PROXY_LOGIN;
    u.password = '';
    proxyPool = createPool(u.toString());
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
  });
  afterAll(async () => {
    await Promise.all([proxyPool.end(), opsPool.end(), appPool.end()]);
    await admin.query(`REVOKE run_binding_resolver FROM ${PROXY_LOGIN}`);
    await admin.query(`DROP ROLE ${PROXY_LOGIN}`);
    admin.release();
    await adminPool.end();
  });

  const account = async (): Promise<string> => {
    const id = randomUUID();
    await admin.query(`INSERT INTO accounts (id, plan, stripe_customer_id, status) VALUES ($1, 'starter', $2, 'active')`, [id, `cus_test_${id}`]);
    return id;
  };
  async function installation(accountId: string, installer: 'live' | 'deleted' | 'suspended' | 'none' = 'live', kind: 'team' | 'team_readonly' = 'team'): Promise<number> {
    const gh = Number(nextGhInstallationId());
    await admin.query(`INSERT INTO installations (id, account_id, gh_installation_id, app_kind) VALUES ($1, $2, $3, $4)`, [randomUUID(), accountId, gh, kind]);
    if (installer !== 'none') {
      await admin.query(`INSERT INTO installation_installers (gh_installation_id, app_kind, installer_gh_user_id, deleted_at, suspended_at) VALUES ($1, $2, 1, $3, $4)`, [
        gh, kind, installer === 'deleted' ? new Date() : null, installer === 'suspended' ? new Date() : null,
      ]);
    }
    return gh;
  }
  const run = async (accountId: string, o: { role?: string; status?: string; name?: string } = {}): Promise<string> => {
    const name = o.name ?? `pp-${randomUUID()}`;
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status, sandbox_name) VALUES ($1, $2, $3, 'production', $4, $5)`, [randomUUID(), accountId, o.role ?? 'plane_publish', o.status ?? 'running', name]);
    return name;
  };
  const ask = async (name: string | null, gh: number | null, pool: Pool = proxyPool): Promise<boolean> =>
    (await pool.query<{ owned: boolean }>('SELECT plane_publish_installation_owned($1, $2) AS owned', [name, gh])).rows[0]!.owned;

  describe('what it answers', () => {
    it("is true for any live team installation of the run's own account, whichever it is", async () => {
      const a = await account();
      const first = await installation(a);
      const second = await installation(a);
      const name = await run(a);
      expect(await ask(name, first)).toBe(true);
      expect(await ask(name, second)).toBe(true);
    });

    it("is false for another account's live installation, and for an id that is no installation", async () => {
      const a = await account();
      const b = await account();
      const theirs = await installation(b);
      const name = await run(a);
      expect(await ask(name, theirs)).toBe(false);
      expect(await ask(name, Number(nextGhInstallationId()))).toBe(false);
    });

    it.each(['deleted', 'suspended', 'none'] as const)('is false for an installation of the same account whose installer record is %s', async (installer) => {
      const a = await account();
      const gh = await installation(a, installer);
      expect(await ask(await run(a), gh)).toBe(false);
    });

    it('is false for another App kind, and for pending, running and paused runs alike only when the run is a live plane_publish run', async () => {
      const a = await account();
      expect(await ask(await run(a), await installation(a, 'live', 'team_readonly'))).toBe(false);
      const gh = await installation(a);
      for (const status of ['pending', 'running', 'paused']) expect(await ask(await run(a, { status }), gh), status).toBe(true);
      for (const status of ['succeeded', 'failed', 'cancelled']) expect(await ask(await run(a, { status }), gh), status).toBe(false);
      expect(await ask(await run(a, { role: 'executor' }), gh)).toBe(false);
    });

    it('is false with no run to name the account: an unknown name, a null name, two live runs under one name', async () => {
      const a = await account();
      const gh = await installation(a);
      expect(await ask(`pp-${randomUUID()}`, gh)).toBe(false);
      expect(await ask(null, gh)).toBe(false);
      expect(await ask('', gh)).toBe(false);
      const dup = await run(a);
      await run(a, { name: dup });
      expect(await ask(dup, gh)).toBe(false);
      const other = await account();
      const dup2 = await run(a);
      await run(other, { name: dup2 });
      expect(await ask(dup2, gh)).toBe(false);
    });

    it('is false for a null or non-positive installation id', async () => {
      const a = await account();
      const name = await run(a);
      for (const id of [null, 0, -5]) expect(await ask(name, id), String(id)).toBe(false);
    });

    it('follows the rows at once: suspending the installer record or deleting the installation takes ownership away', async () => {
      const a = await account();
      const gh = await installation(a);
      const name = await run(a);
      expect(await ask(name, gh)).toBe(true);
      await admin.query(`UPDATE installation_installers SET suspended_at = now() WHERE gh_installation_id = $1 AND app_kind = 'team'`, [gh]);
      expect(await ask(name, gh)).toBe(false);
      await admin.query(`UPDATE installation_installers SET suspended_at = NULL, deleted_at = now() WHERE gh_installation_id = $1 AND app_kind = 'team'`, [gh]);
      expect(await ask(name, gh)).toBe(false);
      await admin.query(`UPDATE installation_installers SET deleted_at = NULL WHERE gh_installation_id = $1 AND app_kind = 'team'`, [gh]);
      expect(await ask(name, gh)).toBe(true);
      await admin.query(`DELETE FROM installations WHERE gh_installation_id = $1 AND app_kind = 'team'`, [gh]);
      expect(await ask(name, gh)).toBe(false);
    });
  });

  describe('the account is the run\'s, never the caller\'s', () => {
    it('a tenant the caller sets on its own session changes nothing, and is back as it was after the call', async () => {
      const a = await account();
      const b = await account();
      const mine = await installation(a);
      const theirs = await installation(b);
      const name = await run(a);
      const c = await proxyPool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT set_config('app.account_id', $1, true)`, [b]);
        expect((await c.query('SELECT plane_publish_installation_owned($1, $2) AS owned', [name, theirs])).rows[0].owned).toBe(false);
        expect((await c.query('SELECT plane_publish_installation_owned($1, $2) AS owned', [name, mine])).rows[0].owned).toBe(true);
        expect((await c.query(`SELECT current_setting('app.account_id', true) AS t`)).rows[0].t).toBe(b);
        await c.query('ROLLBACK');
        await c.query('BEGIN');
        await c.query('SELECT plane_publish_installation_owned($1, $2)', [name, mine]);
        expect([null, '']).toContain((await c.query(`SELECT current_setting('app.account_id', true) AS t`)).rows[0].t);
        await c.query('ROLLBACK');
      } finally {
        c.release();
      }
    });

    it('the role itself sees no installation and no installer record without a tenant, and only its own tenant\'s with one', async () => {
      const a = await account();
      const b = await account();
      const mine = await installation(a);
      const theirs = await installation(b);
      const seen = async (tenant: string | null) => {
        await admin.query('BEGIN');
        try {
          await admin.query(`SET LOCAL ROLE ${ROLE}`);
          if (tenant) await admin.query(`SELECT set_config('app.account_id', $1, true)`, [tenant]);
          const inst = await admin.query<{ g: string }>('SELECT gh_installation_id::text AS g FROM installations WHERE gh_installation_id = ANY($1::bigint[])', [[mine, theirs]]);
          const inst2 = await admin.query<{ g: string }>('SELECT gh_installation_id::text AS g FROM installation_installers WHERE gh_installation_id = ANY($1::bigint[])', [[mine, theirs]]);
          return [inst.rows.map((r) => Number(r.g)).sort(), inst2.rows.map((r) => Number(r.g)).sort()];
        } finally {
          await admin.query('ROLLBACK');
        }
      };
      expect(await seen(null)).toEqual([[], []]);
      expect(await seen(a)).toEqual([[mine], [mine]]);
      expect(await seen(b)).toEqual([[theirs], [theirs]]);
      expect(await seen(randomUUID())).toEqual([[], []]);
    });
  });

  describe('who may call it, and what the role holds', () => {
    it('only run_binding_resolver (and the owner) may execute it; app_user, agent_run_writer, platform_ops and partner_user may not', async () => {
      const { rows } = await admin.query(
        `SELECT p.prosecdef, p.provolatile, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
                (SELECT array_agg(DISTINCT pg_get_userbyid(a.grantee)::text ORDER BY pg_get_userbyid(a.grantee)::text) FROM aclexplode(p.proacl) a) AS grantees,
                EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.is_grantable) AS grantable
           FROM pg_proc p WHERE p.oid = $1::regprocedure`,
        [FN],
      );
      expect(rows[0]).toEqual({ prosecdef: true, provolatile: 'v', proconfig: ['search_path=pg_catalog, public, pg_temp'], owner: ROLE, grantees: [ROLE, 'run_binding_resolver'].sort(), grantable: false });
      for (const who of ['app_user', 'agent_run_writer', 'platform_ops', 'partner_user']) {
        expect((await admin.query(`SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok`, [who, FN])).rows[0].ok, who).toBe(false);
      }
      for (const pool of [appPool, opsPool]) {
        await expect(pool.query('SELECT plane_publish_installation_owned($1, 1)', ['x'])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });

    it('the proxy login still reads no table: the function is the only door', async () => {
      for (const table of ['installations', 'installation_installers', 'agent_runs']) {
        await expect(proxyPool.query(`SELECT 1 FROM ${table} LIMIT 1`), table).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });

    it('the role is NOLOGIN, unprivileged, has no members and no memberships, and holds exactly the column SELECTs the body reads', async () => {
      const r = (await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1`, [ROLE])).rows[0];
      expect(Object.values(r)).toEqual([false, false, false, false, false, false]);
      expect((await admin.query(`SELECT count(*)::int AS n FROM pg_auth_members WHERE roleid = $1::regrole OR member = $1::regrole`, [ROLE])).rows[0].n).toBe(0);
      const held = await admin.query<{ x: string }>(
        `WITH r AS (SELECT oid FROM pg_roles WHERE rolname = $1)
         SELECT 'table ' || c.relname || ' ' || a.privilege_type AS x FROM pg_class c, aclexplode(c.relacl) a, r WHERE a.grantee = r.oid
         UNION ALL SELECT 'column ' || c.relname || '.' || t.attname || ' ' || a.privilege_type FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a, r WHERE a.grantee = r.oid
         UNION ALL SELECT 'schema ' || n.nspname || ' ' || a.privilege_type FROM pg_namespace n, aclexplode(n.nspacl) a, r WHERE a.grantee = r.oid AND n.nspname = 'public'`,
        [ROLE],
      );
      expect(held.rows.map((x) => x.x).sort()).toEqual(EXPECTED_PRIVILEGES);
      const owned = await admin.query<{ s: string }>(`SELECT p.oid::regprocedure::text AS s FROM pg_proc p WHERE p.proowner = $1::regrole`, [ROLE]);
      expect(owned.rows.map((x) => x.s)).toEqual([`${FN.replace(', ', ',')}`]);
      expect((await admin.query(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS ok`, [ROLE])).rows[0].ok).toBe(false);
    });

    it('its policies are its own, SELECT only, and the two tenant ones read app.account_id', async () => {
      const { rows } = await admin.query<{ tablename: string; cmd: string; roles: string[]; qual: string }>(
        `SELECT tablename, cmd, roles::text[] AS roles, qual FROM pg_policies WHERE policyname = 'plane_publish_owner_definer_select' ORDER BY tablename`,
      );
      expect(rows.map((r) => [r.tablename, r.cmd, r.roles])).toEqual([
        ['agent_runs', 'SELECT', [ROLE]],
        ['installation_installers', 'SELECT', [ROLE]],
        ['installations', 'SELECT', [ROLE]],
      ]);
      for (const r of rows.filter((x) => x.tablename !== 'agent_runs')) expect(r.qual).toContain("current_setting('app.account_id'");
      // platform_ops and app_user gained no policy from this migration.
      const others = await admin.query(`SELECT 1 FROM pg_policies WHERE policyname = 'plane_publish_owner_definer_select' AND NOT (roles = ARRAY[$1]::name[])`, [ROLE]);
      expect(others.rowCount).toBe(0);
    });
  });
});
