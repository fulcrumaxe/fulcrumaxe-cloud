-- D#6 R2b (correction C24 section 2): leaving `runner_local` cancels the repo's queued runner runs in the same transaction as the
-- switch, and the audit row records how many were cancelled.
--
-- Why a migration. The switch runs on the web tier's login (app_user). That login cannot call agent_run_set_status (EXECUTE is for
-- agent_run_writer alone, 0642/0744), and repo_execution_mode_audit (0757) has no place for a count. Neither is widened here.
-- Instead one new role owns two new definers, in the shape 0720 gave guard_definer and 0754 gave runner_lease_definer:
--
--   runner_mode_switch_definer   NOLOGIN, no members (the migration role holds it only inside this file), a member of nothing.
--                                Column grants only, for what the two bodies read and write; a row policy for this role only on
--                                each row-secured table it touches; a pinned search_path; EXECUTE on its functions for app_user
--                                alone. platform_ops gains NOTHING (a test diffs its privileges against the migrations without
--                                this file, as 0754's does).
--
-- 1. repo_cancel_pending_runner_runs(p_repo_id) moves every pending runner run of the repo `pending -> cancelled`, by CALLING
--    agent_run_set_status (the role holds EXECUTE on that one exact signature, the 0754 precedent for agent_run_create), and
--    answers the ids it moved. It re-derives every precondition from table state:
--      * the caller is an owner or admin of an active account (read through a policy that shows this role only the caller's own
--        membership row), and the repo is that account's (P0002 otherwise, the same answer for another tenant's repo);
--      * the repo is NOT runner_local any more (55000): the function exists for the switch away, and an admin cannot use it as a
--        bulk cancel on a repo that still runs on a runner. The switch updates the row first, in the same transaction;
--      * the runs are locked first (FOR UPDATE, through this role's UPDATE policy, which shows only a pending runner run of
--        the tenant), so a claim that is committing at that moment is waited for and then no longer matches;
--      * each move is the compare-and-set writer, so a run that is no longer pending is not counted.
--    It includes jobless runs (job_signed is not read at all) and follow-ups still waiting on claimable_after. Running runs are
--    untouched: they are not pending, and the policy does not show them to the lock. It does not write the run's events: it
--    answers the ids and the web tier writes `run.status_changed` (with failureReason `execution_mode_changed`) and the domain
--    event for each through the same code every status change uses, in the same transaction. That keeps run_events and
--    domain_events out of this role's reach. The function is why the role needs UPDATE on one column of agent_runs: a row lock
--    needs an UPDATE privilege. The column is updated_at, no body writes it, and the policy limits the lock to pending runner runs.
--
-- 2. repo_execution_mode_switch_audit(p_repo_id, p_from, p_to, p_auto_merge_turned_off, p_cancelled_runs) is 0757's audit
--    definer with one more argument, the number of runs the switch cancelled. It is a function of its own, not a change to
--    0757's, which stays as it is. The count is the caller's figure (an owner or admin, the same trust as the rest of the
--    row), and it must be 0 unless the switch leaves runner_local, because nothing else can cancel a run.
--
-- Numbered above the highest migration claimed (0758 is another PR's). Re-check against main right before merging.
DO $$
DECLARE
  n text := 'runner_mode_switch_definer';
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

-- What the two bodies read and write, column by column, and nothing else. agent_runs: which runs of the repo are pending runner runs
-- (and updated_at, the one column a row lock needs a privilege on). account_members: the caller's own row. repos: that the repo is the
-- account's and which mode it is in. accounts: that the account is active. audit_log: the one row the audit definer writes.
GRANT USAGE ON SCHEMA public TO runner_mode_switch_definer;
GRANT SELECT (id, account_id, status, runtime, execution_mode, dispatch_repo_id), UPDATE (updated_at) ON agent_runs TO runner_mode_switch_definer;
GRANT SELECT (account_id, user_id, role) ON account_members TO runner_mode_switch_definer;
GRANT SELECT (id, account_id, execution_mode) ON repos TO runner_mode_switch_definer;
GRANT SELECT (id, deleted_at) ON accounts TO runner_mode_switch_definer;
GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO runner_mode_switch_definer;

-- Row policies for this role only, each held to the caller's tenant. The agent_runs update policy names the one kind of row the lock
-- may reach: a pending runner run in runner_local mode.
CREATE POLICY runner_mode_switch_definer_select ON agent_runs FOR SELECT TO runner_mode_switch_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_mode_switch_definer_update ON agent_runs FOR UPDATE TO runner_mode_switch_definer
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND status = 'pending' AND runtime = 'runner' AND execution_mode = 'runner_local'
  )
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_mode_switch_definer_select ON account_members FOR SELECT TO runner_mode_switch_definer
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
CREATE POLICY runner_mode_switch_definer_select ON repos FOR SELECT TO runner_mode_switch_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_mode_switch_definer_select ON accounts FOR SELECT TO runner_mode_switch_definer USING (true);
CREATE POLICY runner_mode_switch_definer_audit ON audit_log FOR INSERT TO runner_mode_switch_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND action = 'repo.execution_mode.changed');

-- ---- ownership brackets (as 0754 and 0757) ------------------------------------------------------------------------
-- The migration role holds the new role (with ADMIN from creating it) only to hand the functions over, and the role has CREATE on
-- public only for that transfer. It holds platform_ops only to grant EXECUTE on agent_run_set_status (a function platform_ops owns)
-- to the new role; that is a grant OF one function, and platform_ops itself gains nothing. All are reset at the end.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'runner_mode_switch_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_mode_switch_definer; cannot ALTER FUNCTION ... OWNER TO runner_mode_switch_definer';
    END IF;
    GRANT runner_mode_switch_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO runner_mode_switch_definer;

CREATE FUNCTION repo_cancel_pending_runner_runs(p_repo_id uuid)
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
  IF v_mode = 'runner_local' THEN
    RAISE EXCEPTION 'repo_cancel_pending_runner_runs: the repo is still on a runner' USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  -- Lock first (the lock applies this role's UPDATE policy, which shows pending runner runs only), then move each through the
  -- compare-and-set writer. A run that stopped being pending between the two is not counted.
  FOR r IN
    SELECT a.id FROM public.agent_runs a
     WHERE a.account_id = acct AND a.dispatch_repo_id = p_repo_id AND a.runtime = 'runner' AND a.execution_mode = 'runner_local' AND a.status = 'pending'
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

CREATE FUNCTION repo_execution_mode_switch_audit(p_repo_id uuid, p_from text, p_to text, p_auto_merge_turned_off boolean, p_cancelled_runs integer)
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
     OR p_from IS NULL OR p_from NOT IN ('sandbox', 'runner_local') OR p_to IS NULL OR p_to NOT IN ('sandbox', 'runner_local') OR p_from = p_to
     OR (p_cancelled_runs > 0 AND p_from <> 'runner_local') THEN
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

REVOKE ALL ON FUNCTION repo_cancel_pending_runner_runs(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION repo_execution_mode_switch_audit(uuid, text, text, boolean, integer) FROM PUBLIC;
ALTER FUNCTION repo_cancel_pending_runner_runs(uuid) OWNER TO runner_mode_switch_definer;
ALTER FUNCTION repo_execution_mode_switch_audit(uuid, text, text, boolean, integer) OWNER TO runner_mode_switch_definer;
-- EXECUTE is granted after the transfer (a transfer rewrites the ACL entries that named the old owner), to app_user alone.
GRANT EXECUTE ON FUNCTION repo_cancel_pending_runner_runs(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION repo_execution_mode_switch_audit(uuid, text, text, boolean, integer) TO app_user;
-- The cancel definer moves each run through the compare-and-set writer, as the run-writer login does; this is the one signature.
GRANT EXECUTE ON FUNCTION agent_run_set_status(uuid, uuid, text, text, jsonb, bigint, bigint, numeric, text, integer) TO runner_mode_switch_definer;

REVOKE CREATE ON SCHEMA public FROM runner_mode_switch_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_mode_switch_definer FROM CURRENT_USER;
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
