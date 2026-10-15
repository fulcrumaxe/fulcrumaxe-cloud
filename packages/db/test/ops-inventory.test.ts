import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { findOpsInventoryViolations, OPS_VIEW_ALLOWLIST } from '../src/opsInventory.js';

/** D#68 OPS-C1 criterion 8: the ops inventory is clean on the migrated schema and names each fixture violation exactly once. */
describe('ops inventory (OPS-C1)', () => {
  let pool: Pool;
  let client: PoolClient;

  /** Runs `setup` in a transaction that is always rolled back, then the inventory inside it. */
  const inventory = async (setup: string, allowlist: readonly string[] = OPS_VIEW_ALLOWLIST): Promise<string[]> => {
    await client.query('BEGIN');
    try {
      await client.query(setup);
      return await findOpsInventoryViolations(client, allowlist);
    } finally {
      await client.query('ROLLBACK');
    }
  };

  /** A function owned by ops_owner; `attrs` and `acl` vary the one property under test. */
  const fn = (attrs: { definer?: boolean; searchPath?: boolean; acl: string }) => `
    CREATE FUNCTION ops_fixture_fn() RETURNS int LANGUAGE sql ${attrs.definer ? 'SECURITY DEFINER' : ''}
      ${attrs.searchPath ? 'SET search_path = pg_catalog, public, pg_temp' : ''} AS 'SELECT 1';
    ALTER FUNCTION ops_fixture_fn() OWNER TO ops_owner;
    REVOKE ALL ON FUNCTION ops_fixture_fn() FROM PUBLIC;
    ${attrs.acl}`;

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL!);
    client = await pool.connect();
  });
  afterAll(async () => {
    client.release();
    await pool.end();
  });

  it('returns [] on the migrated schema', async () => {
    expect(await findOpsInventoryViolations(client)).toEqual([]);
  });

  it('(a) names a view owned by ops_owner that is not on the allowlist', async () => {
    const sql = `CREATE VIEW ops_fixture_view AS SELECT 1 AS x; ALTER VIEW ops_fixture_view OWNER TO ops_owner;`;
    expect(await inventory(sql)).toEqual(['view:ops_fixture_view:not_allowlisted']);
    expect(await inventory(sql, ['ops_fixture_view'])).toEqual([]);
  });

  it('(b) names an allowlisted view with SELECT held by a role other than ops_console', async () => {
    const base = `CREATE VIEW ops_fixture_view AS SELECT 1 AS x; ALTER VIEW ops_fixture_view OWNER TO ops_owner;`;
    const allow = ['ops_fixture_view'];
    expect(await inventory(`${base} GRANT SELECT ON ops_fixture_view TO ops_console;`, allow)).toEqual([]);
    expect(await inventory(`${base} GRANT SELECT ON ops_fixture_view TO app_user;`, allow)).toEqual(['view:ops_fixture_view:grant:app_user']);
    expect(await inventory(`${base} GRANT SELECT ON ops_fixture_view TO PUBLIC;`, allow)).toEqual(['view:ops_fixture_view:grant:public']);
    expect(await inventory(`${base} GRANT SELECT ON ops_fixture_view TO ops_console, platform_ops;`, allow)).toEqual(['view:ops_fixture_view:grant:platform_ops']);
  });

  it('(c) names an ops_owner function that is not SECURITY DEFINER or has no pinned search_path', async () => {
    const ok = 'GRANT EXECUTE ON FUNCTION ops_fixture_fn() TO ops_console;';
    expect(await inventory(fn({ definer: true, searchPath: true, acl: ok }))).toEqual([]);
    expect(await inventory(fn({ definer: false, searchPath: true, acl: ok }))).toEqual(['function:ops_fixture_fn():not_definer']);
    expect(await inventory(fn({ definer: true, searchPath: false, acl: ok }))).toEqual(['function:ops_fixture_fn():search_path']);
  });

  it('(d) names an ops_owner function whose EXECUTE reaches PUBLIC or app_user', async () => {
    expect(await inventory(fn({ definer: true, searchPath: true, acl: 'GRANT EXECUTE ON FUNCTION ops_fixture_fn() TO app_user;' }))).toEqual([
      'function:ops_fixture_fn():execute:app_user',
    ]);
    expect(await inventory(fn({ definer: true, searchPath: true, acl: 'GRANT EXECUTE ON FUNCTION ops_fixture_fn() TO PUBLIC;' }))).toEqual([
      'function:ops_fixture_fn():execute:public',
    ]);
  });
});
