import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

const ROLE = 'plane_publish_definer';
const FN = 'resolve_plane_publish_target(text)';
const PROXY_LOGIN = 'fx_ppub_test_login';

/** Everything the role holds, exactly: column SELECT on what the body reads, and the schema. */
const EXPECTED_PRIVILEGES = [
  ...['id', 'account_id', 'work_item_id', 'role', 'status', 'sandbox_name', 'dispatch_repo_id'].map((c) => `column agent_runs.${c} SELECT`),
  ...['account_id', 'plane_push_id', 'run_id', 'finished_at'].map((c) => `column plane_push_attempts.${c} SELECT`),
  ...['id', 'account_id', 'work_item_id', 'repo_id', 'code_repo', 'branch', 'managed_by_person_at'].map((c) => `column plane_pushes.${c} SELECT`),
  'schema public USAGE',
].sort();

describe('migration 0834: resolve_plane_publish_target (D#598 P1f-4a)', () => {
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
    run: string;
    push: string;
    attempt: string;
    name: string;
    codeRepo: string;
    branch: string;
  }

  const DIGEST = 'a'.repeat(64);

  async function pushRow(refs: SeedRefs, o: { codeRepo?: string } = {}): Promise<{ id: string; branch: string; codeRepo: string }> {
    const codeRepo = o.codeRepo ?? `acme-${randomUUID().slice(0, 8)}/widgets-public`;
    const { rows } = await admin.query<{ id: string; branch: string }>(
      `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest) VALUES ($1, $2, $3, $4, $5) RETURNING id, branch`,
      [refs.accountId, refs.workItemId, refs.repoId, codeRepo, DIGEST],
    );
    return { id: rows[0]!.id, branch: rows[0]!.branch, codeRepo };
  }
  const runRow = async (refs: SeedRefs, o: { role?: string; status?: string; name: string; workItem?: string | null; repo?: string | null }): Promise<string> => {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, work_item_id, role, runtime, status, sandbox_name, dispatch_repo_id)
       VALUES ($1, $2, $3, $4, 'production', $5, $6, $7)`,
      [id, refs.accountId, o.workItem === undefined ? refs.workItemId : o.workItem, o.role ?? 'plane_publish', o.status ?? 'running', o.name, o.repo === undefined ? refs.repoId : o.repo],
    );
    return id;
  };
  const attemptRow = async (refs: SeedRefs, push: string, run: string | null, no = 1): Promise<string> => {
    const { rows } = await admin.query<{ id: string }>(
      `INSERT INTO plane_push_attempts (account_id, plane_push_id, run_id, runtime, kind, attempt_no) VALUES ($1, $2, $3, 'sandbox', 'push', $4) RETURNING id`,
      [refs.accountId, push, run, no],
    );
    return rows[0]!.id;
  };

  /** A work item with a paired push row, a live plane_publish run and one unfinished attempt: the answerable case. */
  async function world(o: { role?: string; workItem?: string | null; repo?: string | null } = {}): Promise<World> {
    const refs = await seedAccount(admin, randomUUID());
    const push = await pushRow(refs);
    const name = `pp-${randomUUID()}`;
    const run = await runRow(refs, { name, ...o });
    const attempt = await attemptRow(refs, push.id, run);
    return { refs, run, push: push.id, attempt, name, codeRepo: push.codeRepo, branch: push.branch };
  }
  const ask = async (name: string | null, pool: Pool = proxyPool): Promise<Array<{ code_repo: string; branch: string }>> =>
    (await pool.query<{ code_repo: string; branch: string }>('SELECT * FROM resolve_plane_publish_target($1)', [name])).rows;

  describe('what it answers', () => {
    it('a live plane_publish run with an unfinished attempt resolves to exactly its (code_repo, branch)', async () => {
      const w = await world();
      expect(await ask(w.name)).toEqual([{ code_repo: w.codeRepo, branch: w.branch }]);
      expect(w.branch).toBe(`fx/p-${w.push}`);
    });

    it.each(['pending', 'running', 'paused'])('a %s run resolves', async (status) => {
      const w = await world();
      await admin.query('UPDATE agent_runs SET status = $2 WHERE id = $1', [w.run, status]);
      expect(await ask(w.name)).toHaveLength(1);
    });

    it('answers nothing for an ended run, whatever the terminal status', async () => {
      for (const status of ['succeeded', 'failed', 'cancelled']) {
        const w = await world();
        await admin.query('UPDATE agent_runs SET status = $2 WHERE id = $1', [w.run, status]);
        expect(await ask(w.name), status).toEqual([]);
      }
    });

    it('answers nothing for a run whose role is executor', async () => {
      const w = await world({ role: 'executor' });
      expect(await ask(w.name)).toEqual([]);
    });

    it('answers nothing when two live runs carry the name, even if only one of them is a plane_publish run', async () => {
      const w = await world();
      await runRow(w.refs, { name: w.name, role: 'executor' });
      expect(await ask(w.name)).toEqual([]);
      const w2 = await world();
      await runRow(w2.refs, { name: w2.name });
      expect(await ask(w2.name)).toEqual([]);
    });

    it('an ended run that shares the name does not count: the live one still resolves', async () => {
      const w = await world();
      await runRow(w.refs, { name: w.name, status: 'failed' });
      expect(await ask(w.name)).toEqual([{ code_repo: w.codeRepo, branch: w.branch }]);
    });

    it('answers nothing once the attempt is finished (the undo path: a sandbox that outlives its attempt can do nothing)', async () => {
      const w = await world();
      expect(await ask(w.name)).toHaveLength(1);
      await admin.query('UPDATE plane_push_attempts SET finished_at = now() WHERE id = $1', [w.attempt]);
      expect(await ask(w.name)).toEqual([]);
    });

    it('answers nothing when the run has no attempt at all, or only an attempt of another run', async () => {
      const refs = await seedAccount(admin, randomUUID());
      const push = await pushRow(refs);
      const name = `pp-${randomUUID()}`;
      await runRow(refs, { name });
      expect(await ask(name)).toEqual([]);
      const other = await runRow(refs, { name: `pp-${randomUUID()}` });
      await attemptRow(refs, push.id, other);
      expect(await ask(name)).toEqual([]);
    });

    it('answers nothing when the run has two unfinished attempts on two push rows (more than one match fails closed)', async () => {
      const w = await world();
      const second = await admin.query<{ id: string }>(
        `INSERT INTO plane_pushes (account_id, work_item_id, repo_id, code_repo, pairing_digest) VALUES ($1, $2, $3, 'acme-two/widgets-public-two', $4) RETURNING id`,
        [w.refs.accountId, w.refs.workItemId, w.refs.repoId, DIGEST],
      );
      await attemptRow(w.refs, second.rows[0]!.id, w.run);
      expect(await ask(w.name)).toEqual([]);
    });

    it("answers nothing when the run's dispatch repo differs from the push row's repo", async () => {
      const refs = await seedAccount(admin, randomUUID());
      const { rows } = await admin.query<{ id: string }>(`INSERT INTO repos (account_id, installation_id, gh_repo_id, product) VALUES ($1, $2, 77, 'team') RETURNING id`, [refs.accountId, refs.installationId]);
      const w = await world({ repo: null });
      expect(await ask(w.name)).toEqual([]);
      const push = await pushRow(refs);
      const name = `pp-${randomUUID()}`;
      const run = await runRow(refs, { name, repo: rows[0]!.id });
      await attemptRow(refs, push.id, run);
      expect(await ask(name)).toEqual([]);
    });

    it('answers nothing for a run of a different work item than the push row, or with no work item', async () => {
      const refs = await seedAccount(admin, randomUUID());
      const { rows } = await admin.query<{ id: string }>(`INSERT INTO work_items (account_id, repo_id, kind, provenance) VALUES ($1, $2, 'feature', 'internal') RETURNING id`, [refs.accountId, refs.repoId]);
      const push = await pushRow(refs);
      const name = `pp-${randomUUID()}`;
      const run = await runRow(refs, { name, workItem: rows[0]!.id });
      await attemptRow(refs, push.id, run);
      expect(await ask(name)).toEqual([]);
      expect(await ask((await world({ workItem: null })).name)).toEqual([]);
    });

    it('answers nothing once a person has taken over the branch, and again when they hand it back', async () => {
      const w = await world();
      await admin.query('UPDATE plane_pushes SET managed_by_person_at = now() WHERE id = $1', [w.push]);
      expect(await ask(w.name)).toEqual([]);
      await admin.query('UPDATE plane_pushes SET managed_by_person_at = NULL WHERE id = $1', [w.push]);
      expect(await ask(w.name)).toHaveLength(1);
    });

    it("never answers with another account's rows: each name resolves to its own account's push only", async () => {
      const a = await world();
      const b = await world();
      // An attempt of account A cannot be pointed at a push row of account B (composite foreign key).
      await expect(admin.query('UPDATE plane_push_attempts SET plane_push_id = $2 WHERE id = $1', [a.attempt, b.push])).rejects.toBeTruthy();
      expect(await ask(a.name)).toEqual([{ code_repo: a.codeRepo, branch: a.branch }]);
      expect(await ask(b.name)).toEqual([{ code_repo: b.codeRepo, branch: b.branch }]);
    });

    it('answers nothing when the push row is deleted or the run is pruned (no stale grant)', async () => {
      const a = await world();
      await admin.query('DELETE FROM plane_pushes WHERE id = $1', [a.push]);
      expect(await ask(a.name)).toEqual([]);
      const b = await world();
      await admin.query('DELETE FROM agent_runs WHERE id = $1', [b.run]);
      expect(await ask(b.name)).toEqual([]);
    });

    it("never reads the name's contents: a name that merely contains the branch or the repo text resolves to nothing", async () => {
      const w = await world();
      for (const name of [w.branch, w.codeRepo, `pp-${w.push}`, `${w.name} `, w.name.toUpperCase(), `${w.name}%`, '', `x${w.name}`]) {
        expect(await ask(name), name).toEqual([]);
      }
    });

    it('answers nothing for a null name', async () => {
      expect(await ask(null)).toEqual([]);
    });
  });

  describe('who holds what', () => {
    it('the role is NOLOGIN and unprivileged, a member of nothing with no member, and owns exactly its one function', async () => {
      const { rows } = await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1`, [ROLE]);
      expect(rows[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
      expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE roleid = $1::regrole OR member = $1::regrole`, [ROLE])).rowCount).toBe(0);
      const owned = await admin.query<{ sig: string }>(`SELECT p.oid::regprocedure::text AS sig FROM pg_proc p WHERE p.proowner = $1::regrole`, [ROLE]);
      expect(owned.rows.map((r) => r.sig)).toEqual([FN]);
      expect((await admin.query(`SELECT has_schema_privilege($1, 'public', 'CREATE') AS ok`, [ROLE])).rows[0].ok).toBe(false);
    });

    it('holds exactly the column SELECT grants the body reads, and no table-wide grant', async () => {
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

    it('has a row policy of its own on each of the three tables, and only those', async () => {
      const { rows } = await admin.query<{ tablename: string; cmd: string; roles: string[] }>(`SELECT tablename, cmd, roles::text[] AS roles FROM pg_policies WHERE schemaname = 'public' AND $1 = ANY(roles) ORDER BY tablename, cmd`, [ROLE]);
      expect(rows.map((r) => `${r.tablename} ${r.cmd}`)).toEqual(['agent_runs SELECT', 'plane_push_attempts SELECT', 'plane_pushes SELECT']);
      for (const p of rows) expect(p.roles).toEqual([ROLE]);
    });

    it('is a SECURITY DEFINER with a pinned search_path, owned by the role; EXECUTE is held by run_binding_resolver and the owner only, with no grant option', async () => {
      const { rows } = await admin.query<{ prosecdef: boolean; provolatile: string; proconfig: string[]; owner: string; grantees: string[]; grantable: boolean }>(
        `SELECT p.prosecdef, p.provolatile, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
                coalesce((SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END) FROM aclexplode(p.proacl) a), '{}') AS grantees,
                coalesce((SELECT bool_or(a.is_grantable) FROM aclexplode(p.proacl) a), false) AS grantable
           FROM pg_proc p WHERE p.oid = $1::regprocedure`,
        [FN],
      );
      expect(rows[0]).toEqual({ prosecdef: true, provolatile: 's', proconfig: ['search_path=pg_catalog, public, pg_temp'], owner: ROLE, grantees: [ROLE, 'run_binding_resolver'].sort(), grantable: false });
    });

    it('app_user, platform_ops, agent_run_writer and partner_user cannot execute it, and calls as app_user or platform_ops are refused', async () => {
      for (const who of ['app_user', 'agent_run_writer', 'platform_ops', 'partner_user']) {
        expect((await admin.query(`SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok`, [who, FN])).rows[0].ok, who).toBe(false);
      }
      for (const pool of [appPool, opsPool]) {
        await expect(pool.query('SELECT * FROM resolve_plane_publish_target($1)', ['pp-x'])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });

    it('platform_ops gains no privilege or policy from this migration (the new role is not a platform_ops member)', async () => {
      expect((await admin.query(`SELECT pg_has_role('platform_ops', $1, 'MEMBER') AS m`, [ROLE])).rows[0].m).toBe(false);
      expect((await admin.query(`SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND policyname = 'plane_publish_definer_select' AND 'platform_ops' = ANY(roles)`)).rowCount).toBe(0);
    });

    it('the proxy login gets permission-denied (42501) reading plane_pushes, plane_push_attempts and agent_runs itself', async () => {
      for (const table of ['plane_pushes', 'plane_push_attempts', 'agent_runs']) {
        await expect(proxyPool.query(`SELECT * FROM ${table} LIMIT 1`), table).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
    });

    it('0831 grants nothing to run_binding_resolver (a static check of the migration text and of the live ACLs)', async () => {
      const sql = readFileSync(path.join(__dirname, '../migrations/0831_plane_pushes.sql'), 'utf8');
      expect(sql).not.toMatch(/run_binding_resolver/);
      const tables = await admin.query(`SELECT c.relname FROM pg_class c, aclexplode(c.relacl) a WHERE c.relname IN ('plane_pushes', 'plane_push_attempts') AND a.grantee = 'run_binding_resolver'::regrole::oid`);
      expect(tables.rows).toEqual([]);
      const cols = await admin.query(
        `SELECT c.relname FROM pg_class c JOIN pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a WHERE c.relname IN ('plane_pushes', 'plane_push_attempts') AND a.grantee = 'run_binding_resolver'::regrole::oid`,
      );
      expect(cols.rows).toEqual([]);
    });

    it('the function body reads no clock and writes nothing', () => {
      const sql = readFileSync(path.join(__dirname, '../migrations/0834_plane_publish_target_resolver.sql'), 'utf8');
      const body = /AS \$\$\nBEGIN\n([\s\S]*?)\nEND;\n\$\$;/.exec(sql)?.[1] ?? '';
      expect(body).toContain('SELECT');
      expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE|now\(\)|clock_timestamp|current_timestamp)\b/i);
    });
  });
});
