import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { createPool } from '../src/pool.js';
import { findRlsViolations } from '../src/rlsInventory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MISSING_RLS_FIXTURE = readFileSync(
  path.join(__dirname, 'fixtures', 'missing-rls.sql'),
  'utf8',
);
const VIEW_INVENTORY_FIXTURE = readFileSync(
  path.join(__dirname, 'fixtures', 'view-inventory.sql'),
  'utf8',
);
const VIEW_INVENTORY_CLEANUP = `
  DROP MATERIALIZED VIEW IF EXISTS view_inventory_fixture_g;
  DROP MATERIALIZED VIEW IF EXISTS view_inventory_fixture_h;
  DROP VIEW IF EXISTS view_inventory_fixture_a;
  DROP VIEW IF EXISTS view_inventory_fixture_b;
  DROP VIEW IF EXISTS view_inventory_fixture_c;
  DROP VIEW IF EXISTS view_inventory_fixture_d;
  DROP VIEW IF EXISTS view_inventory_fixture_e;
  DROP VIEW IF EXISTS view_inventory_fixture_f;
  DROP VIEW IF EXISTS view_inventory_fixture_i;
  DROP TABLE IF EXISTS view_inventory_fixture_base;
  DROP ROLE IF EXISTS view_inventory_fixture_role;
`;

describe('RLS inventory', () => {
  let pool: Pool;
  let client: PoolClient;

  beforeAll(async () => {
    pool = createPool(process.env.DATABASE_URL!);
    client = await pool.connect();
  });

  afterAll(async () => {
    client.release();
    await pool.end();
  });

  it('every real table has RLS enabled and forced', async () => {
    expect(await findRlsViolations(client)).toEqual([]);
  });

  it('users and partners are named explicitly: NOT exempt, RLS-enabled with non-account_id policies', async () => {
    // D#2605 H02 security fix round 2, item 9: `users` (global identity,
    // membership-scoped via EXISTS on account_members -- see
    // test/users-global.test.ts) and `partners` (platform-wide, D#2607;
    // platform_ops-only) do NOT use the standard account_id equality
    // policy. That's a different policy shape, not an exemption -- both
    // still have RLS enabled and forced like every other table, and
    // findRlsViolations() (which only checks relrowsecurity/
    // relforcerowsecurity, never policy content) already proves that as
    // part of the "every real table" check above. This test says so
    // explicitly, by name, so it can't be missed in that generic sweep.
    const violations = await findRlsViolations(client);
    expect(violations).not.toContain('users');
    expect(violations).not.toContain('partners');

    const { rows } = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relname IN ('users', 'partners')
    `);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });

  it('D#71 DS-1: the 7 new Discussions tables are named explicitly, RLS-enabled and forced, not exempt', async () => {
    const NEW_TABLES = [
      'discussion_counters',
      'discussions',
      'discussion_revisions',
      'discussion_comments',
      'spec_versions',
      'spec_corrections',
      'work_item_deps',
    ];
    const violations = await findRlsViolations(client);
    for (const table of NEW_TABLES) {
      expect(violations).not.toContain(table);
    }

    const { rows } = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relname = ANY($1)`,
      [NEW_TABLES],
    );
    expect(rows).toHaveLength(NEW_TABLES.length);
    for (const row of rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
  });

  it('routing_tables and routing_rows are named explicitly: exempt, and have no RLS at all (H22)', async () => {
    // D#2, H22: these are platform-wide (every account reads the same live
    // version), so unlike users/partners above there is no account_id to
    // scope a policy on -- they are genuinely un-RLS'd, and rely entirely
    // on the PLATFORM_WIDE_TABLES exemption, not on a policy of their own.
    const violations = await findRlsViolations(client);
    expect(violations).not.toContain('routing_tables');
    expect(violations).not.toContain('routing_rows');

    const { rows } = await client.query<{ relname: string; relrowsecurity: boolean }>(`
      SELECT relname, relrowsecurity
      FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relname IN ('routing_tables', 'routing_rows')
    `);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.relrowsecurity).toBe(false);
    }
  });

  it('catches a table that lacks RLS (deliberate-failure fixture goes red)', async () => {
    await client.query(MISSING_RLS_FIXTURE);
    try {
      const violations = await findRlsViolations(client);
      expect(violations).toContain('rls_violation_fixture');
    } finally {
      await client.query('DROP TABLE rls_violation_fixture');
    }
  });

  it('an explicitly exempted table name is not reported (H22 mechanism)', async () => {
    await client.query('CREATE TABLE platform_wide_fixture (id uuid PRIMARY KEY)');
    try {
      const violations = await findRlsViolations(client, ['platform_wide_fixture']);
      expect(violations).not.toContain('platform_wide_fixture');
    } finally {
      await client.query('DROP TABLE platform_wide_fixture');
    }
  });

  /**
   * D#45 S1 criterion 8 (D#68 PM correction, C4): the view/matview
   * inventory check, one lettered case per Spec bullet.
   */
  describe('view/matview inventory (D#45 S1 criterion 8)', () => {
    beforeAll(async () => {
      await client.query(VIEW_INVENTORY_FIXTURE);
    });

    afterAll(async () => {
      await client.query(VIEW_INVENTORY_CLEANUP);
    });

    it('returns exactly the expected flagged set: (a), (d), (e), (g), (i) -- and not (b), (c), (f), (h)', async () => {
      const violations = await findRlsViolations(client);
      expect(violations).toContain('view:view_inventory_fixture_a');
      expect(violations).not.toContain('view:view_inventory_fixture_b');
      expect(violations).not.toContain('view:view_inventory_fixture_c');
      expect(violations).toContain('view:view_inventory_fixture_d');
      expect(violations).toContain('view:view_inventory_fixture_e');
      expect(violations).not.toContain('view:view_inventory_fixture_f');
      expect(violations).toContain('matview:view_inventory_fixture_g');
      expect(violations).not.toContain('matview:view_inventory_fixture_h');
      expect(violations).toContain('view:view_inventory_fixture_i');
    });

    it('(a) a view with no option, granted to app_user, is flagged', async () => {
      expect(await findRlsViolations(client)).toContain('view:view_inventory_fixture_a');
    });

    it('(b) security_invoker = true is not flagged', async () => {
      expect(await findRlsViolations(client)).not.toContain('view:view_inventory_fixture_b');
    });

    it('(c) security_invoker = on is not flagged', async () => {
      expect(await findRlsViolations(client)).not.toContain('view:view_inventory_fixture_c');
    });

    it('(d) security_invoker = false is flagged', async () => {
      expect(await findRlsViolations(client)).toContain('view:view_inventory_fixture_d');
    });

    it('(e) a view with no option, granted only to PUBLIC, is flagged', async () => {
      expect(await findRlsViolations(client)).toContain('view:view_inventory_fixture_e');
    });

    it('(f) a definer view granted only to a non-tenant NOLOGIN role is not flagged', async () => {
      expect(await findRlsViolations(client)).not.toContain('view:view_inventory_fixture_f');
    });

    it('(g) a materialized view granted to partner_user is flagged', async () => {
      expect(await findRlsViolations(client)).toContain('matview:view_inventory_fixture_g');
    });

    it('(h) a materialized view granted to no tenant role is not flagged', async () => {
      expect(await findRlsViolations(client)).not.toContain('matview:view_inventory_fixture_h');
    });

    it('(i) a view with no option (owner rights), granted only a column grant to partner_user, is flagged', async () => {
      expect(await findRlsViolations(client)).toContain('view:view_inventory_fixture_i');
    });
  });
});
