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
import { PG_ERROR } from './helpers/pgErrors.js';
import { provisionEphemeralPostgres, type EphemeralPostgres } from './support/ephemeral-pg.js';
import { guardPoolTeardown, type PoolTeardownGuard } from './support/pool-teardown.js';

const MIGRATION = '0765_runner_git_path_a.sql';
const ROLE = 'runner_git_definer';
const FN = 'resolve_runner_git_request(uuid,uuid,uuid,integer,uuid,boolean)';
const PROXY_LOGIN = 'fx_rgit_test_login';

/** Everything the role holds, exactly (C27 section 3.5: column SELECT only, plus the counter table). */
const EXPECTED_PRIVILEGES = [
  ...['id', 'account_id', 'runner_id', 'lease_generation', 'lease_expires_at', 'status', 'runtime', 'execution_mode', 'role', 'dispatch_repo_id'].map((c) => `column agent_runs.${c} SELECT`),
  ...['id', 'account_id', 'revoked_at'].map((c) => `column runners.${c} SELECT`),
  ...['id', 'account_id', 'gh_owner', 'gh_name', 'installation_id', 'product'].map((c) => `column repos.${c} SELECT`),
  ...['id', 'account_id', 'gh_installation_id', 'app_kind'].map((c) => `column installations.${c} SELECT`),
  'table runner_git_full_clones SELECT', 'table runner_git_full_clones INSERT', 'table runner_git_full_clones UPDATE', 'table runner_git_full_clones DELETE',
  'schema public USAGE',
].sort();

interface Answer {
  verdict: string;
  role: string | null;
  product: string | null;
  gh_owner: string | null;
  gh_name: string | null;
  gh_installation_id: string | null;
  app_kind: string | null;
}

describe(`migration 0765: ${ROLE}, resolve_runner_git_request and the clone counter (D#6 R5a-2a, C27 section 3)`, () => {
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

  interface World {
    refs: SeedRefs;
    runner: string;
    run: string;
    owner: string;
    name: string;
    ghInstallationId: number;
  }

  /** An account with a repo that has a GitHub name and an installation, a runner, and a live 'runner_verified' run leased to it. */
  async function world(o: { mode?: string | null; runtime?: string; status?: string; lease?: string; repo?: boolean; generation?: number } = {}): Promise<World> {
    const refs = await seedAccount(admin, randomUUID());
    const owner = `acme-${randomUUID().slice(0, 8)}`;
    const name = `widgets-${randomUUID().slice(0, 8)}`;
    const ghInstallationId = 1_000_000 + Math.floor(Math.random() * 900_000_000);
    await admin.query(`UPDATE repos SET gh_owner = $2, gh_name = $3 WHERE id = $1`, [refs.repoId, owner, name]);
    await admin.query(`UPDATE installations SET gh_installation_id = $2, app_kind = 'team' WHERE id = $1`, [refs.installationId, ghInstallationId]);
    const runner = await insertRunner(admin, refs.accountId, refs.userId);
    const run = randomUUID();
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, runner_id, lease_generation, lease_expires_at, dispatch_repo_id)
       VALUES ($1, $2, 'executor', $3, $4, $5, $6, $7, ${o.lease ?? "now() + interval '10 minutes'"}, $8)`,
      [run, refs.accountId, o.runtime ?? 'runner', o.status ?? 'running', o.mode === undefined ? 'runner_verified' : o.mode, runner, o.generation ?? 1, o.repo === false ? null : refs.repoId],
    );
    return { refs, runner, run, owner, name, ghInstallationId };
  }

  async function resolve(w: World, o: { runner?: string; account?: string; run?: string; generation?: number; repo?: string; fullClone?: boolean } = {}): Promise<Answer> {
    const { rows } = await proxyPool.query<Answer>(`SELECT * FROM resolve_runner_git_request($1, $2, $3, $4, $5, $6)`, [
      o.runner ?? w.runner, o.account ?? w.refs.accountId, o.run ?? w.run, o.generation ?? 1, o.repo ?? w.refs.repoId, o.fullClone ?? false,
    ]);
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }
  const todayRows = async (w: World) => (await admin.query<{ full_clones: number }>(`SELECT full_clones FROM runner_git_full_clones WHERE repo_id = $1 AND utc_day = (now() AT TIME ZONE 'UTC')::date`, [w.refs.repoId])).rows;
  const EMPTY = { role: null, product: null, gh_owner: null, gh_name: null, gh_installation_id: null, app_kind: null };

  describe('the verdicts, in the order C27 section 3.2 gives', () => {
    it('ok: answers the role, product, owner, name, installation and app kind', async () => {
      const w = await world();
      expect(await resolve(w)).toEqual({ verdict: 'ok', role: 'executor', product: 'team', gh_owner: w.owner, gh_name: w.name, gh_installation_id: String(w.ghInstallationId), app_kind: 'team' });
    });

    it('unknown: no such run in the account (a run id of another account is unknown too)', async () => {
      const w = await world();
      const other = await world();
      expect(await resolve(w, { run: randomUUID() })).toEqual({ verdict: 'unknown', ...EMPTY });
      expect(await resolve(w, { run: other.run })).toEqual({ verdict: 'unknown', ...EMPTY });
      expect(await resolve(w, { account: other.refs.accountId })).toEqual({ verdict: 'unknown', ...EMPTY });
    });

    it('stale: another runner or another generation', async () => {
      const w = await world();
      const otherRunner = await insertRunner(admin, w.refs.accountId, w.refs.userId);
      expect(await resolve(w, { runner: otherRunner })).toEqual({ verdict: 'stale', ...EMPTY });
      expect(await resolve(w, { generation: 2 })).toEqual({ verdict: 'stale', ...EMPTY });
    });

    it('not_running: a finished or cancelled run, and the lease of an ended run is not read', async () => {
      const w = await world({ status: 'cancelled' });
      expect(await resolve(w)).toEqual({ verdict: 'not_running', ...EMPTY });
    });

    it('revoked: the runner row is revoked', async () => {
      const w = await world();
      await admin.query(`UPDATE runners SET revoked_at = now(), revoked_reason = 'user_revoked' WHERE id = $1`, [w.runner]);
      expect(await resolve(w)).toEqual({ verdict: 'revoked', ...EMPTY });
    });

    it('expired: a lease at or before the database clock (the caller supplies no time)', async () => {
      expect(await resolve(await world({ lease: 'now()' }))).toEqual({ verdict: 'expired', ...EMPTY });
      expect(await resolve(await world({ lease: "now() - interval '1 second'" }))).toEqual({ verdict: 'expired', ...EMPTY });
      const noLease = await world();
      await admin.query(`SET session_replication_role = replica`);
      try {
        await admin.query(`UPDATE agent_runs SET lease_expires_at = NULL WHERE id = $1`, [noLease.run]);
      } finally {
        await admin.query(`SET session_replication_role = DEFAULT`);
      }
      expect(await resolve(noLease)).toEqual({ verdict: 'expired', ...EMPTY });
    });

    it('expired: a lease that ends at this very instant (the boundary is inclusive)', async () => {
      const w = await world();
      const c = await adminPool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`UPDATE agent_runs SET lease_expires_at = now() WHERE id = $1`, [w.run]); // now() is the transaction's start, as in the function
        const { rows } = await c.query<Answer>(`SELECT * FROM resolve_runner_git_request($1, $2, $3, 1, $4, false)`, [w.runner, w.refs.accountId, w.run, w.refs.repoId]);
        expect(rows).toEqual([{ verdict: 'expired', ...EMPTY }]);
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    });

    it('not_verified: the run mode is runner_local or unset, or the runtime is not a runner', async () => {
      expect(await resolve(await world({ mode: 'runner_local' }))).toEqual({ verdict: 'not_verified', ...EMPTY });
      expect(await resolve(await world({ mode: null }))).toEqual({ verdict: 'not_verified', ...EMPTY });
      expect(await resolve(await world({ mode: 'sandbox', runtime: 'production' }))).toEqual({ verdict: 'not_verified', ...EMPTY });
    });

    it('no_repo: another repo asked, no dispatch repo, a repo without owner or name, or a missing installation', async () => {
      const w = await world();
      const other = await world();
      expect(await resolve(w, { repo: other.refs.repoId })).toEqual({ verdict: 'no_repo', ...EMPTY });
      expect(await resolve(w, { repo: randomUUID() })).toEqual({ verdict: 'no_repo', ...EMPTY });
      expect(await resolve(await world({ repo: false }), { repo: w.refs.repoId })).toEqual({ verdict: 'no_repo', ...EMPTY });
      for (const column of ['gh_owner', 'gh_name']) {
        const nameless = await world();
        await admin.query(`UPDATE repos SET ${column} = NULL WHERE id = $1`, [nameless.refs.repoId]);
        expect((await resolve(nameless)).verdict, column).toBe('no_repo');
      }
      const unlinked = await world();
      await admin.query(`UPDATE repos SET installation_id = NULL WHERE id = $1`, [unlinked.refs.repoId]);
      expect((await resolve(unlinked)).verdict).toBe('no_repo');
    });

    it('installation_ambiguous: the same gh_installation_id on another installation (0707 guard)', async () => {
      const w = await world();
      const other = await world();
      await admin.query(`UPDATE installations SET gh_installation_id = $2, app_kind = 'team_readonly' WHERE id = $1`, [other.refs.installationId, w.ghInstallationId]);
      expect(await resolve(w)).toEqual({ verdict: 'installation_ambiguous', ...EMPTY });
      expect(await resolve(other)).toEqual({ verdict: 'installation_ambiguous', ...EMPTY });
    });

    it('clone_limited: the fourth full clone of the day, and only when a full clone is asked for', async () => {
      const w = await world();
      for (let i = 1; i <= 3; i++) expect((await resolve(w, { fullClone: true })).verdict).toBe('ok');
      expect(await resolve(w, { fullClone: true })).toEqual({ verdict: 'clone_limited', ...EMPTY });
      expect((await resolve(w, { fullClone: false })).verdict).toBe('ok'); // fetches and pushes are never counted
      expect(await todayRows(w)).toEqual([{ full_clones: 3 }]);
    });

    it('answers the earlier verdict when several apply, one condition at a time', async () => {
      // Every fixture below also breaks all the later conditions; only the first of them is answered.
      const stale = await world({ status: 'cancelled', mode: 'runner_local', lease: 'now()', repo: false });
      expect((await resolve(stale, { generation: 9, repo: randomUUID(), fullClone: true })).verdict).toBe('stale');
      const ended = await world({ status: 'cancelled', mode: 'runner_local', lease: 'now()', repo: false });
      expect((await resolve(ended, { repo: randomUUID(), fullClone: true })).verdict).toBe('not_running');
      const revoked = await world({ mode: 'runner_local', lease: 'now()', repo: false });
      await admin.query(`UPDATE runners SET revoked_at = now(), revoked_reason = 'user_revoked' WHERE id = $1`, [revoked.runner]);
      expect((await resolve(revoked, { repo: randomUUID(), fullClone: true })).verdict).toBe('revoked');
      const expired = await world({ mode: 'runner_local', lease: 'now()', repo: false });
      expect((await resolve(expired, { repo: randomUUID(), fullClone: true })).verdict).toBe('expired');
      const unverified = await world({ mode: 'runner_local', repo: false });
      expect((await resolve(unverified, { repo: randomUUID(), fullClone: true })).verdict).toBe('not_verified');
      const norepo = await world();
      const dup = await world();
      await admin.query(`UPDATE installations SET gh_installation_id = $2, app_kind = 'team_readonly' WHERE id = $1`, [dup.refs.installationId, norepo.ghInstallationId]);
      await admin.query(`UPDATE repos SET gh_name = NULL WHERE id = $1`, [norepo.refs.repoId]);
      expect((await resolve(norepo, { fullClone: true })).verdict).toBe('no_repo');
      const ambiguous = await world();
      const dup2 = await world();
      await admin.query(`UPDATE installations SET gh_installation_id = $2, app_kind = 'team_readonly' WHERE id = $1`, [dup2.refs.installationId, ambiguous.ghInstallationId]);
      for (let i = 0; i < 3; i++) await admin.query(`INSERT INTO runner_git_full_clones (account_id, repo_id, utc_day, full_clones) VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date, 3) ON CONFLICT (repo_id, utc_day) DO NOTHING`, [ambiguous.refs.accountId, ambiguous.refs.repoId]);
      expect((await resolve(ambiguous, { fullClone: true })).verdict).toBe('installation_ambiguous');
      const limited = await world();
      await admin.query(`INSERT INTO runner_git_full_clones (account_id, repo_id, utc_day, full_clones) VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date, 3)`, [limited.refs.accountId, limited.refs.repoId]);
      expect((await resolve(limited, { fullClone: true })).verdict).toBe('clone_limited');
    });

    it('rejects a missing or negative argument with 22023, and a platform_ops session with 42501, whatever it passes', async () => {
      const w = await world();
      const call = (args: unknown[]) => proxyPool.query(`SELECT * FROM resolve_runner_git_request($1, $2, $3, $4, $5, $6)`, args);
      const base = [w.runner, w.refs.accountId, w.run, 1, w.refs.repoId, false];
      for (let i = 0; i < base.length; i++) {
        await expect(call(base.map((v, j) => (j === i ? null : v)))).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      }
      await expect(call([w.runner, w.refs.accountId, w.run, -1, w.refs.repoId, false])).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      // platform_ops holds no EXECUTE, so the function's own refusal is reached only with one granted for this probe.
      await admin.query(`GRANT EXECUTE ON FUNCTION ${FN} TO platform_ops`);
      try {
        await expect(opsPool.query(`SELECT * FROM resolve_runner_git_request($1, $2, $3, $4, $5, $6)`, base)).rejects.toMatchObject({
          code: PG_ERROR.INSUFFICIENT_PRIVILEGE,
          message: expect.stringMatching(/refused for a platform_ops login/),
        });
      } finally {
        await admin.query(`REVOKE EXECUTE ON FUNCTION ${FN} FROM platform_ops`);
      }
    });
  });

  describe('the daily full-clone count (C27 sections 2.3, 3.2 and 5)', () => {
    it('four concurrent full clones give exactly three ok and one clone_limited, and the count is 3', async () => {
      const w = await world();
      const answers = await Promise.all([1, 2, 3, 4].map(() => resolve(w, { fullClone: true })));
      expect(answers.filter((a) => a.verdict === 'ok')).toHaveLength(3);
      expect(answers.filter((a) => a.verdict === 'clone_limited')).toHaveLength(1);
      expect(await todayRows(w)).toEqual([{ full_clones: 3 }]);
    });

    it('the next UTC day starts again from zero', async () => {
      const w = await world();
      for (let i = 0; i < 3; i++) await resolve(w, { fullClone: true });
      expect((await resolve(w, { fullClone: true })).verdict).toBe('clone_limited');
      await admin.query(`UPDATE runner_git_full_clones SET utc_day = utc_day - 1 WHERE repo_id = $1`, [w.refs.repoId]);
      expect((await resolve(w, { fullClone: true })).verdict).toBe('ok');
      expect(await todayRows(w)).toEqual([{ full_clones: 1 }]);
      const { rows } = await admin.query(`SELECT utc_day FROM runner_git_full_clones WHERE repo_id = $1`, [w.refs.repoId]);
      expect(rows).toHaveLength(2); // yesterday's row is kept for now
    });

    it('a call that counts deletes that repository\'s rows older than two days, and no other repository\'s', async () => {
      const w = await world();
      const other = await world();
      for (const [repo, account, back] of [[w.refs.repoId, w.refs.accountId, 3], [w.refs.repoId, w.refs.accountId, 2], [other.refs.repoId, other.refs.accountId, 5]] as const) {
        await admin.query(`INSERT INTO runner_git_full_clones (account_id, repo_id, utc_day, full_clones) VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date - $3::int, 1)`, [account, repo, back]);
      }
      expect((await resolve(w, { fullClone: false })).verdict).toBe('ok'); // a fetch deletes nothing
      expect((await admin.query(`SELECT 1 FROM runner_git_full_clones WHERE repo_id = $1`, [w.refs.repoId])).rowCount).toBe(2);
      expect((await resolve(w, { fullClone: true })).verdict).toBe('ok');
      const days = (await admin.query<{ back: number }>(`SELECT ((now() AT TIME ZONE 'UTC')::date - utc_day)::int AS back FROM runner_git_full_clones WHERE repo_id = $1 ORDER BY 1`, [w.refs.repoId])).rows;
      expect(days.map((d) => d.back)).toEqual([0, 2]);
      expect((await admin.query(`SELECT 1 FROM runner_git_full_clones WHERE repo_id = $1`, [other.refs.repoId])).rowCount).toBe(1);
    });

    it('a refused request counts nothing, and a clone_limited one writes nothing', async () => {
      const w = await world();
      await resolve(w, { generation: 5, fullClone: true });
      await resolve(w, { run: randomUUID(), fullClone: true });
      expect(await todayRows(w)).toEqual([]);
      await admin.query(`INSERT INTO runner_git_full_clones (account_id, repo_id, utc_day, full_clones) VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date, 3)`, [w.refs.accountId, w.refs.repoId]);
      await resolve(w, { fullClone: true });
      expect(await todayRows(w)).toEqual([{ full_clones: 3 }]);
    });

    it('is bounded by the table itself, and deleting the repository removes its rows', async () => {
      const w = await world();
      await resolve(w, { fullClone: true });
      await expect(admin.query(`UPDATE runner_git_full_clones SET full_clones = 4 WHERE repo_id = $1`, [w.refs.repoId])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(admin.query(`INSERT INTO runner_git_full_clones (account_id, repo_id, utc_day, full_clones) VALUES ($1, $2, '2020-01-01', 1)`, [randomUUID(), w.refs.repoId])).rejects.toMatchObject({ code: PG_ERROR.FOREIGN_KEY_VIOLATION });
      const spare = randomUUID();
      await admin.query(`INSERT INTO repos (id, account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, $3, 2, 'team')`, [spare, w.refs.accountId, w.refs.installationId]);
      await admin.query(`INSERT INTO runner_git_full_clones (account_id, repo_id, utc_day, full_clones) VALUES ($1, $2, (now() AT TIME ZONE 'UTC')::date, 2)`, [w.refs.accountId, spare]);
      await admin.query(`DELETE FROM repos WHERE id = $1`, [spare]);
      expect((await admin.query(`SELECT 1 FROM runner_git_full_clones WHERE repo_id = $1`, [spare])).rowCount).toBe(0);
    });
  });

  describe('the execution_mode constraints (C27 section 3.1)', () => {
    it("agent_runs accepts 'runner_verified' for a runner run, and refuses it for any other runtime", async () => {
      const refs = await seedAccount(admin, randomUUID());
      const insert = (runtime: string, mode: string) =>
        admin.query(`INSERT INTO agent_runs (account_id, role, runtime, status, execution_mode) VALUES ($1, 'executor', $2, 'pending', $3)`, [refs.accountId, runtime, mode]);
      await insert('runner', 'runner_verified');
      for (const runtime of ['production', 'local']) {
        await expect(insert(runtime, 'runner_verified'), runtime).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION, constraint: 'agent_runs_runner_verified_runtime_check' });
      }
      await expect(insert('runner', 'runner_remote')).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION, constraint: 'agent_runs_execution_mode_check' });
    });

    it("repos.execution_mode accepts 'runner_verified' since 0771 (the route still refuses it until R5b-2b), and refuses any other word", async () => {
      const refs = await seedAccount(admin, randomUUID());
      await admin.query(`UPDATE repos SET execution_mode = 'runner_verified' WHERE id = $1`, [refs.repoId]);
      await expect(admin.query(`UPDATE repos SET execution_mode = 'runner_other' WHERE id = $1`, [refs.repoId])).rejects.toMatchObject({
        code: PG_ERROR.CHECK_VIOLATION,
        constraint: 'repos_execution_mode_check',
      });
    });
  });

  describe('the role', () => {
    it('is NOLOGIN and unprivileged, has no member and is a member of nothing, and owns exactly its one function', async () => {
      const { rows } = await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1`, [ROLE]);
      expect(rows[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
      expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE roleid = $1::regrole`, [ROLE])).rowCount, 'members').toBe(0);
      expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE member = $1::regrole`, [ROLE])).rowCount, 'member of').toBe(0);
      const owned = await admin.query<{ sig: string }>(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proowner = $1::regrole`, [ROLE]);
      expect(owned.rows.map((r) => r.sig)).toEqual([FN]);
      const objects = await admin.query(`SELECT 1 FROM pg_class WHERE relowner = $1::regrole UNION ALL SELECT 1 FROM pg_namespace WHERE nspowner = $1::regrole`, [ROLE]);
      expect(objects.rowCount, 'other objects').toBe(0);
      expect((await admin.query(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS ok`, [ROLE])).rows[0].ok).toBe(false);
    });

    it('holds exactly the column SELECT grants the body reads, plus the counter table, and nothing table-wide elsewhere', async () => {
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
      const { rows } = await admin.query<{ tablename: string; cmd: string; roles: string[] }>(`SELECT tablename, cmd, roles::text[] AS roles FROM pg_policies WHERE schemaname = 'public' AND $1 = ANY(roles) ORDER BY tablename, cmd`, [ROLE]);
      expect(rows.map((r) => `${r.tablename} ${r.cmd}`)).toEqual([
        'agent_runs SELECT',
        'installations SELECT',
        'repos SELECT',
        'runner_git_full_clones DELETE',
        'runner_git_full_clones INSERT',
        'runner_git_full_clones SELECT',
        'runner_git_full_clones UPDATE',
        'runners SELECT',
      ]);
      for (const p of rows) expect(p.roles).toEqual([ROLE]);
    });

    it('the counter table is row-secured and forced, and no other role can touch it', async () => {
      const { rows } = await admin.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'runner_git_full_clones'::regclass`);
      expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      for (const who of ['app_user', 'platform_ops', 'partner_user', 'agent_run_writer', 'run_binding_resolver', PROXY_LOGIN]) {
        const { rows: priv } = await admin.query(`SELECT has_any_column_privilege($1, 'runner_git_full_clones', 'SELECT, INSERT, UPDATE, REFERENCES') AS ok`, [who]);
        expect(priv[0].ok, who).toBe(false);
      }
    });
  });

  describe('who may call the function', () => {
    it('is a SECURITY DEFINER with a pinned search_path, owned by the role, and EXECUTE is held by run_binding_resolver and the owner only', async () => {
      const { rows } = await admin.query<{ prosecdef: boolean; provolatile: string; proconfig: string[]; owner: string; grantees: string[]; grantable: boolean }>(
        `SELECT p.prosecdef, p.provolatile, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
                coalesce((SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END)
                            FROM aclexplode(p.proacl) a), '{}') AS grantees,
                coalesce((SELECT bool_or(a.is_grantable) FROM aclexplode(p.proacl) a), false) AS grantable
           FROM pg_proc p WHERE p.oid = $1::regprocedure`,
        [FN],
      );
      expect(rows[0]).toEqual({ prosecdef: true, provolatile: 'v', proconfig: ['search_path=pg_catalog, public, pg_temp'], owner: ROLE, grantees: [ROLE, 'run_binding_resolver'].sort(), grantable: false });
    });

    it('run_binding_resolver holds EXECUTE on exactly resolve_sandbox_run, resolve_runner_git_request and (0766) runner_git_bytes_account', async () => {
      const { rows } = await admin.query<{ proname: string }>(`SELECT DISTINCT p.proname FROM pg_proc p, aclexplode(p.proacl) a WHERE a.grantee = 'run_binding_resolver'::regrole::oid AND a.privilege_type = 'EXECUTE' ORDER BY 1`);
      expect(rows.map((r) => r.proname)).toEqual(['resolve_runner_git_request', 'resolve_sandbox_run', 'runner_git_bytes_account']);
    });

    it('app_user, agent_run_writer, platform_ops and partner_user cannot execute it, and calling it as app_user or platform_ops is refused', async () => {
      for (const who of ['app_user', 'agent_run_writer', 'platform_ops', 'partner_user']) {
        expect((await admin.query(`SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok`, [who, FN])).rows[0].ok, who).toBe(false);
      }
      const args = [randomUUID(), randomUUID(), randomUUID(), 1, randomUUID(), false];
      for (const pool of [appPool, opsPool]) {
        await expect(pool.query(`SELECT * FROM resolve_runner_git_request($1, $2, $3, $4, $5, $6)`, args)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });

    it('the proxy login can read nothing the function reads', async () => {
      for (const table of ['agent_runs', 'runners', 'repos', 'installations', 'runner_git_full_clones']) {
        await expect(proxyPool.query(`SELECT 1 FROM ${table} LIMIT 1`), table).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });
  });
});

/**
 * C27 section 3.5: "No new platform_ops privilege." This migrates a throwaway cluster to everything except 0765, snapshots what
 * platform_ops holds, applies 0765 on the same database and snapshots again (the same method 0754's test uses).
 */
describe('migration 0765 gives platform_ops nothing', () => {
  let pg: EphemeralPostgres;
  let pool: Pool;
  let guard: PoolTeardownGuard | undefined;
  let beforeDir: string;
  let before: Record<string, string[]>;
  let after: Record<string, string[]>;

  const TABLES = `('agent_runs', 'runners', 'repos', 'installations', 'runner_git_full_clones')`;
  async function snapshot(): Promise<Record<string, string[]>> {
    const q = async (sql: string) => (await pool.query<{ x: string }>(sql)).rows.map((r) => r.x);
    return {
      tableGrants: await q(`
        SELECT c.relname || ' ' || p.privilege_type AS x FROM pg_class c
          CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(privilege_type)
         WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ${TABLES} AND has_table_privilege('platform_ops', c.oid, p.privilege_type) ORDER BY 1`),
      columnGrants: await q(`
        SELECT c.relname || '.' || a.attname || ' ' || p.privilege_type AS x FROM pg_class c
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
          CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) AS p(privilege_type)
         WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ${TABLES} AND has_column_privilege('platform_ops', c.oid, a.attnum, p.privilege_type) ORDER BY 1`),
      policies: await q(`
        SELECT tablename || ' ' || policyname || ' ' || cmd || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '') AS x FROM pg_policies
         WHERE schemaname = 'public' AND tablename IN ${TABLES} AND 'platform_ops' = ANY(roles) ORDER BY 1`),
      ownedFunctions: await q(`SELECT p.oid::regprocedure::text AS x FROM pg_proc p WHERE p.proowner = 'platform_ops'::regrole ORDER BY 1`),
      memberships: await q(`SELECT pg_get_userbyid(roleid) || ' ' || admin_option::text AS x FROM pg_auth_members WHERE member = 'platform_ops'::regrole ORDER BY 1`),
      executes: await q(`SELECT p.oid::regprocedure::text AS x FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND has_function_privilege('platform_ops', p.oid, 'EXECUTE') ORDER BY 1`),
    };
  }

  beforeAll(async () => {
    pg = await provisionEphemeralPostgres({ database: 'fx_0765_ops_diff_test', tmpPrefix: 'fx-0765-diff-' });
    pool = createPool(pg.url);
    guard = guardPoolTeardown(pool, 'platformOpsDiffPool');
    beforeDir = mkdtempSync(path.join(tmpdir(), 'fx-0765-diff-migrations-'));
    for (const f of readdirSync(DEFAULT_MIGRATIONS_DIR).filter((name) => name.endsWith('.sql') && name < MIGRATION)) {
      copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, f), path.join(beforeDir, f));
    }
    await runMigrations(pool, beforeDir);
    before = await snapshot();
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR); // applies 0765 and every later migration (the earlier ones are already recorded; a later one may depend on 0765, so it cannot be in the before set)
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
    expect(before.tableGrants!.length).toBeGreaterThan(0);
    expect(before.columnGrants!.length).toBeGreaterThan(20);
    expect(before.policies!.length).toBeGreaterThan(0);
    expect(before.executes!.length).toBeGreaterThan(5);
  });

  it('platform_ops holds exactly what it held: table and column grants, row policies, owned functions, memberships and EXECUTE', () => {
    for (const key of Object.keys(before)) expect(after[key], key).toEqual(before[key]);
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
});
