-- D#2 H08-followup: role defaults become rows, and tenants lose DELETE on
-- role_settings.
--
-- THE HOLE. role_settings has only ever stored overrides: a missing
-- (repo, role) row meant "use the defaultMode of whatever manifest is
-- deployed". Editing a defaultMode, or shipping a new role with defaultMode
-- 'always', therefore changed what ran on every repo that had never touched
-- that role -- on the customer's own model bill, with no audit row. And
-- 0001 granted app_user DELETE on the table on the reasoning that a row is
-- "a toggle, not a record of anything that happened", so a tenant could also
-- delete a row and thereby silently re-adopt whatever default was deployed.
--
-- THE RULE FROM HERE. A row's presence carries the meaning. Every repo has
-- one row per manifest role (written below for existing repos, and by
-- syncInstallationRepos for new ones); a role with no row is 'off'; and a
-- tenant can change a row (UPDATE) but not remove it.
--
-- 1. REVOKE DELETE ON role_settings FROM app_user. 0001_core.sql's grant
--    comment ("kept both UPDATE and DELETE ... it's a toggle, not a record of
--    anything that happened") is superseded by the table comment set below;
--    0001 itself is an applied migration and is not edited (D#94 R1). Rows
--    still disappear with their repo or account through the ON DELETE CASCADE
--    foreign keys, which run with the table owner's rights, not app_user's.
--    Tenant self-service "revert to default" is an UPDATE of mode/model.
-- 2. Backfill: for every existing repos row, insert the missing (repo, role)
--    rows with mode = that role's manifest defaultMode AS OF THIS MIGRATION
--    (the literal list below, generated from packages/roles/src/manifest.ts;
--    packages/db/test/role-settings-materialize.test.ts compares it to the
--    manifest and fails when a role is added without its own materialization),
--    model NULL, ON CONFLICT DO NOTHING so a tenant's existing rows win.
-- 3. One audit row per account that received rows, through the existing
--    audit_write_system definer (0612; its action is free-form, so no
--    allowlist edit): action 'role_settings.materialized', actor
--    'system:role_settings', payload counts only (repos, rows_created).
--    Accounts that already had every row get none.
--
-- The backfill writes under FORCE ROW LEVEL SECURITY, which the migration
-- role bypasses (superuser in tests, BYPASSRLS on the hosted owner shape,
-- D#81). audit_write_system is EXECUTE-able by platform_ops only, so the
-- audit call runs under SET LOCAL ROLE platform_ops, for that loop alone.
-- Privilege bracket for that (SET TRUE, INHERIT FALSE) copied from 0612.

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;

REVOKE DELETE ON role_settings FROM app_user;

COMMENT ON TABLE role_settings IS
  'One row per (repo, role): presence carries the meaning. Every repo has a row for every manifest role (written at repo creation and by the 0687 backfill); a missing row means the role is off. app_user can INSERT and UPDATE rows but not DELETE them (0687).';

DO $$
DECLARE
  done jsonb;
  rec  record;
BEGIN
  WITH defaults (role, mode) AS (
    VALUES
      ('executor', 'always'),
      ('code-reviewer', 'always'),
      ('security-reviewer', 'always'),
      ('acceptance-tester', 'always'),
      ('debater', 'feature_critical'),
      ('project-manager', 'always'),
      ('technical-architect', 'always'),
      ('product-owner', 'always'),
      ('cost-analyst', 'always'),
      ('performance-expert', 'always'),
      ('security-expert', 'always'),
      ('researcher', 'always'),
      ('feedback-scanner', 'always'),
      ('incident-commander', 'always'),
      ('browser-tester', 'always'),
      ('tui-tester', 'always'),
      ('docs-writer', 'always'),
      ('release-manager', 'always'),
      ('runbook-writer', 'feature_critical'),
      ('accessibility-reviewer', 'feature_critical'),
      ('ux-designer', 'feature_critical'),
      ('mission-analyst', 'weekly'),
      ('run-analyst', 'weekly'),
      ('analytics-engineer', 'weekly'),
      ('visual-verifier', 'weekly'),
      ('quality-sweep', 'off')
  ),
  ins AS (
    INSERT INTO role_settings (account_id, repo_id, role, mode)
    SELECT r.account_id, r.id, d.role, d.mode
      FROM repos r CROSS JOIN defaults d
    ON CONFLICT (repo_id, role) DO NOTHING
    RETURNING account_id, repo_id
  )
  SELECT jsonb_agg(jsonb_build_object('account_id', s.account_id, 'repos', s.repos, 'rows_created', s.rows_created)
                   ORDER BY s.account_id)
    INTO done
    FROM (SELECT account_id, count(DISTINCT repo_id)::int AS repos, count(*)::int AS rows_created
            FROM ins GROUP BY account_id) s;

  IF done IS NULL THEN
    RETURN;
  END IF;

  SET LOCAL ROLE platform_ops;
  FOR rec IN SELECT * FROM jsonb_to_recordset(done) AS x(account_id uuid, repos int, rows_created int) LOOP
    PERFORM audit_write_system(
      rec.account_id,
      'role_settings',
      'role_settings.materialized',
      jsonb_build_object('repos', rec.repos, 'rows_created', rec.rows_created)
    );
  END LOOP;
  RESET ROLE;
END
$$;
