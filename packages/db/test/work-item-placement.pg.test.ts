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

const MIGRATION = '0781_work_item_placement.sql';
const ROLE = 'work_item_placement_definer';
const CANCEL = 'work_item_cancel_pending_runs(uuid,text)';
const AUDIT = 'work_item_placement_audit(uuid,text,text,integer)';
const DEFINERS = [CANCEL, AUDIT];

/** Everything the role holds, exactly: column grants only on what its two bodies read and write. */
const EXPECTED_PRIVILEGES = [
  ...['id', 'account_id', 'status', 'execution_mode', 'work_item_id'].map((c) => `column agent_runs.${c} SELECT`),
  'column agent_runs.updated_at UPDATE',
  ...['id', 'account_id', 'repo_id', 'placement'].map((c) => `column work_items.${c} SELECT`),
  ...['id', 'account_id', 'execution_mode'].map((c) => `column repos.${c} SELECT`),
  ...['account_id', 'user_id', 'role'].map((c) => `column account_members.${c} SELECT`),
  'column accounts.id SELECT',
  'column accounts.deleted_at SELECT',
  ...['account_id', 'actor', 'action', 'payload', 'created_at'].map((c) => `column audit_log.${c} INSERT`),
  'schema public USAGE',
].sort();

describe(`migration 0781: work_items.placement and ${ROLE} (D#599 PL-1)`, () => {
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

  async function repo(accountId: string, mode: string): Promise<string> {
    const id = randomUUID();
    await admin.query("INSERT INTO repos (id, account_id, gh_repo_id, product, gh_owner, gh_name, execution_mode) VALUES ($1, $2, $3, 'team', 'Acme', 'widgets', $4)", [id, accountId, Math.floor(Math.random() * 1e12), mode]);
    return id;
  }
  async function item(accountId: string, repoId: string | null, placement: string | null = null): Promise<string> {
    const id = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, placement) VALUES ($1, $2, $3, 'feature', 'internal', $4)`, [id, accountId, repoId, placement]);
    return id;
  }
  /** `side` 'runner' is a runner run in `mode`; 'cloud' is a sandbox run. */
  async function run(accountId: string, repoId: string, itemId: string, side: 'runner' | 'cloud', status = 'pending', mode = 'runner_local'): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO agent_runs (id, account_id, role, runtime, status, execution_mode, dispatch_repo_id, work_item_id) VALUES ($1, $2, 'code-reviewer', $3, $4, $5, $6, $7)`,
      [id, accountId, side === 'runner' ? 'runner' : 'production', status, side === 'runner' ? mode : 'sandbox', repoId, itemId],
    );
    return id;
  }
  /** One transaction, rolled back: the tenant context, then `SET LOCAL ROLE app_user` (the session user stays the superuser, so the definers' own platform_ops refusal does not fire). */
  async function asApp<T>(userId: string, accountId: string, body: () => Promise<T>, role = 'app_user'): Promise<T> {
    await admin.query('BEGIN');
    try {
      await admin.query(`SELECT set_config('app.account_id', $1, true), set_config('app.user_id', $2, true)`, [accountId, userId]);
      await admin.query(`SET LOCAL ROLE ${role}`);
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
  const cancel = async (itemId: string, leaving: string) => (await admin.query<{ run_id: string }>('SELECT run_id FROM work_item_cancel_pending_runs($1, $2)', [itemId, leaving])).rows.map((r) => r.run_id);
  const audit = (itemId: string, from: string | null, to: string | null, n: number) => admin.query('SELECT work_item_placement_audit($1, $2, $3, $4)', [itemId, from, to, n]);
  const statusOf = async (id: string) => (await admin.query('SELECT status FROM agent_runs WHERE id = $1', [id])).rows[0].status as string;
  const setPlacement = (itemId: string, placement: string | null) => admin.query('UPDATE work_items SET placement = $2 WHERE id = $1', [itemId, placement]);

  describe('the column', () => {
    it('allows cloud, runner and NULL, and the CHECK refuses runner_verified and every other value', async () => {
      const id = await item(f.accountId, null);
      expect((await admin.query('SELECT placement FROM work_items WHERE id = $1', [id])).rows[0].placement).toBeNull();
      for (const ok of ['cloud', 'runner', null]) {
        await setPlacement(id, ok);
      }
      for (const bad of ['runner_verified', 'runner_local', 'sandbox', 'Cloud', 'RUNNER', '', ' cloud', 'cloud ', 'both']) {
        await expect(setPlacement(id, bad), JSON.stringify(bad)).rejects.toMatchObject({ code: '23514', constraint: 'work_items_placement_check' });
        await expect(admin.query(`INSERT INTO work_items (account_id, kind, provenance, placement) VALUES ($1, 'feature', 'internal', $2)`, [f.accountId, bad]), `insert ${bad}`).rejects.toMatchObject({ code: '23514' });
      }
      expect((await admin.query('SELECT placement FROM work_items WHERE id = $1', [id])).rows[0].placement).toBeNull();
    });

    it('cannot be written by app_user (an UPDATE has no column grant, and an INSERT that sets it is refused by the guard), a member, or platform_ops; app_user can read it', async () => {
      const id = await item(f.accountId, null, 'cloud');
      for (const who of ['app_user', 'platform_ops', 'partner_user', 'agent_run_writer']) {
        expect((await admin.query(`SELECT has_column_privilege($1, 'work_items', 'placement', 'UPDATE') AS ok`, [who])).rows[0].ok, who).toBe(false);
      }
      for (const who of [f.a1, f.o1, f.m1]) {
        await asApp(who, f.accountId, async () => {
          await expect(sp(() => admin.query('UPDATE work_items SET placement = $2 WHERE id = $1', [id, 'runner']))).rejects.toMatchObject({ code: '42501' });
          await expect(sp(() => admin.query(`INSERT INTO work_items (account_id, kind, provenance, placement) VALUES ($1, 'feature', 'internal', 'runner')`, [f.accountId]))).rejects.toMatchObject({ code: '42501' });
          // an insert that leaves it NULL is the normal path and still works
          await sp(() => admin.query(`INSERT INTO work_items (account_id, kind, provenance) VALUES ($1, 'feature', 'internal')`, [f.accountId]));
          expect((await admin.query('SELECT placement FROM work_items WHERE id = $1', [id])).rows[0].placement).toBe('cloud');
        });
      }
    });
  });

  describe('the insert guard', () => {
    it('refuses a non-NULL placement from a login created IN ROLE app_user (it inherits the INSERT and the row policy), and lets it insert NULL', async () => {
      const login = `pl1_login_${randomUUID().slice(0, 8)}`;
      await admin.query(`CREATE ROLE ${login} LOGIN IN ROLE app_user`);
      try {
        await asApp(f.o1, f.accountId, async () => {
          await admin.query('RESET ROLE');
          await admin.query(`SET LOCAL ROLE ${login}`);
          expect((await admin.query('SELECT current_user AS u')).rows[0].u).toBe(login);
          for (const value of ['runner', 'cloud']) {
            await expect(sp(() => admin.query(`INSERT INTO work_items (account_id, kind, provenance, placement) VALUES ($1, 'feature', 'internal', $2)`, [f.accountId, value])), value).rejects.toMatchObject({ code: '42501' });
          }
          await sp(() => admin.query(`INSERT INTO work_items (account_id, kind, provenance) VALUES ($1, 'feature', 'internal')`, [f.accountId]));
        });
      } finally {
        await admin.query(`DROP ROLE ${login}`);
      }
    });
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
      expect(rows.map((r) => `${r.tablename} ${r.cmd}`)).toEqual(['account_members SELECT', 'accounts SELECT', 'agent_runs SELECT', 'agent_runs UPDATE', 'audit_log INSERT', 'repos SELECT', 'work_items SELECT']);
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

    it('cannot be called by the run-writer login, platform_ops or the public', async () => {
      const id = await item(f.accountId, null, 'cloud');
      for (const who of ['agent_run_writer', 'platform_ops', 'partner_user']) {
        await asApp(f.a1, f.accountId, async () => {
          await expect(sp(() => admin.query('SELECT run_id FROM work_item_cancel_pending_runs($1, $2)', [id, 'runner'])), who).rejects.toMatchObject({ code: '42501' });
          await expect(sp(() => admin.query('SELECT work_item_placement_audit($1, $2, $3, $4)', [id, null, 'cloud', 0])), who).rejects.toMatchObject({ code: '42501' });
        }, who);
      }
    });
  });

  describe('the item-scoped cancel, called as the web tier\'s login under a tenant context', () => {
    it('with one pending and one running run on the item, moves exactly the pending one, and the audit row says 1 (criterion 3)', async () => {
      const g = await repo(f.accountId, 'runner_local');
      const id = await item(f.accountId, g, 'cloud');
      const pending = await run(f.accountId, g, id, 'runner');
      const running = await run(f.accountId, g, id, 'runner', 'running');
      await asApp(f.a1, f.accountId, async () => {
        expect(await cancel(id, 'runner')).toEqual([pending]);
        expect(await statusOf(pending)).toBe('cancelled');
        expect(await statusOf(running)).toBe('running');
        await audit(id, 'runner', 'cloud', 1);
        const rows = (await admin.query("SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'work_item.placement.changed' AND payload ->> 'item_id' = $2 ORDER BY created_at, id", [f.accountId, id])).rows;
        expect(rows).toEqual([{ actor: f.a1, payload: { item_id: id, from: 'runner', to: 'cloud', cancelled_runs: 1 } }]);
        expect(await cancel(id, 'runner')).toEqual([]);
      });
    });

    it('never touches another item\'s runs, not on the same repo, not on another repo, not another account\'s; a finished run stays finished', async () => {
      const g = await repo(f.accountId, 'runner_local');
      const mine = await item(f.accountId, g, 'cloud');
      const sibling = await item(f.accountId, g, 'cloud');
      const unrelated = await item(f.accountId, null, 'cloud');
      const other = await seedAccount(admin, randomUUID());
      const og = await repo(other.accountId, 'runner_local');
      const theirs = await item(other.accountId, og, 'cloud');
      const own = await run(f.accountId, g, mine, 'runner');
      const near = await run(f.accountId, g, sibling, 'runner');
      const far = await run(f.accountId, g, unrelated, 'runner');
      const foreign = await run(other.accountId, og, theirs, 'runner');
      const done = await run(f.accountId, g, mine, 'runner', 'succeeded');
      await asApp(f.a1, f.accountId, async () => {
        expect(await cancel(mine, 'runner')).toEqual([own]);
        for (const [r, want] of [[near, 'pending'], [far, 'pending'], [done, 'succeeded']] as const) expect(await statusOf(r), r).toBe(want);
        await admin.query('RESET ROLE'); // the other account's run is invisible to the web login; read it as the superuser, still inside the transaction
        expect(await statusOf(foreign)).toBe('pending');
      });
    });

    it('leaves a running run alone even if the definer\'s UPDATE policy were widened, and the pending filter is in the function body', async () => {
      const g = await repo(f.accountId, 'runner_local');
      const id = await item(f.accountId, g, 'cloud');
      const pending = await run(f.accountId, g, id, 'runner');
      const running = await run(f.accountId, g, id, 'runner', 'running');
      await asApp(f.a1, f.accountId, async () => {
        await admin.query('RESET ROLE');
        // the policy is the first thing that keeps a running run out of the lock; widen it (rolled back with the transaction)
        await admin.query(`ALTER POLICY work_item_placement_definer_update ON agent_runs USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)`);
        await admin.query('SET LOCAL ROLE app_user');
        expect(await cancel(id, 'runner')).toEqual([pending]);
        expect(await statusOf(running)).toBe('running');
      });
      const def = (await admin.query<{ d: string }>(`SELECT pg_get_functiondef('work_item_cancel_pending_runs(uuid,text)'::regprocedure) AS d`)).rows[0].d;
      // The compare-and-set writer would also mask a missing filter, so the filter itself is pinned by its text.
      expect(def).toContain("a.status = 'pending'");
    });

    it('leaving the runner cancels runner runs of both modes and no sandbox run; leaving the cloud cancels sandbox runs and no runner run', async () => {
      const g = await repo(f.accountId, 'runner_verified');
      const toCloud = await item(f.accountId, g, 'cloud');
      const local = await run(f.accountId, g, toCloud, 'runner');
      const verified = await run(f.accountId, g, toCloud, 'runner', 'pending', 'runner_verified');
      const box = await run(f.accountId, g, toCloud, 'cloud');
      await asApp(f.a1, f.accountId, async () => {
        expect((await cancel(toCloud, 'runner')).sort()).toEqual([local, verified].sort());
        expect(await statusOf(box)).toBe('pending');
      });
      const toRunner = await item(f.accountId, g, 'runner');
      const rr = await run(f.accountId, g, toRunner, 'runner');
      const sandboxRun = await run(f.accountId, g, toRunner, 'cloud');
      await asApp(f.a1, f.accountId, async () => {
        expect(await cancel(toRunner, 'cloud')).toEqual([sandboxRun]);
        expect(await statusOf(rr)).toBe('pending');
      });
    });

    it('answers the item\'s effective side from the repo when the placement is NULL (the undo path: back to the repo default)', async () => {
      const onRunner = await repo(f.accountId, 'runner_local');
      const id = await item(f.accountId, onRunner, null);
      const box = await run(f.accountId, onRunner, id, 'cloud');
      const rr = await run(f.accountId, onRunner, id, 'runner');
      await asApp(f.a1, f.accountId, async () => {
        // inheriting a runner repo: the item runs on the runner, so leaving the runner is refused and leaving the cloud is allowed
        await expect(sp(() => cancel(id, 'runner'))).rejects.toMatchObject({ code: '55000' });
        expect(await cancel(id, 'cloud')).toEqual([box]);
        expect(await statusOf(rr)).toBe('pending');
      });
      const onCloud = await repo(f.accountId, 'sandbox');
      const id2 = await item(f.accountId, onCloud, null);
      const rr2 = await run(f.accountId, onCloud, id2, 'runner');
      await asApp(f.a1, f.accountId, async () => {
        await expect(sp(() => cancel(id2, 'cloud'))).rejects.toMatchObject({ code: '55000' });
        expect(await cancel(id2, 'runner')).toEqual([rr2]);
      });
    });

    it('refuses while the item still runs on the side being left (55000) and moves nothing', async () => {
      const g = await repo(f.accountId, 'sandbox');
      const stays = await item(f.accountId, g, 'runner');
      const waiting = await run(f.accountId, g, stays, 'runner');
      await asApp(f.a1, f.accountId, async () => {
        await expect(sp(() => cancel(stays, 'runner'))).rejects.toMatchObject({ code: '55000' });
      });
      expect(await statusOf(waiting)).toBe('pending');
    });

    it('refuses a member who is not an owner or admin (42501), no user in context (42501), another account\'s item and an unknown item (P0002), a bad side or a null item (22023)', async () => {
      const g = await repo(f.accountId, 'runner_local');
      const id = await item(f.accountId, g, 'cloud');
      const queued = await run(f.accountId, g, id, 'runner');
      const other = await seedAccount(admin, randomUUID());
      const og = await repo(other.accountId, 'runner_local');
      const theirs = await item(other.accountId, og, 'cloud');
      const theirRun = await run(other.accountId, og, theirs, 'runner');
      for (const who of [f.m1, f.m2]) {
        await asApp(who, f.accountId, async () => {
          await expect(sp(() => cancel(id, 'runner'))).rejects.toMatchObject({ code: '42501' });
        });
      }
      await asApp('', f.accountId, async () => {
        await expect(sp(() => cancel(id, 'runner'))).rejects.toMatchObject({ code: '42501' });
      });
      // an owner of ANOTHER account, with this account's id in context, is not a member of it
      await asApp(other.userId, f.accountId, async () => {
        await expect(sp(() => cancel(id, 'runner'))).rejects.toMatchObject({ code: '42501' });
      });
      await asApp(f.a1, f.accountId, async () => {
        await expect(sp(() => cancel(theirs, 'runner'))).rejects.toMatchObject({ code: 'P0002' });
        await expect(sp(() => cancel(randomUUID(), 'runner'))).rejects.toMatchObject({ code: 'P0002' });
        await expect(sp(() => cancel(id, 'sandbox'))).rejects.toMatchObject({ code: '22023' });
        await expect(sp(() => cancel(id, 'runner_local'))).rejects.toMatchObject({ code: '22023' });
        await expect(sp(() => admin.query('SELECT run_id FROM work_item_cancel_pending_runs(NULL, $1)', ['runner']))).rejects.toMatchObject({ code: '22023' });
        await expect(sp(() => admin.query('SELECT run_id FROM work_item_cancel_pending_runs($1, NULL)', [id]))).rejects.toMatchObject({ code: '22023' });
      });
      // the other account's admin cannot reach this account's item either: the same answer as an unknown item
      await asApp(other.userId, other.accountId, async () => {
        await expect(sp(() => cancel(id, 'runner'))).rejects.toMatchObject({ code: 'P0002' });
      });
      expect(await statusOf(queued)).toBe('pending');
      expect(await statusOf(theirRun)).toBe('pending');
    });

    it('refuses an account that is no longer active (42501)', async () => {
      const gone = await seedF2(admin);
      const g = await repo(gone.accountId, 'runner_local');
      const id = await item(gone.accountId, g, 'cloud');
      const queued = await run(gone.accountId, g, id, 'runner');
      await admin.query('UPDATE accounts SET deleted_at = now() WHERE id = $1', [gone.accountId]);
      await asApp(gone.a1, gone.accountId, async () => {
        await expect(sp(() => cancel(id, 'runner'))).rejects.toMatchObject({ code: '42501' });
      });
      expect(await statusOf(queued)).toBe('pending');
    });
  });

  describe('the audit definer', () => {
    const rows = async (itemId: string) => (await admin.query("SELECT actor, payload FROM audit_log WHERE account_id = $1 AND action = 'work_item.placement.changed' AND payload ->> 'item_id' = $2 ORDER BY created_at, id", [f.accountId, itemId])).rows;

    it('writes one row per change with from, to, count and the caller as actor; NULL is written as JSON null', async () => {
      const g = await repo(f.accountId, 'sandbox');
      const toRunner = await item(f.accountId, g, 'runner');
      const toDefault = await item(f.accountId, g, null);
      const toCloud = await item(f.accountId, g, 'cloud');
      await asApp(f.o1, f.accountId, async () => {
        await audit(toRunner, null, 'runner', 2);
        await audit(toDefault, 'runner', null, 0);
        await audit(toCloud, null, 'cloud', 0);
        expect((await rows(toRunner)).map((r) => [r.actor, r.payload])).toEqual([[f.o1, { item_id: toRunner, from: null, to: 'runner', cancelled_runs: 2 }]]);
        expect((await rows(toDefault)).map((r) => [r.actor, r.payload])).toEqual([[f.o1, { item_id: toDefault, from: 'runner', to: null, cancelled_runs: 0 }]]);
        expect((await rows(toCloud)).map((r) => [r.actor, r.payload])).toEqual([[f.o1, { item_id: toCloud, from: null, to: 'cloud', cancelled_runs: 0 }]]);
      });
    });

    it('refuses a row that describes a change that did not happen: a stored placement that is not the new one (55000)', async () => {
      const g = await repo(f.accountId, 'sandbox');
      const id = await item(f.accountId, g, 'cloud');
      await asApp(f.a1, f.accountId, async () => {
        await expect(sp(() => audit(id, 'cloud', 'runner', 0))).rejects.toMatchObject({ code: '55000' });
        await expect(sp(() => audit(id, 'cloud', null, 0))).rejects.toMatchObject({ code: '55000' });
        expect(await rows(id)).toEqual([]);
      });
    });

    it('accepts a cancelled count only for a change that moves the item\'s side, and refuses a negative or null count, bad values and a no-op', async () => {
      const g = await repo(f.accountId, 'sandbox');
      const id = await item(f.accountId, g, 'cloud');
      await asApp(f.a1, f.accountId, async () => {
        // from NULL on a sandbox repo to 'cloud': the side does not move
        await expect(sp(() => audit(id, null, 'cloud', 1))).rejects.toMatchObject({ code: '22023' });
        for (const args of [
          [id, null, 'cloud', -1],
          [id, 'cloud', 'cloud', 0],
          [id, null, null, 0],
          [id, 'runner_verified', 'cloud', 0],
          [id, 'cloud', 'runner_verified', 0],
        ] as const) {
          await expect(sp(() => audit(args[0], args[1], args[2], args[3])), JSON.stringify(args)).rejects.toMatchObject({ code: '22023' });
        }
        await expect(sp(() => admin.query('SELECT work_item_placement_audit($1, NULL, $2, NULL)', [id, 'cloud']))).rejects.toMatchObject({ code: '22023' });
        await expect(sp(() => admin.query('SELECT work_item_placement_audit(NULL, NULL, $1, 0)', ['cloud']))).rejects.toMatchObject({ code: '22023' });
        expect(await rows(id)).toEqual([]);
      });
    });

    it('refuses a member (42501), and another account\'s item and an unknown item (P0002)', async () => {
      const g = await repo(f.accountId, 'sandbox');
      const id = await item(f.accountId, g, 'cloud');
      const other = await seedAccount(admin, randomUUID());
      const theirs = await item(other.accountId, null, 'cloud');
      await asApp(f.m1, f.accountId, async () => {
        await expect(sp(() => audit(id, null, 'cloud', 0))).rejects.toMatchObject({ code: '42501' });
      });
      await asApp(f.a1, f.accountId, async () => {
        await expect(sp(() => audit(theirs, null, 'cloud', 0))).rejects.toMatchObject({ code: 'P0002' });
        await expect(sp(() => audit(randomUUID(), null, 'cloud', 0))).rejects.toMatchObject({ code: 'P0002' });
      });
      expect(await rows(id)).toEqual([]);
    });
  });
});

/**
 * C21 section 11 for this file too: platform_ops gains nothing. This migrates a throwaway cluster to everything EXCEPT 0781,
 * snapshots what platform_ops holds, applies 0781 on the same database and snapshots again. The snapshot is the table grants,
 * every column grant of every kind on the tables the new role touches, the row policies that name platform_ops, the functions it
 * owns and the roles it belongs to. All of it must be unchanged, and neither new definer is owned by platform_ops.
 */
describe('migration 0781 gives platform_ops nothing', () => {
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
  const TABLES = `('agent_runs', 'work_items', 'repos', 'account_members', 'accounts', 'audit_log', 'run_events', 'domain_events')`;

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
      newDefinersOwnedByPlatformOps: await q(`SELECT p.proname AS x FROM pg_proc p WHERE p.proowner = 'platform_ops'::regrole AND p.proname IN ('work_item_cancel_pending_runs', 'work_item_placement_audit') ORDER BY 1`),
    };
  }

  beforeAll(async () => {
    pg = await provisionEphemeralPostgres({ database: 'fx_0781_ops_diff_test', tmpPrefix: 'fx-0781-diff-' });
    pool = createPool(pg.url);
    guard = guardPoolTeardown(pool, 'platformOpsDiff0781Pool');
    beforeDir = mkdtempSync(path.join(tmpdir(), 'fx-0781-diff-migrations-'));
    // Every migration numbered after this one is left out too: it was written against a database that has this file.
    for (const file of readdirSync(DEFAULT_MIGRATIONS_DIR).filter((name) => name.endsWith('.sql') && name < MIGRATION)) {
      copyFileSync(path.join(DEFAULT_MIGRATIONS_DIR, file), path.join(beforeDir, file));
    }
    await runMigrations(pool, beforeDir);
    before = await snapshot();
    await runMigrations(pool, DEFAULT_MIGRATIONS_DIR); // applies 0781 and anything after it
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

  it('migration 0781 mentions platform_ops in exactly the ways 0759 does: the role brackets, and nothing else', () => {
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
