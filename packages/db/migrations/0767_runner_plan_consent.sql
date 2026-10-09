-- D#6 R2b-4a (correction C31): a runner run follows the autonomy dial, and the plan holder's own consent decides whose Claude plan a
-- run may use without a click. This file is the database side: the consent record, the claim-time auto-approval, and the one
-- function the read model shares with the claim so the two cannot disagree.
--
-- 1. runner_plan_consents is an append-only record, one row per change, keyed to ONE runner (not to a person, so a re-registered
--    runner, which has a new id, starts with no consent). Current state is the highest version; a runner with no row has consent
--    off. app_user can read it (a member sees who lets work run on whose plan) and nothing else: no INSERT, UPDATE or DELETE for
--    any application role, platform_ops included. A row is written only by runner_plan_consent_set.
--
-- 2. runner_plan_consent_set(runner, granted) writes the next version. It refuses (42501) unless the session user IS that
--    runner's registered_by, so an account owner, an admin and a platform_ops login are refused alike; nobody can switch consent
--    on for someone else. An unknown or revoked runner is P0002. A write that would not change the state (granting what is on,
--    withdrawing what is off or was never on) writes nothing and answers changed = false. Every real change writes one audit_log
--    row naming the actor, the runner, the new state and the repository list at that moment. Owner: runner_consent_definer.
--
-- 3. runner_plan_auto_approvable(runner, repo) is the dry run of the claim's conditions 1 to 4 (C31 section 2.2): the runner is a
--    live subscription runner of the session's account and lists the repo; its registrant is still a member of the account; the
--    runner's current consent is granted; the repo's current dial for runner_run_on_member_plan resolves to announce or act. With
--    no dial row the answer is the catalogue's default, announce. That default is a fixed constant here (the caller must not choose
--    it, 0622's lesson), and packages/db/test pins it to the catalogue's own entry. The function reads, it writes nothing. Both
--    the claim (as the run-writer login) and the read model (as the web tier's login) call this one function, so what the claim
--    would do and what the screen says are the same computation.
--
-- 4. agent_run_runner_auto_approve(run, runner, now, catalogue_version) is the claim's write. Inside the claim's transaction, with
--    the run row locked, it re-checks the run (a pending, unclaimed runner_local runner run with no approver, claimable at `now`)
--    and the function above, and only then writes approved_by = the runner's registrant (the column is write-once, so this is the
--    only moment it is written), one audit_log row (runner.run_auto_approved: the runner, the consent version, the dial version
--    and disposition) and one decision receipt through the existing receipt writer. Auto-approval is never written ahead of a claim.
--    Owner: runner_auto_approve_definer. EXECUTE: the run-writer login only.
--
-- Who owns the definers (C21 section 11, as 0754 and 0757 do): each of the two roles below is NOLOGIN, unprivileged, with no member
-- outside this file's bracket; column grants only, on exactly what the bodies read and write; a row policy of its own on every
-- row-secured table it touches, held to the caller's tenant; a pinned search_path; EXECUTE only for the logins that call each
-- function. platform_ops gains NOTHING: no new privilege and no new policy on any table. runner_auto_approve_definer is a member
-- of receipt_writer_invoker (the NOLOGIN role whose only privilege is EXECUTE on the receipt definers), which is how its body calls
-- decision_receipt_write without any INSERT grant on decision_receipts of its own: the direct grantees of that INSERT stay exactly
-- receipt_writer. The receipt's actor is therefore 'policy' (the claim sets no user), and its dial version is NULL when no dial row
-- exists and the default applied.
--
-- Numbered above the highest migration on the code plane (0766). Re-check against main right before merging (C7 section 4).
--
-- Refusals use fixed SQLSTATEs and messages, never an argument value: 42501 not permitted, P0002 no such runner, 22023 invalid argument.

-- ---- the roles ---------------------------------------------------------------------------------------------------
DO $$
DECLARE
  n text;
BEGIN
  FOREACH n IN ARRAY ARRAY['runner_consent_definer', 'runner_auto_approve_definer'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
    END IF;
    IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
      EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
      RAISE EXCEPTION 'role % still has a privileged attribute', n;
    END IF;
  END LOOP;
END
$$;

-- ---- the consent record ------------------------------------------------------------------------------------------
CREATE TABLE runner_plan_consents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  runner_id   uuid NOT NULL,
  granted     boolean NOT NULL,
  version     integer NOT NULL CHECK (version >= 1),
  changed_by  uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, runner_id, version),
  FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE CASCADE
);
ALTER TABLE runner_plan_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE runner_plan_consents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_select ON runner_plan_consents FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
-- Read only for app_user. No grant and no policy for platform_ops: it gains nothing.
GRANT SELECT ON runner_plan_consents TO app_user;

-- ---- what the bodies read and write, column by column ------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO runner_consent_definer;
GRANT SELECT (id, account_id, registered_by, allowed_repo_ids, revoked_at) ON runners TO runner_consent_definer;
GRANT SELECT (account_id, user_id) ON account_members TO runner_consent_definer;
GRANT SELECT (account_id, runner_id, granted, version, created_at), INSERT (account_id, runner_id, granted, version, changed_by) ON runner_plan_consents TO runner_consent_definer;
GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO runner_consent_definer;
GRANT SELECT (id, deleted_at) ON accounts TO runner_consent_definer;

CREATE POLICY runner_consent_definer_select ON runners FOR SELECT TO runner_consent_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
-- Shows this role only the caller's own membership row, as 0757 does.
CREATE POLICY runner_consent_definer_select ON account_members FOR SELECT TO runner_consent_definer
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
CREATE POLICY runner_consent_definer_select ON runner_plan_consents FOR SELECT TO runner_consent_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_consent_definer_insert ON runner_plan_consents FOR INSERT TO runner_consent_definer
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND changed_by = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM account_members m WHERE m.account_id = runner_plan_consents.account_id AND m.user_id = runner_plan_consents.changed_by)
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY runner_consent_definer_audit ON audit_log FOR INSERT TO runner_consent_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND action = 'runner.plan_consent_changed');
CREATE POLICY runner_consent_definer_select ON accounts FOR SELECT TO runner_consent_definer USING (true);

GRANT USAGE ON SCHEMA public TO runner_auto_approve_definer;
GRANT SELECT (id, account_id, work_item_id, dispatch_repo_id, status, runtime, execution_mode, approved_by, runner_id, claimable_after),
      UPDATE (approved_by, updated_at) ON agent_runs TO runner_auto_approve_definer;
GRANT SELECT (id, account_id, registered_by, credential_mode, allowed_repo_ids, revoked_at) ON runners TO runner_auto_approve_definer;
GRANT SELECT (account_id, user_id) ON account_members TO runner_auto_approve_definer;
GRANT SELECT (account_id, runner_id, granted, version) ON runner_plan_consents TO runner_auto_approve_definer;
GRANT SELECT (account_id, repo_id, decision_type, disposition, version) ON decision_settings TO runner_auto_approve_definer;
GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO runner_auto_approve_definer;
GRANT SELECT (id, deleted_at) ON accounts TO runner_auto_approve_definer;

CREATE POLICY runner_auto_approve_definer_select ON agent_runs FOR SELECT TO runner_auto_approve_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
-- The one kind of row the body may change: a pending, unclaimed, unapproved runner_local runner run of the caller's tenant.
CREATE POLICY runner_auto_approve_definer_update ON agent_runs FOR UPDATE TO runner_auto_approve_definer
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND status = 'pending' AND runtime = 'runner' AND execution_mode = 'runner_local' AND approved_by IS NULL AND runner_id IS NULL
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_auto_approve_definer_select ON runners FOR SELECT TO runner_auto_approve_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_auto_approve_definer_select ON account_members FOR SELECT TO runner_auto_approve_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_auto_approve_definer_select ON runner_plan_consents FOR SELECT TO runner_auto_approve_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_auto_approve_definer_select ON decision_settings FOR SELECT TO runner_auto_approve_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_auto_approve_definer_audit ON audit_log FOR INSERT TO runner_auto_approve_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND action = 'runner.run_auto_approved');
CREATE POLICY runner_auto_approve_definer_select ON accounts FOR SELECT TO runner_auto_approve_definer USING (true);

-- The receipt writer's invoker role: EXECUTE on the receipt definers and no table privilege at all. A member of it can call
-- decision_receipt_write; it gains no INSERT on decision_receipts.
GRANT receipt_writer_invoker TO runner_auto_approve_definer;

-- ---- ownership bracket (0757's shape): a non-superuser migrator needs SET on each role for ALTER ... OWNER TO ----------
DO $$
DECLARE
  n text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH n IN ARRAY ARRAY['runner_consent_definer', 'runner_auto_approve_definer'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_auth_members m
        WHERE m.roleid = n::regrole AND m.member = current_user::regrole AND m.admin_option
      ) THEN
        RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot ALTER FUNCTION ... OWNER TO %', n, n;
      END IF;
      EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', n);
    END LOOP;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO runner_consent_definer;
GRANT CREATE ON SCHEMA public TO runner_auto_approve_definer;

-- ---- runner_plan_consent_set -------------------------------------------------------------------------------------
CREATE FUNCTION runner_plan_consent_set(p_runner_id uuid, p_granted boolean)
RETURNS TABLE (changed boolean, consent_version integer, changed_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct        uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr         uuid;
  v_by        uuid;
  v_revoked   timestamptz;
  v_repos     uuid[];
  v_version   integer;
  v_granted   boolean;
  v_at        timestamptz;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_plan_consent_set: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The caller's own membership row (the policy shows this role no other).
  SELECT m.user_id INTO usr FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL THEN
    RAISE EXCEPTION 'runner_plan_consent_set: caller is not a member of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_runner_id IS NULL OR p_granted IS NULL THEN
    RAISE EXCEPTION 'runner_plan_consent_set: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT r.registered_by, r.revoked_at, r.allowed_repo_ids INTO v_by, v_revoked, v_repos
    FROM public.runners r WHERE r.account_id = acct AND r.id = p_runner_id;
  IF NOT FOUND OR v_revoked IS NOT NULL THEN
    RAISE EXCEPTION 'runner_plan_consent_set: no such runner' USING ERRCODE = 'no_data_found';
  END IF;
  -- Only the person whose plan it is. An owner or admin who did not register the runner is refused like anyone else.
  IF v_by <> usr THEN
    RAISE EXCEPTION 'runner_plan_consent_set: only the person who registered the runner can change this' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- One writer per runner, so the next version cannot be raced.
  PERFORM pg_advisory_xact_lock(hashtextextended('runner_plan_consent:' || p_runner_id::text, 0));
  SELECT c.version, c.granted, c.created_at INTO v_version, v_granted, v_at
    FROM public.runner_plan_consents c WHERE c.account_id = acct AND c.runner_id = p_runner_id
   ORDER BY c.version DESC LIMIT 1;
  IF COALESCE(v_granted, false) = p_granted THEN
    RETURN QUERY SELECT false, COALESCE(v_version, 0), v_at;
    RETURN;
  END IF;

  INSERT INTO public.runner_plan_consents (account_id, runner_id, granted, version, changed_by)
  VALUES (acct, p_runner_id, p_granted, COALESCE(v_version, 0) + 1, usr)
  RETURNING public.runner_plan_consents.version, public.runner_plan_consents.created_at INTO v_version, v_at;

  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, 'runner.plan_consent_changed',
          jsonb_build_object('runner_id', p_runner_id, 'granted', p_granted, 'version', v_version, 'repo_ids', to_jsonb(v_repos)), clock_timestamp());
  RETURN QUERY SELECT true, v_version, v_at;
END;
$$;

REVOKE ALL ON FUNCTION runner_plan_consent_set(uuid, boolean) FROM PUBLIC;
ALTER FUNCTION runner_plan_consent_set(uuid, boolean) OWNER TO runner_consent_definer;
-- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner), to app_user alone.
GRANT EXECUTE ON FUNCTION runner_plan_consent_set(uuid, boolean) TO app_user;

-- ---- runner_plan_auto_approvable ---------------------------------------------------------------------------------
CREATE FUNCTION runner_plan_auto_approvable(p_runner_id uuid, p_repo_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct        uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_by        uuid;
  v_disposition text;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_plan_auto_approvable: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR p_runner_id IS NULL OR p_repo_id IS NULL OR NOT account_is_active(acct) THEN
    RETURN false;
  END IF;
  -- 1. a live subscription runner of this account that lists the repo
  SELECT r.registered_by INTO v_by FROM public.runners r
   WHERE r.account_id = acct AND r.id = p_runner_id AND r.credential_mode = 'subscription' AND r.revoked_at IS NULL
     AND p_repo_id = ANY (r.allowed_repo_ids);
  IF NOT FOUND THEN RETURN false; END IF;
  -- 2. its registrant is still a member of the account
  IF NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = v_by) THEN RETURN false; END IF;
  -- 3. the registrant's standing consent on this runner is on at its current version
  IF NOT COALESCE((SELECT c.granted FROM public.runner_plan_consents c WHERE c.account_id = acct AND c.runner_id = p_runner_id
                    ORDER BY c.version DESC LIMIT 1), false) THEN RETURN false; END IF;
  -- 4. the repo's current dial for runner_run_on_member_plan is announce or act; with no row it is the catalogue default, announce
  SELECT d.disposition INTO v_disposition FROM public.decision_settings d
   WHERE d.account_id = acct AND d.repo_id = p_repo_id AND d.decision_type = 'runner_run_on_member_plan'
   ORDER BY d.version DESC LIMIT 1;
  RETURN COALESCE(v_disposition, 'announce') IN ('announce', 'act');
END;
$$;

REVOKE ALL ON FUNCTION runner_plan_auto_approvable(uuid, uuid) FROM PUBLIC;
ALTER FUNCTION runner_plan_auto_approvable(uuid, uuid) OWNER TO runner_auto_approve_definer;
GRANT EXECUTE ON FUNCTION runner_plan_auto_approvable(uuid, uuid) TO app_user, agent_run_writer;

-- ---- agent_run_runner_auto_approve -------------------------------------------------------------------------------
CREATE FUNCTION agent_run_runner_auto_approve(p_run_id uuid, p_runner_id uuid, p_now timestamptz, p_catalogue_version integer)
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
  IF v_status <> 'pending' OR v_runtime <> 'runner' OR v_mode IS DISTINCT FROM 'runner_local' OR v_approved IS NOT NULL
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

REVOKE ALL ON FUNCTION agent_run_runner_auto_approve(uuid, uuid, timestamptz, integer) FROM PUBLIC;
ALTER FUNCTION agent_run_runner_auto_approve(uuid, uuid, timestamptz, integer) OWNER TO runner_auto_approve_definer;
GRANT EXECUTE ON FUNCTION agent_run_runner_auto_approve(uuid, uuid, timestamptz, integer) TO agent_run_writer;

REVOKE CREATE ON SCHEMA public FROM runner_consent_definer;
REVOKE CREATE ON SCHEMA public FROM runner_auto_approve_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_auto_approve_definer FROM CURRENT_USER;
    REVOKE runner_consent_definer FROM CURRENT_USER;
  END IF;
END
$$;
