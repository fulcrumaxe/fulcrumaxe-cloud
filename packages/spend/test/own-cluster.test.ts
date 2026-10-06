import { describe, expect, inject, it } from 'vitest';
import type { Pool } from 'pg';
import { createPool } from '../src/pg.js';

/**
 * D#56 criterion 3: proves each of this project's pools reaches the
 * database its OWN globalSetup provisioned. See packages/db/test/
 * own-cluster.test.ts's header for the full rationale -- this project
 * uses SPEND_-prefixed env names and no partner_user role.
 */
describe('own-cluster', () => {
  const testDbEnv = inject('testDbEnv');
  const expected = new URL(testDbEnv.url);
  const expectedDatabase = expected.pathname.slice(1);
  const expectedPort = Number(expected.port);

  const pools: ReadonlyArray<[label: string, url: string, role: string]> = [
    ['admin', process.env.SPEND_DATABASE_URL!, 'postgres'],
    ['app_user', process.env.SPEND_DATABASE_URL_APP_USER!, 'app_user'],
    ['platform_ops', process.env.SPEND_DATABASE_URL_PLATFORM_OPS!, 'platform_ops'],
  ];

  it.each(pools)(
    '%s pool reaches this project\'s own database, port and role',
    async (_label, url, expectedRole) => {
      const pool: Pool = createPool(url);
      try {
        const { rows } = await pool.query<{ db: string; port: number; role: string }>(
          'SELECT current_database() AS db, inet_server_port() AS port, current_user AS role',
        );
        expect(rows).toHaveLength(1);
        const row = rows[0]!;
        expect(row.db).toBe(expectedDatabase);
        expect(Number(row.port)).toBe(expectedPort);
        expect(row.role).toBe(expectedRole);
      } finally {
        await pool.end();
      }
    },
  );
});
