import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { isAccountNotifyWindowOpen, stampAskNotified, stampAskRenotified } from '../src/askNotify.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * [pg] D#7 DP12b-2, migration 0932: account_notify_window_open, the per-account 15-minute email window read from the database.
 * Same stand-in login for the receipt invoker as ask-notify.pg.test.ts.
 */
const INVOKER_LOGIN = 'fx_ask_notify_window_test';
const OPTIONS = [{ id: 'apply', label: 'QUESTION-OPTION-TEXT apply' }, { id: 'skip', label: 'QUESTION-OPTION-TEXT skip' }];
const SIG = 'account_notify_window_open(uuid,integer)';

describe('account_notify_window_open (0932)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let invokerPool: Pool;
  let acct: SeedRefs;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${INVOKER_LOGIN}') THEN CREATE ROLE ${INVOKER_LOGIN} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; END IF; END $$`);
    await admin.query(`GRANT app_user, receipt_writer_invoker TO ${INVOKER_LOGIN}`);
    const u = new URL(process.env.DATABASE_URL_APP_USER!);
    u.username = INVOKER_LOGIN;
    u.password = '';
    invokerPool = createPool(u.toString());
    acct = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), invokerPool.end()]);
  });

  async function ask(t: SeedRefs): Promise<string> {
    const itemId = randomUUID();
    await admin.query(`INSERT INTO work_items (id, account_id, repo_id, kind, provenance, stage) VALUES ($1, $2, $3, 'issue', 'internal', 'in_progress')`, [itemId, t.accountId, t.repoId]);
    return withTenant(invokerPool, t.accountId, async (c) =>
      (await c.query<{ id: string }>(
        `SELECT decision_ask_raise('human_over_the_loop', 'test_strategy_choice', $1::uuid, NULL, $2::jsonb, 'apply', 'because', '["trusted"]'::jsonb, 60, 'stop_and_flag', 0) AS id`,
        [itemId, JSON.stringify(OPTIONS)])).rows[0]!.id);
  }
  /** Moves a stamp into the past. The immutability guard is bypassed for this one admin statement only. */
  async function ageStamp(id: string, minutes: number): Promise<void> {
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL session_replication_role = replica');
      await admin.query(`UPDATE decision_asks SET notified_at = notified_at - make_interval(mins => $2), renotified_at = renotified_at - make_interval(mins => $2) WHERE id = $1`, [id, minutes]);
      await admin.query('COMMIT');
    } catch (err) {
      await admin.query('ROLLBACK');
      throw err;
    }
  }

  it('the definer: owner platform_ops, pinned search_path, EXECUTE for the invoker only, nothing for PUBLIC or app_user', async () => {
    const r = (await admin.query(
      `SELECT pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS definer, p.proconfig AS config,
              has_function_privilege('receipt_writer_invoker', p.oid, 'EXECUTE') AS invoker, has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user,
              EXISTS (SELECT 1 FROM aclexplode(p.proacl) x WHERE x.grantee = 0) AS public_grant
         FROM pg_proc p WHERE p.oid::regprocedure::text = $1`, [SIG])).rows[0];
    expect(r).toMatchObject({ owner: 'platform_ops', definer: true, config: ['search_path=pg_catalog, public, pg_temp'], invoker: true, app_user: false, public_grant: false });
  });

  it('the policy for ended asks applies to platform_ops, to SELECT, and only to a stamped ask that is not open or overdue', async () => {
    const rows = (await admin.query(`SELECT cmd, roles::text AS roles, qual FROM pg_policies WHERE tablename = 'decision_asks' AND policyname = 'platform_ops_ask_notify_window_select'`)).rows;
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ cmd: 'SELECT', roles: '{platform_ops}' });
    expect(rows[0].qual).toContain("SESSION_USER <> 'platform_ops'");
    expect(rows[0].qual).toMatch(/state <> ALL/);
    expect(rows[0].qual).toContain('GREATEST(notified_at, renotified_at)');
  });

  it('is open with no stamp, closed right after a first-email stamp or a reminder stamp, and open again once the stamp is older than the window', async () => {
    const t = await seedAccount(admin, randomUUID());
    const a = await ask(t);
    expect(await isAccountNotifyWindowOpen(invokerPool, t.accountId, 900)).toBe(true);
    expect(await stampAskNotified(invokerPool, a)).toBe(true);
    expect(await isAccountNotifyWindowOpen(invokerPool, t.accountId, 900)).toBe(false);
    await ageStamp(a, 16);
    expect(await isAccountNotifyWindowOpen(invokerPool, t.accountId, 900)).toBe(true);
    await admin.query(`UPDATE decision_asks SET state = 'overdue' WHERE id = $1`, [a]);
    expect(await stampAskRenotified(invokerPool, a)).toBe(true);
    expect(await isAccountNotifyWindowOpen(invokerPool, t.accountId, 900)).toBe(false);
  });

  it('is per account: a stamp on another account does not close this one', async () => {
    const t = await seedAccount(admin, randomUUID());
    await stampAskNotified(invokerPool, await ask(t));
    expect(await isAccountNotifyWindowOpen(invokerPool, acct.accountId, 900)).toBe(true);
  });

  it('an ask that ended inside the window keeps the window closed (and not after an hour)', async () => {
    const t = await seedAccount(admin, randomUUID());
    const a = await ask(t);
    await stampAskNotified(invokerPool, a);
    await admin.query(`UPDATE decision_asks SET state = 'answered', answered_option = 'skip', answered_by = $2, answered_at = now() WHERE id = $1`, [a, t.userId]);
    expect(await isAccountNotifyWindowOpen(invokerPool, t.accountId, 900)).toBe(false);
    await ageStamp(a, 61);
    expect(await isAccountNotifyWindowOpen(invokerPool, t.accountId, 3600)).toBe(true);
  });

  it('refuses a window outside 1 to 3600 seconds, and the platform_ops session even with EXECUTE granted (rolled back)', async () => {
    await expect(invokerPool.query('SELECT account_notify_window_open($1::uuid, 0)', [acct.accountId])).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
    await expect(invokerPool.query('SELECT account_notify_window_open($1::uuid, 3601)', [acct.accountId])).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
    const c = await adminPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`GRANT EXECUTE ON FUNCTION ${SIG} TO platform_ops`);
      await c.query('SET LOCAL SESSION AUTHORIZATION platform_ops');
      await expect(c.query('SELECT account_notify_window_open($1::uuid, 900)', [acct.accountId])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE, message: expect.stringContaining('refused for a platform_ops login') });
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
      c.release();
    }
  });

  it('is not callable by app_user directly', async () => {
    const appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    try {
      await expect(appUserPool.query('SELECT account_notify_window_open($1::uuid, 900)', [acct.accountId])).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    } finally {
      await appUserPool.end();
    }
  });
});
