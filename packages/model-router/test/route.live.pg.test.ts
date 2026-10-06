import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '@fx/db/src/pool.js';
import { loadLiveRoutingTable, route } from '../src/route.js';

describe('[pg] loadLiveRoutingTable + route: data, not code', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('changing a row in the DB changes the routing result, with no code change', async () => {
    const before = route({ role: 'executor', size: 'Small' }, await loadLiveRoutingTable(pool));
    expect(before.model).toBe('haiku-4.5');

    await pool.query(
      "UPDATE routing_rows SET model = 'opus-5', rationale = 'test override' WHERE table_version = 1 AND role = 'executor' AND size = 'Small'",
    );
    try {
      const after = route({ role: 'executor', size: 'Small' }, await loadLiveRoutingTable(pool));
      expect(after.model).toBe('opus-5');
      expect(after.reason).toBe('table v1: executor/Small');
    } finally {
      await pool.query(
        "UPDATE routing_rows SET model = 'haiku-4.5', rationale = 'role default (sonnet) size-adjusted for Small' WHERE table_version = 1 AND role = 'executor' AND size = 'Small'",
      );
    }
  });

  it('reads only the live version -- a proposed version is invisible', async () => {
    await pool.query("INSERT INTO routing_tables (version, status, source) VALUES (555, 'proposed', 'cost_analyst')");
    await pool.query(
      "INSERT INTO routing_rows (table_version, role, size, model, rationale) VALUES (555, 'executor', 'Small', 'opus-5', 'proposed, not live')",
    );
    try {
      const table = await loadLiveRoutingTable(pool);
      expect(table.version).toBe(1);
    } finally {
      await pool.query('DELETE FROM routing_tables WHERE version = 555');
    }
  });
});
