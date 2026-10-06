-- D#2 H17a: the GitHub App install callback records an installation.
-- Nothing on main wrote `installations` outside seed-dev, and the column
-- had no uniqueness on the GitHub side, so two accounts could each hold the
-- same GitHub installation.
--
-- 1. UNIQUE (gh_installation_id, app_kind): one tenant per GitHub
--    installation and App. PRECONDITION: no two existing rows share the
--    pair. On main only packages/api/scripts/seed-dev.ts inserts
--    installations, so a real database has none; if one did, this index
--    build would fail loudly and the migration would roll back, never
--    silently delete or merge rows. installations-unique-index.test.ts
--    covers both cases.
-- 2. platform_ops may INSERT exactly (account_id, gh_installation_id,
--    app_kind), and only for the tenant set in app.account_id. This is the
--    only way the callback can write the row and audit_write_system(...)
--    in one transaction. No UPDATE, no DELETE, no other column.
--
-- A new file, never an edit to a merged one (D#94 R1). The privilege bracket
-- is copied from 0650.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE UNIQUE INDEX installations_gh_installation_kind_key
  ON installations (gh_installation_id, app_kind);

GRANT INSERT (account_id, gh_installation_id, app_kind) ON installations TO platform_ops;
CREATE POLICY platform_ops_callback_insert ON installations
  FOR INSERT TO platform_ops
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
