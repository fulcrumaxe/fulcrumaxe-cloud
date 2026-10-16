import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';

const HASH = 'b'.repeat(64);

/** D#600 CX-8b: what a run's prompt held (migration 0833). Real Postgres, row security forced. */
describe('migration 0833: run_context_inputs', () => {
  let adminPool: Pool;
  let appPool: Pool;
  let admin: PoolClient;
  let a: SeedRefs;
  let b: SeedRefs;

  const run = async (accountId: string): Promise<string> => {
    const id = randomUUID();
    await admin.query(`INSERT INTO agent_runs (id, account_id, role, runtime, status) VALUES ($1, $2, 'executor', 'production', 'succeeded')`, [id, accountId]);
    return id;
  };
  const put = (accountId: string, runId: string, ids: string[] = [], versions: number[] = [], mapVersion: string | null = null, sha: string | null = null) =>
    withTenant(appPool, accountId, randomUUID(), (c) =>
      c.query(`INSERT INTO run_context_inputs (account_id, run_id, recalled_entry_ids, recalled_entry_versions, map_version, map_sha256) VALUES ($1, $2, $3::uuid[], $4::integer[], $5, $6)`, [accountId, runId, ids, versions, mapVersion, sha]),
    );

  beforeAll(async () => {
    adminPool = createPool(process.env.DATABASE_URL!);
    appPool = createPool(process.env.DATABASE_URL_APP_USER!);
    admin = await adminPool.connect();
    a = await seedAccount(admin, randomUUID());
    b = await seedAccount(admin, randomUUID());
  });
  afterAll(async () => {
    admin.release();
    await Promise.all([adminPool.end(), appPool.end()]);
  });

  it('stores a run\'s recalled entries in order and its map identity, and the row goes with the run', async () => {
    const r = await run(a.accountId);
    const ids = [randomUUID(), randomUUID()];
    await put(a.accountId, r, ids, [3, 1], '1', HASH);
    const row = (await admin.query('SELECT recalled_entry_ids, recalled_entry_versions, map_version, map_sha256 FROM run_context_inputs WHERE run_id = $1', [r])).rows[0];
    expect(row).toEqual({ recalled_entry_ids: ids, recalled_entry_versions: [3, 1], map_version: '1', map_sha256: HASH });
    await admin.query('DELETE FROM agent_runs WHERE id = $1', [r]);
    expect((await admin.query('SELECT 1 FROM run_context_inputs WHERE run_id = $1', [r])).rowCount).toBe(0);
  });

  it('has a GIN index on recalled_entry_ids, so "used in N runs" (D#601 MEM-4a) is an index search', async () => {
    const r = await admin.query(`SELECT indexdef FROM pg_indexes WHERE tablename = 'run_context_inputs' AND indexname = 'run_context_inputs_recalled_idx'`);
    expect(r.rows[0]?.indexdef).toMatch(/USING gin \(recalled_entry_ids\)/);
  });

  it('refuses a bad shape: unequal arrays, a null or zero version, more than 50 entries, half a map, a malformed hash', async () => {
    const r = await run(a.accountId);
    const id = randomUUID();
    await expect(put(a.accountId, r, [id], [])).rejects.toMatchObject({ code: '23514' });
    await expect(put(a.accountId, r, [id], [0])).rejects.toMatchObject({ code: '23514' });
    const many = Array.from({ length: 51 }, () => randomUUID());
    await expect(put(a.accountId, r, many, many.map(() => 1))).rejects.toMatchObject({ code: '23514' });
    await expect(put(a.accountId, r, [], [], '1', null)).rejects.toMatchObject({ code: '23514' });
    await expect(put(a.accountId, r, [], [], '1', 'xyz')).rejects.toMatchObject({ code: '23514' });
    await put(a.accountId, r, [id], [2]);
    // One row per run.
    await expect(put(a.accountId, r, [id], [2])).rejects.toMatchObject({ code: '23505' });
  });

  it('RLS: another account reads nothing, cannot write a row for this account\'s run, and nobody updates or deletes through app_user', async () => {
    const r = await run(a.accountId);
    await put(a.accountId, r, [randomUUID()], [1]);
    expect((await withTenant(appPool, b.accountId, randomUUID(), (c) => c.query('SELECT 1 FROM run_context_inputs'))).rowCount).toBe(0);
    await expect(put(b.accountId, r, [], [], '1', HASH)).rejects.toMatchObject({ code: '23503' });
    await expect(withTenant(appPool, b.accountId, randomUUID(), (c) => c.query(`INSERT INTO run_context_inputs (account_id, run_id, map_version, map_sha256) VALUES ($1, $2, '1', $3)`, [a.accountId, r, HASH]))).rejects.toMatchObject({ code: '42501' });
    await expect(withTenant(appPool, a.accountId, randomUUID(), (c) => c.query(`UPDATE run_context_inputs SET map_version = '2' WHERE run_id = $1`, [r]))).rejects.toMatchObject({ code: '42501' });
    await expect(withTenant(appPool, a.accountId, randomUUID(), (c) => c.query('DELETE FROM run_context_inputs WHERE run_id = $1', [r]))).rejects.toMatchObject({ code: '42501' });
    expect((await withTenant(appPool, a.accountId, randomUUID(), (c) => c.query('SELECT 1 FROM run_context_inputs WHERE run_id = $1', [r]))).rowCount).toBe(1);
  });
});
