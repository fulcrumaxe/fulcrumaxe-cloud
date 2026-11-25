-- D#845 ON-13a5: system-caused engine-session stops, and a start that can no longer be delivered once its cause is gone.
--
--   1. engine_stop_definer (new, NOLOGIN): the owner of five definers, and nothing else. It reads, by column, the rows that say whether an account's plan ended, whether a repo is operated, where an engine is placed and what the
--      machine last reported, and it can write exactly three things: a `engine_session_stop` job row whose reason is `operate_off` or `plan`, the `state` of an ISSUED `engine_session_start` (to superseded), and one audit row.
--      Every grant has a policy that names this role alone, so a bug in a definer body cannot sign a start, touch a setup job or write another action.
--   2. engine_plan_ended(account) and engine_repo_operated(account, repo): the two causes, one copy each in SQL. The first must equal `readEngineCoverage(...).state = 'plan_ended'` (held wins, then a quantity above zero that is
--      not paying or has ended); the second is item 9: watch AND operate AND the repo is ticked. EXECUTE: machine_jobs_owner only (for the deliver check below). Never app_user, never PUBLIC.
--   3. engine_system_stops_due(account, repo, limit), engine_system_stop_issue(...) and engine_system_stop_next_due(): the level-triggered list of the sessions a system cause says to stop, the one issuer, and the earliest grace end.
--      EXECUTE: platform_ops only. The issuer takes the repo's session lock (the key #1224's person issuers take) and the account's bridge lock (shared; the key every writer of the switches takes exclusively), so a person's start, an
--      operate switch and a system stop on one repo are serialized. It re-checks the cause from the rows under both locks and signs nothing itself: the cloud signs, the definer holds the signed bytes to the row.
--   4. machine_job_deliver is re-made (1053's body carried forward): an `engine_session_start` whose cause is gone when the runner asks for it (the plan ended, or the repo is no longer operated) is marked superseded and answers NULL,
--      so a start issued just before a plan ended or a repo was unticked can never reach a runner. A stop and every other kind are delivered as before.
--   5. The reconcile job `engine_session_stops` (60 s), which runs the list and the issuer on the existing reconcile tick.
--
-- Numbered 1077 by the Team Lead; it merges after 1068. Re-check against main right before merging and renumber to stay above its highest.

DO $$
DECLARE
  n text := 'engine_stop_definer';
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

-- ---- what the definers read, by column, each through a policy that names this role --------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO engine_stop_definer;
GRANT SELECT (id, deleted_at, engine_quantity, platform_hold_at, partner_suspended_at, subscription_ended_at, past_due_since, stripe_subscription_status) ON accounts TO engine_stop_definer;
GRANT SELECT (account_id, watch_enabled, operate_enabled, operate_epoch) ON engine_bridge_settings TO engine_stop_definer;
GRANT SELECT (account_id, repo_id) ON engine_bridge_repos TO engine_stop_definer;
GRANT SELECT (account_id, repo_id, runner_id) ON project_placements TO engine_stop_definer;
GRANT SELECT (id, account_id, revoked_at) ON runners TO engine_stop_definer;
GRANT SELECT (id, account_id, gh_repo_id) ON repos TO engine_stop_definer;
GRANT SELECT (account_id, runner_id, name, state) ON runner_sandboxes TO engine_stop_definer;
GRANT SELECT (account_id, runner_id, seen_at) ON runner_sandbox_reports TO engine_stop_definer;
GRANT SELECT (id, account_id, repo_id, runner_id, kind, state, issued_at, stop_reason) ON machine_jobs TO engine_stop_definer;
CREATE POLICY engine_stop_definer_select ON accounts FOR SELECT TO engine_stop_definer USING (true);
CREATE POLICY engine_stop_definer_select ON engine_bridge_settings FOR SELECT TO engine_stop_definer USING (true);
CREATE POLICY engine_stop_definer_select ON engine_bridge_repos FOR SELECT TO engine_stop_definer USING (true);
CREATE POLICY engine_stop_definer_select ON project_placements FOR SELECT TO engine_stop_definer USING (true);
CREATE POLICY engine_stop_definer_select ON runners FOR SELECT TO engine_stop_definer USING (true);
CREATE POLICY engine_stop_definer_select ON repos FOR SELECT TO engine_stop_definer USING (true);
CREATE POLICY engine_stop_definer_select ON runner_sandboxes FOR SELECT TO engine_stop_definer USING (true);
CREATE POLICY engine_stop_definer_select ON runner_sandbox_reports FOR SELECT TO engine_stop_definer USING (true);
CREATE POLICY engine_stop_definer_select ON machine_jobs FOR SELECT TO engine_stop_definer USING (true);

-- ---- what they write -----------------------------------------------------------------------------------------------------------------------------------
-- A stop job of a system reason and nothing else (the table's own CHECKs hold the columns to the signed bytes); an issued start becomes superseded and nothing else; one audit action.
GRANT INSERT ON machine_jobs TO engine_stop_definer;
GRANT UPDATE (state) ON machine_jobs TO engine_stop_definer;
CREATE POLICY engine_stop_definer_insert ON machine_jobs FOR INSERT TO engine_stop_definer
  WITH CHECK (kind = 'engine_session_stop' AND setup_id IS NULL AND stop_reason IN ('operate_off', 'plan'));
CREATE POLICY engine_stop_definer_supersede ON machine_jobs FOR UPDATE TO engine_stop_definer
  USING (kind = 'engine_session_start' AND state = 'issued') WITH CHECK (state = 'superseded');
-- The actor is the login that called (platform_ops), as 0618's eraser writes it, never a literal.
GRANT INSERT (account_id, actor, action, payload) ON audit_log TO engine_stop_definer;
CREATE POLICY engine_stop_definer_audit ON audit_log FOR INSERT TO engine_stop_definer
  WITH CHECK (action = 'engine_session.stopped' AND actor = session_user::text);

-- ---- ownership: the migration role holds the two owners only to create and hand the functions over (1066's shape) ------------------------------------
DO $$
DECLARE
  super boolean := (SELECT rolsuper FROM pg_roles WHERE rolname = current_user);
BEGIN
  IF (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid = 'public.machine_job_deliver(uuid)'::regprocedure) IS DISTINCT FROM 'machine_jobs_owner' THEN
    RAISE EXCEPTION 'machine_job_deliver is not owned by machine_jobs_owner; this migration was written for 1053''s owner';
  END IF;
  IF NOT super THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'machine_jobs_owner'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on machine_jobs_owner; cannot replace machine_job_deliver';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'engine_stop_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on engine_stop_definer; cannot ALTER FUNCTION ... OWNER TO engine_stop_definer';
    END IF;
    GRANT machine_jobs_owner TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
    GRANT engine_stop_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
  GRANT CREATE ON SCHEMA public TO machine_jobs_owner;
  GRANT CREATE ON SCHEMA public TO engine_stop_definer;

  -- ---- 2. the two causes ----------------------------------------------------------------------------------------------------------------------------
  -- Held wins; then a quantity above zero that has ended (the subscription ended, or the grace of a past due payment ran out, judged against the clock now) or is not paying. A missing or deleted account is not ended.
  CREATE FUNCTION public.engine_plan_ended(p_account uuid) RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
    SELECT COALESCE((
      SELECT NOT (a.platform_hold_at IS NOT NULL OR a.partner_suspended_at IS NOT NULL)
         AND a.engine_quantity > 0
         AND ((a.subscription_ended_at IS NOT NULL OR (a.past_due_since IS NOT NULL AND NOT (a.past_due_since > now() - interval '7 days')))
              OR NOT COALESCE(a.stripe_subscription_status IN ('active', 'trialing') OR (a.stripe_subscription_status = 'past_due' AND a.past_due_since IS NOT NULL), false))
        FROM public.accounts a WHERE a.id = p_account AND a.deleted_at IS NULL), false);
  $f$;

  CREATE FUNCTION public.engine_repo_operated(p_account uuid, p_repo uuid) RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
    SELECT COALESCE((
      SELECT st.watch_enabled AND st.operate_enabled AND EXISTS (SELECT 1 FROM public.engine_bridge_repos br WHERE br.account_id = st.account_id AND br.repo_id = p_repo)
        FROM public.engine_bridge_settings st WHERE st.account_id = p_account), false);
  $f$;

  -- ---- 3a. the list: what a system cause says to stop, derived from the rows and the clock on every call -----------------------------------------------
  -- One row per placed repo on a live runner with a cause, where a session is up (the machine lists its sandbox creating or running, or a start of the repo is delivered) or a start is still issued, and where no stop of the repo
  -- is waiting and none was issued since the machine's last inventory report (one stop per report: nothing churns while a machine is offline). A machine that never reported counts any earlier stop as after its report.
  CREATE FUNCTION public.engine_system_stops_due(p_account uuid, p_repo uuid, p_limit integer)
  RETURNS TABLE (o_account uuid, o_repo uuid, o_runner uuid, o_repo_gh_id bigint, o_reason text, o_epoch integer, o_issued_starts integer)
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
  BEGIN
    IF session_user <> 'platform_ops' OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL OR NULLIF(current_setting('app.user_id', true), '') IS NOT NULL THEN
      RAISE EXCEPTION 'engine_system_stops_due: refused' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 OR (p_repo IS NOT NULL AND p_account IS NULL) THEN
      RAISE EXCEPTION 'engine_system_stops_due: invalid argument' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    RETURN QUERY
    SELECT pl.account_id, pl.repo_id, pl.runner_id, rp.gh_repo_id, c.reason, COALESCE(st.operate_epoch, 0),
           (SELECT count(*)::integer FROM public.machine_jobs j WHERE j.account_id = pl.account_id AND j.repo_id = pl.repo_id AND j.kind = 'engine_session_start' AND j.state = 'issued')
      FROM public.project_placements pl
      JOIN public.accounts ac ON ac.id = pl.account_id AND ac.deleted_at IS NULL
      JOIN public.runners rn ON rn.account_id = pl.account_id AND rn.id = pl.runner_id AND rn.revoked_at IS NULL
      JOIN public.repos rp ON rp.account_id = pl.account_id AND rp.id = pl.repo_id
      LEFT JOIN public.engine_bridge_settings st ON st.account_id = pl.account_id
      LEFT JOIN public.runner_sandbox_reports rep ON rep.account_id = pl.account_id AND rep.runner_id = pl.runner_id
      CROSS JOIN LATERAL (SELECT CASE WHEN public.engine_plan_ended(pl.account_id) THEN 'plan' WHEN NOT public.engine_repo_operated(pl.account_id, pl.repo_id) THEN 'operate_off' END AS reason) c
     WHERE c.reason IS NOT NULL
       AND (p_account IS NULL OR pl.account_id = p_account) AND (p_repo IS NULL OR pl.repo_id = p_repo)
       AND (EXISTS (SELECT 1 FROM public.runner_sandboxes s WHERE s.account_id = pl.account_id AND s.runner_id = pl.runner_id AND s.name = 'fx-engine-' || rp.gh_repo_id::text AND s.state IN ('creating', 'running'))
            OR EXISTS (SELECT 1 FROM public.machine_jobs j WHERE j.account_id = pl.account_id AND j.repo_id = pl.repo_id AND j.kind = 'engine_session_start' AND j.state IN ('issued', 'delivered')))
       AND NOT EXISTS (SELECT 1 FROM public.machine_jobs j WHERE j.account_id = pl.account_id AND j.repo_id = pl.repo_id AND j.kind = 'engine_session_stop' AND j.state IN ('issued', 'delivered'))
       AND NOT EXISTS (SELECT 1 FROM public.machine_jobs j WHERE j.account_id = pl.account_id AND j.repo_id = pl.repo_id AND j.kind = 'engine_session_stop' AND j.issued_at > COALESCE(rep.seen_at, '-infinity'::timestamptz))
     ORDER BY pl.account_id, pl.repo_id
     LIMIT p_limit;
  END;
  $f$;

  -- ---- 3b. the issuer ---------------------------------------------------------------------------------------------------------------------------------
  -- o_result: issued, superseded_only (nothing was live: only the repo's issued starts were tidied), cause_gone, already_stopping, awaiting_report, epoch_moved (the signed epoch is not the one now) or not_placed.
  -- Anything else the signed bytes disagree with raises 22023 and writes nothing.
  CREATE FUNCTION public.engine_system_stop_issue(p_id uuid, p_account uuid, p_repo uuid, p_reason text, p_job jsonb, p_issued_at timestamptz, p_expires_at timestamptz)
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
    v_seen   timestamptz;
  BEGIN
    IF session_user <> 'platform_ops' OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL OR NULLIF(current_setting('app.user_id', true), '') IS NOT NULL THEN
      RAISE EXCEPTION 'engine_system_stop_issue: refused' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_id IS NULL OR p_account IS NULL OR p_repo IS NULL OR p_reason IS NULL OR p_reason <> ALL (ARRAY['operate_off', 'plan']) OR p_job IS NULL OR jsonb_typeof(p_job) <> 'object' OR p_issued_at IS NULL OR p_expires_at IS NULL THEN
      RAISE EXCEPTION 'engine_system_stop_issue: invalid argument' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- The repo's session lock (the key the person issuers take), then the account's bridge lock, shared (the key every writer of the switches and ticks takes exclusively): a start, an off and this stop never interleave.
    PERFORM pg_advisory_xact_lock(hashtextextended('engine_session:' || p_account::text || ':' || p_repo::text, 0));
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('engine_bridge:' || p_account::text, 0));
    SELECT pl.runner_id, rp.gh_repo_id INTO v_runner, v_gh
      FROM public.project_placements pl
      JOIN public.accounts ac ON ac.id = pl.account_id AND ac.deleted_at IS NULL
      JOIN public.runners rn ON rn.account_id = pl.account_id AND rn.id = pl.runner_id AND rn.revoked_at IS NULL
      JOIN public.repos rp ON rp.account_id = pl.account_id AND rp.id = pl.repo_id
     WHERE pl.account_id = p_account AND pl.repo_id = p_repo;
    IF NOT FOUND THEN RETURN 'not_placed'; END IF;
    IF (p_job #>> '{job,kind}') IS DISTINCT FROM 'engine_session_stop'
       OR (p_job #>> '{job,job_id}') IS DISTINCT FROM p_id::text
       OR (p_job #>> '{job,runner_id}') IS DISTINCT FROM v_runner::text
       OR (p_job #>> '{job,repo_gh_id}') IS DISTINCT FROM v_gh::text
       OR (p_job #>> '{job,args,reason}') IS DISTINCT FROM p_reason
       OR (p_job #>> '{job,setup_id}') IS NOT NULL THEN
      RAISE EXCEPTION 'engine_system_stop_issue: the signed job does not say what was asked' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT COALESCE((SELECT st.operate_epoch FROM public.engine_bridge_settings st WHERE st.account_id = p_account), 0) INTO v_epoch;
    IF (p_job #>> '{job,args,operate_epoch}') IS DISTINCT FROM v_epoch::text THEN RETURN 'epoch_moved'; END IF;
    IF p_reason = 'plan' THEN
      IF NOT public.engine_plan_ended(p_account) THEN RETURN 'cause_gone'; END IF;
    ELSIF public.engine_repo_operated(p_account, p_repo) THEN
      RETURN 'cause_gone';
    END IF;
    -- The repo's issued starts are tidied whatever follows (the deliver check keeps one from reaching a runner; this stops the page from showing it as starting).
    UPDATE public.machine_jobs SET state = 'superseded' WHERE account_id = p_account AND repo_id = p_repo AND kind = 'engine_session_start' AND state = 'issued';
    IF EXISTS (SELECT 1 FROM public.machine_jobs j WHERE j.account_id = p_account AND j.repo_id = p_repo AND j.kind = 'engine_session_stop' AND j.state IN ('issued', 'delivered')) THEN RETURN 'already_stopping'; END IF;
    SELECT rep.seen_at INTO v_seen FROM public.runner_sandbox_reports rep WHERE rep.account_id = p_account AND rep.runner_id = v_runner;
    IF EXISTS (SELECT 1 FROM public.machine_jobs j WHERE j.account_id = p_account AND j.repo_id = p_repo AND j.kind = 'engine_session_stop' AND j.issued_at > COALESCE(v_seen, '-infinity'::timestamptz)) THEN RETURN 'awaiting_report'; END IF;
    IF NOT (EXISTS (SELECT 1 FROM public.runner_sandboxes s WHERE s.account_id = p_account AND s.runner_id = v_runner AND s.name = 'fx-engine-' || v_gh::text AND s.state IN ('creating', 'running'))
            OR EXISTS (SELECT 1 FROM public.machine_jobs j WHERE j.account_id = p_account AND j.repo_id = p_repo AND j.kind = 'engine_session_start' AND j.state = 'delivered')) THEN
      RETURN 'superseded_only';
    END IF;
    INSERT INTO public.machine_jobs (id, account_id, runner_id, repo_id, setup_id, kind, job, attempt, issued_at, expires_at)
    VALUES (p_id, p_account, v_runner, p_repo, NULL, 'engine_session_stop', p_job, 1, p_issued_at, p_expires_at);
    INSERT INTO public.audit_log (account_id, actor, action, payload)
    VALUES (p_account, session_user, 'engine_session.stopped', jsonb_build_object('repo_id', p_repo, 'job_id', p_id, 'reason', p_reason));
    RETURN 'issued';
  END;
  $f$;

  -- ---- 3c. the earliest grace end of an account with a live engine ---------------------------------------------------------------------------------------
  CREATE FUNCTION public.engine_system_stop_next_due() RETURNS timestamptz
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
  BEGIN
    IF session_user <> 'platform_ops' OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL OR NULLIF(current_setting('app.user_id', true), '') IS NOT NULL THEN
      RAISE EXCEPTION 'engine_system_stop_next_due: refused' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN (SELECT min(a.past_due_since + interval '7 days')
              FROM public.accounts a
             WHERE a.deleted_at IS NULL AND a.engine_quantity > 0 AND a.past_due_since IS NOT NULL AND a.past_due_since > now() - interval '7 days'
               AND a.subscription_ended_at IS NULL AND a.platform_hold_at IS NULL AND a.partner_suspended_at IS NULL AND a.stripe_subscription_status = 'past_due'
               AND EXISTS (SELECT 1 FROM public.project_placements pl JOIN public.runners rn ON rn.account_id = pl.account_id AND rn.id = pl.runner_id AND rn.revoked_at IS NULL WHERE pl.account_id = a.id));
  END;
  $f$;

  -- ---- 4. machine_job_deliver: 1053's body, and a start whose cause is gone is superseded instead of delivered ---------------------------------------
  CREATE OR REPLACE FUNCTION public.machine_job_deliver(p_id uuid) RETURNS jsonb
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    rid    uuid := public.machine_job_runner();
    acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    v_job  jsonb;
    v_kind text;
    v_repo uuid;
  BEGIN
    PERFORM public.machine_job_expire(rid);
    IF EXISTS (SELECT 1 FROM public.machine_jobs j WHERE j.account_id = acct AND j.runner_id = rid AND j.state = 'delivered') THEN RETURN NULL; END IF;
    SELECT x.kind, x.repo_id INTO v_kind, v_repo FROM public.machine_jobs x
     WHERE x.id = p_id AND x.account_id = acct AND x.runner_id = rid AND x.state = 'issued' AND x.expires_at > now() FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF v_kind = 'engine_session_start' AND (public.engine_plan_ended(acct) OR NOT public.engine_repo_operated(acct, v_repo)) THEN
      UPDATE public.machine_jobs SET state = 'superseded', ended_at = now() WHERE id = p_id AND account_id = acct;
      RETURN NULL;
    END IF;
    UPDATE public.machine_jobs j SET state = 'delivered', delivered_at = now() WHERE j.id = p_id AND j.account_id = acct RETURNING j.job INTO v_job;
    RETURN v_job;
  EXCEPTION WHEN unique_violation THEN
    RETURN NULL;
  END;
  $f$;

  REVOKE ALL ON FUNCTION public.engine_plan_ended(uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.engine_repo_operated(uuid, uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.engine_system_stops_due(uuid, uuid, integer) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.engine_system_stop_issue(uuid, uuid, uuid, text, jsonb, timestamptz, timestamptz) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.engine_system_stop_next_due() FROM PUBLIC;
  ALTER FUNCTION public.engine_plan_ended(uuid) OWNER TO engine_stop_definer;
  ALTER FUNCTION public.engine_repo_operated(uuid, uuid) OWNER TO engine_stop_definer;
  ALTER FUNCTION public.engine_system_stops_due(uuid, uuid, integer) OWNER TO engine_stop_definer;
  ALTER FUNCTION public.engine_system_stop_issue(uuid, uuid, uuid, text, jsonb, timestamptz, timestamptz) OWNER TO engine_stop_definer;
  ALTER FUNCTION public.engine_system_stop_next_due() OWNER TO engine_stop_definer;
  -- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner). machine_job_deliver keeps its owner and its EXECUTE grant (CREATE OR REPLACE).
  GRANT EXECUTE ON FUNCTION public.engine_plan_ended(uuid) TO machine_jobs_owner;
  GRANT EXECUTE ON FUNCTION public.engine_repo_operated(uuid, uuid) TO machine_jobs_owner;
  GRANT EXECUTE ON FUNCTION public.engine_system_stops_due(uuid, uuid, integer) TO platform_ops;
  GRANT EXECUTE ON FUNCTION public.engine_system_stop_issue(uuid, uuid, uuid, text, jsonb, timestamptz, timestamptz) TO platform_ops;
  GRANT EXECUTE ON FUNCTION public.engine_system_stop_next_due() TO platform_ops;

  REVOKE CREATE ON SCHEMA public FROM machine_jobs_owner;
  REVOKE CREATE ON SCHEMA public FROM engine_stop_definer;
  IF NOT super THEN
    REVOKE machine_jobs_owner FROM CURRENT_USER;
    REVOKE engine_stop_definer FROM CURRENT_USER;
  END IF;
END
$$;

-- The job that runs the list and the issuer on the reconcile tick; every tick that connects runs it (the gate decides whether the tick connects).
INSERT INTO reconcile_jobs (name, interval_seconds) VALUES ('engine_session_stops', 60) ON CONFLICT (name) DO NOTHING;
