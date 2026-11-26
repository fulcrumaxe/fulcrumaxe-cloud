-- D#845 FU-289/FU-292 (Ruling 109): a private twin's `install_paths` are recorded when its install pull request merges. Numbered 1107 by the Team Lead; never renumbered.
--   1. setup_finish_claim() is restated from 1085 with three more columns: the setup's install pull request number and head sha (from its own row) and the live twin id of the setup's repo (NULL when the repo is no live twin's private repo).
--      Every other line is 1085's. Its return type grows, so the function is dropped and made again (owner and EXECUTE are set again below).
--   2. setup_finish_twin_install_paths(setup, attempt, paths): the finish step's one write for a twin. platform_ops only. It refuses (writes nothing) unless the setup is at phase `finish` at that attempt and its repo is a live twin's private repo,
--      then applies what twin_add_install_paths (1103) applies to a twin: the union of the paths (a path once private stays private), refused past 5,000 rather than cut, and one audit row of counts. The runner names no path of its own: it passes
--      the files GitHub lists as ADDED by the merged install pull request.
--   3. setup_finish_definer gains what these read and write: the setup's install_pr and install_head_sha, the twin's id, private repo, state and install_paths (and UPDATE of install_paths and updated_at, live twins only), and one audit insert policy (that one action, by actor `system`).

GRANT SELECT (install_pr, install_head_sha) ON project_setups TO setup_finish_definer;
GRANT SELECT (id, account_id, private_repo_id, state, install_paths) ON repo_twins TO setup_finish_definer;
GRANT UPDATE (install_paths, updated_at) ON repo_twins TO setup_finish_definer;
CREATE POLICY setup_finish_definer_select ON repo_twins FOR SELECT TO setup_finish_definer USING (state <> 'removed');
CREATE POLICY setup_finish_definer_update ON repo_twins FOR UPDATE TO setup_finish_definer USING (state <> 'removed') WITH CHECK (state <> 'removed');
GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO setup_finish_definer;
CREATE POLICY setup_finish_definer_audit ON audit_log FOR INSERT TO setup_finish_definer WITH CHECK (action = 'twin.install_paths_added' AND actor = 'system');

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'setup_finish_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on setup_finish_definer; cannot ALTER FUNCTION ... OWNER TO setup_finish_definer';
    END IF;
    GRANT setup_finish_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO setup_finish_definer;

DROP FUNCTION setup_finish_claim();

-- The oldest due setup, leased. Due: phase finish, and either no failure or a `seed_failed` fifteen minutes old with fewer than 96 failed passes; and no lease of the last ten minutes.
CREATE FUNCTION setup_finish_claim()
RETURNS TABLE (o_account uuid, o_setup uuid, o_repo uuid, o_attempt integer, o_owner text, o_name text, o_roadmap jsonb, o_seeded jsonb, o_install_pr integer, o_install_head_sha text, o_twin uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  s_id uuid; s_account uuid; s_repo uuid; s_attempt integer; s_pr integer; s_head text; s_twin uuid;
BEGIN
  IF session_user <> 'platform_ops' THEN
    RAISE EXCEPTION 'setup_finish_claim: platform_ops only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT x.id, x.account_id, x.repo_id, x.attempt, x.install_pr, x.install_head_sha INTO s_id, s_account, s_repo, s_attempt, s_pr, s_head FROM public.project_setups x
   WHERE x.phase = 'finish'
     AND (x.state <> 'failed' OR (x.failure_code = 'seed_failed' AND x.failure_at < now() - interval '15 minutes' AND x.finish_tries < 96))
     AND (x.finish_claim_at IS NULL OR x.finish_claim_at < now() - interval '10 minutes')
     AND public.account_is_active(x.account_id)
   ORDER BY x.updated_at, x.id
   LIMIT 1
   FOR UPDATE OF x SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.project_setups x SET finish_claim_at = now() WHERE x.account_id = s_account AND x.id = s_id;
  SELECT t.id INTO s_twin FROM public.repo_twins t WHERE t.account_id = s_account AND t.private_repo_id = s_repo AND t.state <> 'removed';
  RETURN QUERY
    SELECT s_account, s_id, s_repo, s_attempt, r.gh_owner, r.gh_name, public.setup_finish_kept_rows(s_account, s_repo, s_id),
           COALESCE((SELECT jsonb_agg(jsonb_build_object('row_key', q.row_key, 'discussion_number', q.discussion_number) ORDER BY q.row_key) FROM public.project_seeded_rows q WHERE q.account_id = s_account AND q.setup_id = s_id), '[]'::jsonb),
           s_pr, s_head, s_twin
      FROM public.repos r WHERE r.account_id = s_account AND r.id = s_repo;
END;
$$;

-- o_result: ok (the list is the union now; o_count is its length) | skipped (the setup is not at phase finish at that attempt) | not_twin (its repo is not a live twin's private repo) | too_many (the union would pass 5,000; nothing is written).
CREATE FUNCTION setup_finish_twin_install_paths(p_setup uuid, p_attempt integer, p_paths text[])
RETURNS TABLE (o_result text, o_count integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  s_account uuid; s_repo uuid;
  v_id uuid; v_old text[]; v_new text[];
BEGIN
  IF session_user <> 'platform_ops' THEN
    RAISE EXCEPTION 'setup_finish_twin_install_paths: platform_ops only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_setup IS NULL OR p_attempt IS NULL OR p_paths IS NULL OR cardinality(p_paths) > 5000
     OR EXISTS (SELECT 1 FROM unnest(p_paths) g WHERE g IS NULL OR g !~ '^[A-Za-z0-9._/@+=~-]{1,200}$' OR g LIKE '/%' OR g LIKE '%//%' OR g ~ '(^|/)\.\.(/|$)') THEN
    RAISE EXCEPTION 'setup_finish_twin_install_paths: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT x.account_id, x.repo_id INTO s_account, s_repo FROM public.project_setups x WHERE x.id = p_setup AND x.phase = 'finish' AND x.attempt = p_attempt FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'skipped', NULL::integer; RETURN;
  END IF;
  SELECT t.id, t.install_paths INTO v_id, v_old FROM public.repo_twins t WHERE t.account_id = s_account AND t.private_repo_id = s_repo AND t.state <> 'removed' FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_twin', NULL::integer; RETURN;
  END IF;
  SELECT COALESCE(array_agg(DISTINCT y ORDER BY y), '{}') INTO v_new FROM unnest(v_old || p_paths) y;
  IF cardinality(v_new) > 5000 THEN
    RETURN QUERY SELECT 'too_many', cardinality(v_old); RETURN;
  END IF;
  IF cardinality(v_new) > cardinality(v_old) THEN
    UPDATE public.repo_twins t SET install_paths = v_new, updated_at = clock_timestamp() WHERE t.id = v_id AND t.account_id = s_account;
    INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
    VALUES (s_account, 'system', 'twin.install_paths_added',
            jsonb_build_object('twin_id', v_id, 'added', cardinality(v_new) - cardinality(v_old), 'total', cardinality(v_new)), clock_timestamp());
  END IF;
  RETURN QUERY SELECT 'ok', cardinality(v_new);
END;
$$;

REVOKE ALL ON FUNCTION setup_finish_claim() FROM PUBLIC;
REVOKE ALL ON FUNCTION setup_finish_twin_install_paths(uuid, integer, text[]) FROM PUBLIC;
ALTER FUNCTION setup_finish_claim() OWNER TO setup_finish_definer;
ALTER FUNCTION setup_finish_twin_install_paths(uuid, integer, text[]) OWNER TO setup_finish_definer;
GRANT EXECUTE ON FUNCTION setup_finish_claim() TO platform_ops;
GRANT EXECUTE ON FUNCTION setup_finish_twin_install_paths(uuid, integer, text[]) TO platform_ops;
REVOKE CREATE ON SCHEMA public FROM setup_finish_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE setup_finish_definer FROM CURRENT_USER;
  END IF;
END
$$;
