-- D#845 ON-8b: issuing `project_setup`, and the plan route.
--
--   1. machine_job_issue (1053) now needs a person: the session's app.user_id, an owner or admin of the session's active account (1037's check), on top of what it already refused (a runner session,
--      a platform_ops login, another account's runner). The body is 1053's with that one check added; CREATE OR REPLACE keeps its owner and its EXECUTE grants. Its owner reads account_members
--      through a read-only column grant and a policy for the session's own account, whichever role owns the function (it is named from pg_proc, so a later owner change in 1053 is followed).
--   2. machine_job_lapse(setup) (new, same owner, same person check): runs 1053's expiry rule (machine_job_expire) for the runner holding the setup's live job, so a retry sees `expired` or `failed` and never a job that is
--      still reporting. app_user cannot read the progress columns, so the rule runs inside the definer and the caller reads only the resulting state.
--   3. engine_releases.version must be MAJOR.MINOR.PATCH from now on (NOT VALID: rows already there are not rechecked), so a release the issuer would skip can no longer be published.
--   4. project_setups.plan_setup: the cloud facts of the plan file (repo owner and name, default branch, visibility, the approver's login) as they were when the job was issued, so the plan route
--      rebuilds exactly the bytes whose sha256 the job carries even if GitHub's answer changes later. A closed small object; app_user writes it with the rest of the row.
--
-- Numbered 1057 by the Team Lead; it merges after 1053. Re-check against main right before merging and renumber to stay above its highest.

ALTER TABLE engine_releases ADD CONSTRAINT engine_releases_version_semver CHECK (version ~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$') NOT VALID;

ALTER TABLE project_setups
  ADD COLUMN plan_setup jsonb CONSTRAINT project_setups_plan_setup_check CHECK (plan_setup IS NULL OR (jsonb_typeof(plan_setup) = 'object' AND octet_length(plan_setup::text) <= 1024));

DO $$
DECLARE
  owner_name text := (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid = 'public.machine_job_issue(uuid, uuid, uuid, uuid, text, jsonb, timestamptz, timestamptz)'::regprocedure);
  super boolean := (SELECT rolsuper FROM pg_roles WHERE rolname = current_user);
BEGIN
  IF owner_name IS DISTINCT FROM 'machine_jobs_owner' THEN
    RAISE EXCEPTION 'machine_job_issue is owned by %, not machine_jobs_owner; this migration was written for 1053''s owner', owner_name;
  END IF;
  IF NOT super THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = owner_name::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot replace machine_job_issue', owner_name;
    END IF;
    EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', owner_name);
  END IF;
  EXECUTE format('GRANT CREATE ON SCHEMA public TO %I', owner_name);
  EXECUTE format('GRANT SELECT (account_id, user_id, role) ON account_members TO %I', owner_name);
  EXECUTE format('CREATE POLICY machine_job_issue_members ON account_members FOR SELECT TO %I USING (account_id = NULLIF(current_setting(''app.account_id'', true), '''')::uuid)', owner_name);

  CREATE OR REPLACE FUNCTION public.machine_job_issue(p_id uuid, p_runner uuid, p_repo uuid, p_setup uuid, p_kind text, p_job jsonb, p_issued_at timestamptz, p_expires_at timestamptz)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
    v_attempt integer := 1;
  BEGIN
    IF session_user = 'platform_ops' OR acct IS NULL OR usr IS NULL OR NOT public.account_is_active(acct) OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin')) THEN
      RAISE EXCEPTION 'machine_job_issue: refused' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.runners r WHERE r.id = p_runner AND r.account_id = acct AND r.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'machine_job_issue: no such live runner' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_setup IS NOT NULL THEN
      UPDATE public.machine_jobs SET state = 'superseded' WHERE account_id = acct AND setup_id = p_setup AND state IN ('issued', 'delivered');
      SELECT COALESCE(max(attempt), 0) + 1 INTO v_attempt FROM public.machine_jobs WHERE account_id = acct AND setup_id = p_setup;
    END IF;
    INSERT INTO public.machine_jobs (id, account_id, runner_id, repo_id, setup_id, kind, job, attempt, issued_at, expires_at)
    VALUES (p_id, acct, p_runner, p_repo, p_setup, p_kind, p_job, v_attempt, p_issued_at, p_expires_at);
    RETURN v_attempt;
  END;
  $f$;

  -- The retry's first step: expire what is over, for the runner holding this setup's live job. A person only (an owner or admin of the active account), never a runner's session.
  CREATE FUNCTION public.machine_job_lapse(p_setup uuid) RETURNS void
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
    rid  uuid;
  BEGIN
    IF session_user = 'platform_ops' OR acct IS NULL OR usr IS NULL OR NOT public.account_is_active(acct) OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin')) THEN
      RAISE EXCEPTION 'machine_job_lapse: refused' USING ERRCODE = 'insufficient_privilege';
    END IF;
    FOR rid IN SELECT DISTINCT j.runner_id FROM public.machine_jobs j WHERE j.account_id = acct AND j.setup_id = p_setup AND j.state IN ('issued', 'delivered') LOOP
      PERFORM public.machine_job_expire(rid);
    END LOOP;
  END;
  $f$;
  REVOKE ALL ON FUNCTION public.machine_job_lapse(uuid) FROM PUBLIC;
  EXECUTE format('ALTER FUNCTION public.machine_job_lapse(uuid) OWNER TO %I', owner_name);
  GRANT EXECUTE ON FUNCTION public.machine_job_lapse(uuid) TO app_user;

  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', owner_name);
  IF NOT super THEN
    EXECUTE format('REVOKE %I FROM CURRENT_USER', owner_name);
  END IF;
END
$$;
