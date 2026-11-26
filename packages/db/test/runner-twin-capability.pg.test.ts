import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { insertRunner } from './helpers/runnerFixtures.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

/** D#845 ON-27b (migration 1108): the closed capability list takes `twin_v1`, through the definer and the CHECK, and keeps every earlier value. */
describe('migration 1108: runner_capabilities takes twin_v1 [pg]', () => {
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

  it('stores twin_v1 next to the capabilities that came before it, as sent', async () => {
    const caps = ['proposal_verifier', 'heartbeat_inventory_v1', 'survey_v1', 'repo_token_refresh_v1', 'engine_lease_v1', 'survey_public_v1', 'twin_v1'];
    await record(caps);
    expect(await stored()).toEqual(caps);
    await record([]);
    expect(await stored()).toEqual([]);
  });

  it('keeps every value the closed list had before it (1096\'s twenty-eight) next to twin_v1', async () => {
    const before = ['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1', 'discovery_analyst', 'conflict_facts_v1', 'ordered_facts_v1', 'tip_publish_v1', 'mem_proposal_v1', 'browser_chrome_v1', 'deploy_order_v1', 'browser_playwright_v1', 'overlap_facts_v1', 'engine_bridge_v1', 'sandbox_commands_v1', 'watch_mode_v1', 'kvm_fact_v1', 'preflight_v1', 'heartbeat_inventory_v1', 'device_register_v1', 'project_setup_v1', 'survey_v1', 'engine_session_v1', 'machine_login_v1', 'repo_token_refresh_v1', 'engine_lease_v1', 'survey_public_v1'];
    expect(before).toHaveLength(28);
    await record([...before, 'twin_v1']);
    expect(await stored()).toEqual([...before, 'twin_v1']);
    for (const one of before) {
      await record([one]);
      expect(await stored()).toEqual([one]);
    }
  });

  it('still refuses an unknown code or a repeat (22023), and the CHECK holds the same line for a direct write (23514)', async () => {
    await record(['twin_v1']);
    for (const bad of [['twin_v2'], ['twin_v1', 'twin_v1']]) {
      await expect(record(bad), JSON.stringify(bad)).rejects.toMatchObject({ code: '22023' });
    }
    expect(await stored()).toEqual(['twin_v1']);
    await expect(admin.query(`UPDATE runner_capabilities SET capabilities = ARRAY['twin_v2'] WHERE runner_id = $1`, [runner])).rejects.toMatchObject({ code: '23514' });
  });

  it('is one function: app_user alone may execute it and PUBLIC may not', async () => {
    const { rows } = await admin.query(
      `SELECT coalesce((SELECT array_agg(DISTINCT CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee)::text END) FROM aclexplode(p.proacl) x WHERE x.grantee <> p.proowner), '{}') AS grantees
         FROM pg_proc p WHERE p.oid = 'runner_capabilities_record(text[])'::regprocedure`,
    );
    expect(rows[0].grantees).toEqual(['app_user']);
  });
});
