-- D#845 ON-14a2: the engine version on a start the cloud issues itself. A person's start reads the version from the newest installed setup of the repository (ON-14a); the system issuers sign through platform_ops, which cannot read
-- project_setups, so their starts carried none and the runner refused them. This adds one reader and restates nothing:
--   engine_start_version(account, repo)  platform_ops only, owned by engine_start_definer (1100): the newest setup of THAT account's THAT repo that has a version (created_at, then id), or NULL when none has.
--   engine_start_definer gains SELECT (engine_version, created_at) on project_setups, through the policy 1100 already gave it for that table.
-- Numbered 1113 by the Team Lead. Re-check against main right before merging and renumber to stay above its highest.

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'engine_start_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on engine_start_definer; cannot ALTER FUNCTION ... OWNER TO engine_start_definer';
    END IF;
    GRANT engine_start_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
  GRANT CREATE ON SCHEMA public TO engine_start_definer;
END
$$;

GRANT SELECT (engine_version, created_at) ON project_setups TO engine_start_definer;

CREATE FUNCTION public.engine_start_version(p_account uuid, p_repo uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $f$
BEGIN
  IF session_user <> 'platform_ops' OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL OR NULLIF(current_setting('app.user_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'engine_start_version: refused' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_account IS NULL OR p_repo IS NULL THEN
    RAISE EXCEPTION 'engine_start_version: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN (SELECT ps.engine_version FROM public.project_setups ps
           WHERE ps.account_id = p_account AND ps.repo_id = p_repo AND ps.engine_version IS NOT NULL
           ORDER BY ps.created_at DESC, ps.id DESC LIMIT 1);
END;
$f$;

REVOKE ALL ON FUNCTION public.engine_start_version(uuid, uuid) FROM PUBLIC;
ALTER FUNCTION public.engine_start_version(uuid, uuid) OWNER TO engine_start_definer;
GRANT EXECUTE ON FUNCTION public.engine_start_version(uuid, uuid) TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM engine_start_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE engine_start_definer FROM CURRENT_USER;
  END IF;
END
$$;
