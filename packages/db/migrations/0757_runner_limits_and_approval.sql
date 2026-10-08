-- D#6 R2b (criterion 12, correction C9 section 3): the runner count limit comes from the plan data, not from a string.
--
-- 0712 (kept by 0732) compared `accounts.plan` with the text 'runner' and refused the third active runner. That was a
-- temporary seam, marked as such in its own comment: the plan figures are private data that live in the plan data, and a
-- SQL function cannot read them. Now the caller passes the limit.
--
--   runner_register(code_sha256, public_key_jwk, isolation, max_runners)
--
-- `p_max_runners` is the most active (not revoked) runners the account may hold. NULL means no limit, which is what an
-- account that is not on the runner plan gets. The caller (packages/runner-cloud, from the plan data) decides which case
-- applies; the function only enforces the number it is given, under the same per-account advisory lock as before, so the
-- count cannot be raced past it. A negative number is refused as an invalid argument.
--
-- The function is called by the web tier's login with the account's tenant context, as before; nobody who can call it can
-- do anything with the argument they could not already do by registering fewer runners, since a larger value only lets
-- their own account hold more runners and the registration code, minter and membership checks are unchanged.
--
-- The old three-argument function is dropped, so there is one registration path. No argument has a default: a call that
-- still passes three arguments (a stale caller during a rolling deploy) finds no function and fails, where a default of
-- NULL would have registered it with no cap. The isolation argument loses its default with it, because a parameter after
-- one with a default must have one too; callers pass NULL for it explicitly. NULL for the limit is still how a caller says
-- "this account is not on the runner plan", but it has to be said.
--
-- The body is 0732's, verbatim apart from the limit.
--
-- The same file adds agent_run_approve (D#6 R2b criterion 2): a subscription runner claims only runs its registrant started
-- or approved, and this is how a registrant approves a teammate's run. approved_by had no write path (0711 added the column,
-- 0714 opened initiated_by and job_signed). The definer runs for a signed-in member, who must be the registrant of a live
-- (not revoked) subscription runner of the account: anyone else is refused (42501). It approves only a pending runner run,
-- once: approved_by is write-once, by trigger, for every role, and a platform_ops login cannot write it directly. Approving
-- again by the same person changes nothing; by someone else is refused (55000), so one approval is never silently replaced.
-- It writes one audit_log row. Refusals: 42501 not permitted, P0002 no such run, 55000 not approvable (not pending, not a
-- runner run, or approved by someone else).
--
-- Who owns the two new definers (correction C21 section 11): platform_ops gains NOTHING here. The approve definer and the
-- execution-mode audit definer are owned by a new role of their own, runner_approval_definer, in the shape of 0720's
-- guard_definer and 0754's runner_lease_definer: NOLOGIN, no members (the migration role holds it only inside this file), a member
-- of nothing, column-level grants for exactly what the two bodies read and write, row policies for this role only, a pinned
-- search_path, and EXECUTE for app_user alone. Their bodies re-derive every precondition from table state: the caller's
-- membership is read from account_members through a policy that shows this role only the caller's own row. The old grants of
-- approved_by to platform_ops, and EXECUTE for platform_ops on the two definers, are not made. runner_register (an existing
-- platform_ops definer, replaced below with one more argument) keeps its owner and gains no privilege.
--
-- A second new role, runner_notice_lister, owns the cross-tenant list of runs that still owe a runner notice
-- (agent_run_list_runner_runs_owing_notice, at the end of the file). It is a role of its own so that the approval role keeps
-- every row policy held to the caller's tenant: the lister must see pending runs and notice events of every account, and nothing
-- else may. Same shape as the approval role: NOLOGIN, no members, column grants only, two narrow row policies, a pinned
-- search_path, and EXECUTE for the run-writer login alone (the login the sweeps run as). platform_ops gains nothing from it.
-- ---- the role ---------------------------------------------------------------------------------------------------
DO $$
DECLARE
  n text := 'runner_approval_definer';
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

DO $$
DECLARE
  n text := 'runner_notice_lister';
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

-- What the two bodies read and write, column by column, and nothing else. agent_runs: whether a run is pending, a runner run in
-- runner_local mode and already approved (approved_by is the only column written, with updated_at). runners: the caller's live
-- subscription runners. account_members: the caller's own row. repos: that a repo belongs to the account. audit_log: one row each.
GRANT USAGE ON SCHEMA public TO runner_approval_definer;
GRANT SELECT (id, account_id, status, runtime, execution_mode, approved_by), UPDATE (approved_by, updated_at) ON agent_runs TO runner_approval_definer;
GRANT SELECT (id, account_id, registered_by, credential_mode, revoked_at) ON runners TO runner_approval_definer;
GRANT SELECT (account_id, user_id, role) ON account_members TO runner_approval_definer;
GRANT SELECT (id, account_id) ON repos TO runner_approval_definer;
GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO runner_approval_definer;
GRANT SELECT (id, deleted_at) ON accounts TO runner_approval_definer;

-- Row policies for this role only. Every one is held to the caller's tenant context; the member policy shows only the caller's
-- own membership row. The agent_runs update policy names the one kind of row the approve body may change.
CREATE POLICY runner_approval_definer_select ON agent_runs FOR SELECT TO runner_approval_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_approval_definer_update ON agent_runs FOR UPDATE TO runner_approval_definer
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND status = 'pending' AND runtime = 'runner' AND execution_mode = 'runner_local'
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_approval_definer_select ON runners FOR SELECT TO runner_approval_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_approval_definer_select ON account_members FOR SELECT TO runner_approval_definer
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
CREATE POLICY runner_approval_definer_select ON repos FOR SELECT TO runner_approval_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_approval_definer_audit ON audit_log FOR INSERT TO runner_approval_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND action IN ('runner.run_approved', 'repo.execution_mode.changed'));
CREATE POLICY runner_approval_definer_select ON accounts FOR SELECT TO runner_approval_definer USING (true);

-- The notice lister's whole reach: which pending runner_local runner runs exist (ids, account, creation time), and whether a run
-- already has each of the two notice events (run, account, kind; never the payload). Two policies, for this role alone.
GRANT USAGE ON SCHEMA public TO runner_notice_lister;
GRANT SELECT (id, account_id, status, runtime, execution_mode, created_at) ON agent_runs TO runner_notice_lister;
GRANT SELECT (account_id, run_id, kind) ON run_events TO runner_notice_lister;
CREATE POLICY runner_notice_lister_select ON agent_runs FOR SELECT TO runner_notice_lister
  USING (status = 'pending' AND runtime = 'runner' AND execution_mode = 'runner_local');
CREATE POLICY runner_notice_lister_select ON run_events FOR SELECT TO runner_notice_lister
  USING (kind IN ('runner.waiting', 'runner.ttl_reminder'));

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'runner_approval_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_approval_definer; cannot ALTER FUNCTION ... OWNER TO runner_approval_definer';
    END IF;
    GRANT runner_approval_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'runner_notice_lister'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_notice_lister; cannot ALTER FUNCTION ... OWNER TO runner_notice_lister';
    END IF;
    GRANT runner_notice_lister TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

GRANT CREATE ON SCHEMA public TO platform_ops;
GRANT CREATE ON SCHEMA public TO runner_approval_definer;
GRANT CREATE ON SCHEMA public TO runner_notice_lister;

DROP FUNCTION runner_register(text, jsonb, text);

CREATE FUNCTION runner_register(p_code_sha256 text, p_public_key_jwk jsonb, p_isolation text, p_max_runners integer)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_jkt  text;
  v_code public.runner_registration_codes;
  v_id   uuid;
BEGIN
  IF acct IS NULL OR NOT account_is_active(acct) THEN
    RAISE EXCEPTION 'runner_register: no active account in context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_code_sha256 IS NULL OR p_code_sha256 !~ '^[0-9a-f]{64}$'
     OR (p_isolation IS NOT NULL AND p_isolation NOT IN ('microvm', 'vm_container', 'container', 'host_sandbox'))
     OR (p_max_runners IS NOT NULL AND p_max_runners < 0) THEN
    RAISE EXCEPTION 'runner_register: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_jkt := public.runner_key_thumbprint(p_public_key_jwk);

  -- One registration at a time per account, so the count below cannot be raced past the limit.
  PERFORM pg_advisory_xact_lock(hashtextextended('runner_register:' || acct::text, 0));

  -- The code must be this account's, unused and unexpired. Every way of failing gives the same answer, so a caller
  -- learns nothing about which check it was.
  SELECT * INTO v_code FROM public.runner_registration_codes c
   WHERE c.account_id = acct AND c.code_sha256 = p_code_sha256
   FOR UPDATE;
  IF NOT FOUND OR v_code.used_at IS NOT NULL OR v_code.expires_at <= now() THEN
    RAISE EXCEPTION 'runner_register: the code is not valid' USING ERRCODE = 'no_data_found';
  END IF;

  -- Its minter must still be an owner or admin, and stay one until this transaction ends: the row is locked FOR SHARE,
  -- so a demotion or removal waits for this registration and then revokes the runner it creates (see 0732).
  PERFORM 1 FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = v_code.registered_by AND m.role IN ('owner', 'admin')
   FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runner_register: the code is not valid' USING ERRCODE = 'no_data_found';
  END IF;

  -- The limit the caller read from the plan data (replaces the plan = 'runner' string seam of 0712 and 0732).
  IF p_max_runners IS NOT NULL
     AND (SELECT count(*) FROM public.runners r WHERE r.account_id = acct AND r.revoked_at IS NULL) >= p_max_runners THEN
    RAISE EXCEPTION 'runner_register: runner limit reached' USING ERRCODE = 'configuration_limit_exceeded';
  END IF;

  UPDATE public.runner_registration_codes SET used_at = now() WHERE id = v_code.id;

  BEGIN
    INSERT INTO public.runners (account_id, registered_by, public_key_jwk, jkt, credential_mode, isolation, allowed_repo_ids)
    VALUES (acct, v_code.registered_by,
            jsonb_build_object('kty', 'OKP', 'crv', 'Ed25519', 'x', p_public_key_jwk ->> 'x'),
            v_jkt, v_code.credential_mode, p_isolation, v_code.allowed_repo_ids)
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'runner_register: that key is already registered' USING ERRCODE = 'unique_violation';
  END;

  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, 'runner:' || v_id::text, 'runner.registered', jsonb_build_object(
    'runner_id', v_id, 'registered_by', v_code.registered_by, 'credential_mode', v_code.credential_mode,
    'isolation', p_isolation, 'jkt', v_jkt), clock_timestamp());
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION runner_register(text, jsonb, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_register(text, jsonb, text, integer) TO app_user;
ALTER FUNCTION runner_register(text, jsonb, text, integer) OWNER TO platform_ops;

CREATE FUNCTION agent_runs_approved_by_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
    IF session_user = 'platform_ops' THEN
      RAISE EXCEPTION 'agent_runs: platform_ops may not write approved_by; use agent_run_approve' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.approved_by IS NOT NULL THEN
      RAISE EXCEPTION 'agent_runs.approved_by is write-once (run %)', OLD.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_runs_approved_by_guard
  BEFORE UPDATE ON agent_runs
  FOR EACH ROW
  EXECUTE FUNCTION agent_runs_approved_by_guard();

CREATE FUNCTION agent_run_approve(p_run_id uuid)
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
  -- Read without a lock first: the row lock below applies this role's UPDATE policy, which shows only a pending runner_local
  -- run, so a run of any other kind must be answered from this read (55000, "cannot be approved") and not as "no such run".
  SELECT a.status, a.runtime, a.execution_mode, a.approved_by INTO v_status, v_runtime, v_mode, v_approved
    FROM public.agent_runs a WHERE a.account_id = acct AND a.id = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'agent_run_approve: no such run' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_status <> 'pending' OR v_runtime <> 'runner' OR v_mode IS DISTINCT FROM 'runner_local'
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

REVOKE ALL ON FUNCTION agent_runs_approved_by_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION agent_run_approve(uuid) FROM PUBLIC;
ALTER FUNCTION agent_run_approve(uuid) OWNER TO runner_approval_definer;
-- EXECUTE is granted after the transfer (a transfer rewrites the ACL entries that named the old owner), to app_user alone. A
-- platform_ops login cannot call it at all, and the check inside still refuses one that somehow could.
GRANT EXECUTE ON FUNCTION agent_run_approve(uuid) TO app_user;
-- repo_execution_mode_audit: the audit row for a change of repos.execution_mode (D#6 R2b criterion 4, correction C14
-- section 2). app_user has no INSERT on audit_log (0008), so the route's change and its audit row commit in one
-- transaction through this definer, modelled on 0713. It records the actor (stamped from the session, never an
-- argument), the repo, the old and new mode and whether the auto-merge opt-in was turned off with it. The caller must be
-- an owner or admin of an active account and the repo must be that account's. The modes are a fixed list.
CREATE FUNCTION repo_execution_mode_audit(p_repo_id uuid, p_from text, p_to text, p_auto_merge_turned_off boolean)
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
    RAISE EXCEPTION 'repo_execution_mode_audit: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'repo_execution_mode_audit: caller is not an owner or admin of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_repo_id IS NULL OR p_auto_merge_turned_off IS NULL
     OR p_from IS NULL OR p_from NOT IN ('sandbox', 'runner_local') OR p_to IS NULL OR p_to NOT IN ('sandbox', 'runner_local') OR p_from = p_to THEN
    RAISE EXCEPTION 'repo_execution_mode_audit: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM 1 FROM public.repos r WHERE r.id = p_repo_id AND r.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'repo_execution_mode_audit: no such repo' USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, 'repo.execution_mode.changed',
          jsonb_build_object('repo_id', p_repo_id, 'from', p_from, 'to', p_to, 'auto_merge_turned_off', p_auto_merge_turned_off), clock_timestamp());
END;
$$;

REVOKE ALL ON FUNCTION repo_execution_mode_audit(uuid, text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION repo_execution_mode_audit(uuid, text, text, boolean) TO app_user;
ALTER FUNCTION repo_execution_mode_audit(uuid, text, text, boolean) OWNER TO runner_approval_definer;

-- agent_run_list_runner_runs_owing_notice: the cross-tenant list the notice sweep starts from. Pending runner_local runner runs
-- that still lack at least one of the two notices, at most `limit` (1..50), ordered by when their next notice falls due: the
-- creation time plus `waiting_after_ms` for a run without its `runner.waiting`, plus `reminder_after_ms` for a run without its
-- `runner.ttl_reminder`, the earlier of the two when it lacks both; ties by creation time and id. 0734's queue lister returns the
-- oldest pending runs whether or not they still owe anything, and a run that has both notices (or only the 48 hour one to come)
-- stays in that window until its queue time ends, so with more than 50 runs waiting at once the newer ones would never be looked
-- at. Here a run drops out when both notices exist, runs whose notice is due come before runs whose notice is not, and the first
-- row's due time is the earliest of every run in the list, which is what the sweep stores as its next look. Same refusal and limit
-- check as the other sweep listers; it writes nothing and returns ids and the creation time only. The two delays are arguments
-- (the caller owns the notice schedule), each held to 1 s .. 30 days.
CREATE FUNCTION agent_run_list_runner_runs_owing_notice(p_limit int, p_waiting_after_ms bigint, p_reminder_after_ms bigint)
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
   WHERE a.status = 'pending' AND a.runtime = 'runner' AND a.execution_mode = 'runner_local' AND (n.owes_waiting OR n.owes_reminder)
   ORDER BY LEAST(CASE WHEN n.owes_waiting THEN a.created_at + make_interval(secs => p_waiting_after_ms / 1000.0) END,
                  CASE WHEN n.owes_reminder THEN a.created_at + make_interval(secs => p_reminder_after_ms / 1000.0) END),
            a.created_at, a.id
   LIMIT p_limit;
END $$;

REVOKE ALL ON FUNCTION agent_run_list_runner_runs_owing_notice(int, bigint, bigint) FROM PUBLIC;
ALTER FUNCTION agent_run_list_runner_runs_owing_notice(int, bigint, bigint) OWNER TO runner_notice_lister;
-- EXECUTE after the transfer, to the run-writer login alone, as 0734 and 0754 do for their listers.
GRANT EXECUTE ON FUNCTION agent_run_list_runner_runs_owing_notice(int, bigint, bigint) TO agent_run_writer;
REVOKE CREATE ON SCHEMA public FROM platform_ops;
REVOKE CREATE ON SCHEMA public FROM runner_approval_definer;
REVOKE CREATE ON SCHEMA public FROM runner_notice_lister;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_notice_lister FROM CURRENT_USER;
    REVOKE runner_approval_definer FROM CURRENT_USER;
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
