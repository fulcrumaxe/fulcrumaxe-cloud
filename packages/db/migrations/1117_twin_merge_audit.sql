-- D#845 ON-27d4c: Merge on a private twin's card is a person's action, so it writes an audit row like the other twin actions.
--
--   twin_merge_record(twin, which, number)  the merge route's call AFTER the App's merge succeeded (an `already` answer writes nothing). One audit row, `twin.merged`, actor = the person, payload exactly
--                                           {twin_id, pr, number} (pr is 'publish' or 'sync'; no sha, no path, no repository name). o_result: ok | not_found | bad_state (the twin is removed, seeding, refused or failed).
--                                           SECURITY DEFINER, owned by repo_twins_owner, search_path pinned, EXECUTE for app_user alone. The caller must be a person who is an owner or admin of an active account:
--                                           a runner session, a platform_ops login, a session with no person and a member are all refused (42501). The twin is read in the session's account only.
--   repo_twins_owner_audit                  restated: 1116's list plus 'twin.merged'.
--
-- Numbered 1117 by the Team Lead. Re-check against main right before merging and renumber to stay above its highest.

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'repo_twins_owner'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on repo_twins_owner; cannot ALTER FUNCTION ... OWNER TO repo_twins_owner';
    END IF;
    GRANT repo_twins_owner TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO repo_twins_owner;

DROP POLICY repo_twins_owner_audit ON audit_log;
CREATE POLICY repo_twins_owner_audit ON audit_log FOR INSERT TO repo_twins_owner
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
              AND action IN ('twin.created', 'twin.paused', 'twin.resumed', 'twin.removed', 'twin.connected', 'twin.paths_changed', 'twin.install_paths_added', 'twin.refused', 'twin.merged'));

CREATE FUNCTION twin_merge_record(p_twin uuid, p_which text, p_number integer) RETURNS TABLE (o_result text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  t    record;
BEGIN
  IF session_user = 'platform_ops' OR acct IS NULL OR usr IS NULL OR NOT public.account_is_active(acct) OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'twin_merge_record: refused' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_twin IS NULL OR p_which IS NULL OR p_which NOT IN ('publish', 'sync') OR p_number IS NULL OR p_number < 1 THEN
    RAISE EXCEPTION 'twin_merge_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT x.id, x.state INTO t FROM public.repo_twins x WHERE x.id = p_twin AND x.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'; RETURN; END IF;
  IF t.state NOT IN ('ready', 'paused', 'conflict') THEN RETURN QUERY SELECT 'bad_state'; RETURN; END IF;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, 'twin.merged', jsonb_build_object('twin_id', t.id, 'pr', p_which, 'number', p_number), clock_timestamp());
  RETURN QUERY SELECT 'ok';
END;
$$;

REVOKE ALL ON FUNCTION twin_merge_record(uuid, text, integer) FROM PUBLIC;
ALTER FUNCTION twin_merge_record(uuid, text, integer) OWNER TO repo_twins_owner;
-- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner).
GRANT EXECUTE ON FUNCTION twin_merge_record(uuid, text, integer) TO app_user;

REVOKE CREATE ON SCHEMA public FROM repo_twins_owner;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE repo_twins_owner FROM CURRENT_USER;
  END IF;
END
$$;
