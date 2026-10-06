import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedF1 } from './helpers/members.js';
import { PG_ERROR } from './helpers/pgErrors.js';

/**
 * D#2 C48 H12c, migration 0651: audit_write accepts 'run_limits.changed' and
 * still accepts every earlier entry and refuses an unlisted one; run_limits
 * is unique on (account_id, role) and its role column is well-formed.
 * The CHECK bounds, RLS and resolution are in packages/core/test/run-limits.test.ts.
 */
describe('migration 0651: run_limits table and the run_limits.changed audit action', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
  });

  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  const audit = async (f1: { accountId: string; o1: string }, action: string, payload = '{}') =>
    withTenant(appUserPool, f1.accountId, f1.o1, (c) =>
      c.query<{ audit_write: string }>('SELECT audit_write($1, $2::jsonb)', [action, payload]),
    );

  it("audit_write('run_limits.changed') is accepted and stamps the actor; an unlisted action still raises", async () => {
    const f1 = await seedF1(admin);
    const { rows } = await audit(f1, 'run_limits.changed', JSON.stringify({ role: '*', before: {}, after: {} }));
    const { rows: logged } = await admin.query('SELECT action, actor FROM audit_log WHERE id = $1', [rows[0]!.audit_write]);
    expect(logged[0]).toMatchObject({ action: 'run_limits.changed', actor: f1.o1 });
    await expect(audit(f1, 'run_limits.not_a_real_action')).rejects.toMatchObject({
      code: PG_ERROR.INVALID_PARAMETER_VALUE,
    });
  });

  it('keeps every earlier allowlist entry accepted', async () => {
    const f1 = await seedF1(admin);
    for (const action of [
      'decision_dial_changed',
      'model_connection.connect',
      'model_connection.replace',
      'model_connection.remove',
      'role_settings.mode_changed',
      'role_settings.guard_changed',
      'role_settings.model_changed',
    ]) {
      expect((await audit(f1, action)).rows[0]!.audit_write, action).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it('is unique on (account_id, role), and role must be * or a lowercase slug', async () => {
    const f1 = await seedF1(admin);
    const ins = (role: string) =>
      admin.query('INSERT INTO run_limits (account_id, role) VALUES ($1, $2)', [f1.accountId, role]);
    await ins('*');
    await ins('executor');
    await expect(ins('executor')).rejects.toMatchObject({ code: PG_ERROR.UNIQUE_VIOLATION });
    await expect(ins('Not A Role')).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
  });
});
