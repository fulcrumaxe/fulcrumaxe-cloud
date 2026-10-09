-- D#6 R5b-1 (correction C38 section 1): the mode exists. A repository may now hold execution_mode = 'runner_verified'.
--
-- 1. repos_execution_mode_check also allows 'runner_verified'. agent_runs already allows it (0765), with its one-way runtime check. The HTTP
--    route that sets a repository's mode still refuses the value (R5b-2b opens it), so no row holds it in production after this file; the
--    pg tests set it directly.
--
-- 2. Every database filter that means "a run on the customer's runner" is widened from 'runner_local' to both runner modes, with the
--    body each function already had and only that predicate changed. They are CREATE OR REPLACE, so each keeps its owner and its
--    EXECUTE grants (the migrator takes the owning role for the statement and gives it up again, as 0762 does):
--      * agent_run_set_runner_job (0714)               the job is written to a pending runner run of either mode
--      * agent_run_list_pending_runner_runs (0734)     the sweeper's queue lister
--      * agent_run_list_jobless_runner_runs (0754)     the sweeper's no-job lister
--      * agent_run_list_runner_runs_owing_notice (0757), and the row policy of its role
--      * repo_cancel_pending_runner_runs (0759), its role's update policy, and repo_execution_mode_switch_audit (0759)
--    The claim itself is not a database filter (it reads runs in TypeScript), and agent_run_runner_claim never tested the mode.
--
-- 3. The mode switch (0759) cancels queued runner runs when the repository leaves the runner modes, and only then. Moving between
--    'runner_local' and 'runner_verified' cancels nothing: repo_cancel_pending_runner_runs refuses a repository that is still on either
--    runner mode (55000), and the audit function refuses a cancel count for a move that stays on a runner.
--
-- NOT widened here, on purpose: the run-approval definers (0757, 0767) and the local-review opt-in (0733) keep 'runner_local' (the
-- approval of another member's run in a verified repository belongs to the opt-in change, R5b-2b).
--
-- Numbered above the highest migration on the code plane (0770). Re-check against main right before merging.

ALTER TABLE repos DROP CONSTRAINT repos_execution_mode_check;
ALTER TABLE repos ADD CONSTRAINT repos_execution_mode_check CHECK (execution_mode IN ('sandbox', 'runner_local', 'runner_verified'));

-- ---- the migrator takes the owning roles for the replacements ------------------------------------------------------
DO $$
DECLARE
  n text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH n IN ARRAY ARRAY['runner_notice_lister', 'runner_mode_switch_definer', 'runner_lease_definer'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_auth_members m
        WHERE m.roleid = n::regrole AND m.member = current_user::regrole AND m.admin_option
      ) THEN
        RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot replace its functions', n;
      END IF;
      EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', n);
    END LOOP;
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

-- ---- the job write (platform_ops), the queue lister (platform_ops) and the no-job lister (runner_lease_definer) --------
CREATE OR REPLACE FUNCTION agent_run_set_runner_job(
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
       AND status = 'pending' AND runtime = 'runner' AND execution_mode IN ('runner_local', 'runner_verified');
    GET DIAGNOSTICS v_rows = ROW_COUNT;
  EXCEPTION WHEN check_violation THEN
    RETURN false;
  END;
  RETURN v_rows = 1;
END;
$$;

CREATE OR REPLACE FUNCTION agent_run_list_pending_runner_runs(p_limit int)
RETURNS TABLE (account_id uuid, run_id uuid, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'agent_run_list_pending_runner_runs: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'agent_run_list_pending_runner_runs: bad limit' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT a.account_id, a.id, a.created_at
    FROM public.agent_runs a
   WHERE a.status = 'pending' AND a.runtime = 'runner' AND a.execution_mode IN ('runner_local', 'runner_verified')
   ORDER BY a.created_at, a.id
   LIMIT p_limit;
END $$;

CREATE OR REPLACE FUNCTION agent_run_list_jobless_runner_runs(p_limit int)
RETURNS TABLE (account_id uuid, run_id uuid, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'agent_run_list_jobless_runner_runs: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'agent_run_list_jobless_runner_runs: bad limit' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT a.account_id, a.id, a.created_at
    FROM public.agent_runs a
   WHERE a.status = 'pending' AND a.runtime = 'runner' AND a.execution_mode IN ('runner_local', 'runner_verified') AND a.job_signed IS NULL
   ORDER BY a.created_at, a.id
   LIMIT p_limit;
END $$;

-- ---- runner_notice_lister: the policy and the function --------------------------------------------------------------
ALTER POLICY runner_notice_lister_select ON agent_runs
  USING (status = 'pending' AND runtime = 'runner' AND execution_mode IN ('runner_local', 'runner_verified'));

CREATE OR REPLACE FUNCTION agent_run_list_runner_runs_owing_notice(p_limit int, p_waiting_after_ms bigint, p_reminder_after_ms bigint)
RETURNS TABLE (account_id uuid, run_id uuid, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'agent_run_list_runner_runs_owing_notice: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50
     OR p_waiting_after_ms IS NULL OR p_waiting_after_ms NOT BETWEEN 1000 AND 2592000000
     OR p_reminder_after_ms IS NULL OR p_reminder_after_ms NOT BETWEEN 1000 AND 2592000000 THEN
    RAISE EXCEPTION 'agent_run_list_runner_runs_owing_notice: bad argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT a.account_id, a.id, a.created_at
    FROM public.agent_runs a
   CROSS JOIN LATERAL (
     SELECT NOT EXISTS (SELECT 1 FROM public.run_events e WHERE e.account_id = a.account_id AND e.run_id = a.id AND e.kind = 'runner.waiting') AS owes_waiting,
            NOT EXISTS (SELECT 1 FROM public.run_events e WHERE e.account_id = a.account_id AND e.run_id = a.id AND e.kind = 'runner.ttl_reminder') AS owes_reminder
   ) n
   WHERE a.status = 'pending' AND a.runtime = 'runner' AND a.execution_mode IN ('runner_local', 'runner_verified') AND (n.owes_waiting OR n.owes_reminder)
   ORDER BY LEAST(CASE WHEN n.owes_waiting THEN a.created_at + make_interval(secs => p_waiting_after_ms / 1000.0) END,
                  CASE WHEN n.owes_reminder THEN a.created_at + make_interval(secs => p_reminder_after_ms / 1000.0) END),
            a.created_at, a.id
   LIMIT p_limit;
END $$;

-- ---- runner_mode_switch_definer: cancel on leaving the runner modes -------------------------------------------------
ALTER POLICY runner_mode_switch_definer_update ON agent_runs
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND status = 'pending' AND runtime = 'runner' AND execution_mode IN ('runner_local', 'runner_verified')
  )
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

CREATE OR REPLACE FUNCTION repo_cancel_pending_runner_runs(p_repo_id uuid)
RETURNS TABLE (run_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr    uuid;
  v_role text;
  v_mode text;
  r      record;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'repo_cancel_pending_runner_runs: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'repo_cancel_pending_runner_runs: caller is not an owner or admin of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_repo_id IS NULL THEN
    RAISE EXCEPTION 'repo_cancel_pending_runner_runs: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT g.execution_mode INTO v_mode FROM public.repos g WHERE g.id = p_repo_id AND g.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'repo_cancel_pending_runner_runs: no such repo' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_mode IN ('runner_local', 'runner_verified') THEN
    RAISE EXCEPTION 'repo_cancel_pending_runner_runs: the repo is still on a runner' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  -- Lock first (the lock applies this role's UPDATE policy, which shows pending runner runs only), then move each through the
  -- compare-and-set writer. A run that stopped being pending between the two is not counted.
  FOR r IN
    SELECT a.id FROM public.agent_runs a
     WHERE a.account_id = acct AND a.dispatch_repo_id = p_repo_id AND a.runtime = 'runner' AND a.execution_mode IN ('runner_local', 'runner_verified') AND a.status = 'pending'
     ORDER BY a.id
       FOR UPDATE
  LOOP
    IF public.agent_run_set_status(acct, r.id, 'pending', 'cancelled', NULL, NULL, NULL, NULL, NULL, NULL) THEN
      run_id := r.id;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION repo_execution_mode_switch_audit(p_repo_id uuid, p_from text, p_to text, p_auto_merge_turned_off boolean, p_cancelled_runs integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr  uuid;
  v_role text;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'repo_execution_mode_switch_audit: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'repo_execution_mode_switch_audit: caller is not an owner or admin of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_repo_id IS NULL OR p_auto_merge_turned_off IS NULL OR p_cancelled_runs IS NULL OR p_cancelled_runs < 0
     OR p_from IS NULL OR p_from NOT IN ('sandbox', 'runner_local', 'runner_verified')
     OR p_to IS NULL OR p_to NOT IN ('sandbox', 'runner_local', 'runner_verified') OR p_from = p_to
     -- Runs are cancelled only by a move that leaves the runner modes.
     OR (p_cancelled_runs > 0 AND (p_from = 'sandbox' OR p_to <> 'sandbox')) THEN
    RAISE EXCEPTION 'repo_execution_mode_switch_audit: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM 1 FROM public.repos r WHERE r.id = p_repo_id AND r.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'repo_execution_mode_switch_audit: no such repo' USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, 'repo.execution_mode.changed',
          jsonb_build_object('repo_id', p_repo_id, 'from', p_from, 'to', p_to, 'auto_merge_turned_off', p_auto_merge_turned_off, 'cancelled_runs', p_cancelled_runs),
          clock_timestamp());
END;
$$;

-- ---- the migrator gives the roles up again --------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_notice_lister FROM CURRENT_USER;
    REVOKE runner_mode_switch_definer FROM CURRENT_USER;
    REVOKE runner_lease_definer FROM CURRENT_USER;
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
