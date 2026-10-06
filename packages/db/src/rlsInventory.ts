import type { PoolClient } from 'pg';
import { PLATFORM_WIDE_TABLES } from './platformWideTables.js';

/** Every table gets this exemption; migrate.ts creates it outside any migration file. */
const ALWAYS_EXEMPT = 'schema_migrations';

/**
 * Returns the names of every table in `public` without RLS enabled+forced
 * (excludes `schema_migrations`/`exemptions`, default PLATFORM_WIDE_TABLES);
 * PLUS (D#45 S1 criterion 8, D#68 PM correction C4) `view:<relname>` /
 * `matview:<relname>` wherever `app_user`/`partner_user` has has_any_column_privilege(...,
 * 'SELECT') -- true for whole-table or column-level grants, incl. PUBLIC --
 * unless the view declares `security_invoker = true` (no such option for matviews).
 * Empty is passing; test/rls-inventory.test.ts asserts this against the real
 * schema and each lettered view/matview case.
 */
export async function findRlsViolations(
  client: PoolClient,
  exemptions: readonly string[] = PLATFORM_WIDE_TABLES,
): Promise<string[]> {
  const exempt = new Set([ALWAYS_EXEMPT, ...exemptions]);
  const { rows: tableRows } = await client.query<{ relname: string }>(`
    SELECT relname
    FROM pg_class
    WHERE relnamespace = 'public'::regnamespace
      AND relkind = 'r'
      AND NOT (relrowsecurity AND relforcerowsecurity)
    ORDER BY relname
  `);
  const tableViolations = tableRows.map((r) => r.relname).filter((name) => !exempt.has(name));

  const { rows: objectRows } = await client.query<{ label: string }>(`
    SELECT 'view:' || c.relname AS label
    FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relkind = 'v'
      AND (
        has_any_column_privilege('app_user', c.oid, 'SELECT')
        OR has_any_column_privilege('partner_user', c.oid, 'SELECT')
      )
      AND COALESCE(
        (SELECT option_value FROM pg_options_to_table(c.reloptions) WHERE option_name = 'security_invoker')::boolean,
        false
      ) IS NOT TRUE
    UNION ALL
    SELECT 'matview:' || c.relname AS label
    FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relkind = 'm'
      AND (
        has_any_column_privilege('app_user', c.oid, 'SELECT')
        OR has_any_column_privilege('partner_user', c.oid, 'SELECT')
      )
    ORDER BY label
  `);

  return [...tableViolations, ...objectRows.map((r) => r.label)];
}
