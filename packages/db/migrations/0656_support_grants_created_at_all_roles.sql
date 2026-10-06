-- D#68 OPS-G0: close the forward-dated support_grants.created_at bypass for
-- every role. 0200's guard exempted any member of platform_ops
-- (pg_has_role(current_user, 'platform_ops', 'USAGE')), and pg_has_role is
-- also true for a superuser, so platform_ops and the migration role could
-- insert a created_at years ahead and let the 60-minute CHECK authorise an
-- expires_at years out, or move created_at later on an existing grant.
--
-- The guard now applies with no role test at all: INSERT stamps created_at
-- with the server's now(); UPDATE that changes created_at raises. The
-- trigger definition is unchanged, so only the function body is replaced.
--
-- A new file, never an edit to a merged one (D#94 R1). The privilege bracket
-- is copied from 0650 (D#81/#92).
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION support_grants_created_at_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := now();
  ELSIF TG_OP = 'UPDATE' AND NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'support_grants: created_at is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
