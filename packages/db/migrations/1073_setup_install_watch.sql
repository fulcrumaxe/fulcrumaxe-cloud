-- D#845 ON-8f2b: the watch on a setup's install pull request (Ruling 83, ON-8f). A `pull_request` closed delivery for the install pull request moves a MERGED one to phase `finish` and one closed UNMERGED to
-- state `failed` with the code `pr_closed` (phase `await_merge` stays: it is the pull request that failed, and ON-20's Retry is a person's).
--
--   1. setup_install_pr_closed(repo, pr, merged, head_ref): called by the webhook's tenant session (EXECUTE for app_user alone; the account is the session's own `app.account_id`). It is owned by
--      setup_install_definer (1072), so it reads and writes the columns below and nothing else. It acts on a delivery only when ALL of these hold: the repository is the session's own, the head branch is the
--      install branch of the setup's own job (a pull request of any other branch moves nothing), and either
--        (a) the setup is at phase `await_merge` with this pull request number recorded: merged -> phase `finish`; closed -> state `failed`, code `pr_closed`. Repeats change nothing more; or
--        (b) the pull request was closed or merged BETWEEN `markReady` and the install step's record of its number (FU-235): the setup is still at phase `install`, push ok, no number yet. The delivery cannot find
--            the setup by number, so it finds it by the job's own install branch and keeps the number and the outcome in two columns (`install_pr_closed_number`, `install_pr_closed_merged`).
--      It answers one of 'finished', 'failed', 'recorded' or 'none' (nothing matched; the caller carries on as for any other pull request).
--   2. setup_install_pr_record (1072) is replaced: when the number it is recording is the one a delivery already closed (the two columns above), it records the closed outcome (`finish`, or `failed` / `pr_closed`)
--      instead of `await_merge`. A number that is not the stored one (a pull request the step itself closed on a refusal) is recorded as before. Its signature, owner, grants and every other check are unchanged.
-- Numbered 1073 by the Team Lead. Re-check against main right before merging and renumber to stay above its highest.

ALTER TABLE project_setups
  ADD COLUMN install_pr_closed_number integer CONSTRAINT project_setups_install_pr_closed_number_check CHECK (install_pr_closed_number IS NULL OR install_pr_closed_number > 0),
  ADD COLUMN install_pr_closed_merged boolean,
  ADD CONSTRAINT project_setups_install_pr_closed_pair CHECK ((install_pr_closed_number IS NULL) = (install_pr_closed_merged IS NULL));

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'setup_install_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on setup_install_definer; cannot ALTER FUNCTION ... OWNER TO setup_install_definer';
    END IF;
    GRANT setup_install_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO setup_install_definer;

GRANT SELECT (install_pr_closed_number, install_pr_closed_merged, failure_code, failure_at) ON project_setups TO setup_install_definer;
GRANT UPDATE (install_pr_closed_number, install_pr_closed_merged) ON project_setups TO setup_install_definer;
-- The watch writes a setup that already left phase `install` (1072's update policy holds only `install`).
CREATE POLICY setup_install_definer_watch_update ON project_setups FOR UPDATE TO setup_install_definer USING (phase = 'await_merge') WITH CHECK (phase IN ('await_merge', 'finish'));

CREATE FUNCTION setup_install_pr_closed(p_repo uuid, p_pr integer, p_merged boolean, p_head_ref text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  s_id uuid;
BEGIN
  IF acct IS NULL OR p_repo IS NULL OR p_pr IS NULL OR p_pr < 1 OR p_merged IS NULL OR p_head_ref IS NULL OR p_head_ref !~ '^fx/engine-install-[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$' THEN
    RETURN 'none';
  END IF;
  -- (a) the pull request the step recorded
  SELECT x.id INTO s_id FROM public.project_setups x
   WHERE x.account_id = acct AND x.repo_id = p_repo AND x.phase = 'await_merge' AND x.install_pr = p_pr
     AND EXISTS (SELECT 1 FROM public.machine_jobs j WHERE j.account_id = acct AND j.setup_id = x.id AND j.attempt = x.attempt AND j.kind = 'project_setup' AND j.job #>> '{job,args,branch}' = p_head_ref)
   FOR UPDATE;
  IF FOUND THEN
    IF p_merged THEN
      UPDATE public.project_setups x SET phase = 'finish', sub_step = 'pr_merged', state = 'ok', failure_code = NULL, failure_reason = NULL, failure_at = NULL, updated_at = now() WHERE x.account_id = acct AND x.id = s_id;
      RETURN 'finished';
    END IF;
    UPDATE public.project_setups x SET state = 'failed', failure_code = 'pr_closed', failure_reason = NULL, failure_at = COALESCE(x.failure_at, now()), updated_at = now()
     WHERE x.account_id = acct AND x.id = s_id AND (x.state <> 'failed' OR x.failure_code IS DISTINCT FROM 'pr_closed');
    RETURN 'failed';
  END IF;
  -- (b) closed or merged before the step recorded the number
  SELECT x.id INTO s_id FROM public.project_setups x
   WHERE x.account_id = acct AND x.repo_id = p_repo AND x.phase = 'install' AND x.sub_step = 'push' AND x.state = 'ok' AND x.install_head_sha IS NOT NULL AND x.install_pr IS NULL
     AND EXISTS (SELECT 1 FROM public.machine_jobs j WHERE j.account_id = acct AND j.setup_id = x.id AND j.attempt = x.attempt AND j.kind = 'project_setup' AND j.state = 'delivered' AND j.job #>> '{job,args,branch}' = p_head_ref)
   FOR UPDATE;
  IF FOUND THEN
    UPDATE public.project_setups x SET install_pr_closed_number = p_pr, install_pr_closed_merged = p_merged WHERE x.account_id = acct AND x.id = s_id;
    RETURN 'recorded';
  END IF;
  RETURN 'none';
END;
$$;

-- 1072's record, with the closed outcome of the number it records honoured (see the head of this file). Everything else is as it was.
CREATE OR REPLACE FUNCTION setup_install_pr_record(p_setup uuid, p_attempt integer, p_head text, p_pr integer)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  s_account uuid; j_id uuid; j_job jsonb;
  v_direct boolean; c_num integer; c_merged boolean;
BEGIN
  IF session_user <> 'platform_ops' THEN
    RAISE EXCEPTION 'setup_install_pr_record: platform_ops only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_setup IS NULL OR p_attempt IS NULL OR p_head IS NULL OR p_head !~ '^[0-9a-f]{40}$' OR (p_pr IS NOT NULL AND p_pr < 1) THEN
    RAISE EXCEPTION 'setup_install_pr_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT x.account_id, x.install_pr_closed_number, x.install_pr_closed_merged INTO s_account, c_num, c_merged FROM public.project_setups x WHERE x.id = p_setup AND x.phase = 'install' AND x.sub_step = 'push' AND x.state = 'ok' AND x.attempt = p_attempt AND x.install_head_sha = p_head AND x.install_pr IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT x.id, x.job INTO j_id, j_job FROM public.machine_jobs x WHERE x.account_id = s_account AND x.setup_id = p_setup AND x.attempt = p_attempt AND x.kind = 'project_setup' AND x.state = 'delivered' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  v_direct := j_job #>> '{job,args,mode}' = 'direct';
  -- a pull request number goes with a pull request job and none with a direct one
  IF (p_pr IS NULL) IS DISTINCT FROM v_direct THEN RETURN false; END IF;
  UPDATE public.machine_jobs x SET state = 'done' WHERE x.account_id = s_account AND x.id = j_id;
  IF v_direct THEN
    UPDATE public.project_setups x SET phase = 'finish', failure_code = NULL, failure_reason = NULL, failure_at = NULL, updated_at = now() WHERE x.account_id = s_account AND x.id = p_setup;
  ELSIF c_num IS NOT NULL AND c_num = p_pr AND c_merged THEN
    UPDATE public.project_setups x SET phase = 'finish', sub_step = 'pr_merged', state = 'ok', install_pr = p_pr, failure_code = NULL, failure_reason = NULL, failure_at = NULL, updated_at = now() WHERE x.account_id = s_account AND x.id = p_setup;
  ELSIF c_num IS NOT NULL AND c_num = p_pr THEN
    UPDATE public.project_setups x SET phase = 'await_merge', sub_step = 'pr_open', state = 'failed', install_pr = p_pr, failure_code = 'pr_closed', failure_reason = NULL, failure_at = now(), updated_at = now() WHERE x.account_id = s_account AND x.id = p_setup;
  ELSE
    UPDATE public.project_setups x SET phase = 'await_merge', sub_step = 'pr_open', state = 'ok', install_pr = p_pr, failure_code = NULL, failure_reason = NULL, failure_at = NULL, updated_at = now() WHERE x.account_id = s_account AND x.id = p_setup;
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION setup_install_pr_closed(uuid, integer, boolean, text) FROM PUBLIC;
ALTER FUNCTION setup_install_pr_closed(uuid, integer, boolean, text) OWNER TO setup_install_definer;
GRANT EXECUTE ON FUNCTION setup_install_pr_closed(uuid, integer, boolean, text) TO app_user;
REVOKE CREATE ON SCHEMA public FROM setup_install_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE setup_install_definer FROM CURRENT_USER;
  END IF;
END
$$;
