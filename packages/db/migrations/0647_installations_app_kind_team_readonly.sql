-- D#31 API-8c: installations.app_kind gains 'team_readonly', the preview-only
-- read App (a third GitHub App next to the write 'team' App and 'sitekit').
-- Only the CHECK is replaced: DROP then ADD in one transaction, nothing else
-- is touched. Every existing row is 'team' or 'sitekit', so the new CHECK
-- validates against all of them. The value set must equal
-- INSTALLATION_APP_KINDS (packages/core/src/repos/appKinds.ts); the db test
-- installations-app-kind.test.ts fails if they drift.
--
-- A new file, never an edit to a merged one (D#94 R1). The privilege bracket
-- is copied from 0645 (D#81/#92).
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

ALTER TABLE installations DROP CONSTRAINT installations_app_kind_check;
ALTER TABLE installations
  ADD CONSTRAINT installations_app_kind_check CHECK (app_kind IN ('team', 'team_readonly', 'sitekit'));

-- Close the window opened above, matching 0645's own shape.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
