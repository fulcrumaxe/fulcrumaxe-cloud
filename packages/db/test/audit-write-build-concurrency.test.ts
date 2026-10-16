import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/** D#483 S5-c2 (migration 0850): audit_write accepts 'build_concurrency.changed' and still accepts every action it accepted before, including 'ask_route.changed' (0836) and the discovery one (0849). */
describe('audit_write allowlist carries build_concurrency.changed', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let a: SeedRefs;

  const call = (action: string | null) =>
    withTenant(appUserPool, a.accountId, a.userId, (c) => c.query(`SELECT audit_write($1::text, '{"n":1}'::jsonb) AS id`, [action]));
  const count = async (action: string) =>
    Number((await admin.query(`SELECT count(*) AS n FROM audit_log WHERE account_id = $1 AND action = $2`, [a.accountId, action])).rows[0].n);

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    admin = await adminPool.connect();
    appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
    a = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await adminPool.end();
    await appUserPool.end();
  });

  it('accepts the new action and every earlier one, the last three migrations included', async () => {
    for (const action of [
      'build_concurrency.changed', 'discovery_setting.changed', 'ask_route.changed', 'decision_ask_setting.changed', 'run_limits.changed', 'decision_dial_changed',
      'model_connection.connect', 'model_connection.replace', 'model_connection.remove',
      'role_settings.mode_changed', 'role_settings.guard_changed', 'role_settings.model_changed',
    ]) {
      await call(action);
      expect(await count(action), action).toBe(1);
    }
  });

  it('still refuses an unknown action and NULL', async () => {
    for (const action of ['build_concurrency.deleted', '', null]) await expect(call(action)).rejects.toMatchObject({ code: '22023' });
  });
});
