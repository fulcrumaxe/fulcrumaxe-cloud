-- D#845 ON-13a0: the session job contract, the cloud side of a session job's report and of the account's operate epoch.
--
--   1. machine_jobs gains the facts of a session job's report: last_step (the newest step reported, a session kind only), failure_code and failure_reason (why it failed or expired), start_mode (how a start came up: created,
--      resumed or fresh; only on a start that ended done) and ended_at. app_user reads these five and still reads nothing of `job` or `last_seq`.
--   2. machine_job_progress_record (new, owned by machine_jobs_owner): the fence and the write of one report of a SESSION job, keyed by the signed job id (a session job has no setup row, so setup_progress_record does not apply).
--      A failed report ends the job `failed`, and `done` reported ok ends it `done`; either one stamps ended_at and frees the runner's one job slot.
--   3. machine_job_expire is re-made (CREATE OR REPLACE, 1053's body carried forward) and now also stamps the job row's failure_code (job_expired, job_silent or job_overran) and ended_at, so a job that went quiet shows its reason.
--   4. engine_bridge_settings.operate_epoch: one counter per account. A BEFORE trigger owns it (an insert sets 1 when operate is on, else 0; an update adds 1 whenever operate_enabled changes, in either direction; any other
--      update keeps the old value), so no writer, app_user's table-wide UPDATE included, can set it or lower it. An AFTER trigger on a switch to off marks every issued, undelivered engine_session_start of the account superseded
--      in the same transaction.
--
-- Numbered 1066 by the Team Lead; it merges after 1059. Re-check against main right before merging and renumber to stay above its highest.

-- ---- 1. machine_jobs: the report's facts --------------------------------------------------------------------------------------------------------------
ALTER TABLE machine_jobs
  ADD COLUMN last_step text,
  ADD COLUMN failure_code text,
  ADD COLUMN failure_reason text,
  ADD COLUMN start_mode text,
  ADD COLUMN ended_at timestamptz;
ALTER TABLE machine_jobs
  ADD CONSTRAINT machine_jobs_last_step_check CHECK (last_step IS NULL OR (kind IN ('engine_session_start', 'engine_session_stop', 'engine_session_delete')
    AND last_step IN ('admission', 'session_create', 'seed', 'session_boot', 'credentials', 'supervisor', 'session_stop', 'snapshot', 'session_delete', 'done'))),
  ADD CONSTRAINT machine_jobs_failure_code_check CHECK (failure_code IS NULL OR (state IN ('failed', 'expired') AND failure_code IN (
    'machine_single_project', 'vm_memory_low', 'operate_stale', 'snapshot_failed', 'kind_unsupported', 'engine_unsupported',
    'vm_admission_refused', 'vm_boot_failed', 'vm_egress_unavailable', 'vm_token_delivery_failed', 'vm_workspace_failed', 'vm_teardown_incomplete',
    'job_expired', 'job_silent', 'job_overran'))),
  ADD CONSTRAINT machine_jobs_failure_reason_check CHECK (failure_reason IS NULL OR (failure_code IS NOT NULL AND failure_reason ~ '^[a-z][a-z0-9_]{0,31}$')),
  ADD CONSTRAINT machine_jobs_start_mode_check CHECK (start_mode IS NULL OR (kind = 'engine_session_start' AND state = 'done' AND last_step = 'done' AND start_mode IN ('created', 'resumed', 'fresh')));

GRANT SELECT (last_step, failure_code, failure_reason, start_mode, ended_at) ON machine_jobs TO app_user;

-- ---- 4a. engine_bridge_settings.operate_epoch (the column; its triggers follow below) -------------------------------------------------------------------
ALTER TABLE engine_bridge_settings ADD COLUMN operate_epoch integer NOT NULL DEFAULT 0 CONSTRAINT engine_bridge_settings_operate_epoch_check CHECK (operate_epoch >= 0);
-- An account that has operate on today starts at 1 (the first on-switch makes 1). The table forces row security, so the backfill lifts it for this statement, inside this migration's transaction, and puts it back.
ALTER TABLE engine_bridge_settings NO FORCE ROW LEVEL SECURITY;
UPDATE engine_bridge_settings SET operate_epoch = 1 WHERE operate_enabled;
ALTER TABLE engine_bridge_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE engine_bridge_settings ADD CONSTRAINT engine_bridge_settings_operate_epoch_on CHECK (operate_epoch >= 1 OR NOT operate_enabled);

-- ---- the functions: created by the migration role holding machine_jobs_owner for the replace and the hand-over (1057's shape) ------------------------------
DO $$
DECLARE
  super boolean := (SELECT rolsuper FROM pg_roles WHERE rolname = current_user);
BEGIN
  IF (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid = 'public.machine_job_expire(uuid)'::regprocedure) IS DISTINCT FROM 'machine_jobs_owner' THEN
    RAISE EXCEPTION 'machine_job_expire is not owned by machine_jobs_owner; this migration was written for 1053''s owner';
  END IF;
  IF NOT super THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'machine_jobs_owner'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on machine_jobs_owner; cannot replace machine_job_expire';
    END IF;
    GRANT machine_jobs_owner TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
  GRANT CREATE ON SCHEMA public TO machine_jobs_owner;

  -- ---- 3. machine_job_expire: 1053's rule, and the job row now says why it expired ------------------------------------------------------------------
  CREATE OR REPLACE FUNCTION public.machine_job_expire(p_runner uuid) RETURNS void
  LANGUAGE sql
  VOLATILE
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
    WITH ex AS (
      UPDATE public.machine_jobs
         SET state = 'expired', ended_at = now(),
             failure_code = CASE WHEN last_seq IS NULL THEN 'job_expired' WHEN delivered_at <= now() - interval '3 hours' THEN 'job_overran' ELSE 'job_silent' END
       WHERE account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND runner_id = p_runner AND state IN ('issued', 'delivered')
         AND ((last_seq IS NULL AND expires_at <= now()) OR (last_seq IS NOT NULL AND (delivered_at <= now() - interval '3 hours' OR last_progress_at <= now() - interval '10 minutes')))
      RETURNING setup_id, failure_code AS code
    )
    UPDATE public.project_setups s SET state = 'failed', failure_code = ex.code, failure_reason = NULL, failure_at = now(), updated_at = now()
      FROM ex WHERE s.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND s.id = ex.setup_id;
  $f$;

  -- ---- 2. machine_job_progress_record: one report of one session job ----------------------------------------------------------------------------------
  -- o_result: ok, not_found (no such job of this runner, so every foreign id; a job with a setup; a kind that is not a session kind), not_active (the job is not delivered: never taken, ended, expired or superseded)
  -- or seq (not above the last one). A step outside the kind's list, a start mode anywhere but a start's `done` ok (or missing there), and any argument the closed lists refuse raise invalid_parameter_value.
  CREATE FUNCTION public.machine_job_progress_record(p_job uuid, p_seq integer, p_step text, p_state text, p_code text, p_reason text, p_start_mode text)
  RETURNS TABLE (o_result text, o_repo_id uuid)
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    rid   uuid := public.machine_job_runner();
    acct  uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    j     public.machine_jobs%ROWTYPE;
    steps text[];
    v_done boolean;
  BEGIN
    IF p_job IS NULL OR p_seq IS NULL OR p_seq < 0 OR p_step IS NULL OR p_step <> ALL (ARRAY['admission', 'session_create', 'seed', 'session_boot', 'credentials', 'supervisor', 'session_stop', 'snapshot', 'session_delete', 'done'])
       OR p_state IS NULL OR p_state NOT IN ('started', 'ok', 'failed', 'skipped')
       OR (p_state = 'failed') <> (p_code IS NOT NULL)
       OR (p_code IS NOT NULL AND p_code <> ALL (ARRAY['machine_single_project', 'vm_memory_low', 'operate_stale', 'snapshot_failed', 'kind_unsupported', 'engine_unsupported',
            'vm_admission_refused', 'vm_boot_failed', 'vm_egress_unavailable', 'vm_token_delivery_failed', 'vm_workspace_failed', 'vm_teardown_incomplete']))
       OR (p_reason IS NOT NULL AND (p_code IS NULL OR p_reason !~ '^[a-z][a-z0-9_]{0,31}$'))
       OR (p_start_mode IS NOT NULL AND p_start_mode <> ALL (ARRAY['created', 'resumed', 'fresh'])) THEN
      RAISE EXCEPTION 'machine_job_progress_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    PERFORM public.machine_job_expire(rid);
    SELECT * INTO j FROM public.machine_jobs x
     WHERE x.id = p_job AND x.account_id = acct AND x.runner_id = rid AND x.setup_id IS NULL AND x.kind IN ('engine_session_start', 'engine_session_stop', 'engine_session_delete') FOR UPDATE;
    IF NOT FOUND THEN RETURN QUERY SELECT 'not_found', NULL::uuid; RETURN; END IF;
    IF j.state <> 'delivered' THEN RETURN QUERY SELECT 'not_active', NULL::uuid; RETURN; END IF;
    IF p_seq <= COALESCE(j.last_seq, -1) THEN RETURN QUERY SELECT 'seq', NULL::uuid; RETURN; END IF;
    steps := CASE j.kind
      WHEN 'engine_session_start' THEN ARRAY['admission', 'session_create', 'seed', 'session_boot', 'credentials', 'supervisor', 'done']
      WHEN 'engine_session_stop' THEN ARRAY['admission', 'session_stop', 'snapshot', 'done']
      ELSE ARRAY['admission', 'session_delete', 'done'] END;
    v_done := p_step = 'done' AND p_state = 'ok';
    IF p_step <> ALL (steps) OR (p_start_mode IS NOT NULL AND NOT (j.kind = 'engine_session_start' AND v_done)) OR (p_start_mode IS NULL AND j.kind = 'engine_session_start' AND v_done) THEN
      RAISE EXCEPTION 'machine_job_progress_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    UPDATE public.machine_jobs SET
        last_seq = p_seq, last_progress_at = now(), last_step = p_step,
        state = CASE WHEN p_state = 'failed' THEN 'failed' WHEN v_done THEN 'done' ELSE state END,
        failure_code = CASE WHEN p_state = 'failed' THEN p_code END,
        failure_reason = CASE WHEN p_state = 'failed' THEN p_reason END,
        start_mode = CASE WHEN v_done THEN p_start_mode END,
        ended_at = CASE WHEN p_state = 'failed' OR v_done THEN now() END
      WHERE id = j.id AND account_id = acct;
    RETURN QUERY SELECT 'ok'::text, j.repo_id;
  END;
  $f$;

  -- ---- 4b. the epoch's two triggers --------------------------------------------------------------------------------------------------------------------
  -- BEFORE INSERT OR UPDATE: the value belongs to this function alone. Plain invoker rights (it reads only the row in hand), and it stays owned by the migration role like every trigger function that is not a definer
  -- (test/trigger-function-ownership.pg.test.ts).
  CREATE FUNCTION public.engine_operate_epoch_set() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
  BEGIN
    IF TG_OP = 'INSERT' THEN
      NEW.operate_epoch := CASE WHEN NEW.operate_enabled THEN 1 ELSE 0 END;
    ELSE
      NEW.operate_epoch := OLD.operate_epoch + CASE WHEN NEW.operate_enabled IS DISTINCT FROM OLD.operate_enabled THEN 1 ELSE 0 END;
    END IF;
    RETURN NEW;
  END;
  $f$;

  -- AFTER UPDATE, on a switch to off: every issued, undelivered start of the account is superseded in the same transaction. The owner's policy on machine_jobs shows it only the session's own account, so the session's
  -- account is pointed at the row's account for this one statement (transaction-local) and put back; a delivered start is the runner's, and the epoch check there is what stops it.
  CREATE FUNCTION public.engine_operate_off_supersede() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    prev text := current_setting('app.account_id', true);
  BEGIN
    PERFORM set_config('app.account_id', NEW.account_id::text, true);
    UPDATE public.machine_jobs SET state = 'superseded', ended_at = now()
     WHERE account_id = NEW.account_id AND kind = 'engine_session_start' AND state = 'issued';
    PERFORM set_config('app.account_id', COALESCE(prev, ''), true);
    RETURN NULL;
  END;
  $f$;

  CREATE TRIGGER engine_bridge_settings_operate_epoch BEFORE INSERT OR UPDATE ON public.engine_bridge_settings
    FOR EACH ROW EXECUTE FUNCTION public.engine_operate_epoch_set();
  CREATE TRIGGER engine_bridge_settings_operate_off AFTER UPDATE ON public.engine_bridge_settings
    FOR EACH ROW WHEN (OLD.operate_enabled AND NOT NEW.operate_enabled) EXECUTE FUNCTION public.engine_operate_off_supersede();

  REVOKE ALL ON FUNCTION public.machine_job_progress_record(uuid, integer, text, text, text, text, text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.engine_operate_epoch_set() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.engine_operate_off_supersede() FROM PUBLIC;
  ALTER FUNCTION public.machine_job_progress_record(uuid, integer, text, text, text, text, text) OWNER TO machine_jobs_owner;
  ALTER FUNCTION public.engine_operate_off_supersede() OWNER TO machine_jobs_owner;
  -- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner). The trigger definer is granted to app_user alone like its siblings; called outside a trigger it only raises.
  GRANT EXECUTE ON FUNCTION public.machine_job_progress_record(uuid, integer, text, text, text, text, text) TO app_user;
  GRANT EXECUTE ON FUNCTION public.engine_operate_off_supersede() TO app_user;

  REVOKE CREATE ON SCHEMA public FROM machine_jobs_owner;
  IF NOT super THEN
    REVOKE machine_jobs_owner FROM CURRENT_USER;
  END IF;
END
$$;
