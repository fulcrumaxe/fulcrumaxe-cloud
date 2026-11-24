-- D#845 ON-8f1: the push of a project setup.
--
--   1. project_setups.install_head_sha (Ruling 73): the commit the runner pushed, written once from the job's `push ok` report and read by ON-20a. machine_jobs.push_token_at: the one push credential of an attempt
--      was handed out (the push-token route may answer once per job).
--   2. setup_push_grant(setup, job): the fence of the push-token route. The runner's own delivered, current `project_setup` job, whose setup reported the `push` step started; marks the credential handed out, once.
--   3. setup_head_record(setup, job, head): stores install_head_sha, in the same transaction as the `push ok` report it came with, for the same fence.
--   4. machine_job_raced(job) and machine_job_reissue(...): a direct-mode job that ended `direct_raced` (someone pushed the default branch first) is replaced by the same setup in PR mode, attempt + 1, at the new head. The
--      runner's session may do this and nothing else with it: the new job must be the old one's own signed arguments but for `mode` (pr) and `base_sha`, bound to the same runner, repo and setup.
-- The four are owned by machine_jobs_owner (1053), SECURITY DEFINER, EXECUTE for app_user alone, and pinned to the session's runner and account.
--
-- Numbered 1071 by the Team Lead. Re-check against main right before merging and renumber to stay above its highest.

ALTER TABLE project_setups ADD COLUMN install_head_sha text CONSTRAINT project_setups_install_head_check CHECK (install_head_sha IS NULL OR install_head_sha ~ '^[0-9a-f]{40}$');
ALTER TABLE machine_jobs ADD COLUMN push_token_at timestamptz;

DO $$
DECLARE
  owner_name text := (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid = 'public.setup_progress_record(uuid, uuid, integer, text, text, text, text)'::regprocedure);
  super boolean := (SELECT rolsuper FROM pg_roles WHERE rolname = current_user);
BEGIN
  IF owner_name IS DISTINCT FROM 'machine_jobs_owner' THEN
    RAISE EXCEPTION 'setup_progress_record is owned by %, not machine_jobs_owner', owner_name;
  END IF;
  IF NOT super THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = owner_name::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot create the setup push functions', owner_name;
    END IF;
    EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', owner_name);
  END IF;
  EXECUTE format('GRANT CREATE ON SCHEMA public TO %I', owner_name);
  EXECUTE format('GRANT SELECT (phase, sub_step, state, failure_code, install_head_sha) ON project_setups TO %I', owner_name);
  EXECUTE format('GRANT UPDATE (attempt, install_head_sha) ON project_setups TO %I', owner_name);

  -- The credential: only for this runner's delivered, current job, once the setup says the push began.
  CREATE FUNCTION public.setup_push_grant(p_setup uuid, p_job uuid) RETURNS TABLE (o_result text, o_repo_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    rid  uuid := public.machine_job_runner();
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    j    public.machine_jobs%ROWTYPE;
  BEGIN
    PERFORM public.machine_job_expire(rid);
    SELECT * INTO j FROM public.machine_jobs x WHERE x.id = p_job AND x.account_id = acct AND x.runner_id = rid AND x.setup_id = p_setup AND x.kind = 'project_setup' FOR UPDATE;
    IF NOT FOUND THEN RETURN QUERY SELECT 'not_found', NULL::uuid; RETURN; END IF;
    IF j.state = 'superseded' OR EXISTS (SELECT 1 FROM public.machine_jobs n WHERE n.account_id = acct AND n.setup_id = p_setup AND n.attempt > j.attempt) THEN RETURN QUERY SELECT 'superseded', NULL::uuid; RETURN; END IF;
    IF j.state <> 'delivered' THEN RETURN QUERY SELECT 'not_active', NULL::uuid; RETURN; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.project_setups s WHERE s.account_id = acct AND s.id = p_setup AND s.phase = 'install' AND s.sub_step = 'push' AND s.state = 'started') THEN RETURN QUERY SELECT 'not_ready', NULL::uuid; RETURN; END IF;
    IF j.push_token_at IS NOT NULL THEN RETURN QUERY SELECT 'already_issued', NULL::uuid; RETURN; END IF;
    UPDATE public.machine_jobs SET push_token_at = now() WHERE id = j.id AND account_id = acct;
    RETURN QUERY SELECT 'ok', j.repo_id;
  END;
  $f$;

  -- The pushed commit, written once, in the transaction of the `push ok` report (the caller rolls the report back when this says false).
  CREATE FUNCTION public.setup_head_record(p_setup uuid, p_job uuid, p_head text) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    rid  uuid := public.machine_job_runner();
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    j    public.machine_jobs%ROWTYPE;
  BEGIN
    IF p_head IS NULL OR p_head !~ '^[0-9a-f]{40}$' THEN RETURN false; END IF;
    SELECT * INTO j FROM public.machine_jobs x WHERE x.id = p_job AND x.account_id = acct AND x.runner_id = rid AND x.setup_id = p_setup AND x.kind = 'project_setup' AND x.state = 'delivered' FOR UPDATE;
    IF NOT FOUND OR EXISTS (SELECT 1 FROM public.machine_jobs n WHERE n.account_id = acct AND n.setup_id = p_setup AND n.attempt > j.attempt) THEN RETURN false; END IF;
    UPDATE public.project_setups s SET install_head_sha = p_head, updated_at = now()
     WHERE s.account_id = acct AND s.id = p_setup AND s.phase = 'install' AND s.sub_step = 'push' AND s.state = 'ok' AND s.install_head_sha IS NULL;
    RETURN FOUND;
  END;
  $f$;

  -- The signed job of this runner's latest attempt, only when it is a direct-mode job that ended direct_raced.
  CREATE FUNCTION public.machine_job_raced(p_job uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    rid  uuid := public.machine_job_runner();
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    j    public.machine_jobs%ROWTYPE;
  BEGIN
    SELECT * INTO j FROM public.machine_jobs x WHERE x.id = p_job AND x.account_id = acct AND x.runner_id = rid AND x.kind = 'project_setup' AND x.state = 'failed' AND x.job #>> '{job,args,mode}' = 'direct';
    IF NOT FOUND OR EXISTS (SELECT 1 FROM public.machine_jobs n WHERE n.account_id = acct AND n.setup_id = j.setup_id AND n.attempt > j.attempt)
       OR NOT EXISTS (SELECT 1 FROM public.project_setups s WHERE s.account_id = acct AND s.id = j.setup_id AND s.phase = 'install' AND s.failure_code = 'direct_raced') THEN RETURN NULL; END IF;
    RETURN j.job -> 'job';
  END;
  $f$;

  -- The replacement: the raced job's own arguments but for the mode and the base. The runner's session cannot change anything else about what it is sent.
  CREATE FUNCTION public.machine_job_reissue(p_prev uuid, p_id uuid, p_job jsonb, p_issued_at timestamptz, p_expires_at timestamptz) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    rid  uuid := public.machine_job_runner();
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    j    public.machine_jobs%ROWTYPE;
    v_attempt integer;
  BEGIN
    IF public.machine_job_raced(p_prev) IS NULL THEN RAISE EXCEPTION 'machine_job_reissue: not a raced direct job' USING ERRCODE = 'insufficient_privilege'; END IF;
    SELECT * INTO j FROM public.machine_jobs x WHERE x.id = p_prev AND x.account_id = acct FOR UPDATE;
    IF p_job #>> '{job,args,mode}' IS DISTINCT FROM 'pr' OR (p_job #> '{job,args}') - 'mode' - 'base_sha' IS DISTINCT FROM (j.job #> '{job,args}') - 'mode' - 'base_sha'
       OR p_job #>> '{job,repo_gh_id}' IS DISTINCT FROM j.job #>> '{job,repo_gh_id}' OR p_job #>> '{job,requires_engine}' IS DISTINCT FROM j.job #>> '{job,requires_engine}' THEN
      RAISE EXCEPTION 'machine_job_reissue: not the same job' USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_attempt := j.attempt + 1;
    INSERT INTO public.machine_jobs (id, account_id, runner_id, repo_id, setup_id, kind, job, attempt, issued_at, expires_at) VALUES (p_id, acct, rid, j.repo_id, j.setup_id, 'project_setup', p_job, v_attempt, p_issued_at, p_expires_at);
    UPDATE public.project_setups SET state = 'started', sub_step = NULL, failure_code = NULL, failure_reason = NULL, failure_at = NULL, attempt = v_attempt, install_head_sha = NULL, updated_at = now() WHERE account_id = acct AND id = j.setup_id;
    RETURN v_attempt;
  END;
  $f$;

  REVOKE ALL ON FUNCTION public.setup_push_grant(uuid, uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.setup_head_record(uuid, uuid, text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.machine_job_raced(uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.machine_job_reissue(uuid, uuid, jsonb, timestamptz, timestamptz) FROM PUBLIC;
  EXECUTE format('ALTER FUNCTION public.setup_push_grant(uuid, uuid) OWNER TO %I', owner_name);
  EXECUTE format('ALTER FUNCTION public.setup_head_record(uuid, uuid, text) OWNER TO %I', owner_name);
  EXECUTE format('ALTER FUNCTION public.machine_job_raced(uuid) OWNER TO %I', owner_name);
  EXECUTE format('ALTER FUNCTION public.machine_job_reissue(uuid, uuid, jsonb, timestamptz, timestamptz) OWNER TO %I', owner_name);
  GRANT EXECUTE ON FUNCTION public.setup_push_grant(uuid, uuid) TO app_user;
  GRANT EXECUTE ON FUNCTION public.setup_head_record(uuid, uuid, text) TO app_user;
  GRANT EXECUTE ON FUNCTION public.machine_job_raced(uuid) TO app_user;
  GRANT EXECUTE ON FUNCTION public.machine_job_reissue(uuid, uuid, jsonb, timestamptz, timestamptz) TO app_user;

  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', owner_name);
  IF NOT super THEN
    EXECUTE format('REVOKE %I FROM CURRENT_USER', owner_name);
  END IF;
END
$$;
