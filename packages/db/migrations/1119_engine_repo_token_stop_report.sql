-- D#845 ON-18 (Ruling 126.2): the runner reports the stop it asked for itself when a session's repository token could not be refreshed three times, so the cloud can show why the engine stopped.
--
--   engine_repo_token_stop_report(p_id, p_session, p_job, p_issued_at, p_expires_at): owned by engine_stop_definer (1077), run by the runner's own session (app.runner_id set, EXECUTE: app_user). It records ONE
--   `engine_session_stop` machine job for the repository with the reason `token_refresh_failed`, in state `failed` with no code, plus one audit row (`engine_session.token_refresh_failed`). It writes only when ALL of these hold,
--   each read from our own rows and none from the caller: the session is a live runner of an active account; the signed job says what was asked (kind, job id, this runner, the repository, the reason, no setup, the epoch now); the
--   repository is the account's and is placed on THIS runner; `p_session` is the id of the repository's newest delivered or done start on this runner (a newer start makes an old id invalid); no report of this reason is newer than that
--   start (a second call answers `already`); no stop or delete in state issued, delivered or done is newer than it; this runner's lease row for the repository has not expired and carries the epoch now; the repository is operated and
--   the plan has not ended (1077's two predicates). Anything else writes nothing and answers `not_found`, `not_running` or `epoch_moved`; a bad argument raises 22023.
--   The job is `failed` and not `done` on purpose: the report is made BEFORE the runner's own stop runs, so the cloud cannot know the stop finished. `stop_failed` (derived from the newest session job and a sandbox that is still up)
--   then shows the reason and Try again until the machine reports the sandbox down, and clears by itself when it does.
--   engine_stop_definer's policies widen by exactly this: reading engine_session_leases (five columns), inserting a stop job of this reason in state failed, and inserting this one audit action.
--
-- Numbered 1119 by the Team Lead; it builds on 1077 and 1092, so it merges after both. Re-check against main right before merging and renumber to stay above its highest.

GRANT SELECT (account_id, repo_id, runner_id, operate_epoch, expires_at) ON engine_session_leases TO engine_stop_definer;
CREATE POLICY engine_stop_definer_select ON engine_session_leases FOR SELECT TO engine_stop_definer USING (true);

DROP POLICY engine_stop_definer_insert ON machine_jobs;
CREATE POLICY engine_stop_definer_insert ON machine_jobs FOR INSERT TO engine_stop_definer
  WITH CHECK (kind = 'engine_session_stop' AND setup_id IS NULL
              AND (stop_reason IN ('operate_off', 'plan') OR (stop_reason = 'token_refresh_failed' AND state = 'failed' AND failure_code IS NULL AND delivered_at IS NOT NULL)));

DROP POLICY engine_stop_definer_audit ON audit_log;
CREATE POLICY engine_stop_definer_audit ON audit_log FOR INSERT TO engine_stop_definer
  WITH CHECK (action IN ('engine_session.stopped', 'engine_session.token_refresh_failed') AND actor = session_user::text);

DO $$
DECLARE
  super boolean := (SELECT rolsuper FROM pg_roles WHERE rolname = current_user);
BEGIN
  IF NOT super THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'engine_stop_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on engine_stop_definer; cannot ALTER FUNCTION ... OWNER TO engine_stop_definer';
    END IF;
    GRANT engine_stop_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
  GRANT CREATE ON SCHEMA public TO engine_stop_definer;

  CREATE FUNCTION public.engine_repo_token_stop_report(p_id uuid, p_session uuid, p_job jsonb, p_issued_at timestamptz, p_expires_at timestamptz)
  RETURNS text
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    acct      uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    raw       text := COALESCE(current_setting('app.runner_id', true), '');
    rid       uuid;
    v_gh      bigint;
    v_repo    uuid;
    v_start   uuid;
    v_start_at timestamptz;
    v_epoch   integer;
    v_lease   integer;
  BEGIN
    IF session_user = 'platform_ops' OR acct IS NULL OR NOT public.account_is_active(acct) OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'engine_repo_token_stop_report: the session is not a runner of an active account' USING ERRCODE = 'insufficient_privilege';
    END IF;
    rid := raw::uuid;
    IF NOT EXISTS (SELECT 1 FROM public.runners r WHERE r.id = rid AND r.account_id = acct AND r.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'engine_repo_token_stop_report: the session is not a live runner of the account' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_id IS NULL OR p_session IS NULL OR p_job IS NULL OR jsonb_typeof(p_job) <> 'object' OR jsonb_typeof(p_job -> 'job') IS DISTINCT FROM 'object' OR p_issued_at IS NULL OR p_expires_at IS NULL
       OR COALESCE(p_job #>> '{job,repo_gh_id}', '') !~ '^[1-9][0-9]{0,17}$' OR jsonb_typeof(p_job #> '{job,repo_gh_id}') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'engine_repo_token_stop_report: invalid argument' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_gh := (p_job #>> '{job,repo_gh_id}')::bigint;
    SELECT rp.id INTO v_repo
      FROM public.repos rp
      JOIN public.project_placements pl ON pl.account_id = rp.account_id AND pl.repo_id = rp.id AND pl.runner_id = rid
     WHERE rp.account_id = acct AND rp.gh_repo_id = v_gh;
    IF NOT FOUND THEN RETURN 'not_found'; END IF;
    -- The repo's session lock (the key the person issuers take): a start, a stop and this report never interleave.
    PERFORM pg_advisory_xact_lock(hashtextextended('engine_session:' || acct::text || ':' || v_repo::text, 0));
    IF (p_job #>> '{job,kind}') IS DISTINCT FROM 'engine_session_stop'
       OR (p_job #>> '{job,job_id}') IS DISTINCT FROM p_id::text
       OR (p_job #>> '{job,runner_id}') IS DISTINCT FROM rid::text
       OR (p_job #>> '{job,args,reason}') IS DISTINCT FROM 'token_refresh_failed'
       OR (p_job #>> '{job,setup_id}') IS NOT NULL
       OR (p_job #>> '{job,issued_at}')::timestamptz IS DISTINCT FROM p_issued_at
       OR (p_job #>> '{job,expires_at}')::timestamptz IS DISTINCT FROM p_expires_at THEN
      RAISE EXCEPTION 'engine_repo_token_stop_report: the signed job does not say what was asked' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT j.id, j.issued_at INTO v_start, v_start_at
      FROM public.machine_jobs j
     WHERE j.account_id = acct AND j.repo_id = v_repo AND j.runner_id = rid AND j.kind = 'engine_session_start' AND j.state IN ('delivered', 'done')
     ORDER BY j.issued_at DESC, j.id DESC LIMIT 1;
    IF v_start IS DISTINCT FROM p_session THEN RETURN 'not_running'; END IF;
    IF EXISTS (SELECT 1 FROM public.machine_jobs j WHERE j.account_id = acct AND j.repo_id = v_repo AND j.runner_id = rid AND j.kind = 'engine_session_stop' AND j.stop_reason = 'token_refresh_failed' AND j.issued_at > v_start_at) THEN
      RETURN 'already';
    END IF;
    IF EXISTS (SELECT 1 FROM public.machine_jobs j WHERE j.account_id = acct AND j.repo_id = v_repo AND j.runner_id = rid AND j.kind IN ('engine_session_stop', 'engine_session_delete') AND j.state IN ('issued', 'delivered', 'done') AND j.issued_at > v_start_at) THEN
      RETURN 'not_running';
    END IF;
    SELECT st.operate_epoch INTO v_epoch FROM public.engine_bridge_settings st WHERE st.account_id = acct;
    IF v_epoch IS NULL OR (p_job #>> '{job,args,operate_epoch}') IS DISTINCT FROM v_epoch::text THEN RETURN 'epoch_moved'; END IF;
    SELECT l.operate_epoch INTO v_lease FROM public.engine_session_leases l WHERE l.account_id = acct AND l.repo_id = v_repo AND l.runner_id = rid AND l.expires_at > now();
    IF v_lease IS DISTINCT FROM v_epoch OR NOT public.engine_repo_operated(acct, v_repo) OR public.engine_plan_ended(acct) THEN RETURN 'not_running'; END IF;
    INSERT INTO public.machine_jobs (id, account_id, runner_id, repo_id, setup_id, kind, job, attempt, state, issued_at, expires_at, delivered_at, ended_at)
    VALUES (p_id, acct, rid, v_repo, NULL, 'engine_session_stop', p_job, 1, 'failed', p_issued_at, p_expires_at, p_issued_at, now());
    INSERT INTO public.audit_log (account_id, actor, action, payload)
    VALUES (acct, session_user, 'engine_session.token_refresh_failed', jsonb_build_object('repo_id', v_repo, 'job_id', p_id, 'session_id', p_session));
    RETURN 'recorded';
  END;
  $f$;

  REVOKE ALL ON FUNCTION public.engine_repo_token_stop_report(uuid, uuid, jsonb, timestamptz, timestamptz) FROM PUBLIC;
  ALTER FUNCTION public.engine_repo_token_stop_report(uuid, uuid, jsonb, timestamptz, timestamptz) OWNER TO engine_stop_definer;
  GRANT EXECUTE ON FUNCTION public.engine_repo_token_stop_report(uuid, uuid, jsonb, timestamptz, timestamptz) TO app_user;

  REVOKE CREATE ON SCHEMA public FROM engine_stop_definer;
  IF NOT super THEN
    REVOKE engine_stop_definer FROM CURRENT_USER;
  END IF;
END
$$;
