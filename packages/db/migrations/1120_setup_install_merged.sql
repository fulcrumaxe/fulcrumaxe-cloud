-- D#845 Ruling 122.1: a person's "Merge and continue" finishes at once. Three definers:
--
--   1. setup_install_merged(setup, pr): called by the install merge route's tenant session after GitHub answered merged for pull request `pr` (EXECUTE for app_user alone; the account is the session's own `app.account_id`, and the
--      caller must be an owner or admin of it, else 42501). It moves the setup at phase `await_merge` whose recorded `install_pr` IS `pr` to phase `finish`, sub_step `pr_merged`, exactly as setup_install_pr_closed (1073) does for
--      the webhook (which binds `p_pr` the same way), so a merge recorded for an old pull request can never move a setup that has since been retried with a new one. Answers 'finished' only for the call that moved it, else 'none'.
--      The phase check is a data invariant of the function, not only row security: setup_install_definer's update policies also admit a row at phase `install`, which must never be moved from here.
--      Owned by setup_install_definer (1072/1073): it reads and writes only the columns those migrations granted, and reads the caller's own account_members row for the role check.
--   2. setup_finish_claim(setup) is made again (it was 1107's): the same oldest-due claim, with an optional setup id (the immediate hand-off claims the setup it was started for and no other; NULL is the old behaviour) and the claim's own
--      timestamp as a new last column `o_claim_at` (text, so the microseconds survive the round trip).
--   3. setup_finish_release(setup, attempt, claim_at): called by the reconcile login (platform_ops only) when an immediate finish pass failed, so the next pass retries at once instead of waiting out the ten minute lease. It clears
--      `finish_claim_at` and nothing else, only for a setup still at phase `finish` at that attempt whose claim is still the one named (a later pass's claim is never given back). Owned by setup_finish_definer (1085).
-- Numbered 1120 by the Team Lead. Re-check against main right before merging.

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'setup_install_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on setup_install_definer; cannot ALTER FUNCTION ... OWNER TO setup_install_definer';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'setup_finish_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on setup_finish_definer; cannot ALTER FUNCTION ... OWNER TO setup_finish_definer';
    END IF;
    GRANT setup_install_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
    GRANT setup_finish_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO setup_install_definer;
GRANT CREATE ON SCHEMA public TO setup_finish_definer;

-- the role check reads the caller's own membership row, through a policy that shows this role no other row (as 0757's runner_approval_definer)
GRANT SELECT (account_id, user_id, role) ON account_members TO setup_install_definer;
CREATE POLICY setup_install_definer_select ON account_members FOR SELECT TO setup_install_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

CREATE FUNCTION setup_install_merged(p_setup uuid, p_pr integer)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v_id uuid;
BEGIN
  IF acct IS NULL OR p_setup IS NULL OR p_pr IS NULL OR p_pr < 1 THEN
    RETURN 'none';
  END IF;
  IF usr IS NULL OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'setup_install_merged: owner or admin only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT x.id INTO v_id FROM public.project_setups x WHERE x.account_id = acct AND x.id = p_setup AND x.phase = 'await_merge' AND x.install_pr = p_pr FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'none';
  END IF;
  UPDATE public.project_setups x SET phase = 'finish', sub_step = 'pr_merged', state = 'ok', failure_code = NULL, failure_reason = NULL, failure_at = NULL, updated_at = now() WHERE x.account_id = acct AND x.id = v_id;
  RETURN 'finished';
END;
$$;

DROP FUNCTION setup_finish_claim();

CREATE FUNCTION setup_finish_claim(p_setup uuid DEFAULT NULL)
RETURNS TABLE (o_account uuid, o_setup uuid, o_repo uuid, o_attempt integer, o_owner text, o_name text, o_roadmap jsonb, o_seeded jsonb, o_install_pr integer, o_install_head_sha text, o_twin uuid, o_claim_at text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  s_id uuid; s_account uuid; s_repo uuid; s_attempt integer; s_pr integer; s_head text; s_twin uuid; s_at timestamptz;
BEGIN
  IF session_user <> 'platform_ops' THEN
    RAISE EXCEPTION 'setup_finish_claim: platform_ops only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT x.id, x.account_id, x.repo_id, x.attempt, x.install_pr, x.install_head_sha INTO s_id, s_account, s_repo, s_attempt, s_pr, s_head FROM public.project_setups x
   WHERE x.phase = 'finish'
     AND (p_setup IS NULL OR x.id = p_setup)
     AND (x.state <> 'failed' OR (x.failure_code = 'seed_failed' AND x.failure_at < now() - interval '15 minutes' AND x.finish_tries < 96))
     AND (x.finish_claim_at IS NULL OR x.finish_claim_at < now() - interval '10 minutes')
     AND public.account_is_active(x.account_id)
   ORDER BY x.updated_at, x.id
   LIMIT 1
   FOR UPDATE OF x SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.project_setups x SET finish_claim_at = clock_timestamp() WHERE x.account_id = s_account AND x.id = s_id RETURNING x.finish_claim_at INTO s_at;
  SELECT t.id INTO s_twin FROM public.repo_twins t WHERE t.account_id = s_account AND t.private_repo_id = s_repo AND t.state <> 'removed';
  RETURN QUERY
    SELECT s_account, s_id, s_repo, s_attempt, r.gh_owner, r.gh_name, public.setup_finish_kept_rows(s_account, s_repo, s_id),
           COALESCE((SELECT jsonb_agg(jsonb_build_object('row_key', q.row_key, 'discussion_number', q.discussion_number) ORDER BY q.row_key) FROM public.project_seeded_rows q WHERE q.account_id = s_account AND q.setup_id = s_id), '[]'::jsonb),
           s_pr, s_head, s_twin, s_at::text
      FROM public.repos r WHERE r.account_id = s_account AND r.id = s_repo;
END;
$$;

CREATE FUNCTION setup_finish_release(p_setup uuid, p_attempt integer, p_claim_at text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  s_account uuid;
BEGIN
  IF session_user <> 'platform_ops' THEN
    RAISE EXCEPTION 'setup_finish_release: platform_ops only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_setup IS NULL OR p_attempt IS NULL OR p_claim_at IS NULL OR p_claim_at !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9:.]+[+-][0-9:]+$' THEN
    RAISE EXCEPTION 'setup_finish_release: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT x.account_id INTO s_account FROM public.project_setups x WHERE x.id = p_setup AND x.phase = 'finish' AND x.attempt = p_attempt AND x.finish_claim_at = p_claim_at::timestamptz FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.project_setups x SET finish_claim_at = NULL WHERE x.account_id = s_account AND x.id = p_setup;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION setup_install_merged(uuid, integer) FROM PUBLIC;
ALTER FUNCTION setup_install_merged(uuid, integer) OWNER TO setup_install_definer;
GRANT EXECUTE ON FUNCTION setup_install_merged(uuid, integer) TO app_user;
REVOKE ALL ON FUNCTION setup_finish_claim(uuid) FROM PUBLIC;
ALTER FUNCTION setup_finish_claim(uuid) OWNER TO setup_finish_definer;
GRANT EXECUTE ON FUNCTION setup_finish_claim(uuid) TO platform_ops;
REVOKE ALL ON FUNCTION setup_finish_release(uuid, integer, text) FROM PUBLIC;
ALTER FUNCTION setup_finish_release(uuid, integer, text) OWNER TO setup_finish_definer;
GRANT EXECUTE ON FUNCTION setup_finish_release(uuid, integer, text) TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM setup_install_definer;
REVOKE CREATE ON SCHEMA public FROM setup_finish_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE setup_install_definer FROM CURRENT_USER;
    REVOKE setup_finish_definer FROM CURRENT_USER;
  END IF;
END
$$;
