import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/pool.js';

/**
 * Partner layer umbrella item 6: a grant snapshot pins every has_table_privilege and has_column_privilege result for
 * partner_user, so any widening (or any narrowing) of what a partner session may touch shows up as a reviewed snapshot diff.
 *
 * The snapshot lists what IS granted, one line each, sorted: a table privilege as `table: PRIV`, a column privilege that the table
 * level does not already give as `table.column: PRIV`. Everything not listed is a `false` result. A new table, a new column or a
 * new grant changes the file; nothing else does. Update it with `vitest -u` only after reading the diff.
 */
describe('partner_user grant snapshot', () => {
  let adminPool: Pool;

  beforeAll(() => {
    adminPool = createPool(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    await adminPool.end();
  });

  it('pins every table-level and column-level privilege result of partner_user', async () => {
    const tablePrivs = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
    const columnPrivs = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'];

    const tables = await adminPool.query<{ oid: string; name: string }>(
      `SELECT c.oid::text AS oid, c.relname AS name
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
        ORDER BY c.relname`,
    );
    const lines: string[] = [];
    for (const t of tables.rows) {
      const granted = new Set<string>();
      for (const priv of tablePrivs) {
        const { rows } = await adminPool.query(`SELECT has_table_privilege('partner_user', $1::oid, $2) AS ok`, [t.oid, priv]);
        if (rows[0].ok) {
          granted.add(priv);
          lines.push(`${t.name}: ${priv}`);
        }
      }
      const cols = await adminPool.query<{ attnum: number; name: string }>(
        `SELECT a.attnum, a.attname AS name FROM pg_attribute a
          WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
        [t.oid],
      );
      for (const col of cols.rows) {
        for (const priv of columnPrivs) {
          if (granted.has(priv)) continue;
          const { rows } = await adminPool.query(`SELECT has_column_privilege('partner_user', $1::oid, $2::smallint, $3) AS ok`, [
            t.oid,
            col.attnum,
            priv,
          ]);
          if (rows[0].ok) lines.push(`${t.name}.${col.name}: ${priv}`);
        }
      }
    }
    expect(lines.sort().join('\n')).toMatchSnapshot();
  });
});
