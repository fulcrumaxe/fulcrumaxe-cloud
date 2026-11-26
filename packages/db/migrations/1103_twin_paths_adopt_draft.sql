-- D#845 ON-27a3: the rest of the private twin's creation. Numbered 1103 by the Team Lead; never renumbered.
--   1. twin_set_paths: an owner or admin writes the twin's overlay globs, binary globs and the two rule-file paths in one call, against the revision they read (a compare-and-swap on updated_at; a stale read
--      answers 'conflict' and changes nothing). The shape is checked here too (the app also checks the rule files are private paths, which needs the glob compiler). One audit row of ids, field names and counts.
--   2. twin_add_install_paths: the install merge adds the engine files the install added. It only ever adds (a path once private stays private; nothing here can publish a file), refuses past 5,000 rather than cut
--      the list, and needs no person: with a person in the session it must be an owner or admin. One audit row of counts.
--   3. twin_adopt_draft: the public repo's latest plan draft (approved, or still being edited, never a discarded one) becomes the twin setup's next draft through project_draft_insert (source survey), and the setup
--      goes to the plan step with no survey run. An owner or admin; the new draft is a draft again (the plan is approved afresh). It is owned by project_drafts_owner, which alone can call project_draft_insert.
-- The audit rows are written by the definers into audit_log under the same kind of insert policy 1097 and 1099 use, so audit_write is not touched.

-- Policy restated from 1099 with the two new twin actions.
DROP POLICY repo_twins_owner_audit ON audit_log;
CREATE POLICY repo_twins_owner_audit ON audit_log FOR INSERT TO repo_twins_owner
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
              AND action IN ('twin.created', 'twin.paused', 'twin.resumed', 'twin.removed', 'twin.connected', 'twin.paths_changed', 'twin.install_paths_added'));

-- What project_drafts_owner reads and writes for the adopt, by column, in the session's account only.
GRANT SELECT (id, account_id, public_repo_id, private_repo_id, state) ON repo_twins TO project_drafts_owner;
CREATE POLICY project_drafts_owner_use ON repo_twins FOR SELECT TO project_drafts_owner USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
GRANT SELECT (prd_md, roadmap, status) ON project_drafts TO project_drafts_owner;
GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO project_drafts_owner;
CREATE POLICY project_drafts_owner_audit ON audit_log FOR INSERT TO project_drafts_owner
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND action = 'twin.draft_adopted');

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'repo_twins_owner'::regrole AND m.member = current_user::regrole AND m.admin_option)
       OR NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'project_drafts_owner'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on repo_twins_owner and project_drafts_owner; cannot ALTER FUNCTION ... OWNER TO them';
    END IF;
    GRANT repo_twins_owner TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
    GRANT project_drafts_owner TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO repo_twins_owner, project_drafts_owner;

-- o_result: ok | not_found | bad_state (a removed twin) | conflict (p_expect is not the twin's revision now). o_revision is the revision after the call.
CREATE FUNCTION twin_set_paths(p_id uuid, p_expect text, p_overlay text[], p_binary text[], p_identifier text, p_plan text) RETURNS TABLE (o_result text, o_revision text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v    public.repo_twins%ROWTYPE;
  fmt  constant text := 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"';
  glob constant text := '^[A-Za-z0-9._/*?{},@+=~-]{1,200}$';
  plain constant text := '^[A-Za-z0-9._/@+=~-]{1,200}$';
  changed text[] := '{}';
BEGIN
  IF acct IS NULL OR usr IS NULL OR NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = acct AND a.deleted_at IS NULL) OR NOT public.account_is_active(acct)
     OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'twin_set_paths: caller is not an owner or admin of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_id IS NULL OR p_expect IS NULL OR p_overlay IS NULL OR p_binary IS NULL
     OR cardinality(p_overlay) > 100 OR cardinality(p_binary) > 100
     OR EXISTS (SELECT 1 FROM unnest(p_overlay) g WHERE g IS NULL OR g !~ glob OR g LIKE '/%' OR g LIKE '%//%' OR g ~ '(^|/)\.\.(/|$)')
     OR (SELECT count(DISTINCT g) <> count(*) FROM unnest(p_overlay) g)
     OR EXISTS (SELECT 1 FROM unnest(p_binary) g WHERE g IS NULL OR g !~ glob OR g LIKE '/%' OR g LIKE '%//%' OR g ~ '(^|/)\.\.(/|$)')
     OR (SELECT count(DISTINCT g) <> count(*) FROM unnest(p_binary) g)
     OR (p_identifier IS NOT NULL AND (p_identifier !~ plain OR p_identifier LIKE '/%' OR p_identifier LIKE '%//%' OR p_identifier ~ '(^|/)\.\.(/|$)'))
     OR (p_plan IS NOT NULL AND (p_plan !~ plain OR p_plan LIKE '/%' OR p_plan LIKE '%//%' OR p_plan ~ '(^|/)\.\.(/|$)')) THEN
    RAISE EXCEPTION 'twin_set_paths: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v FROM public.repo_twins t WHERE t.id = p_id AND t.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found', NULL::text; RETURN;
  END IF;
  IF v.state = 'removed' THEN
    RETURN QUERY SELECT 'bad_state', NULL::text; RETURN;
  END IF;
  IF to_char(v.updated_at AT TIME ZONE 'UTC', fmt) <> p_expect THEN
    RETURN QUERY SELECT 'conflict', to_char(v.updated_at AT TIME ZONE 'UTC', fmt); RETURN;
  END IF;
  IF v.overlay_globs IS DISTINCT FROM p_overlay THEN changed := array_append(changed, 'overlay_globs'); END IF;
  IF v.binary_globs IS DISTINCT FROM p_binary THEN changed := array_append(changed, 'binary_globs'); END IF;
  IF v.identifier_rules_path IS DISTINCT FROM p_identifier THEN changed := array_append(changed, 'identifier_rules_path'); END IF;
  IF v.plan_data_rules_path IS DISTINCT FROM p_plan THEN changed := array_append(changed, 'plan_data_rules_path'); END IF;
  IF cardinality(changed) = 0 THEN
    RETURN QUERY SELECT 'ok', to_char(v.updated_at AT TIME ZONE 'UTC', fmt); RETURN;
  END IF;
  UPDATE public.repo_twins SET overlay_globs = p_overlay, binary_globs = p_binary, identifier_rules_path = p_identifier, plan_data_rules_path = p_plan, updated_at = clock_timestamp()
   WHERE id = v.id AND account_id = acct RETURNING * INTO v;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, 'twin.paths_changed',
          jsonb_build_object('twin_id', v.id, 'changed', to_jsonb(changed), 'overlay_count', cardinality(p_overlay), 'binary_count', cardinality(p_binary),
                             'identifier_rules_path', p_identifier, 'plan_data_rules_path', p_plan), clock_timestamp());
  RETURN QUERY SELECT 'ok', to_char(v.updated_at AT TIME ZONE 'UTC', fmt);
END;
$$;

-- o_result: ok | not_found | bad_state (a removed twin) | too_many (the list would pass 5,000; nothing is written). o_count is the list's length now.
CREATE FUNCTION twin_add_install_paths(p_id uuid, p_paths text[]) RETURNS TABLE (o_result text, o_count integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v    public.repo_twins%ROWTYPE;
  v_new text[];
BEGIN
  IF acct IS NULL OR NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = acct AND a.deleted_at IS NULL) OR NOT public.account_is_active(acct)
     OR (usr IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin'))) THEN
    RAISE EXCEPTION 'twin_add_install_paths: refused' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_id IS NULL OR p_paths IS NULL OR cardinality(p_paths) > 5000
     OR EXISTS (SELECT 1 FROM unnest(p_paths) g WHERE g IS NULL OR g !~ '^[A-Za-z0-9._/@+=~-]{1,200}$' OR g LIKE '/%' OR g LIKE '%//%' OR g ~ '(^|/)\.\.(/|$)') THEN
    RAISE EXCEPTION 'twin_add_install_paths: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v FROM public.repo_twins t WHERE t.id = p_id AND t.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found', NULL::integer; RETURN;
  END IF;
  IF v.state = 'removed' THEN
    RETURN QUERY SELECT 'bad_state', NULL::integer; RETURN;
  END IF;
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}') INTO v_new FROM unnest(v.install_paths || p_paths) x;
  IF cardinality(v_new) > 5000 THEN
    RETURN QUERY SELECT 'too_many', cardinality(v.install_paths); RETURN;
  END IF;
  IF cardinality(v_new) > cardinality(v.install_paths) THEN
    UPDATE public.repo_twins SET install_paths = v_new, updated_at = clock_timestamp() WHERE id = v.id AND account_id = acct;
    INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
    VALUES (acct, COALESCE(usr::text, 'system'), 'twin.install_paths_added',
            jsonb_build_object('twin_id', v.id, 'added', cardinality(v_new) - cardinality(v.install_paths), 'total', cardinality(v_new)), clock_timestamp());
  END IF;
  RETURN QUERY SELECT 'ok', cardinality(v_new);
END;
$$;

-- o_result: ok | not_found (a twin or setup that is not this account's, or a setup that is not the twin's private repo's) | bad_state (a removed twin, or a setup past the survey step or with a survey started)
--           | no_draft (the public repo has no plan draft with rows to carry, or the draft no longer passes the plan shape).
CREATE FUNCTION twin_adopt_draft(p_twin uuid, p_setup uuid) RETURNS TABLE (o_result text, o_draft uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  w    record;
  s    record;
  d    record;
  v_id uuid;
BEGIN
  IF acct IS NULL OR usr IS NULL OR NOT EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = acct AND a.deleted_at IS NULL) OR NOT public.account_is_active(acct)
     OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'twin_adopt_draft: caller is not an owner or admin of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_twin IS NULL OR p_setup IS NULL THEN
    RAISE EXCEPTION 'twin_adopt_draft: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT t.public_repo_id, t.private_repo_id, t.state INTO w FROM public.repo_twins t WHERE t.id = p_twin AND t.account_id = acct;
  SELECT x.id, x.repo_id, x.phase, x.survey_run_id INTO s FROM public.project_setups x WHERE x.id = p_setup AND x.account_id = acct FOR UPDATE;
  IF w.public_repo_id IS NULL OR s.id IS NULL OR w.private_repo_id IS NULL OR s.repo_id <> w.private_repo_id THEN
    RETURN QUERY SELECT 'not_found', NULL::uuid; RETURN;
  END IF;
  IF w.state = 'removed' OR s.phase <> 'survey' OR s.survey_run_id IS NOT NULL THEN
    RETURN QUERY SELECT 'bad_state', NULL::uuid; RETURN;
  END IF;
  SELECT x.id, x.prd_md, x.roadmap INTO d FROM public.project_drafts x
   WHERE x.account_id = acct AND x.repo_id = w.public_repo_id AND x.status IN ('approved', 'draft') AND jsonb_array_length(x.roadmap) > 0
   ORDER BY x.version DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'no_draft', NULL::uuid; RETURN;
  END IF;
  BEGIN
    v_id := public.project_draft_insert(acct, s.repo_id, s.id, 'survey', d.prd_md, d.roadmap);
  EXCEPTION WHEN check_violation OR invalid_parameter_value THEN
    RETURN QUERY SELECT 'no_draft', NULL::uuid; RETURN;
  END;
  UPDATE public.project_setups x SET phase = 'plan', state = 'ok', sub_step = NULL, failure_code = NULL, failure_reason = NULL, failure_at = NULL, updated_at = now() WHERE x.account_id = acct AND x.id = s.id;
  PERFORM public.project_setup_notice(s.id, s.repo_id);
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, 'twin.draft_adopted',
          jsonb_build_object('twin_id', p_twin, 'public_repo_id', w.public_repo_id, 'private_repo_id', w.private_repo_id, 'setup_id', s.id, 'draft_id', v_id, 'from_draft_id', d.id), clock_timestamp());
  RETURN QUERY SELECT 'ok', v_id;
END;
$$;

REVOKE ALL ON FUNCTION twin_set_paths(uuid, text, text[], text[], text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION twin_add_install_paths(uuid, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION twin_adopt_draft(uuid, uuid) FROM PUBLIC;
ALTER FUNCTION twin_set_paths(uuid, text, text[], text[], text, text) OWNER TO repo_twins_owner;
ALTER FUNCTION twin_add_install_paths(uuid, text[]) OWNER TO repo_twins_owner;
ALTER FUNCTION twin_adopt_draft(uuid, uuid) OWNER TO project_drafts_owner;
-- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner).
GRANT EXECUTE ON FUNCTION twin_set_paths(uuid, text, text[], text[], text, text) TO app_user;
GRANT EXECUTE ON FUNCTION twin_add_install_paths(uuid, text[]) TO app_user;
GRANT EXECUTE ON FUNCTION twin_adopt_draft(uuid, uuid) TO app_user;

REVOKE CREATE ON SCHEMA public FROM repo_twins_owner, project_drafts_owner;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE repo_twins_owner FROM CURRENT_USER;
    REVOKE project_drafts_owner FROM CURRENT_USER;
  END IF;
END
$$;
