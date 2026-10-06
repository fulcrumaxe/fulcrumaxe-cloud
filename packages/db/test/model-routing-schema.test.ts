import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { withTenant } from '../src/withTenant.js';
import { seedAccount, type SeedRefs } from './helpers/seed.js';
import { PG_ERROR } from './helpers/pgErrors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface ColumnRow {
  column_name: string;
  data_type: string;
}

interface DefaultTableRow {
  role: string;
  size: string;
  model: string;
  rationale: string;
}

describe('model routing schema (D#2 H22)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('agent_runs gains the six routing columns', async () => {
    const { rows } = await pool.query<ColumnRow>(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'agent_runs'
        AND column_name IN ('model', 'route_reason', 'route_table_version', 'escalated_from_run_id', 'expected_usd', 'all_opus_expected_usd')
    `);
    const byName = new Map(rows.map((r) => [r.column_name, r.data_type]));
    expect(byName.get('model')).toBe('text');
    expect(byName.get('route_reason')).toBe('text');
    expect(byName.get('route_table_version')).toBe('integer');
    expect(byName.get('escalated_from_run_id')).toBe('uuid');
    expect(byName.get('expected_usd')).toBe('numeric');
    expect(byName.get('all_opus_expected_usd')).toBe('numeric');
    expect(rows).toHaveLength(6);
  });

  it('at most one routing_tables row can be status=live', async () => {
    await pool.query(
      "INSERT INTO routing_tables (version, status, source) VALUES (999, 'proposed', 'cost_analyst')",
    );
    await expect(
      pool.query("UPDATE routing_tables SET status = 'live' WHERE version = 999"),
    ).rejects.toThrow();
    await pool.query('DELETE FROM routing_tables WHERE version = 999');
  });

  it('routing_rows rejects a size or model outside the fixed enums', async () => {
    await expect(
      pool.query(
        "INSERT INTO routing_rows (table_version, role, size, model, rationale) VALUES (1, 'executor', 'Huge', 'sonnet-5', 'x')",
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        "INSERT INTO routing_rows (table_version, role, size, model, rationale) VALUES (1, 'executor', 'Small', 'gpt-5', 'x')",
      ),
    ).rejects.toThrow();
  });

  it('the seeded live version-1 rows are byte-identical to default-table/v1.json', async () => {
    // Guards against the migration's hand-authored INSERT drifting from the
    // JSON file that ships as "the" table (Spec: "table is data, not code").
    const json = JSON.parse(
      readFileSync(
        path.join(__dirname, '..', '..', 'model-router', 'default-table', 'v1.json'),
        'utf8',
      ),
    ) as { version: number; rows: DefaultTableRow[] };

    const { rows: dbRows } = await pool.query<DefaultTableRow>(
      'SELECT role, size, model, rationale FROM routing_rows WHERE table_version = 1 ORDER BY role, size',
    );
    const sortedJson = [...json.rows].sort((a, b) => (a.role + a.size).localeCompare(b.role + b.size));
    expect(dbRows).toEqual(sortedJson);

    const { rows: liveRows } = await pool.query<{ version: number; status: string }>(
      "SELECT version, status FROM routing_tables WHERE status = 'live'",
    );
    expect(liveRows).toEqual([{ version: 1, status: 'live' }]);
  });

  describe('agent_runs.model CHECK constraint (security review Must-fix #1b)', () => {
    let admin: PoolClient;
    let appUserPool: Pool;
    let refs: SeedRefs;

    beforeAll(async () => {
      admin = await pool.connect();
      appUserPool = createPool(process.env.DATABASE_URL_APP_USER!);
      refs = await seedAccount(admin, randomUUID());
    });

    afterAll(async () => {
      admin.release();
      await appUserPool.end();
    });

    it('rejects an arbitrary string as an admin write', async () => {
      // On 3945419, agent_runs.model was plain `text` with no CHECK -- this
      // INSERT succeeded.
      await expect(
        admin.query(
          `INSERT INTO agent_runs (account_id, work_item_id, role, runtime, status, model)
           VALUES ($1, $2, 'executor', 'local', 'running', 'not-a-model')`,
          [refs.accountId, refs.workItemId],
        ),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    // D#2 H09c (0642) revoked app_user's UPDATE on every agent_runs column
    // outside the metering allowlist, `model` included. The CHECK below is
    // still the schema-level guard for whichever role can write the column
    // (a superuser here), so it is exercised through the admin connection.
    it('app_user can no longer UPDATE agent_runs.model at all (42501, before the CHECK is even reached)', async () => {
      await expect(
        withTenant(appUserPool, refs.accountId, async (client) => {
          await client.query(`UPDATE agent_runs SET model = 'not-a-model' WHERE account_id = $1 AND id = $2`, [
            refs.accountId,
            refs.runId,
          ]);
        }),
      ).rejects.toMatchObject({ code: PG_ERROR.INSUFFICIENT_PRIVILEGE });
    });

    it('the CHECK rejects an arbitrary model string on UPDATE too', async () => {
      await expect(
        admin.query(`UPDATE agent_runs SET model = 'not-a-model' WHERE account_id = $1 AND id = $2`, [
          refs.accountId,
          refs.runId,
        ]),
      ).rejects.toMatchObject({ code: PG_ERROR.CHECK_VIOLATION });
    });

    it('allows NULL and each of the three real model ids', async () => {
      await expect(
        admin.query(`UPDATE agent_runs SET model = NULL WHERE account_id = $1 AND id = $2`, [
          refs.accountId,
          refs.runId,
        ]),
      ).resolves.toBeDefined();
      for (const model of ['haiku-4.5', 'sonnet-5', 'opus-5']) {
        await expect(
          admin.query(`UPDATE agent_runs SET model = $1 WHERE account_id = $2 AND id = $3`, [
            model,
            refs.accountId,
            refs.runId,
          ]),
        ).resolves.toBeDefined();
      }
    });
  });
});
