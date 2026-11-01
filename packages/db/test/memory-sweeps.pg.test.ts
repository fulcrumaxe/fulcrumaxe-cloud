import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

const ROLE = 'memory_sweep_definer';
const SWEEPS = ['memory_sweep_expire', 'memory_sweep_purge', 'memory_sweep_retire'];
const DAY = 86_400;

/**
 * D#601 MEM-4b1 (migration 0900): the expiry, retirement and purge sweeps, run as the reconciler's login (platform_ops) on real Postgres with
 * row security forced. Ages are made by moving an entry's own timestamps back, as the admin login; everything else goes through the definers.
 */
describe('memory sweeps (D#601 MEM-4b1)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let opsPool: Pool;
  let a: SeedRefs;
  let b: SeedRefs;
  let aAdmin: string;
  let n = 0;

  const call = async <T>(userId: string | null, sql: string, params: unknown[] = [], accountId: string = a.accountId): Promise<T> => {
    const run = async (c: PoolClient) => (await c.query<{ r: T }>(`SELECT ${sql} AS r`, params)).rows[0]!.r;
    return userId === null ? withTenant(appPool, accountId, run) : withTenant(appPool, accountId, userId, run);
  };
  const body = () => `sweep test fact ${++n} ${randomUUID()}`;
  const propose = (accountId: string = a.accountId) => call<string>(null, `memory_propose('repo','R_kgDOSweep01@7','fact',$1,NULL,'agent','{}'::jsonb)`, [body()], accountId);
  const write = () => call<string>(aAdmin, `memory_write('account',NULL,'fact',$1,NULL,'{}'::jsonb)`, [body()]);
  const decide = (id: string, to: string) => call<string>(aAdmin, `memory_decide($1::uuid,$2)`, [id, to]);
  const del = (id: string, restore = false) => call<string>(aAdmin, `memory_delete($1::uuid,$2)`, [id, restore]);
  const row = async (id: string) => (await admin.query(`SELECT * FROM memory_entries WHERE id = $1`, [id])).rows[0];
  const audit = async (id: string) => (await admin.query(`SELECT actor, action, payload FROM audit_log WHERE payload->>'entry_id' = $1 ORDER BY created_at, id`, [id])).rows;
  const sweep = async (fn: string, limit = 1000) => (await opsPool.query<{ n: number }>(`SELECT ${fn}($1::int) AS n`, [limit])).rows[0]!.n;
  const sweepAll = async () => ({ expired: await sweep('memory_sweep_expire'), retired: await sweep('memory_sweep_retire'), purged: await sweep('memory_sweep_purge') });
  /**
   * Moves an entry's clock back: `days` ago for each named column (fractions allowed). A day here is a calendar day in the database
   * session's zone, the unit the definers count in (`interval '30 days'`), so an entry "30 days old" sits exactly on their boundary
   * whatever zone the database runs in and even when a daylight-saving change falls inside the 30 days (that span is 719 or 721 hours).
   */
  const age = (id: string, cols: Record<string, number>) =>
    admin.query(
      `UPDATE memory_entries SET ${Object.keys(cols).map((c, i) => `${c} = now() - $${i + 2}::float8 * interval '1 day'`).join(', ')} WHERE id = $1`,
      [id, ...Object.values(cols)],
    );
  /** A POSIX zone that put its clocks back `daysAgo` days ago (summer time until then, standard time since), so any window reaching past that day holds a repeated hour. */
  const zoneWithClocksBack = (daysAgo: number): string => {
    const rule = (d: Date) => `M${d.getUTCMonth() + 1}.${Math.floor((d.getUTCDate() - 1) / 7) + 1}.${d.getUTCDay()}/2`;
    const ended = new Date(Date.now() - daysAgo * DAY * 1000);
    const starts = new Date(Date.now() + 170 * DAY * 1000);
    return `FXS0FXD-1,${rule(starts)},${rule(ended)}`;
  };
  /** Runs `fn` in a transaction whose session zone is `zone`; the zone is local to the transaction, so nothing leaks into the pool. */
  const inZone = async <T>(zone: string, pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> => {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('TimeZone', $1, true)`, [zone]);
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  };

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
    aAdmin = randomUUID();
    await admin.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [aAdmin, `${aAdmin}@example.test`]);
    await admin.query(`INSERT INTO account_members (account_id, user_id, role) VALUES ($1, $2, 'admin')`, [a.accountId, aAdmin]);
  });
  // Each test starts from a table with nothing due, so the counts a sweep returns are this test's own.
  beforeEach(async () => {
    await sweepAll();
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end(), opsPool.end()]);
  });

  describe('MEM-4b acceptance 1: expiry and renew', () => {
    it('a proposal created 15 days ago is expired; Restore returns it to proposed with a new 14-day expiry', async () => {
      const old = await propose();
      const fresh = await propose();
      await age(old, { created_at: 15, expires_at: 1 });
      await age(fresh, { created_at: 13 });
      expect(await sweep('memory_sweep_expire')).toBe(1);
      expect(await row(old)).toMatchObject({ status: 'expired' });
      expect((await row(fresh)).status).toBe('proposed');
      const audited = (await audit(old)).at(-1);
      expect(audited).toMatchObject({ actor: 'system:memory_sweep', action: 'memory.expired' });
      expect(audited.payload).toEqual({ entry_id: old, scope: 'repo', kind: 'fact', author_kind: 'agent', from_status: 'proposed', to_status: 'expired', version: 1 });

      expect(await decide(old, 'proposed')).toBe('decided');
      expect((await row(old)).status).toBe('proposed');
      // Database time, as the definer counts it (a calendar 14 days, so a daylight-saving change may make it an hour longer or shorter).
      const { rows } = await admin.query(`SELECT expires_at > now() + interval '13 days' AND expires_at <= clock_timestamp() + interval '14 days' AS ok FROM memory_entries WHERE id = $1`, [old]);
      expect(rows[0].ok).toBe(true);
      // Renewed means not due: the next sweep leaves it alone.
      expect(await sweep('memory_sweep_expire')).toBe(0);
      expect((await row(old)).status).toBe('proposed');
    });
  });

  describe('MEM-4b acceptance 3: the 30 day purge', () => {
    it('an entry deleted 31 days ago is gone from the table; one deleted 29 days ago can be restored', async () => {
      const gone = await write();
      const kept = await write();
      await del(gone);
      await del(kept);
      await age(gone, { deleted_at: 31 });
      await age(kept, { deleted_at: 29 });
      expect(await sweep('memory_sweep_purge')).toBe(1);
      expect(await row(gone)).toBeUndefined();
      expect((await row(kept)).status).toBe('deleted');
      expect(await del(kept, true)).toBe('restored');
      expect((await row(kept)).status).toBe('approved');
      // History is permanent: the purged entry's audit rows stay, ending in the purge (no text, to_status null).
      expect((await audit(gone)).map((r) => r.action)).toEqual(['memory.written', 'memory.deleted', 'memory.purged']);
      expect((await audit(gone)).at(-1).payload).toMatchObject({ from_status: 'deleted', to_status: null, version: 1 });
    });
    it('purge and restore share one boundary: at exactly 30 days a restore is refused and the purge takes it', async () => {
      const id = await write();
      await del(id);
      await age(id, { deleted_at: 30 });
      await expect(del(id, true)).rejects.toMatchObject({ message: /invalid_transition/ });
      expect(await sweep('memory_sweep_purge')).toBe(1);
      expect(await row(id)).toBeUndefined();
    });
    it('the boundary is a calendar 30 days when the clocks went back inside those 30 days (a 721 hour span)', async () => {
      const zone = zoneWithClocksBack(10);
      const probe = await inZone(zone, adminPool, async (c) => (await c.query(`SELECT now() - interval '30 days' = now() - interval '721 hours' AS ok`)).rows[0].ok);
      expect(probe).toBe(true); // the zone really repeats an hour inside the window
      const at30 = await write();
      const at720h = await write();
      await del(at30);
      await del(at720h);
      await inZone(zone, adminPool, async (c) => {
        await c.query(`UPDATE memory_entries SET deleted_at = now() - 30 * interval '1 day' WHERE id = $1`, [at30]);
        await c.query(`UPDATE memory_entries SET deleted_at = now() - interval '720 hours' WHERE id = $1`, [at720h]);
      });
      // Exactly 30 calendar days old: a restore is refused. 720 hours old is still inside them: it can be restored (before the purge, which would take it).
      await withTenant(appPool, a.accountId, aAdmin, async (c) => {
        await c.query(`SELECT set_config('TimeZone', $1, true)`, [zone]);
        await expect(c.query(`SELECT memory_delete($1::uuid, true)`, [at30])).rejects.toMatchObject({ message: /invalid_transition/ });
      });
      await withTenant(appPool, a.accountId, aAdmin, async (c) => {
        await c.query(`SELECT set_config('TimeZone', $1, true)`, [zone]);
        expect((await c.query(`SELECT memory_delete($1::uuid, true) AS r`, [at720h])).rows[0].r).toBe('restored');
      });
      const purged = await inZone(zone, opsPool, async (c) => (await c.query<{ n: number }>(`SELECT memory_sweep_purge(1000) AS n`)).rows[0]!.n);
      expect(purged).toBe(1);
      expect(await row(at30)).toBeUndefined();
      expect((await row(at720h)).status).toBe('approved');
    });
    it('purging a deleted head keeps the versions it replaced as history and takes its open records with it', async () => {
      const v1 = await propose();
      const v2 = await call<string>(aAdmin, `memory_edit($1::uuid,$2,NULL)`, [v1, body()]);
      await admin.query(`INSERT INTO memory_entry_opens (account_id, entry_id, user_id, content_sha256) SELECT account_id, id, $2, content_sha256 FROM memory_entries WHERE id = $1`, [v2, aAdmin]);
      await del(v2);
      await age(v2, { deleted_at: 31 });
      expect(await sweep('memory_sweep_purge')).toBe(1);
      expect(await row(v2)).toBeUndefined();
      expect(await row(v1)).toMatchObject({ version: 1, status: 'superseded' });
      expect((await admin.query(`SELECT 1 FROM memory_entry_opens WHERE entry_id = $1`, [v2])).rowCount).toBe(0);
      // A superseded version is never deleted, so it is never purged.
      await expect(del(v1)).rejects.toMatchObject({ message: /invalid_transition/ });
    });
  });

  describe('retirement after 90 days unused', () => {
    it('counts from the newest of the last recall and the approval, so a recall keeps an entry and a Restore sticks', async () => {
      const unused = await write();
      const recalled = await write();
      const young = await write();
      const restored = await write();
      await age(unused, { approved_at: 91, created_at: 91 });
      await age(recalled, { approved_at: 200, created_at: 200, last_recalled_at: 10 });
      await age(young, { approved_at: 89, created_at: 89 });
      await age(restored, { approved_at: 300, created_at: 300, last_recalled_at: 120 });
      expect(await sweep('memory_sweep_retire')).toBe(2);
      expect((await row(unused)).status).toBe('retired');
      expect((await row(restored)).status).toBe('retired');
      expect((await row(recalled)).status).toBe('approved');
      expect((await row(young)).status).toBe('approved');
      expect((await audit(unused)).at(-1)).toMatchObject({ actor: 'system:memory_sweep', action: 'memory.retired', payload: { from_status: 'approved', to_status: 'retired' } });

      // Restore: approval is now; the old recall stamp must not retire it again at the next sweep.
      expect(await decide(restored, 'approved')).toBe('decided');
      expect(await sweep('memory_sweep_retire')).toBe(0);
      expect((await row(restored)).status).toBe('approved');
    });
  });

  describe('the rules hold in the database', () => {
    it('touches every account, only due rows, and leaves the other statuses alone', async () => {
      const inB = await propose(b.accountId);
      const rejected = await propose();
      await decide(rejected, 'rejected');
      await age(inB, { expires_at: 1 });
      await admin.query(`UPDATE memory_entries SET expires_at = now() - interval '1 day' WHERE id = $1`, [rejected]);
      expect(await sweepAll()).toEqual({ expired: 1, retired: 0, purged: 0 });
      expect((await row(inB)).status).toBe('expired');
      expect((await row(rejected)).status).toBe('rejected');
    });
    it('goes in batches of the size asked, and refuses a size outside 1 to 1000', async () => {
      const ids = [await propose(), await propose(), await propose()];
      for (const id of ids) await age(id, { expires_at: 1 });
      expect(await sweep('memory_sweep_expire', 2)).toBe(2);
      expect(await sweep('memory_sweep_expire', 2)).toBe(1);
      expect(await sweep('memory_sweep_expire', 2)).toBe(0);
      for (const bad of [0, 1001, null]) {
        await expect(opsPool.query(`SELECT memory_sweep_expire($1::int)`, [bad])).rejects.toMatchObject({ code: '22023' });
      }
    });
    it('skips a row a person is deciding right now, and the next pass takes it if it is still due', async () => {
      const id = await propose();
      await age(id, { expires_at: 1 });
      const holder = await adminPool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM memory_entries WHERE id = $1 FOR UPDATE', [id]);
        expect(await sweep('memory_sweep_expire')).toBe(0);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
      expect(await sweep('memory_sweep_expire')).toBe(1);
    });
    it('the row policies refuse what a sweep may not do, even to the role itself', async () => {
      const fresh = await write();
      const deletedYesterday = await write();
      await del(deletedYesterday);
      await age(deletedYesterday, { deleted_at: 1 });
      const asRole = async (sql: string, params: unknown[]) => {
        await admin.query('BEGIN');
        try {
          await admin.query(`SET LOCAL ROLE ${ROLE}`);
          return await admin.query(sql, params);
        } finally {
          await admin.query('ROLLBACK');
        }
      };
      expect((await asRole(`UPDATE memory_entries SET status = 'retired' WHERE id = $1`, [fresh])).rowCount).toBe(0);
      expect((await asRole(`DELETE FROM memory_entries WHERE id = $1`, [deletedYesterday])).rowCount).toBe(0);
      const stale = await write();
      await age(stale, { approved_at: 100, created_at: 100 });
      await expect(asRole(`UPDATE memory_entries SET status = 'rejected' WHERE id = $1`, [stale])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(asRole(`UPDATE memory_entries SET body = 'x' WHERE id = $1`, [stale])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(asRole(`SELECT body FROM memory_entries LIMIT 1`, [])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(
        asRole(`INSERT INTO audit_log (account_id, actor, action, payload) VALUES ($1, 'system:memory_sweep', 'memory.approved', '{}')`, [a.accountId]),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect((await row(fresh)).status).toBe('approved');
      expect((await row(deletedYesterday)).status).toBe('deleted');
    });
    it('writes no entry text into audit_log', async () => {
      const id = await propose();
      const text = (await row(id)).body as string;
      await age(id, { expires_at: 1 });
      await sweep('memory_sweep_expire');
      expect((await admin.query(`SELECT 1 FROM audit_log WHERE payload::text LIKE '%' || $1 || '%'`, [text])).rowCount).toBe(0);
    });
  });

  describe('grants', () => {
    const q = async (sql: string) => (await admin.query<{ can: boolean }>(sql)).rows[0]!.can;
    it('the role is NOLOGIN and unprivileged, has no member, and owns exactly the three sweeps', async () => {
      const { rows } = await admin.query(`SELECT rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1`, [ROLE]);
      expect(rows[0]).toEqual({ rolcanlogin: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
      expect((await admin.query(`SELECT 1 FROM pg_auth_members WHERE roleid = $1::regrole OR member = $1::regrole`, [ROLE])).rowCount).toBe(0);
      const owned = await admin.query<{ name: string }>(`SELECT p.proname AS name FROM pg_proc p WHERE p.proowner = $1::regrole ORDER BY 1`, [ROLE]);
      expect(owned.rows.map((r) => r.name)).toEqual(SWEEPS);
      expect(await q(`SELECT has_schema_privilege('${ROLE}', 'public', 'CREATE') AS can`)).toBe(false);
    });
    it('the sweeps are definers with a pinned search_path and EXECUTE for platform_ops alone', async () => {
      const { rows } = await admin.query(
        `SELECT p.proname, p.prosecdef, p.proconfig,
                has_function_privilege('platform_ops', p.oid, 'EXECUTE') AS ops,
                has_function_privilege('app_user', p.oid, 'EXECUTE') AS app,
                has_function_privilege('partner_user', p.oid, 'EXECUTE') AS partner,
                COALESCE((SELECT bool_or(x.grantee = 0) FROM aclexplode(p.proacl) x), false) AS pub,
                COALESCE((SELECT bool_or(x.is_grantable) FROM aclexplode(p.proacl) x), false) AS grantable
           FROM pg_proc p WHERE p.proowner = $1::regrole ORDER BY 1`,
        [ROLE],
      );
      for (const r of rows) {
        expect(r, r.proname).toMatchObject({ prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'], ops: true, app: false, partner: false, pub: false, grantable: false });
      }
      await expect(call(aAdmin, `memory_sweep_expire(10)`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });
    it('platform_ops gains nothing on the tables, and the role cannot write the text, insert, or touch another table', async () => {
      for (const t of ['memory_entries', 'memory_entry_opens']) {
        expect(await q(`SELECT has_any_column_privilege('platform_ops','public.${t}','SELECT, INSERT, UPDATE, REFERENCES') AS can`), t).toBe(false);
        expect(await q(`SELECT has_table_privilege('platform_ops','public.${t}','SELECT, INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER') AS can`), t).toBe(false);
      }
      await expect(opsPool.query(`SELECT id FROM memory_entries LIMIT 1`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      for (const col of ['body', 'why', 'content_sha256', 'provenance', 'scope_ref', 'created_by']) {
        expect(await q(`SELECT has_column_privilege('${ROLE}','public.memory_entries','${col}','SELECT, UPDATE') AS can`), col).toBe(false);
      }
      for (const col of ['expires_at', 'approved_at', 'deleted_at', 'last_recalled_at', 'version', 'author_kind']) {
        expect(await q(`SELECT has_column_privilege('${ROLE}','public.memory_entries','${col}','UPDATE') AS can`), col).toBe(false);
      }
      expect(await q(`SELECT has_any_column_privilege('${ROLE}','public.memory_entries','INSERT') AS can`)).toBe(false);
      expect(await q(`SELECT has_table_privilege('${ROLE}','public.audit_log','SELECT, UPDATE, DELETE') AS can`)).toBe(false);
      expect(await q(`SELECT has_any_column_privilege('${ROLE}','public.account_members','SELECT, INSERT, UPDATE') AS can`)).toBe(false);
    });
    it('the history reader is SECURITY INVOKER with a pinned search_path, EXECUTE for app_user alone, and reads only the session tenant', async () => {
      const { rows } = await admin.query(
        `SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner,
                has_function_privilege('app_user', p.oid, 'EXECUTE') AS app,
                has_function_privilege('platform_ops', p.oid, 'EXECUTE') AS ops,
                has_function_privilege('partner_user', p.oid, 'EXECUTE') AS partner,
                COALESCE((SELECT bool_or(x.grantee = 0) FROM aclexplode(p.proacl) x), false) AS pub,
                COALESCE((SELECT bool_or(x.is_grantable) FROM aclexplode(p.proacl) x), false) AS grantable
           FROM pg_proc p WHERE p.oid = 'public.memory_history_read(uuid,integer)'::regprocedure`,
      );
      expect(rows[0]).toMatchObject({ prosecdef: false, proconfig: ['search_path=pg_catalog, public, pg_temp'], app: true, ops: false, partner: false, pub: false, grantable: false });
      expect(rows[0].owner).not.toBe(ROLE);
      await expect(opsPool.query(`SELECT * FROM memory_history_read($1::uuid)`, [randomUUID()])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });

      const id = await write();
      await decide(id, 'retired');
      const read = (accountId: string, limit: number | null = null) =>
        withTenant(appPool, accountId, (c) => c.query(`SELECT action FROM memory_history_read($1::uuid, $2::int)`, [id, limit]));
      expect((await read(a.accountId)).rows.map((r) => r.action)).toEqual(['memory.written', 'memory.retired']);
      expect((await read(a.accountId, 1)).rows).toHaveLength(1);
      expect((await read(a.accountId, 0)).rows).toHaveLength(1);
      expect((await read(b.accountId)).rowCount).toBe(0);
      // No tenant in the session: nothing.
      expect((await appPool.query(`SELECT * FROM memory_history_read($1::uuid)`, [id])).rowCount).toBe(0);
    });
    it('the job is seeded once a day', async () => {
      expect((await admin.query(`SELECT interval_seconds FROM reconcile_jobs WHERE name = 'memory_sweep'`)).rows[0]).toEqual({ interval_seconds: 86400 });
    });
  });
});
