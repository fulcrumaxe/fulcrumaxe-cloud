import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { loadLiveRoutingTable, route } from '../src/route.js';

describe('[pg] the site-kit roles after migration 1017 (D#2 C12 (e))', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('the live table routes site-verifier Feature to opus-5, and every site-kit pair to its ruled model', async () => {
    const live = await loadLiveRoutingTable(pool);
    expect(route({ role: 'site-verifier', size: 'Feature' }, live).model).toBe('opus-5');
    const pairs = [
      ['site-extractor', 'Small', 'sonnet-5'],
      ['site-extractor', 'Feature', 'sonnet-5'],
      ['site-extractor', 'Critical', 'opus-5'],
      ['site-verifier', 'Small', 'sonnet-5'],
      ['site-verifier', 'Feature', 'opus-5'],
      ['site-verifier', 'Critical', 'opus-5'],
    ] as const;
    for (const [role, size, model] of pairs) expect(route({ role, size }, live).model, `${role}/${size}`).toBe(model);
  });

  it('a customer override of site-verifier to haiku-4.5 is clamped back to the floor', async () => {
    const live = await loadLiveRoutingTable(pool);
    const r = route({ role: 'site-verifier', size: 'Small', repoSettings: { modelOverride: 'haiku-4.5' } }, live);
    expect(r.model).toBe('sonnet-5');
  });

  it('the migration is the one place the rows come from: exactly six site-kit rows per live or proposed version, none elsewhere', async () => {
    const { rows } = await pool.query<{ version: number; n: string }>(
      `SELECT t.version, count(r.*)::text AS n
         FROM routing_tables t LEFT JOIN routing_rows r ON r.table_version = t.version AND r.role IN ('site-extractor', 'site-verifier')
        GROUP BY t.version, t.status ORDER BY t.version`,
    );
    for (const row of rows) expect(Number(row.n), `version ${row.version}`).toBe(6);
  });

  it('the role_settings floor CHECK refuses site-verifier on haiku-4.5', async () => {
    const { rows } = await pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'role_settings'::regclass AND conname = 'role_settings_model_floor'`,
    );
    expect(rows[0]!.def).toContain("'site-verifier'");
  });
});
