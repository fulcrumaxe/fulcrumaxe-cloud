import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/** D#587 FU-179 (migration 1052): the closed capability list takes `heartbeat_inventory_v1`, through the definer and the CHECK, and keeps every earlier value. */
describe('migration 1052: runner_capabilities takes heartbeat_inventory_v1 [pg]', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let admin: PoolClient;
  let a: SeedRefs;
  let runner: string;

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    admin = await adminPool.connect();
    a = await seedAccount(admin, randomUUID());
    runner = await insertRunner(admin, a.accountId, a.userId);
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  const stored = () => admin.query(`SELECT capabilities FROM runner_capabilities WHERE runner_id = $1`, [runner]).then((r) => (r.rows[0]?.capabilities as string[] | undefined) ?? null);
  const record = (caps: unknown): Promise<unknown> =>
    withTenant(appPool, a.accountId, async (client) => {
      await client.query(`SELECT set_config('app.runner_id', $1, true)`, [runner]);
      await client.query('SELECT runner_capabilities_record($1::text[])', [caps]);
    });

  it('stores heartbeat_inventory_v1 next to the capabilities that came before it, as sent', async () => {
    const caps = ['proposal_verifier', 'sandbox_commands_v1', 'watch_mode_v1', 'kvm_fact_v1', 'heartbeat_inventory_v1'];
    await record(caps);
    expect(await stored()).toEqual(caps);
    await record([]);
    expect(await stored()).toEqual([]);
  });

  it('still refuses an unknown code or a repeat (22023), and the CHECK holds the same line for a direct write (23514)', async () => {
    await record(['heartbeat_inventory_v1']);
    for (const bad of [['heartbeat_inventory_v2'], ['heartbeat_inventory_v1', 'heartbeat_inventory_v1']]) {
      await expect(record(bad), JSON.stringify(bad)).rejects.toMatchObject({ code: '22023' });
    }
    expect(await stored()).toEqual(['heartbeat_inventory_v1']);
    await expect(admin.query(`UPDATE runner_capabilities SET capabilities = ARRAY['heartbeat_inventory_v2'] WHERE runner_id = $1`, [runner])).rejects.toMatchObject({ code: '23514' });
  });

  it('is one function: app_user alone may execute it and PUBLIC may not', async () => {
    const { rows } = await admin.query(
      `SELECT coalesce((SELECT array_agg(DISTINCT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee)::text END) FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner), '{}') AS grantees
         FROM pg_proc p WHERE p.oid = 'runner_capabilities_record(text[])'::regprocedure`,
    );
    expect(rows[0].grantees).toEqual(['app_user']);
  });
});
