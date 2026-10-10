-- D#6 R5b-2b-ii (correction C38 section 1, TL ruling C40): the run-approval definers learn the second runner mode.
--
-- 0771 widened every database filter that means "a run on the customer's runner" except the two approval paths (0757, 0767), on
-- purpose: another member's run in a cloud-verified repository is approved by the same people and the same rules as in a runner_local
-- one, and that belongs to the change that opens the mode (this one: the opt-in route is the same PR). Until now such a run failed
-- closed: agent_run_approve answered "cannot be approved" and the auto-approve returned false, so it never ran.
--
-- What changes, and nothing else:
--   * POLICY runner_approval_definer_update ON agent_runs (0757)     execution_mode = 'runner_local'  ->  IN ('runner_local', 'runner_verified')
--   * POLICY runner_auto_approve_definer_update ON agent_runs (0767) the same one predicate
--   * FUNCTION agent_run_approve(uuid) (0757)                        v_mode IS DISTINCT FROM 'runner_local'
--                                                                    ->  (v_mode IS NULL OR v_mode NOT IN ('runner_local', 'runner_verified'))
--                                                                    and one comment that named runner_local now says "runner (either runner mode)"
--   * FUNCTION agent_run_runner_auto_approve(uuid, uuid, timestamptz, integer) (0767)   the same mode predicate
-- Both policies keep the rest of their USING clause (tenant, pending, runtime 'runner', and for the auto-approve one unapproved and
-- unclaimed, plus the active-account check) and their WITH CHECK, exactly as written. Both functions are CREATE OR REPLACE with
-- the body of 0757 / 0767 copied unchanged apart from the lines above, so each keeps its SECURITY DEFINER, its pinned search_path, its
-- owner and its EXECUTE grants (the migrator takes the owning role for the statement and gives it up again, as 0771 does). Nothing
-- is granted, revoked or re-owned here. A sandbox run, a production run and a run with no mode stay unapprovable (the predicate
-- still names exactly the two runner modes); no new role, column or table.
--
-- NOT changed, on purpose: the local-review opt-in (0733) stays runner_local-only (a cloud-verified repo is reviewed in our sandbox).
--
-- Numbered above the highest migration on the code plane (0773). Re-check against main right before merging.

-- ---- the migrator takes the owning roles for the replacements --------------------------------------------------------
DO $$
DECLARE
  n text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH n IN ARRAY ARRAY['runner_approval_definer', 'runner_auto_approve_definer'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_auth_members m
        WHERE m.roleid = n::regrole AND m.member = current_user::regrole AND m.admin_option
      ) THEN
        RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot replace its functions', n;
      END IF;
      EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', n);
    END LOOP;
  END IF;
END
$$;

-- ---- the policies ---------------------------------------------------------------------------------------------------------
ALTER POLICY runner_approval_definer_update ON agent_runs
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND status = 'pending' AND runtime = 'runner' AND execution_mode IN ('runner_local', 'runner_verified')
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

ALTER POLICY runner_auto_approve_definer_update ON agent_runs
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND status = 'pending' AND runtime = 'runner' AND execution_mode IN ('runner_local', 'runner_verified') AND approved_by IS NULL AND runner_id IS NULL
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- ---- agent_run_approve (0757) -------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION agent_run_approve(p_run_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct    uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr     uuid;
  v_role  text;
  v_status text;
  v_runtime text;
  v_mode text;
  v_approved uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'agent_run_approve: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The caller's own membership row (the policy shows this role no other), read the way current_member_user_id() reads it.
  SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR v_role IS NULL THEN
    RAISE EXCEPTION 'agent_run_approve: caller is not a member of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'agent_run_approve: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Only the registrant of a live subscription runner has a plan this approval would spend.
  PERFORM 1 FROM public.runners r
   WHERE r.account_id = acct AND r.registered_by = usr AND r.credential_mode = 'subscription' AND r.revoked_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent_run_approve: caller registered no live subscription runner' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Read without a lock first: the row lock below applies this role's UPDATE policy, which shows only a pending runner
  -- run (either runner mode), so a run of any other kind must be answered from this read (55000, "cannot be approved") and not as "no such run".
  SELECT a.status, a.runtime, a.execution_mode, a.approved_by INTO v_status, v_runtime, v_mode, v_approved
    FROM public.agent_runs a WHERE a.account_id = acct AND a.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent_run_approve: no such run' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_status <> 'pending' OR v_runtime <> 'runner' OR (v_mode IS NULL OR v_mode NOT IN ('runner_local', 'runner_verified'))
     OR (v_approved IS NOT NULL AND v_approved <> usr) THEN
    RAISE EXCEPTION 'agent_run_approve: the run cannot be approved' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- Then lock it and look again: a run that moved on between the two reads is no longer visible to the lock.
  SELECT a.approved_by INTO v_approved FROM public.agent_runs a WHERE a.account_id = acct AND a.id = p_run_id FOR UPDATE;
  IF NOT FOUND OR (v_approved IS NOT NULL AND v_approved <> usr) THEN
    RAISE EXCEPTION 'agent_run_approve: the run cannot be approved' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF v_approved = usr THEN
    RETURN false;
  END IF;
  UPDATE public.agent_runs SET approved_by = usr, updated_at = now() WHERE account_id = acct AND id = p_run_id;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, 'runner.run_approved', jsonb_build_object('run_id', p_run_id), clock_timestamp());
  RETURN true;
END;
$$;

-- ---- agent_run_runner_auto_approve (0767) -------------------------------------------------------------------------------
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

-- ---- the migrator gives the roles up again --------------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_approval_definer FROM CURRENT_USER;
    REVOKE runner_auto_approve_definer FROM CURRENT_USER;
  END IF;
END
$$;
