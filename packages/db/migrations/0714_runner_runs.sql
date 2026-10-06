-- D#6 R3a: the schema for runs that a local runner claims. 0711 added the columns (runtime 'runner', runner_id, the
-- lease fields, initiated_by, approved_by, job_signed) and left every write path closed on purpose. This file opens
-- the three that the target seam needs, each as narrow as it can be, and one guard.
--
-- Numbered above the highest migration on main (0712). Open PR #506 holds 0713, so this file merges after it. Re-check
-- against main right before merging (C7 section 4).
--
-- 1. agent_runs_execution_mode_check (0605) allows 'runner_local'. The resolver in packages/runner still fails closed
--    for a mode with no registered target, so a repo on 'runner_local' needs a registered RunnerTarget to route.
--
-- 2. agent_runs_runner_local_runtime_check, one way: a run whose execution_mode is 'runner_local' has runtime 'runner'.
--    The reverse is not constrained (a 'runner' run with no persisted mode stays legal). A runner run can therefore not
--    be stamped 'production', which is the value the merge gate counts as a sandbox verdict.
--
-- 3. agent_run_create gains p_initiated_by, the member who started the run. It is written here and nowhere else. The
--    function refuses a user who is not a member of the account, and a trigger refuses any later change to the column
--    (A8: initiated_by is written only through the definer, on insert). The argument defaults to NULL, so every
--    existing caller keeps working. The old 13-argument function is dropped so there is one create path.
--
-- 4. agent_run_set_runner_job(account, run, job) records the signed job in job_signed. It writes once: only to a
--    'pending' run that is 'runner_local' with runtime 'runner', and never over a job already there. It answers
--    true when it wrote and false when the run was not in that state. SECURITY DEFINER, search_path pinned, EXECUTE for
--    agent_run_writer only (the login the worker holds, C9 section 1). The "no job yet" rule is held by the trigger in
--    5 rather than by a read in the function, because platform_ops may not read job_signed: the signed job carries the
--    task text and platform_ops is the login of the GitHub proxy.
--
-- 5. agent_runs_runner_columns_guard: initiated_by never changes after insert, and job_signed never changes once set.
--    It applies to every role, so the rule holds for a table owner as well as for the definers. In the 0689/0706 shape it
--    also refuses a direct platform_ops session: platform_ops is the web tier's live login and passes the row policy of
--    any tenant it sets a context for, so the column grants below must not be a way around the definers. Inside a
--    definer session_user is the runner's login, so the runner path is unaffected. agent_runs_runner_insert_guard does
--    the same for a direct INSERT naming initiated_by, and both definers refuse a platform_ops login outright (as 0704
--    does for agent_run_list_running).
--
-- platform_ops gains SELECT on runtime and execution_mode (the function's WHERE clause reads them, neither is a
-- secret), INSERT on initiated_by and UPDATE on job_signed. Nothing else changes for it; it still cannot read
-- job_signed, envelope or the token columns.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

GRANT CREATE ON SCHEMA public TO platform_ops;

ALTER TABLE agent_runs DROP CONSTRAINT agent_runs_execution_mode_check;
ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_execution_mode_check
  CHECK (execution_mode IS NULL OR execution_mode IN ('sandbox', 'runner_local'));

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_runner_local_runtime_check
  CHECK (execution_mode IS DISTINCT FROM 'runner_local' OR runtime = 'runner');

GRANT SELECT (runtime, execution_mode) ON agent_runs TO platform_ops;
GRANT INSERT (initiated_by) ON agent_runs TO platform_ops;
GRANT UPDATE (job_signed) ON agent_runs TO platform_ops;

CREATE FUNCTION agent_runs_runner_columns_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF session_user = 'platform_ops' AND NEW.job_signed IS DISTINCT FROM OLD.job_signed THEN
    RAISE EXCEPTION 'agent_runs: platform_ops may not write job_signed; use agent_run_set_runner_job'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.initiated_by IS DISTINCT FROM OLD.initiated_by THEN
    RAISE EXCEPTION 'agent_runs.initiated_by is written at insert only (run %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.job_signed IS NOT NULL AND NEW.job_signed IS DISTINCT FROM OLD.job_signed THEN
    RAISE EXCEPTION 'agent_runs.job_signed is write-once (run %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_runs_runner_columns_guard
  BEFORE UPDATE ON agent_runs
  FOR EACH ROW
  EXECUTE FUNCTION agent_runs_runner_columns_guard();

CREATE FUNCTION agent_runs_runner_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF session_user = 'platform_ops' AND (NEW.initiated_by IS NOT NULL OR NEW.job_signed IS NOT NULL) THEN
    RAISE EXCEPTION 'agent_runs: platform_ops may not insert initiated_by or job_signed; use agent_run_create'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_runs_runner_insert_guard
  BEFORE INSERT ON agent_runs
  FOR EACH ROW
  EXECUTE FUNCTION agent_runs_runner_insert_guard();

DROP FUNCTION agent_run_create(uuid, uuid, uuid, uuid, text, text, text, text, uuid, bigint, uuid, jsonb, text);

CREATE FUNCTION agent_run_create(
  p_id                  uuid,
  p_account_id          uuid,
  p_work_item_id        uuid,
  p_parent_run_id       uuid,
  p_role                text,
  p_runtime             text,
  p_head_sha            text,
  p_execution_mode      text,
  p_dispatch_repo_id    uuid,
  p_dispatch_pr_number  bigint,
  p_spec_version_id     uuid,
  p_resolved_exposure   jsonb,
  p_exposure_digest     text,
  p_initiated_by        uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_id uuid := COALESCE(p_id, gen_random_uuid());
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'agent_run_create: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_account_id IS NULL
     OR p_account_id IS DISTINCT FROM NULLIF(current_setting('app.account_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'agent_run_create: account % is not the caller''s tenant context', p_account_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_resolved_exposure IS NULL OR jsonb_typeof(p_resolved_exposure) IS DISTINCT FROM 'object'
     OR p_exposure_digest IS NULL OR p_exposure_digest !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'agent_run_create: a run needs a resolved exposure and its digest'
      USING ERRCODE = 'not_null_violation';
  END IF;

  -- Defence in depth: the exposure was resolved for one account and may only
  -- land on that account's row. The runner builds both from one id; this
  -- refuses a caller that does not.
  IF p_resolved_exposure->>'accountId' IS DISTINCT FROM p_account_id::text THEN
    RAISE EXCEPTION 'agent_run_create: the resolved exposure belongs to a different account'
      USING ERRCODE = 'check_violation';
  END IF;

  -- The person behind a run must be a member of the account the run belongs to.
  IF p_initiated_by IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.account_members m
        WHERE m.account_id = p_account_id AND m.user_id = p_initiated_by
     )
  THEN
    RAISE EXCEPTION 'agent_run_create: the user who started the run is not a member of the account'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO public.agent_runs
    (id, account_id, work_item_id, parent_run_id, role, runtime, status, head_sha,
     execution_mode, dispatch_repo_id, dispatch_pr_number, spec_version_id,
     resolved_exposure, exposure_digest, initiated_by)
  VALUES
    (v_id, p_account_id, p_work_item_id, p_parent_run_id, p_role, p_runtime, 'pending',
     p_head_sha, p_execution_mode, p_dispatch_repo_id, p_dispatch_pr_number, p_spec_version_id,
     p_resolved_exposure, p_exposure_digest, p_initiated_by);
  RETURN v_id;
END;
$$;

CREATE FUNCTION agent_run_set_runner_job(
  p_account_id  uuid,
  p_run_id      uuid,
  p_job         jsonb
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_rows integer;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'agent_run_set_runner_job: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_account_id IS NULL
     OR p_account_id IS DISTINCT FROM NULLIF(current_setting('app.account_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'agent_run_set_runner_job: account % is not the caller''s tenant context', p_account_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_job IS NULL OR jsonb_typeof(p_job) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'agent_run_set_runner_job: the job must be a JSON object'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Only a pending runner run takes a job. A second write is refused by agent_runs_runner_columns_guard, which this
  -- function turns into "nothing written".
  BEGIN
    UPDATE public.agent_runs
       SET job_signed = p_job, updated_at = now()
     WHERE account_id = p_account_id AND id = p_run_id
       AND status = 'pending' AND runtime = 'runner' AND execution_mode = 'runner_local';
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXCEPTION WHEN check_violation THEN
    RETURN false;
  END;
  RETURN v_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION agent_run_create(uuid, uuid, uuid, uuid, text, text, text, text, uuid, bigint, uuid, jsonb, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION agent_run_set_runner_job(uuid, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION agent_runs_runner_columns_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION agent_runs_runner_insert_guard() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_run_create(uuid, uuid, uuid, uuid, text, text, text, text, uuid, bigint, uuid, jsonb, text, uuid) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION agent_run_set_runner_job(uuid, uuid, jsonb) TO agent_run_writer;

ALTER FUNCTION agent_run_create(uuid, uuid, uuid, uuid, text, text, text, text, uuid, bigint, uuid, jsonb, text, uuid) OWNER TO platform_ops;
ALTER FUNCTION agent_run_set_runner_job(uuid, uuid, jsonb) OWNER TO platform_ops;
REVOKE CREATE ON SCHEMA public FROM platform_ops;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
