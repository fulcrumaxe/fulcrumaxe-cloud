-- D#845 ON-13c1: the system first start of an engine session. When an install finished (1085's `start_pending`) and the repo is placed, operated and covered, the cloud signs `engine_session_start` itself, with no person.
--   1. engine_start_definer (new, NOLOGIN), built like 1077's stop definer: column reads, each through a policy that names this role alone; it writes a start job with no setup, `start_pending` true to false of a `done` setup, one audit action.
--   2. engine_start_covered: the SQL copy of `requireEngineCoverage`. 3. engine_system_starts_due and engine_system_start_issue (EXECUTE: platform_ops only): the level-triggered list and the one issuer, which holds the signed bytes to the rows
--      under the person issuers' locks and consumes the cause in the same transaction. The closed causes are `first_start` and `operate_on`; the second has no cause to consume until ON-13c2's queue exists. 4. The reconcile row (60 s).
-- It restates no existing function; 1077's two predicates are granted to the new role. Numbered 1100 by the Team Lead; re-check against main right before merging and renumber to stay above its highest.

DO $$
DECLARE
  n text := 'engine_start_definer';
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

GRANT USAGE ON SCHEMA public TO engine_start_definer;
GRANT SELECT (id, deleted_at, engine_quantity, platform_hold_at, partner_suspended_at, subscription_ended_at, past_due_since, stripe_subscription_status) ON accounts TO engine_start_definer;
GRANT SELECT (account_id, watch_enabled, operate_enabled, operate_epoch) ON engine_bridge_settings TO engine_start_definer;
GRANT SELECT (account_id, repo_id) ON engine_bridge_repos TO engine_start_definer;
GRANT SELECT (account_id, repo_id, runner_id, placed_at) ON project_placements TO engine_start_definer;
GRANT SELECT (id, account_id, revoked_at) ON runners TO engine_start_definer;
GRANT SELECT (id, account_id, gh_repo_id, gh_owner, gh_name) ON repos TO engine_start_definer;
GRANT SELECT (account_id, runner_id, name) ON runner_sandboxes TO engine_start_definer;
GRANT SELECT (id, account_id, repo_id, runner_id, kind, state) ON machine_jobs TO engine_start_definer;
GRANT SELECT (id, account_id, repo_id, phase, start_pending) ON project_setups TO engine_start_definer;
CREATE POLICY engine_start_definer_select ON accounts FOR SELECT TO engine_start_definer USING (true);
CREATE POLICY engine_start_definer_select ON engine_bridge_settings FOR SELECT TO engine_start_definer USING (true);
CREATE POLICY engine_start_definer_select ON engine_bridge_repos FOR SELECT TO engine_start_definer USING (true);
CREATE POLICY engine_start_definer_select ON project_placements FOR SELECT TO engine_start_definer USING (true);
CREATE POLICY engine_start_definer_select ON runners FOR SELECT TO engine_start_definer USING (true);
CREATE POLICY engine_start_definer_select ON repos FOR SELECT TO engine_start_definer USING (true);
CREATE POLICY engine_start_definer_select ON runner_sandboxes FOR SELECT TO engine_start_definer USING (true);
CREATE POLICY engine_start_definer_select ON machine_jobs FOR SELECT TO engine_start_definer USING (true);
CREATE POLICY engine_start_definer_select ON project_setups FOR SELECT TO engine_start_definer USING (true);

-- A start with no setup (the table's own CHECKs hold the columns to the signed bytes); the one flag of a finished setup; one audit action whose actor is the login that called, never a literal.
GRANT INSERT ON machine_jobs TO engine_start_definer;
CREATE POLICY engine_start_definer_insert ON machine_jobs FOR INSERT TO engine_start_definer WITH CHECK (kind = 'engine_session_start' AND setup_id IS NULL);
GRANT UPDATE (start_pending) ON project_setups TO engine_start_definer;
CREATE POLICY engine_start_definer_consume ON project_setups FOR UPDATE TO engine_start_definer USING (phase = 'done' AND start_pending) WITH CHECK (NOT start_pending);
GRANT INSERT (account_id, actor, action, payload) ON audit_log TO engine_start_definer;
CREATE POLICY engine_start_definer_audit ON audit_log FOR INSERT TO engine_start_definer WITH CHECK (action = 'engine_session.started' AND actor = session_user::text);

DO $$
DECLARE
  super boolean := (SELECT rolsuper FROM pg_roles WHERE rolname = current_user);
BEGIN
  IF NOT super THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'engine_start_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on engine_start_definer; cannot ALTER FUNCTION ... OWNER TO engine_start_definer';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'engine_stop_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on engine_stop_definer; cannot GRANT EXECUTE on its predicates';
    END IF;
    GRANT engine_start_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
    GRANT engine_stop_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
  GRANT CREATE ON SCHEMA public TO engine_start_definer;
  GRANT EXECUTE ON FUNCTION public.engine_plan_ended(uuid) TO engine_start_definer;
  GRANT EXECUTE ON FUNCTION public.engine_repo_operated(uuid, uuid) TO engine_start_definer;

  -- Covered: not held, a quantity above zero, paying and not ended (1077's engine_plan_ended is false), and either every unit not over-used (live <= quantity) or, after a downgrade, among the oldest `quantity` placements.
  CREATE FUNCTION public.engine_start_covered(p_account uuid, p_repo uuid) RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
    SELECT COALESCE((
      SELECT a.platform_hold_at IS NULL AND a.partner_suspended_at IS NULL AND a.engine_quantity > 0 AND NOT public.engine_plan_ended(a.id)
         AND ((SELECT count(*) FROM public.project_placements pl WHERE pl.account_id = a.id) <= a.engine_quantity
              OR p_repo IN (SELECT o.repo_id FROM (SELECT pl.repo_id FROM public.project_placements pl WHERE pl.account_id = a.id ORDER BY pl.placed_at, pl.repo_id LIMIT a.engine_quantity) o))
        FROM public.accounts a WHERE a.id = p_account AND a.deleted_at IS NULL), false);
  $f$;

  -- One row per repo whose finished install still has `start_pending`, placed on a live machine, operated, covered, and with no start or stop issued or delivered. o_resume is the machine listing the engine's sandbox, or a start that ended.
  CREATE FUNCTION public.engine_system_starts_due(p_account uuid, p_repo uuid, p_limit integer)
  RETURNS TABLE (o_account uuid, o_repo uuid, o_runner uuid, o_repo_gh_id bigint, o_owner text, o_name text, o_epoch integer, o_resume boolean)
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
  BEGIN
    IF session_user <> 'platform_ops' OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL OR NULLIF(current_setting('app.user_id', true), '') IS NOT NULL THEN
      RAISE EXCEPTION 'engine_system_starts_due: refused' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 OR (p_repo IS NOT NULL AND p_account IS NULL) THEN
      RAISE EXCEPTION 'engine_system_starts_due: invalid argument' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    RETURN QUERY
    SELECT pl.account_id, pl.repo_id, pl.runner_id, rp.gh_repo_id, rp.gh_owner, rp.gh_name, st.operate_epoch,
           (EXISTS (SELECT 1 FROM public.runner_sandboxes s WHERE s.account_id = pl.account_id AND s.runner_id = pl.runner_id AND s.name = 'fx-engine-' || rp.gh_repo_id::text)
            OR EXISTS (SELECT 1 FROM public.machine_jobs j WHERE j.account_id = pl.account_id AND j.repo_id = pl.repo_id AND j.runner_id = pl.runner_id AND j.kind = 'engine_session_start' AND j.state = 'done'))
      FROM public.project_placements pl
      JOIN public.accounts ac ON ac.id = pl.account_id AND ac.deleted_at IS NULL
      JOIN public.runners rn ON rn.account_id = pl.account_id AND rn.id = pl.runner_id AND rn.revoked_at IS NULL
      JOIN public.repos rp ON rp.account_id = pl.account_id AND rp.id = pl.repo_id
      JOIN public.engine_bridge_settings st ON st.account_id = pl.account_id
     WHERE (p_account IS NULL OR pl.account_id = p_account) AND (p_repo IS NULL OR pl.repo_id = p_repo)
       AND EXISTS (SELECT 1 FROM public.project_setups ps WHERE ps.account_id = pl.account_id AND ps.repo_id = pl.repo_id AND ps.phase = 'done' AND ps.start_pending)
       AND public.engine_repo_operated(pl.account_id, pl.repo_id) AND st.operate_epoch >= 1 AND public.engine_start_covered(pl.account_id, pl.repo_id)
       AND NOT EXISTS (SELECT 1 FROM public.machine_jobs j WHERE j.account_id = pl.account_id AND j.repo_id = pl.repo_id AND j.kind IN ('engine_session_start', 'engine_session_stop') AND j.state IN ('issued', 'delivered'))
     ORDER BY pl.account_id, pl.repo_id
     LIMIT p_limit;
  END;
  $f$;

  -- o_result: issued, not_placed, epoch_moved (the signed epoch is not the one now), cause_gone (the cause is consumed or never was, or the repo is no longer operated), plan (not covered) or busy (a start or stop is waiting).
  -- Anything the signed bytes disagree with raises 22023 and writes nothing.
  CREATE FUNCTION public.engine_system_start_issue(p_id uuid, p_account uuid, p_repo uuid, p_cause text, p_job jsonb, p_issued_at timestamptz, p_expires_at timestamptz)
  RETURNS text
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    v_runner uuid;
    v_gh     bigint;
    v_epoch  integer;
    v_resume boolean;
  BEGIN
    IF session_user <> 'platform_ops' OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL OR NULLIF(current_setting('app.user_id', true), '') IS NOT NULL THEN
      RAISE EXCEPTION 'engine_system_start_issue: refused' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_id IS NULL OR p_account IS NULL OR p_repo IS NULL OR p_cause IS NULL OR p_cause <> ALL (ARRAY['first_start', 'operate_on']) OR p_job IS NULL OR jsonb_typeof(p_job) <> 'object' OR jsonb_typeof(p_job -> 'job') IS DISTINCT FROM 'object'
       OR p_issued_at IS NULL OR p_expires_at IS NULL THEN
      RAISE EXCEPTION 'engine_system_start_issue: invalid argument' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- The repo's session lock (the key the person issuers take), then the account's bridge lock, shared (the key every writer of the switches and ticks takes exclusively): a person's start, an off and this start never interleave.
    PERFORM pg_advisory_xact_lock(hashtextextended('engine_session:' || p_account::text || ':' || p_repo::text, 0));
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('engine_bridge:' || p_account::text, 0));
    SELECT pl.runner_id, rp.gh_repo_id INTO v_runner, v_gh
      FROM public.project_placements pl
      JOIN public.accounts ac ON ac.id = pl.account_id AND ac.deleted_at IS NULL
      JOIN public.runners rn ON rn.account_id = pl.account_id AND rn.id = pl.runner_id AND rn.revoked_at IS NULL
      JOIN public.repos rp ON rp.account_id = pl.account_id AND rp.id = pl.repo_id
     WHERE pl.account_id = p_account AND pl.repo_id = p_repo;
    IF NOT FOUND THEN RETURN 'not_placed'; END IF;
    v_resume := EXISTS (SELECT 1 FROM public.runner_sandboxes s WHERE s.account_id = p_account AND s.runner_id = v_runner AND s.name = 'fx-engine-' || v_gh::text)
                OR EXISTS (SELECT 1 FROM public.machine_jobs j WHERE j.account_id = p_account AND j.repo_id = p_repo AND j.runner_id = v_runner AND j.kind = 'engine_session_start' AND j.state = 'done');
    IF (p_job #>> '{job,kind}') IS DISTINCT FROM 'engine_session_start'
       OR (p_job #>> '{job,job_id}') IS DISTINCT FROM p_id::text
       OR (p_job #>> '{job,runner_id}') IS DISTINCT FROM v_runner::text
       OR (p_job #>> '{job,repo_gh_id}') IS DISTINCT FROM v_gh::text
       OR (p_job #>> '{job,setup_id}') IS NOT NULL
       OR jsonb_typeof(p_job #> '{job,repo_gh_id}') IS DISTINCT FROM 'number' OR jsonb_typeof(p_job #> '{job,args,at_sha}') IS DISTINCT FROM 'string'
       OR jsonb_typeof(p_job #> '{job,args,resume}') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_job #> '{job,args,operate_epoch}') IS DISTINCT FROM 'number'
       OR COALESCE((p_job #>> '{job,args,at_sha}') !~ '^[0-9a-f]{40}$', true)
       OR (p_job #>> '{job,args,resume}') IS DISTINCT FROM v_resume::text
       OR COALESCE((p_job #>> '{job,args,operate_epoch}') !~ '^[1-9][0-9]{0,8}$', true) THEN
      RAISE EXCEPTION 'engine_system_start_issue: the signed job does not say what was asked' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT COALESCE((SELECT st.operate_epoch FROM public.engine_bridge_settings st WHERE st.account_id = p_account), 0) INTO v_epoch;
    IF (p_job #>> '{job,args,operate_epoch}') IS DISTINCT FROM v_epoch::text THEN RETURN 'epoch_moved'; END IF;
    -- The cause first: a replay finds it consumed and answers cause_gone, whatever the issued start now makes of the other gates. `operate_on` has no queue row to consume before ON-13c2, so it never has a cause.
    IF p_cause <> 'first_start' OR NOT EXISTS (SELECT 1 FROM public.project_setups ps WHERE ps.account_id = p_account AND ps.repo_id = p_repo AND ps.phase = 'done' AND ps.start_pending)
       OR NOT public.engine_repo_operated(p_account, p_repo) THEN
      RETURN 'cause_gone';
    END IF;
    IF public.engine_plan_ended(p_account) OR NOT public.engine_start_covered(p_account, p_repo) THEN RETURN 'plan'; END IF;
    IF EXISTS (SELECT 1 FROM public.machine_jobs j WHERE j.account_id = p_account AND j.repo_id = p_repo AND j.kind IN ('engine_session_start', 'engine_session_stop') AND j.state IN ('issued', 'delivered')) THEN RETURN 'busy'; END IF;
    UPDATE public.project_setups SET start_pending = false WHERE account_id = p_account AND repo_id = p_repo AND phase = 'done' AND start_pending;
    INSERT INTO public.machine_jobs (id, account_id, runner_id, repo_id, setup_id, kind, job, attempt, issued_at, expires_at)
    VALUES (p_id, p_account, v_runner, p_repo, NULL, 'engine_session_start', p_job, 1, p_issued_at, p_expires_at);
    INSERT INTO public.audit_log (account_id, actor, action, payload)
    VALUES (p_account, session_user, 'engine_session.started', jsonb_build_object('repo_id', p_repo, 'job_id', p_id, 'cause', p_cause, 'resume', v_resume, 'at_sha', p_job #>> '{job,args,at_sha}', 'operate_epoch', v_epoch));
    RETURN 'issued';
  END;
  $f$;

  REVOKE ALL ON FUNCTION public.engine_start_covered(uuid, uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.engine_system_starts_due(uuid, uuid, integer) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.engine_system_start_issue(uuid, uuid, uuid, text, jsonb, timestamptz, timestamptz) FROM PUBLIC;
  ALTER FUNCTION public.engine_start_covered(uuid, uuid) OWNER TO engine_start_definer;
  ALTER FUNCTION public.engine_system_starts_due(uuid, uuid, integer) OWNER TO engine_start_definer;
  ALTER FUNCTION public.engine_system_start_issue(uuid, uuid, uuid, text, jsonb, timestamptz, timestamptz) OWNER TO engine_start_definer;
  GRANT EXECUTE ON FUNCTION public.engine_start_covered(uuid, uuid) TO platform_ops;
  GRANT EXECUTE ON FUNCTION public.engine_system_starts_due(uuid, uuid, integer) TO platform_ops;
  GRANT EXECUTE ON FUNCTION public.engine_system_start_issue(uuid, uuid, uuid, text, jsonb, timestamptz, timestamptz) TO platform_ops;

  REVOKE CREATE ON SCHEMA public FROM engine_start_definer;
  IF NOT super THEN
    REVOKE engine_start_definer FROM CURRENT_USER;
    REVOKE engine_stop_definer FROM CURRENT_USER;
  END IF;
END
$$;

-- The job that runs the list and the issuer on the reconcile tick; every tick that connects runs it (the gate decides whether the tick connects).
INSERT INTO reconcile_jobs (name, interval_seconds) VALUES ('engine_session_starts', 60) ON CONFLICT (name) DO NOTHING;
