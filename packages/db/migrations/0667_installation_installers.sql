-- D#2 H17e: who installed a GitHub App, and claims waiting for that record.
--
-- Only the user who installed an App may claim its recorded installation
-- (owner ruling, C57). The installer is known only from the verified
-- `installation.created` delivery's sender, so:
--
-- 1. installation_installers: one row per (GitHub installation id, App kind),
--    holding the sender's numeric GitHub user id plus deleted/suspended
--    flags kept up to date by installation.deleted / suspend / unsuspend.
--    No account column: the delivery knows no tenant.
-- 2. installation_pending_claims: a callback that arrives before that
--    delivery waits here for 30 minutes. One row per installation, kind and
--    GitHub user, so a repeat callback refreshes rather than duplicates, and
--    a different GitHub user can never displace the installer's claim.
--
-- Both tables are platform_ops only: RLS is forced, app_user gets nothing,
-- and the column grants below are the whole write surface. The installer
-- row is insert-once: platform_ops cannot update installer_gh_user_id, so a
-- replayed delivery can never change who the installer is.
--
-- A new file, never an edit to a merged one (D#94 R1). The privilege bracket
-- is copied from 0655.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE TABLE installation_installers (
  gh_installation_id bigint NOT NULL,
  app_kind text NOT NULL CHECK (app_kind IN ('team', 'team_readonly', 'sitekit')),
  installer_gh_user_id bigint NOT NULL CHECK (installer_gh_user_id > 0),
  deleted_at timestamptz,
  suspended_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (gh_installation_id, app_kind)
);

CREATE TABLE installation_pending_claims (
  gh_installation_id bigint NOT NULL,
  app_kind text NOT NULL CHECK (app_kind IN ('team', 'team_readonly', 'sitekit')),
  gh_user_id bigint NOT NULL CHECK (gh_user_id > 0),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (gh_installation_id, app_kind, gh_user_id)
);

ALTER TABLE installation_installers ENABLE ROW LEVEL SECURITY;
ALTER TABLE installation_installers FORCE ROW LEVEL SECURITY;
ALTER TABLE installation_pending_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE installation_pending_claims FORCE ROW LEVEL SECURITY;

REVOKE ALL ON installation_installers, installation_pending_claims FROM PUBLIC;

GRANT SELECT, INSERT ON installation_installers TO platform_ops;
GRANT UPDATE (deleted_at, suspended_at) ON installation_installers TO platform_ops;
GRANT SELECT, INSERT, DELETE ON installation_pending_claims TO platform_ops;
GRANT UPDATE (account_id, user_id, expires_at) ON installation_pending_claims TO platform_ops;

CREATE POLICY platform_ops_all ON installation_installers FOR ALL TO platform_ops USING (true) WITH CHECK (true);
CREATE POLICY platform_ops_all ON installation_pending_claims FOR ALL TO platform_ops USING (true) WITH CHECK (true);

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
