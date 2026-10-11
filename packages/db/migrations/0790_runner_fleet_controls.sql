-- D#605 FL-8: what the fleet control routes need from the database, on top of 0783.
--
--   1. Every settings action leaves an audit row. 0783's runner_settings_definer could write settings but had no audit_log grant, so this
--      gives it INSERT on the five audit columns and one policy that admits six action names for the caller's own account and nothing else,
--      then replaces runner_settings_apply with the same body plus the audit insert in the same transaction (app_user has no INSERT on
--      audit_log, 0008). Nothing else about the function changes: its signature, its permission matrix, its refusals and its owner stay.
--   2. Changing a runner's repos. runners.allowed_repo_ids had no writer after registration. runner_repos_set is owned by a new NOLOGIN role,
--      runner_repos_definer, whose only reach is: read of the caller's runner (five columns) and a column UPDATE of allowed_repo_ids on a
--      runner that is not revoked; read of repos (id, account); the caller's own membership row; one audit action. platform_ops gets nothing.
--      An owner or admin may set any set of the account's repos. The runner's registrant may only narrow (a subset of what is there now).
--      A revoked runner is refused 55000, another account's runner does not exist (P0002), a non-member is refused 42501, a repo that is not
--      the account's, a null, or more than 100 is invalid (22023). Narrowing cancels nothing running: the claim reads the list on every poll.
--
-- Numbered above the highest migration on the code plane. Re-check against main right before merging and renumber to stay above its highest.

DO $$
DECLARE
  n text := 'runner_repos_definer';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'role % still has a privileged attribute', n;
  END IF;
END
$$;

-- ---- grants and policies: the settings role's audit insert ------------------------------------------------------------
GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO runner_settings_definer;
CREATE POLICY runner_settings_definer_audit ON audit_log FOR INSERT TO runner_settings_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
              AND action IN ('runner.renamed', 'runner.labels_set', 'runner.rank_set', 'runner.paused', 'runner.drain_started', 'runner.resumed'));

-- ---- grants and policies: the repos role ------------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO runner_repos_definer;
GRANT SELECT (id, account_id, registered_by, allowed_repo_ids, revoked_at), UPDATE (allowed_repo_ids) ON runners TO runner_repos_definer;
GRANT SELECT (id, account_id) ON repos TO runner_repos_definer;
GRANT SELECT (account_id, user_id, role) ON account_members TO runner_repos_definer;
GRANT SELECT (id, deleted_at) ON accounts TO runner_repos_definer;
GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO runner_repos_definer;

CREATE POLICY runner_repos_definer_select ON runners FOR SELECT TO runner_repos_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
-- A row can be locked (SELECT ... FOR UPDATE uses the UPDATE policy's USING) so the function can tell a removed runner from a missing one, but an
-- UPDATE must leave a live runner of the caller's account: a revoked row fails the check, so it can never be written.
CREATE POLICY runner_repos_definer_update ON runners FOR UPDATE TO runner_repos_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND revoked_at IS NULL);
CREATE POLICY runner_repos_definer_select ON repos FOR SELECT TO runner_repos_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
-- Shows this role only the caller's own membership row, as 0783 does.
CREATE POLICY runner_repos_definer_select ON account_members FOR SELECT TO runner_repos_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY runner_repos_definer_select ON accounts FOR SELECT TO runner_repos_definer USING (true);
CREATE POLICY runner_repos_definer_audit ON audit_log FOR INSERT TO runner_repos_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND action = 'runner.repos_set');

-- ---- ownership bracket (0783's shape) ---------------------------------------------------------------------------------
DO $$
DECLARE
  n text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH n IN ARRAY ARRAY['runner_repos_definer', 'runner_settings_definer'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = n::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
        RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot change functions owned by %', n, n;
      END IF;
      EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', n);
    END LOOP;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO runner_repos_definer;

-- ---- runner_settings_apply: 0783's body, plus the audit row -----------------------------------------------------------
CREATE OR REPLACE FUNCTION runner_settings_apply(p_runner uuid, p_action text, p_name text, p_labels text[], p_rank integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct        uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr         uuid;
  v_role      text;
  v_reg       uuid;
  v_revoked   timestamptz;
  v_paused    timestamptz;
  v_paused_by uuid;
  v_draining  boolean;
  v_drained_by uuid;
  v_name      text;
  v_admin     boolean;
  v_owns      boolean;
  v_ts        timestamptz := clock_timestamp();
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_settings_apply: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The caller's own membership row (the policy shows this role no other); the role is re-derived on every call, never taken from the request.
  SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'runner_settings_apply: caller is not a member of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_runner IS NULL OR p_action IS NULL OR p_action NOT IN ('rename', 'labels', 'rank', 'pause', 'drain', 'resume') THEN
    RAISE EXCEPTION 'runner_settings_apply: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT r.registered_by, r.revoked_at INTO v_reg, v_revoked FROM public.runners r WHERE r.id = p_runner AND r.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runner_settings_apply: no such runner' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'runner_settings_apply: the runner is removed' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  v_admin := v_role IN ('owner', 'admin');
  v_owns := v_admin OR v_reg = usr;
  IF (p_action IN ('labels', 'rank') AND NOT v_admin) OR (p_action IN ('rename', 'pause', 'drain', 'resume') AND NOT v_owns) THEN
    RAISE EXCEPTION 'runner_settings_apply: not allowed for this caller' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The argument for the action, checked before any write. Text is refused, not repaired.
  IF p_action = 'rename' AND NOT public.runner_name_valid(p_name) THEN
    RAISE EXCEPTION 'runner_settings_apply: invalid name' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_action = 'labels' AND NOT public.runner_labels_valid(p_labels) THEN
    RAISE EXCEPTION 'runner_settings_apply: invalid labels' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_action = 'rank' AND (p_rank IS NULL OR p_rank NOT BETWEEN 0 AND 1000) THEN
    RAISE EXCEPTION 'runner_settings_apply: invalid rank' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.runner_settings (runner_id, account_id, updated_by) VALUES (p_runner, acct, usr) ON CONFLICT (runner_id) DO NOTHING;
  SELECT s.paused_at, s.paused_by, s.draining, s.drained_by, s.name INTO v_paused, v_paused_by, v_draining, v_drained_by, v_name
    FROM public.runner_settings s WHERE s.runner_id = p_runner AND s.account_id = acct FOR UPDATE;

  -- A registrant may not take over, or undo, a pause or drain someone else set. Only an owner / admin overwrites or clears another person's.
  IF NOT v_admin AND (
       (p_action IN ('pause', 'resume') AND v_paused IS NOT NULL AND v_paused_by IS DISTINCT FROM usr)
    OR (p_action IN ('drain', 'resume') AND v_draining AND v_drained_by IS DISTINCT FROM usr)) THEN
    RAISE EXCEPTION 'runner_settings_apply: a pause or drain set by someone else is in place' USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.runner_settings s SET
    name       = CASE WHEN p_action = 'rename' THEN p_name ELSE s.name END,
    labels     = CASE WHEN p_action = 'labels' THEN p_labels ELSE s.labels END,
    rank       = CASE WHEN p_action = 'rank' THEN p_rank ELSE s.rank END,
    paused_at  = CASE p_action WHEN 'pause' THEN COALESCE(s.paused_at, now()) WHEN 'resume' THEN NULL ELSE s.paused_at END,
    paused_by  = CASE p_action WHEN 'pause' THEN usr WHEN 'resume' THEN NULL ELSE s.paused_by END,
    draining   = CASE p_action WHEN 'drain' THEN true WHEN 'resume' THEN false ELSE s.draining END,
    drained_by = CASE p_action WHEN 'drain' THEN usr WHEN 'resume' THEN NULL ELSE s.drained_by END,
    updated_by = usr,
    updated_at = now()
  WHERE s.runner_id = p_runner AND s.account_id = acct;

  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text,
    CASE p_action WHEN 'rename' THEN 'runner.renamed' WHEN 'labels' THEN 'runner.labels_set' WHEN 'rank' THEN 'runner.rank_set'
                  WHEN 'pause' THEN 'runner.paused' WHEN 'drain' THEN 'runner.drain_started' ELSE 'runner.resumed' END,
    jsonb_build_object('runner_id', p_runner, 'registered_by', v_reg) || CASE p_action
      WHEN 'rename' THEN jsonb_build_object('name', p_name, 'previous_name', v_name)
      WHEN 'labels' THEN jsonb_build_object('labels', to_jsonb(p_labels))
      WHEN 'rank' THEN jsonb_build_object('rank', p_rank)
      WHEN 'resume' THEN jsonb_build_object('ended_pause', v_paused IS NOT NULL, 'ended_drain', v_draining)
      ELSE '{}'::jsonb END,
    v_ts);
END;
$$;

-- ---- runner_repos_set -------------------------------------------------------------------------------------------------
CREATE FUNCTION runner_repos_set(p_runner uuid, p_repo_ids uuid[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct      uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr       uuid;
  v_role    text;
  v_reg     uuid;
  v_revoked timestamptz;
  v_now     uuid[];
  v_new     uuid[];
  v_ts      timestamptz := clock_timestamp();
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_repos_set: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'runner_repos_set: caller is not a member of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_runner IS NULL OR p_repo_ids IS NULL OR cardinality(p_repo_ids) > 100 OR array_ndims(p_repo_ids) > 1 OR array_position(p_repo_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'runner_repos_set: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT r.registered_by, r.revoked_at, r.allowed_repo_ids INTO v_reg, v_revoked, v_now
    FROM public.runners r WHERE r.id = p_runner AND r.account_id = acct FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runner_repos_set: no such runner' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'runner_repos_set: the runner is removed' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NOT (v_role IN ('owner', 'admin') OR v_reg = usr) THEN
    RAISE EXCEPTION 'runner_repos_set: not allowed for this caller' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}') INTO v_new FROM unnest(p_repo_ids) AS x;
  IF (SELECT count(*) FROM public.repos g WHERE g.account_id = acct AND g.id = ANY (v_new)) <> cardinality(v_new) THEN
    RAISE EXCEPTION 'runner_repos_set: a repository is not the account''s' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Widening (a repo the runner did not cover) is for an owner or admin; the registrant may only narrow.
  IF v_role NOT IN ('owner', 'admin') AND EXISTS (SELECT 1 FROM unnest(v_new) AS x WHERE x <> ALL (v_now)) THEN
    RAISE EXCEPTION 'runner_repos_set: only an owner or admin may widen a runner''s repositories' USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE public.runners SET allowed_repo_ids = v_new WHERE id = p_runner AND account_id = acct;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, 'runner.repos_set', jsonb_build_object(
    'runner_id', p_runner, 'registered_by', v_reg,
    'added', COALESCE((SELECT jsonb_agg(x ORDER BY x) FROM unnest(v_new) AS x WHERE x <> ALL (v_now)), '[]'::jsonb),
    'removed', COALESCE((SELECT jsonb_agg(x ORDER BY x) FROM unnest(v_now) AS x WHERE x <> ALL (v_new)), '[]'::jsonb)), v_ts);
END;
$$;

-- ---- execute grants, owner, and the bracket closed --------------------------------------------------------------------
REVOKE ALL ON FUNCTION runner_repos_set(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_repos_set(uuid, uuid[]) TO app_user;
ALTER FUNCTION runner_repos_set(uuid, uuid[]) OWNER TO runner_repos_definer;
REVOKE CREATE ON SCHEMA public FROM runner_repos_definer;

DO $$
DECLARE
  n text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH n IN ARRAY ARRAY['runner_repos_definer', 'runner_settings_definer'] LOOP
      EXECUTE format('REVOKE %I FROM CURRENT_USER', n);
    END LOOP;
  END IF;
END
$$;
