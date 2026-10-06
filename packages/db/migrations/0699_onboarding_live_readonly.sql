-- D#2 ONBOARDING-STATE: onboarding step 2 (readonly_app) reflects the CURRENT read-only installation, not a
-- one-time stamp. Whether an installation is still live (not deleted, not suspended) is kept in
-- installation_installers, which only platform_ops can read, so the tenant read goes through one narrow definer:
--   * onboarding_live_readonly_installations(): the ids of the CALLING account's team_readonly installations
--     whose installer record exists and is neither deleted nor suspended. It takes no argument (the account is
--     the app.account_id the tenant transaction already set), returns ids only (no GitHub installation id, no
--     installer user id), and an unset account context returns nothing.
--   * owner platform_ops (it already reads both tables), pinned search_path, EXECUTE for app_user only.
-- A record that does not exist is "not live", the same fail-closed reading the repo sync and the preview request use.
-- Privilege brackets as in 0692.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

CREATE FUNCTION onboarding_live_readonly_installations() RETURNS TABLE (installation_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT i.id
    FROM public.installations i
    JOIN public.installation_installers ii ON ii.gh_installation_id = i.gh_installation_id AND ii.app_kind = i.app_kind
   WHERE i.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
     AND i.app_kind = 'team_readonly'
     AND ii.deleted_at IS NULL
     AND ii.suspended_at IS NULL
$$;
REVOKE ALL ON FUNCTION onboarding_live_readonly_installations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION onboarding_live_readonly_installations() TO app_user;
ALTER FUNCTION onboarding_live_readonly_installations() OWNER TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
