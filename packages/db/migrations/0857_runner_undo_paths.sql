-- Undo paths found missing in staging tests (Refs D#597, the "every state needs an undo path" rule).
--
--   1. A runner's name could be set but never cleared: runner_settings_apply refused a null or empty name, so a named runner could not go back to
--      "Unnamed runner (<registrant>)". The function gains one more action, 'clear_name': the same permission as 'rename' (an owner or admin, or the
--      runner's own registrant), it sets runner_settings.name back to null, and it writes the audit row 'runner.name_cleared' naming the previous
--      name. Everything else about the function, including its signature, owner and every other action, is 0790's body unchanged. The audit
--      policy for the settings role gets a second policy admitting the one new action name (policies on one table are OR'd).
--   2. An account that had accepted runner concurrency figures could not withdraw: the setting row had a writer for insert and update only. The setter,
--      account_runner_concurrency_set, now also takes both figures null to mean "withdraw": it deletes the account's row so the plan's defaults
--      apply again (the row is the whole of "accepted") and writes 'account.runner_concurrency.reset' naming the figures it removed. One null
--      without the other is still an invalid argument. It stays the role's one function with the same signature, owner and ACL (the neon-shape
--      check pins runner_concurrency_definer to exactly that), same caller rule (owner or admin of an active account, platform_ops refused) and
--      same advisory lock; the role gains DELETE on that one table, with a row policy for the caller's own account, and its audit policy gains the
--      one action name.
--
-- Additive (expand only): no column or table changes and no existing behaviour is removed. Old code never calls either new path.
-- Numbered above the highest migration on the code plane and the open pull requests. Re-check right before merging.

-- ---- ownership bracket (0784 and 0790's shape) -----------------------------------------------------------------------
DO $$
DECLARE
  n text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH n IN ARRAY ARRAY['runner_concurrency_definer', 'runner_settings_definer'] LOOP
      IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = n::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
        RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot change functions owned by %', n, n;
      END IF;
      EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', n);
    END LOOP;
  END IF;
END
$$;

-- ---- grants and policies ------------------------------------------------------------------------------------------------
CREATE POLICY runner_settings_definer_audit_name_cleared ON audit_log FOR INSERT TO runner_settings_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND action = 'runner.name_cleared');

GRANT DELETE ON account_runner_concurrency TO runner_concurrency_definer;
CREATE POLICY runner_concurrency_definer_delete ON account_runner_concurrency FOR DELETE TO runner_concurrency_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_concurrency_definer_audit_reset ON audit_log FOR INSERT TO runner_concurrency_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND action = 'account.runner_concurrency.reset');

-- ---- runner_settings_apply: 0790's body plus the 'clear_name' action -----------------------------------------------------
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
  IF p_runner IS NULL OR p_action IS NULL OR p_action NOT IN ('rename', 'clear_name', 'labels', 'rank', 'pause', 'drain', 'resume') THEN
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
  IF (p_action IN ('labels', 'rank') AND NOT v_admin) OR (p_action IN ('rename', 'clear_name', 'pause', 'drain', 'resume') AND NOT v_owns) THEN
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
    name       = CASE p_action WHEN 'rename' THEN p_name WHEN 'clear_name' THEN NULL ELSE s.name END,
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
    CASE p_action WHEN 'rename' THEN 'runner.renamed' WHEN 'clear_name' THEN 'runner.name_cleared' WHEN 'labels' THEN 'runner.labels_set' WHEN 'rank' THEN 'runner.rank_set'
                  WHEN 'pause' THEN 'runner.paused' WHEN 'drain' THEN 'runner.drain_started' ELSE 'runner.resumed' END,
    jsonb_build_object('runner_id', p_runner, 'registered_by', v_reg) || CASE p_action
      WHEN 'rename' THEN jsonb_build_object('name', p_name, 'previous_name', v_name)
      WHEN 'clear_name' THEN jsonb_build_object('previous_name', v_name)
      WHEN 'labels' THEN jsonb_build_object('labels', to_jsonb(p_labels))
      WHEN 'rank' THEN jsonb_build_object('rank', p_rank)
      WHEN 'resume' THEN jsonb_build_object('ended_pause', v_paused IS NOT NULL, 'ended_drain', v_draining)
      ELSE '{}'::jsonb END,
    v_ts);
END;
$$;

-- ---- account_runner_concurrency_set: 0784's body plus the withdrawal ----------------------------------------------------
CREATE OR REPLACE FUNCTION account_runner_concurrency_set(p_total_jobs integer, p_per_repo_jobs integer, p_accept boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct      uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr       uuid;
  v_role    text;
  v_total   smallint;
  v_per     smallint;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'account_runner_concurrency_set: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'account_runner_concurrency_set: caller is not an owner or admin of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_accept IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'account_runner_concurrency_set: the change was not accepted' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Both figures null is the withdrawal (the only way a null is accepted); one null is still an invalid argument.
  IF (p_total_jobs IS NULL) <> (p_per_repo_jobs IS NULL) THEN
    RAISE EXCEPTION 'account_runner_concurrency_set: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_total_jobs IS NOT NULL AND (p_total_jobs NOT BETWEEN 1 AND 100 OR p_per_repo_jobs NOT BETWEEN 1 AND p_total_jobs) THEN
    RAISE EXCEPTION 'account_runner_concurrency_set: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- One writer per account, so the old figures in the audit row are the ones this change replaces.
  PERFORM pg_advisory_xact_lock(hashtextextended('runner_concurrency:' || acct::text, 0));
  IF p_total_jobs IS NULL THEN
    -- Withdraw: delete the row, so the plan defaults apply again, and say which figures went. Nothing to withdraw changes and records nothing.
    SELECT c.total_jobs, c.per_repo_jobs INTO v_total, v_per FROM public.account_runner_concurrency c WHERE c.account_id = acct;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
    DELETE FROM public.account_runner_concurrency WHERE account_id = acct;
    INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
    VALUES (acct, usr::text, 'account.runner_concurrency.reset',
            jsonb_build_object('previous_total_jobs', v_total, 'previous_per_repo_jobs', v_per),
            clock_timestamp());
    RETURN true;
  END IF;
  SELECT c.total_jobs, c.per_repo_jobs INTO v_total, v_per FROM public.account_runner_concurrency c WHERE c.account_id = acct;
  IF FOUND AND v_total = p_total_jobs AND v_per = p_per_repo_jobs THEN
    RETURN false;
  END IF;
  INSERT INTO public.account_runner_concurrency AS c (account_id, total_jobs, per_repo_jobs, updated_by, updated_at)
  VALUES (acct, p_total_jobs, p_per_repo_jobs, usr, clock_timestamp())
  ON CONFLICT (account_id) DO UPDATE SET total_jobs = EXCLUDED.total_jobs, per_repo_jobs = EXCLUDED.per_repo_jobs, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, 'account.runner_concurrency.accepted',
          jsonb_build_object('total_jobs', p_total_jobs, 'per_repo_jobs', p_per_repo_jobs, 'previous_total_jobs', v_total, 'previous_per_repo_jobs', v_per),
          clock_timestamp());
  RETURN true;
END;
$$;

DO $$
DECLARE
  n text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH n IN ARRAY ARRAY['runner_concurrency_definer', 'runner_settings_definer'] LOOP
      EXECUTE format('REVOKE %I FROM CURRENT_USER', n);
    END LOOP;
  END IF;
END
$$;
