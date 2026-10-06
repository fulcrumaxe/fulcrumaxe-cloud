import { readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/pool.js';
import { DEFAULT_MIGRATIONS_DIR, runMigrations } from '../src/migrate.js';

describe('runMigrations', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('applied every migration file to the empty database (via global setup)', async () => {
    const expectedFiles = readdirSync(DEFAULT_MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    expect(expectedFiles.length).toBeGreaterThan(0);

    const { rows } = await pool.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations ORDER BY filename',
    );
    expect(rows.map((r) => r.filename)).toEqual(expectedFiles);
  });

  it('re-running migrations against an already-migrated database is a no-op', async () => {
    const result = await runMigrations(pool);
    expect(result.applied).toEqual([]);
  });
});
