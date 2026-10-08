-- D#575: app_user reads agent_runs through an explicit column list, not the
-- table-wide SELECT 0001 gave it.
--
-- Why. The outside-meter work adds a report tag and a key reference to
-- agent_runs. Those are billing-adjacent values and must never reach a route
-- by accident: one `select *`, one `alias.*` in a join, one new query outside
-- the code-side column list would expose them, and the database would allow
-- it. With only the listed columns granted, the database refuses instead
-- (SQLSTATE 42501).
--
-- What. REVOKE the table-wide SELECT, then GRANT SELECT on every column that
-- exists when this runs EXCEPT the two private ones (gateway_report_tag and
-- om_key_ref, which are granted to no one here whether or not they exist yet).
-- The list is built from the catalog, as 0611 does for UPDATE, because the
-- upgrade-path check in test-neon-shape.sh applies late-landing migrations
-- (0010 adds agent_runs.model and more) after this one, so a literal list
-- naming those columns would fail there. A column added AFTER this migration
-- starts out ungranted for app_user: a migration that adds one app_user must
-- read adds its own `GRANT SELECT (col) ... TO app_user`, and the same column
-- goes on AGENT_RUN_COLUMNS in packages/core/src/tenancy/scopedAccess.ts;
-- packages/db/test/agent-runs-column-grants.test.ts compares that list with
-- what is granted and names any drift, so a column that lands before this
-- migration and is not on the list is caught there too.
-- Revoking the table-level privilege also clears any column-level SELECT that
-- an earlier migration gave app_user, so the result does not depend on the
-- order the column-adding migrations land in.
--
-- Not touched: INSERT (already revoked, 0642), UPDATE (column grants, 0611 and
-- 0642), DELETE (never granted), RLS, and every other role's grants
-- (platform_ops, receipt_writer, partner_user hold their own column lists).
--
-- Roll back with a later migration that runs
-- `GRANT SELECT ON agent_runs TO app_user`. 0001 is never edited.
--
-- Numbering: 0756 (assigned for this change; it follows 0755).

REVOKE SELECT ON agent_runs FROM app_user;

DO $$
DECLARE
  readable_cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position)
    INTO readable_cols
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'agent_runs'
      AND column_name NOT IN ('gateway_report_tag', 'om_key_ref');

  EXECUTE format('GRANT SELECT (%s) ON agent_runs TO app_user', readable_cols);
END
$$;
