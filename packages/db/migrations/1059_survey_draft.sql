-- D#845 ON-10a: the survey run's side of the database. A survey is an ordinary agent run of the role project-surveyor (never a machine job); this migration holds all the SQL of ON-10.
--
--   1. project_setups.survey_run_id (the agent run of the setup's current survey, same account; NULLed if the run is deleted) and survey_started_at. One setup per run (a partial unique index).
--   2. project_drafts_owner: a new NOLOGIN role that holds only what the four functions below use. It is not machine_ops and not onboarding_ops.
--   3. project_draft_insert (internal: no login role may EXECUTE it). The one writer of a draft by a definer: it takes the repo's version lock, numbers the draft per repo (1 on a first survey, the next number after a Start over, because
--      of UNIQUE (account_id, repo_id, version)), sets setup_id, puts keep: true on every row and re-checks the shape and that every depends_on names another row of the draft. ON-12's interview definer calls the same function.
--   4. survey_start_record (a tenant session, owner or admin): binds a pending project-surveyor run to a setup in phase survey that has no live survey run, and starts the setup's survey.
--      survey_draft_record (the run-writer login only): the done branch's write, under the run's lease. The runner and generation are those the verified request carries (the same arguments agent_run_runner_lease takes);
--      the account is the session's. Idempotent: a repeat returns the draft of the first call and inserts nothing. A NULL answer means nothing was stored (the setup is not waiting for this run, or the draft was refused by the table's checks).
--      survey_fail (the run-writer login only): the failed state of the survey, with a closed code and a closed reason; it stores nothing else.
--   Each of the three that changes a setup says so with one setup.changed notice (ids only), in the same transaction.
--
-- Numbered 1059 by the Team Lead; it merges after 1053 (#1179), because it reads the failure_reason column that migration adds. Re-check against main's highest right before merging.

ALTER TABLE project_setups
  ADD COLUMN survey_run_id uuid,
  ADD COLUMN survey_started_at timestamptz,
  ADD CONSTRAINT project_setups_survey_run_fk FOREIGN KEY (account_id, survey_run_id) REFERENCES agent_runs (account_id, id) ON DELETE SET NULL (survey_run_id);
CREATE UNIQUE INDEX project_setups_survey_run ON project_setups (account_id, survey_run_id) WHERE survey_run_id IS NOT NULL;

DO $$
DECLARE
  n text := 'project_drafts_owner';
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

-- What the project_drafts_owner functions read and write, by column, in the session's account only.
GRANT USAGE ON SCHEMA public TO project_drafts_owner;
GRANT SELECT (id, deleted_at) ON accounts TO project_drafts_owner;
CREATE POLICY project_drafts_owner_use ON accounts FOR SELECT TO project_drafts_owner USING (id = NULLIF(current_setting('app.account_id', true), '')::uuid);
GRANT SELECT (account_id, user_id, role) ON account_members TO project_drafts_owner;
CREATE POLICY project_drafts_owner_use ON account_members FOR SELECT TO project_drafts_owner USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
GRANT SELECT (id, account_id, role, runner_id, lease_generation, status) ON agent_runs TO project_drafts_owner;
CREATE POLICY project_drafts_owner_use ON agent_runs FOR SELECT TO project_drafts_owner USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
GRANT SELECT (id, account_id, repo_id, phase, state, survey_run_id, survey_started_at),
  UPDATE (phase, state, sub_step, failure_code, failure_reason, failure_at, survey_run_id, survey_started_at, updated_at) ON project_setups TO project_drafts_owner;
CREATE POLICY project_drafts_owner_use ON project_setups FOR ALL TO project_drafts_owner
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
GRANT SELECT (id, account_id, repo_id, setup_id, source, version), INSERT (account_id, repo_id, setup_id, source, prd_md, roadmap, version) ON project_drafts TO project_drafts_owner;
CREATE POLICY project_drafts_owner_select ON project_drafts FOR SELECT TO project_drafts_owner USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY project_drafts_owner_insert ON project_drafts FOR INSERT TO project_drafts_owner WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
-- The CHECK on project_drafts.roadmap runs as the writer.
GRANT EXECUTE ON FUNCTION project_roadmap_valid(jsonb) TO project_drafts_owner;
-- setup.changed: the one notice, written in the transaction of the change it announces (the same shape and policy as engine.changed in 1027).
GRANT INSERT ON domain_events TO project_drafts_owner;
GRANT USAGE ON SEQUENCE domain_events_seq_seq TO project_drafts_owner;
CREATE POLICY project_drafts_owner_insert ON domain_events FOR INSERT TO project_drafts_owner
  WITH CHECK (type = 'setup.changed' AND account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- ---- ownership: the migration role holds project_drafts_owner only to hand the functions over (1035's shape) ---------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'project_drafts_owner'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on project_drafts_owner; cannot ALTER FUNCTION ... OWNER TO project_drafts_owner';
    END IF;
    GRANT project_drafts_owner TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO project_drafts_owner;

-- The draft itself. Internal: only the definers below (and later ones the owner gives it to) reach it. rows: the survey's roadmap rows without `keep` (the function sets keep: true on each).
CREATE FUNCTION project_draft_insert(p_account uuid, p_repo uuid, p_setup uuid, p_source text, p_prd_md text, p_roadmap jsonb)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct  uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_rows jsonb;
  v_id  uuid;
BEGIN
  IF acct IS NULL OR p_account IS DISTINCT FROM acct OR p_repo IS NULL OR p_source IS NULL OR p_source NOT IN ('survey', 'interview', 'blank')
     OR p_prd_md IS NULL OR p_roadmap IS NULL OR jsonb_typeof(p_roadmap) <> 'array' THEN
    RAISE EXCEPTION 'project_draft_insert: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- A draft of the repo is numbered under one lock, and its setup (when it names one) is held too.
  PERFORM pg_advisory_xact_lock(hashtextextended('project_draft:' || p_repo::text, 0));
  IF p_setup IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.project_setups s WHERE s.account_id = acct AND s.id = p_setup AND s.repo_id = p_repo FOR UPDATE) THEN
    RAISE EXCEPTION 'project_draft_insert: no such setup' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT COALESCE(jsonb_agg(CASE WHEN jsonb_typeof(e.value) = 'object' THEN e.value || '{"keep": true}'::jsonb ELSE e.value END ORDER BY e.ord), '[]'::jsonb) INTO v_rows
    FROM jsonb_array_elements(p_roadmap) WITH ORDINALITY AS e(value, ord);
  -- The shape first, so that what is read below is known to be what it should be; then every dependency names another row of this draft.
  IF NOT public.project_roadmap_valid(v_rows) OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(v_rows) r, jsonb_array_elements_text(r.value -> 'depends_on') d
        WHERE d.value = r.value ->> 'row_key' OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_rows) x WHERE x.value ->> 'row_key' = d.value)) THEN
    RAISE EXCEPTION 'project_draft_insert: invalid roadmap' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.project_drafts (account_id, repo_id, setup_id, source, prd_md, roadmap, version)
  VALUES (acct, p_repo, p_setup, p_source, p_prd_md, v_rows, (SELECT COALESCE(max(d.version), 0) + 1 FROM public.project_drafts d WHERE d.account_id = acct AND d.repo_id = p_repo))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- The one change notice of a setup (ids only).
CREATE FUNCTION project_setup_notice(p_setup uuid, p_repo uuid) RETURNS void
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
  INSERT INTO public.domain_events (account_id, type, subject_id, payload)
  VALUES (NULLIF(current_setting('app.account_id', true), '')::uuid, 'setup.changed', p_setup::text, jsonb_build_object('setup_id', p_setup, 'repo_id', p_repo));
$$;

-- A person starts (or restarts) a setup's survey with a run the cloud has just created (pending, role project-surveyor). Owner or admin of the session's account.
CREATE FUNCTION survey_start_record(p_setup uuid, p_run uuid) RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  s    record;
BEGIN
  IF session_user = 'platform_ops' OR acct IS NULL OR usr IS NULL OR NOT public.account_is_active(acct) OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'survey_start_record: caller is not an owner or admin of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_setup IS NULL OR p_run IS NULL THEN
    RAISE EXCEPTION 'survey_start_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT x.id, x.repo_id, x.phase, x.state, x.survey_run_id INTO s FROM public.project_setups x WHERE x.account_id = acct AND x.id = p_setup FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'survey_start_record: no such setup' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF s.phase <> 'survey' OR (s.survey_run_id IS NOT NULL AND s.state = 'started'
       AND EXISTS (SELECT 1 FROM public.agent_runs a WHERE a.account_id = acct AND a.id = s.survey_run_id AND a.status IN ('pending', 'running', 'paused'))) THEN
    RAISE EXCEPTION 'survey_start_record: the setup is not waiting for a survey' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.agent_runs a WHERE a.account_id = acct AND a.id = p_run AND a.role = 'project-surveyor' AND a.status = 'pending') THEN
    RAISE EXCEPTION 'survey_start_record: not a pending survey run' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.project_setups x SET survey_run_id = p_run, survey_started_at = now(), state = 'started', failure_code = NULL, failure_reason = NULL, failure_at = NULL, updated_at = now()
   WHERE x.account_id = acct AND x.id = p_setup;
  PERFORM public.project_setup_notice(p_setup, s.repo_id);
END;
$$;

-- The draft of a finished survey, written in the done transaction of its run. Returns the draft id, or NULL when nothing was stored.
CREATE FUNCTION survey_draft_record(p_run uuid, p_runner uuid, p_generation integer, p_prd_md text, p_roadmap jsonb) RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  r    record;
  s    record;
  v_id uuid;
BEGIN
  IF session_user = 'platform_ops' OR acct IS NULL OR NOT public.account_is_active(acct) THEN
    RAISE EXCEPTION 'survey_draft_record: refused' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_run IS NULL OR p_runner IS NULL OR p_generation IS NULL OR p_generation < 0 OR p_prd_md IS NULL OR p_roadmap IS NULL THEN
    RAISE EXCEPTION 'survey_draft_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The run is this runner's, at this generation, of this role, and still running (or already succeeded: the repeat).
  SELECT a.role, a.runner_id, a.lease_generation, a.status INTO r FROM public.agent_runs a WHERE a.account_id = acct AND a.id = p_run;
  IF NOT FOUND OR r.role <> 'project-surveyor' OR r.runner_id IS DISTINCT FROM p_runner OR r.lease_generation <> p_generation OR r.status NOT IN ('running', 'succeeded') THEN
    RAISE EXCEPTION 'survey_draft_record: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT x.id, x.repo_id, x.phase, x.state INTO s FROM public.project_setups x WHERE x.account_id = acct AND x.survey_run_id = p_run FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF r.status = 'succeeded' THEN
    RETURN (SELECT d.id FROM public.project_drafts d WHERE d.account_id = acct AND d.setup_id = s.id AND d.source = 'survey' ORDER BY d.version DESC LIMIT 1);
  END IF;
  IF s.phase <> 'survey' OR s.state <> 'started' THEN RETURN NULL; END IF;
  BEGIN
    v_id := public.project_draft_insert(acct, s.repo_id, s.id, 'survey', p_prd_md, p_roadmap);
  EXCEPTION WHEN check_violation OR invalid_parameter_value THEN
    RETURN NULL;
  END;
  UPDATE public.project_setups x SET phase = 'plan', state = 'ok', sub_step = NULL, failure_code = NULL, failure_reason = NULL, failure_at = NULL, updated_at = now() WHERE x.account_id = acct AND x.id = s.id;
  PERFORM public.project_setup_notice(s.id, s.repo_id);
  RETURN v_id;
END;
$$;

-- The survey failed (a bad answer, a run that ended, or the cloud's deadline): the setup's failed state with a closed code and reason. True when it was written; false when the setup is no longer waiting for this run.
CREATE FUNCTION survey_fail(p_run uuid, p_code text, p_reason text) RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_setup uuid;
  v_repo  uuid;
BEGIN
  IF session_user = 'platform_ops' OR acct IS NULL OR NOT public.account_is_active(acct) THEN
    RAISE EXCEPTION 'survey_fail: refused' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_run IS NULL OR p_code IS NULL OR p_code NOT IN ('survey_failed', 'survey_timeout')
     OR p_reason IS NULL OR p_reason NOT IN ('output_invalid', 'output_too_large', 'no_output', 'workspace_written', 'run_failed', 'runner_lost', 'refused_at_admit', 'cancelled', 'deadline') THEN
    RAISE EXCEPTION 'survey_fail: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.project_setups x SET state = 'failed', failure_code = p_code, failure_reason = p_reason, failure_at = now(), updated_at = now()
   WHERE x.account_id = acct AND x.survey_run_id = p_run AND x.phase = 'survey' AND x.state = 'started'
  RETURNING x.id, x.repo_id INTO v_setup, v_repo;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM public.project_setup_notice(v_setup, v_repo);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION project_draft_insert(uuid, uuid, uuid, text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION project_setup_notice(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION survey_start_record(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION survey_draft_record(uuid, uuid, integer, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION survey_fail(uuid, text, text) FROM PUBLIC;
ALTER FUNCTION project_draft_insert(uuid, uuid, uuid, text, text, jsonb) OWNER TO project_drafts_owner;
ALTER FUNCTION project_setup_notice(uuid, uuid) OWNER TO project_drafts_owner;
ALTER FUNCTION survey_start_record(uuid, uuid) OWNER TO project_drafts_owner;
ALTER FUNCTION survey_draft_record(uuid, uuid, integer, text, jsonb) OWNER TO project_drafts_owner;
ALTER FUNCTION survey_fail(uuid, text, text) OWNER TO project_drafts_owner;
-- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner). project_draft_insert and project_setup_notice go to no login role.
GRANT EXECUTE ON FUNCTION survey_start_record(uuid, uuid) TO app_user;
GRANT EXECUTE ON FUNCTION survey_draft_record(uuid, uuid, integer, text, jsonb) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION survey_fail(uuid, text, text) TO agent_run_writer;

REVOKE CREATE ON SCHEMA public FROM project_drafts_owner;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE project_drafts_owner FROM CURRENT_USER;
  END IF;
END
$$;
