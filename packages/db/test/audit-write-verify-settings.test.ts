import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** The action names in a migration's audit_write allowlist (the ARRAY[...] after `p_action = ANY (`). */
function allowlistOf(file: string): string[] {
  const sql = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  const start = sql.indexOf('p_action = ANY (ARRAY[');
  const end = sql.indexOf('])', start);
  return [...sql.slice(start, end).matchAll(/'([a-z_.]+)'/g)].map((m) => m[1]!);
}

/**
 * D#749 V4a (migration 1008): audit_write accepts 'verify_settings.changed' and every action 0974 (the newest earlier definition) accepted, and the function keeps its
 * other refusals. The earlier list is read from 0974's own text, so a dropped entry is caught without a hand-kept copy.
 */
describe('audit_write allowlist carries verify_settings.changed', () => {
  let adminPool: Pool;
  let admin: PoolClient;
  let appUserPool: Pool;
  let a: SeedRefs;

  const call = (action: string | null, payload: string = '{"n":1}') =>
    withTenant(appUserPool, a.accountId, a.userId, (c) => c.query(`SELECT audit_write($1::text, $2::jsonb) AS id`, [action, payload]));
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

  it('1008 lists exactly 0974\'s actions plus verify_settings.changed', () => {
    const before = allowlistOf('0974_context_budget_write.sql');
    expect(before.length).toBeGreaterThan(20);
    expect(allowlistOf('1008_verify_settings_audit.sql')).toEqual([...before, 'verify_settings.changed']);
  });

  it('accepts the new action and every earlier one, each leaving one row', async () => {
    for (const action of ['verify_settings.changed', ...allowlistOf('0974_context_budget_write.sql')]) {
      await call(action);
      expect(await count(action), action).toBe(1);
    }
  });

  it('still refuses an unknown action, NULL and a non-object payload', async () => {
    for (const action of ['verify_settings.deleted', 'verify_settings', '', null]) await expect(call(action)).rejects.toMatchObject({ code: '22023' });
    await expect(call('verify_settings.changed', '[1]')).rejects.toMatchObject({ code: '22023' });
  });

  it('stays closed to a caller that is not a member of the account', async () => {
    await expect(withTenant(appUserPool, a.accountId, randomUUID(), (c) => c.query(`SELECT audit_write('verify_settings.changed', '{}'::jsonb)`))).rejects.toMatchObject({ code: '42501' });
  });
});
