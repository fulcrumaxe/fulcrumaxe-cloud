import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

/**
 * D#181: create / track / drop helper for the tests that build a throwaway
 * database inside the shared test cluster (the migrate-*-upgrade files).
 *
 * The old shape kept ONE `let dbName` that every test reassigned, so
 * afterAll dropped only the last database and the rest piled up in the
 * shared cluster (6 of 7 in migrate-0606-upgrade), each one a fully
 * migrated schema whose dirty buffers the next DROP DATABASE checkpoint had
 * to flush. Here every created name is tracked and `dropAll()` drops them
 * all, in parallel.
 *
 * Drop errors are NOT swallowed: a database that will not drop (for example
 * because a test leaked a connection to it) fails the hook loudly instead
 * of silently leaking, and `dropAll()` then double-checks that nothing with
 * one of this instance's prefixes is left in pg_database.
 */
export interface ThrowawayDbs {
  /** CREATE DATABASE `<prefix>_<uuid>` and track it; resolves to the name. */
  create(prefix: string): Promise<string>;
  /** DROP every tracked database, then assert none with a used prefix remains. */
  dropAll(): Promise<void>;
}

export function throwawayDbs(adminPool: Pool): ThrowawayDbs {
  const names: string[] = [];
  const prefixes = new Set<string>();

  return {
    async create(prefix) {
      const name = `${prefix}_${randomUUID().replace(/-/g, '')}`;
      // Tracked before CREATE so a half-finished create is still dropped.
      names.push(name);
      prefixes.add(prefix);
      await adminPool.query(`CREATE DATABASE ${name}`);
      return name;
    },

    async dropAll() {
      const toDrop = names.splice(0);
      await Promise.all(toDrop.map((name) => adminPool.query(`DROP DATABASE IF EXISTS ${name}`)));

      if (prefixes.size === 0) return;
      const { rows } = await adminPool.query<{ datname: string }>(
        'SELECT datname FROM pg_database WHERE datname LIKE ANY($1) ORDER BY datname',
        [[...prefixes].map((p) => `${p}\\_%`)],
      );
      if (rows.length > 0) {
        throw new Error(`throwaway databases left behind: ${rows.map((r) => r.datname).join(', ')}`);
      }
    },
  };
}
