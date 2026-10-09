import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#2 SANDBOX-REAPER-2b (0762, C85 criteria 23 and 24): the reaper's database kill switch and its audit. Real Postgres, real roles.
 */

/**
 * The off switch exactly as the runbook prints it (docs/ops/sandbox-reaper.md, run as platform_ops), with the operator's name filled in.
 * The runbook is a private page and lives in its own pull request; if its statement changes, this one changes with it.
 */
const RUNBOOK_OFF = (who: string) => `UPDATE sandbox_reap_settings SET mode = 'off', updated_by = '${who}'`;

describe('the sandbox reaper settings and their audit (0762)', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appPool: Pool;
  let opsPool: Pool;
  let writerPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    opsPool = createPool(process.env.DATABASE_URL_PLATFORM_OPS!);
    writerPool = createPool(process.env.DATABASE_URL_RUN_WRITER!);
  });
  afterAll(async () => {
    admin.release();
    for (const p of [adminPool, appPool, opsPool, writerPool]) await p.end();
  });
  beforeEach(async () => {
    await admin.query(`UPDATE sandbox_reap_settings SET mode = NULL, updated_by = 'test-reset'`);
    await admin.query('DELETE FROM sandbox_reap_settings_audit');
  });

  const mode = async () => (await opsPool.query('SELECT mode FROM sandbox_reap_settings')).rows;
  const audit = async () => (await admin.query('SELECT previous_mode, mode, actor, db_session_user FROM sandbox_reap_settings_audit ORDER BY changed_at, id')).rows;

  describe('the setting', () => {
    it('ships as one row with no override', async () => {
      const { rows } = await admin.query('SELECT id, mode FROM sandbox_reap_settings');
      expect(rows).toEqual([{ id: true, mode: null }]);
    });

    it('platform_ops reads it and sets it, and the new value is what the next read answers', async () => {
      expect(await mode()).toEqual([{ mode: null }]);
      await opsPool.query(`UPDATE sandbox_reap_settings SET mode = 'dry_run', updated_by = 'ops:a'`);
      expect(await mode()).toEqual([{ mode: 'dry_run' }]);
      await opsPool.query(`UPDATE sandbox_reap_settings SET mode = NULL, updated_by = 'ops:a'`);
      expect(await mode()).toEqual([{ mode: null }]);
    });

    it('app_user, the runner login and sandbox_reaper can neither read nor write it, nor read the audit', async () => {
      for (const pool of [appPool, writerPool]) {
        await expect(pool.query('SELECT * FROM sandbox_reap_settings')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await expect(pool.query(`UPDATE sandbox_reap_settings SET mode = 'on', updated_by = 'x'`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        await expect(pool.query('SELECT * FROM sandbox_reap_settings_audit')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      }
      // sandbox_reaper has no login; a superuser session takes the role for the statement.
      for (const sql of ['SELECT * FROM sandbox_reap_settings', `UPDATE sandbox_reap_settings SET mode = 'on', updated_by = 'x'`, 'SELECT * FROM sandbox_reap_settings_audit']) {
        await admin.query('BEGIN');
        try {
          await admin.query('SET LOCAL ROLE sandbox_reaper');
          await expect(admin.query(sql)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
        } finally {
          await admin.query('ROLLBACK');
        }
      }
      expect(await mode()).toEqual([{ mode: null }]);
    });

    it('platform_ops cannot INSERT, DELETE, TRUNCATE or UPDATE id, and a second row is impossible', async () => {
      await expect(opsPool.query(`INSERT INTO sandbox_reap_settings (id, mode, updated_by) VALUES (false, 'on', 'x')`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(opsPool.query('DELETE FROM sandbox_reap_settings')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(opsPool.query('TRUNCATE sandbox_reap_settings')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(opsPool.query(`UPDATE sandbox_reap_settings SET id = false, updated_by = 'x'`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      // Even the owner cannot make a second row: the key is a boolean that must be true.
      await expect(admin.query(`INSERT INTO sandbox_reap_settings (id) VALUES (true)`)).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
      await expect(admin.query(`INSERT INTO sandbox_reap_settings (id) VALUES (false)`)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      expect((await admin.query('SELECT 1 FROM sandbox_reap_settings')).rows).toHaveLength(1);
    });

    it('a mode that is none of off, dry_run, on is refused by the CHECK; updated_by must be 1 to 200 characters', async () => {
      await expect(opsPool.query(`UPDATE sandbox_reap_settings SET mode = 'ON', updated_by = 'x'`)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(opsPool.query(`UPDATE sandbox_reap_settings SET mode = 'off', updated_by = ''`)).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      await expect(opsPool.query(`UPDATE sandbox_reap_settings SET mode = 'off', updated_by = $1`, ['x'.repeat(201)])).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
      expect(await mode()).toEqual([{ mode: null }]);
      expect(await audit()).toEqual([]);
    });

    it('the exact statement in the runbook, run as platform_ops, turns the reaper off and leaves one audit row', async () => {
      await opsPool.query(RUNBOOK_OFF('ops:jane'));
      expect(await mode()).toEqual([{ mode: 'off' }]);
      expect(await audit()).toEqual([{ previous_mode: null, mode: 'off', actor: 'ops:jane', db_session_user: 'platform_ops' }]);
    });
  });

  describe('the audit', () => {
    it('writes one row per change of mode, with the old and new mode, the actor and the database login; a repeat of the same mode writes none', async () => {
      await opsPool.query(`UPDATE sandbox_reap_settings SET mode = 'on', updated_by = 'ops:a'`);
      await opsPool.query(`UPDATE sandbox_reap_settings SET mode = 'on', updated_by = 'ops:b'`);
      await opsPool.query(`UPDATE sandbox_reap_settings SET mode = 'off', updated_by = 'ops:c'`);
      await opsPool.query(`UPDATE sandbox_reap_settings SET mode = NULL, updated_by = 'ops:d'`);
      expect(await audit()).toEqual([
        { previous_mode: null, mode: 'on', actor: 'ops:a', db_session_user: 'platform_ops' },
        { previous_mode: 'on', mode: 'off', actor: 'ops:c', db_session_user: 'platform_ops' },
        { previous_mode: 'off', mode: null, actor: 'ops:d', db_session_user: 'platform_ops' },
      ]);
    });

    it('a change of mode that does not also set updated_by is refused, and nothing moves or is audited', async () => {
      await expect(opsPool.query(`UPDATE sandbox_reap_settings SET mode = 'off'`)).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      expect(await mode()).toEqual([{ mode: null }]);
      expect(await audit()).toEqual([]);
    });

    it('the attribution mark of one update is not reused by a later update in the same transaction', async () => {
      const client = await opsPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE sandbox_reap_settings SET mode = 'dry_run', updated_by = 'ops:a'`);
        await expect(client.query(`UPDATE sandbox_reap_settings SET mode = 'off'`)).rejects.toMatchObject({ code: PG_ERROR.INVALID_PARAMETER_VALUE });
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      expect(await audit()).toEqual([]);
    });

    it('a rolled-back change leaves neither the setting nor an audit row', async () => {
      const client = await opsPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE sandbox_reap_settings SET mode = 'off', updated_by = 'ops:a'`);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      expect(await mode()).toEqual([{ mode: null }]);
      expect(await audit()).toEqual([]);
    });

    it('platform_ops can read the audit and write nothing to it: no forged row, no edit, no delete, no direct call of the helper or the trigger', async () => {
      await opsPool.query(RUNBOOK_OFF('ops:a'));
      expect((await opsPool.query('SELECT mode FROM sandbox_reap_settings_audit')).rows).toEqual([{ mode: 'off' }]);
      await expect(opsPool.query(`INSERT INTO sandbox_reap_settings_audit (previous_mode, mode, actor, db_session_user) VALUES (NULL, 'on', 'a', 'a')`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(opsPool.query(`UPDATE sandbox_reap_settings_audit SET actor = 'x'`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(opsPool.query('DELETE FROM sandbox_reap_settings_audit')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(opsPool.query('TRUNCATE sandbox_reap_settings_audit')).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(opsPool.query(`SELECT sandbox_reap_settings_audit_write('on')`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(opsPool.query(`SELECT sandbox_reap_settings_audit_trg()`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      await expect(appPool.query(`SELECT sandbox_reap_settings_audit_write('on')`)).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
      expect(await audit()).toHaveLength(1);
    });

    it('the helper is owned by its own NOLOGIN, member-less role, which holds INSERT on the audit table and a two-column read of the setting', async () => {
      const fn = await admin.query(
        `SELECT pg_get_userbyid(proowner) AS owner, prosecdef, proconfig FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = 'sandbox_reap_settings_audit_write'`,
      );
      expect(fn.rows).toEqual([{ owner: 'sandbox_reap_audit_writer', prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'] }]);
      const role = await admin.query(`SELECT rolcanlogin, rolsuper, rolcreaterole, rolbypassrls, rolreplication, rolcreatedb FROM pg_roles WHERE rolname = 'sandbox_reap_audit_writer'`);
      expect(role.rows).toEqual([{ rolcanlogin: false, rolsuper: false, rolcreaterole: false, rolbypassrls: false, rolreplication: false, rolcreatedb: false }]);
      const members = await admin.query(`SELECT 1 FROM pg_auth_members WHERE roleid = 'sandbox_reap_audit_writer'::regrole OR member = 'sandbox_reap_audit_writer'::regrole`);
      expect(members.rows).toEqual([]);
      const trg = await admin.query(`SELECT pg_get_userbyid(proowner) AS owner, prosecdef FROM pg_proc WHERE proname = 'sandbox_reap_settings_audit_trg'`);
      expect(trg.rows[0]).toMatchObject({ prosecdef: false });
      expect(trg.rows[0].owner).not.toBe('platform_ops');
    });
  });
});
