-- D#7 DW-R7 follow-up: a "No" to the member-plan ask stands.
--
-- A person who answers a `runner_run_on_member_plan` ask with anything but "approve" leaves the run pending and unapproved, and nothing recorded that the answer was a
-- refusal: a later change of the repo's dial to announce or act let the claim approve the run (0767) for the runner's registrant after all. A refusal must not be undone by
-- a dial. This file makes the refusal a fact the claim reads, derived from the ask itself (answered, with an option other than "approve"), never stamped:
--
--   runner_plan_declined(run)   true when the run's member-plan ask (runner_plan_asks) was answered with anything but "approve". Reads only; platform_ops is refused. It is the
--                               one test the claim's auto-approval, the claim's candidate list and the Runs read model share, so they cannot disagree. Owner: runner_plan_ask_definer
--                               (0982), which already holds the row policies on both tables; it gains column SELECT on decision_asks (state, answered_option) and runner_plan_asks (ask_id).
--   agent_run_runner_auto_approve   the 0774 body, plus one line: a declined run is not approved by the claim (false, so the run stays pending). Owner and grants unchanged.
--
-- What a person can still do after a No: Approve on the Runs card (agent_run_approve, 0757), a deliberate click by the plan holder; nothing automatic ever starts the run.
-- EXECUTE on the new function: app_user (the read model, the Needs you list's session), agent_run_writer (the claim) and runner_auto_approve_definer (the replaced function
-- calls it). Nothing is granted to platform_ops. Expand-only; no table, role or column is added. Numbered above 0986, the highest on main; re-checked right before opening.

GRANT SELECT (id, account_id, run_id, decision_type, state, answered_option) ON decision_asks TO runner_plan_ask_definer;
GRANT SELECT (account_id, run_id, ask_id) ON runner_plan_asks TO runner_plan_ask_definer;

-- ---- the migrator takes the owning roles for the statements below (0765's bracket) --------------------------------------------
DO $$
DECLARE
  n text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH n IN ARRAY ARRAY['runner_plan_ask_definer', 'runner_auto_approve_definer'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_auth_members m
        WHERE m.roleid = n::regrole AND m.member = current_user::regrole AND m.admin_option
      ) THEN
        RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot own or replace its functions', n;
      END IF;
      EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', n);
    END LOOP;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO runner_plan_ask_definer;

CREATE FUNCTION runner_plan_declined(p_run_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_plan_declined: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR p_run_id IS NULL OR NOT account_is_active(acct) THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.runner_plan_asks p
      JOIN public.decision_asks k ON k.account_id = p.account_id AND k.id = p.ask_id
     WHERE p.account_id = acct AND p.run_id = p_run_id AND k.state = 'answered' AND k.answered_option IS DISTINCT FROM 'approve');
END;
$$;

REVOKE ALL ON FUNCTION runner_plan_declined(uuid) FROM PUBLIC;
ALTER FUNCTION runner_plan_declined(uuid) OWNER TO runner_plan_ask_definer;
GRANT EXECUTE ON FUNCTION runner_plan_declined(uuid) TO app_user, agent_run_writer, runner_auto_approve_definer;
REVOKE CREATE ON SCHEMA public FROM runner_plan_ask_definer;

-- ---- agent_run_runner_auto_approve (0774) plus the refusal check --------------------------------------------------------------
CREATE OR REPLACE FUNCTION agent_run_runner_auto_approve(p_run_id uuid, p_runner_id uuid, p_now timestamptz, p_catalogue_version integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct          uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_repo        uuid;
  v_item        uuid;
  v_status      text;
  v_runtime     text;
  v_mode        text;
  v_approved    uuid;
  v_runner      uuid;
  v_after       timestamptz;
  v_by          uuid;
  v_consent     integer;
  v_dial        integer;
  v_disposition text;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'agent_run_runner_auto_approve: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'agent_run_runner_auto_approve: no active account in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_run_id IS NULL OR p_runner_id IS NULL OR p_now IS NULL OR p_catalogue_version IS NULL OR p_catalogue_version < 1 THEN
    RAISE EXCEPTION 'agent_run_runner_auto_approve: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Condition 5: lock the run, then look at it. The lock is held to the end of the claim's transaction.
  SELECT a.dispatch_repo_id, a.work_item_id, a.status, a.runtime, a.execution_mode, a.approved_by, a.runner_id, a.claimable_after
    INTO v_repo, v_item, v_status, v_runtime, v_mode, v_approved, v_runner, v_after
    FROM public.agent_runs a WHERE a.account_id = acct AND a.id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_status <> 'pending' OR v_runtime <> 'runner' OR (v_mode IS NULL OR v_mode NOT IN ('runner_local', 'runner_verified')) OR v_approved IS NOT NULL
     OR v_runner IS NOT NULL OR v_repo IS NULL OR (v_after IS NOT NULL AND v_after > p_now) THEN
    RETURN false;
  END IF;
  -- A person's "No" to this run's ask stands: no dial and no consent starts it.
  IF runner_plan_declined(p_run_id) THEN RETURN false; END IF;
  -- Conditions 1 to 4, the same function the read model calls.
  IF NOT runner_plan_auto_approvable(p_runner_id, v_repo) THEN RETURN false; END IF;

  SELECT r.registered_by INTO v_by FROM public.runners r WHERE r.account_id = acct AND r.id = p_runner_id;
  SELECT c.version INTO v_consent FROM public.runner_plan_consents c WHERE c.account_id = acct AND c.runner_id = p_runner_id
   ORDER BY c.version DESC LIMIT 1;
  SELECT d.version, d.disposition INTO v_dial, v_disposition FROM public.decision_settings d
   WHERE d.account_id = acct AND d.repo_id = v_repo AND d.decision_type = 'runner_run_on_member_plan'
   ORDER BY d.version DESC LIMIT 1;
  v_disposition := COALESCE(v_disposition, 'announce');

  UPDATE public.agent_runs SET approved_by = v_by, updated_at = now() WHERE account_id = acct AND id = p_run_id;
  IF NOT FOUND THEN RETURN false; END IF;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, v_by::text, 'runner.run_auto_approved', jsonb_build_object(
    'run_id', p_run_id, 'runner_id', p_runner_id, 'consent_version', v_consent, 'dial_version', v_dial, 'disposition', v_disposition), clock_timestamp());
  -- One class 2 receipt, through the existing writer. No user is set in the claim, so the actor is 'policy'.
  PERFORM public.decision_receipt_write('human_over_the_loop', 'runner_run_on_member_plan', v_disposition, 'ask', v_dial,
                                        '[]'::jsonb, v_item, p_run_id, p_catalogue_version);
  RETURN true;
END;
$$;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_plan_ask_definer FROM CURRENT_USER;
    REVOKE runner_auto_approve_definer FROM CURRENT_USER;
  END IF;
END
$$;
