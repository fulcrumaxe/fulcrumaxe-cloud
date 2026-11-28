-- D#845 MC-9b2d: the start that follows a carry. A move with "Bring the team's memory along" issues no start; once the old machine's export is sealed (1123), the cloud signs the start itself, with the carry's id, size, chunk count and
-- sha256 in its args, for the machine the project is placed on now.
--   1. state_carry_starts_due and state_carry_start_issue (engine_start_definer, EXECUTE: platform_ops only), built like 1100's pair. The lister names the sealed, unfailed, open carries whose repo is placed on the carry's target and
--      operated and covered, with no start or stop waiting and no finished start since the seal. The issuer holds the signed bytes to the carry row: the carry must be the one named, open, sealed and unfailed, and BELONG TO THE
--      REPO THE START IS FOR (1123's guard looks only at the start's own repo, so a carry of another repo would otherwise ride a start whose repo has none). The job's machine is the carry's target and the placement; `resume` is
--      false; the carry object is exactly the row's four facts. After 3 failed carry starts the carry is marked `import_failed` instead of being started again (derived from the start jobs' rows, stamped once).
--   2. state_carry_unsupported (the old machine's own claim): a carry whose source no longer lists the capability fails with `runner_update_needed`, and 1123's machine_cleanup_issue, re-made here, then takes a plain stop
--      (it asked for the carry id only while the carry had not failed).
--   3. The reconcile row that sweeps the carries (1123's state_carry_sweep).
-- Numbered 1124 by the Team Lead. Re-check against main right before merging and renumber to stay above its highest.

GRANT SELECT (bytes, chunks, sha256) ON state_carries TO engine_start_definer;

DO $$
DECLARE
  super boolean := (SELECT rolsuper FROM pg_roles WHERE rolname = current_user);
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['machine_jobs_owner', 'engine_start_definer'] LOOP
    IF NOT super THEN
      IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = r::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
        RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot create the state carry start functions', r;
      END IF;
      EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', r);
    END IF;
    EXECUTE format('GRANT CREATE ON SCHEMA public TO %I', r);
  END LOOP;

  -- One row per sealed carry that may be started now. o_resume is always false: the team's memory is the carry's, never the machine's own.
  CREATE FUNCTION public.state_carry_starts_due(p_account uuid, p_repo uuid, p_limit integer)
  RETURNS TABLE (o_account uuid, o_repo uuid, o_runner uuid, o_repo_gh_id bigint, o_owner text, o_name text, o_epoch integer, o_resume boolean, o_carry uuid, o_bytes integer, o_chunks integer, o_sha256 text)
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
  BEGIN
    IF session_user <> 'platform_ops' OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL OR NULLIF(current_setting('app.user_id', true), '') IS NOT NULL THEN
      RAISE EXCEPTION 'state_carry_starts_due: refused' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 OR (p_repo IS NOT NULL AND p_account IS NULL) THEN
      RAISE EXCEPTION 'state_carry_starts_due: invalid argument' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    RETURN QUERY
    SELECT c.account_id, c.repo_id, c.to_runner_id, rp.gh_repo_id, rp.gh_owner, rp.gh_name, st.operate_epoch, false, c.id, c.bytes, c.chunks, c.sha256
      FROM public.state_carries c
      JOIN public.project_placements pl ON pl.account_id = c.account_id AND pl.repo_id = c.repo_id AND pl.runner_id = c.to_runner_id
      JOIN public.accounts ac ON ac.id = c.account_id AND ac.deleted_at IS NULL
      JOIN public.runners rn ON rn.account_id = c.account_id AND rn.id = c.to_runner_id AND rn.revoked_at IS NULL
      JOIN public.repos rp ON rp.account_id = c.account_id AND rp.id = c.repo_id
      JOIN public.engine_bridge_settings st ON st.account_id = c.account_id
     WHERE (p_account IS NULL OR c.account_id = p_account) AND (p_repo IS NULL OR c.repo_id = p_repo)
       AND c.closed_at IS NULL AND c.sealed_at IS NOT NULL AND c.failure_code IS NULL
       AND public.engine_repo_operated(c.account_id, c.repo_id) AND st.operate_epoch >= 1 AND public.engine_start_covered(c.account_id, c.repo_id)
       AND NOT EXISTS (SELECT 1 FROM public.machine_jobs j WHERE j.account_id = c.account_id AND j.repo_id = c.repo_id AND j.kind IN ('engine_session_start', 'engine_session_stop') AND j.state IN ('issued', 'delivered'))
       AND NOT EXISTS (SELECT 1 FROM public.machine_jobs j WHERE j.account_id = c.account_id AND j.repo_id = c.repo_id AND j.runner_id = c.to_runner_id AND j.kind = 'engine_session_start' AND j.state = 'done' AND j.issued_at >= c.sealed_at)
     ORDER BY c.account_id, c.repo_id
     LIMIT p_limit;
  END;
  $f$;

  -- o_result: issued, not_placed (no live placement, or not on the carry's target), carry_gone (not this repo's, closed, unsealed or failed), epoch_moved, cause_gone (the repo is no longer operated), plan, busy, import_failed.
  -- Anything the signed bytes disagree with raises 22023 and writes nothing.
  CREATE FUNCTION public.state_carry_start_issue(p_id uuid, p_account uuid, p_repo uuid, p_carry uuid, p_job jsonb, p_issued_at timestamptz, p_expires_at timestamptz)
  RETURNS text
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    c        record;
    v_runner uuid;
    v_gh     bigint;
    v_epoch  integer;
  BEGIN
    IF session_user <> 'platform_ops' OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL OR NULLIF(current_setting('app.user_id', true), '') IS NOT NULL THEN
      RAISE EXCEPTION 'state_carry_start_issue: refused' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_id IS NULL OR p_account IS NULL OR p_repo IS NULL OR p_carry IS NULL OR p_job IS NULL OR jsonb_typeof(p_job) <> 'object' OR jsonb_typeof(p_job -> 'job') IS DISTINCT FROM 'object'
       OR p_issued_at IS NULL OR p_expires_at IS NULL THEN
      RAISE EXCEPTION 'state_carry_start_issue: invalid argument' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('engine_session:' || p_account::text || ':' || p_repo::text, 0));
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('engine_bridge:' || p_account::text, 0));
    -- The carry is named by the account AND the repo the start is for: a carry of another repo is not found.
    SELECT x.id, x.account_id, x.to_runner_id, x.sealed_at, x.failure_code, x.bytes, x.chunks, x.sha256 INTO c FROM public.state_carries x WHERE x.id = p_carry AND x.account_id = p_account AND x.repo_id = p_repo AND x.closed_at IS NULL FOR UPDATE;
    IF NOT FOUND OR c.sealed_at IS NULL OR c.failure_code IS NOT NULL THEN RETURN 'carry_gone'; END IF;
    SELECT pl.runner_id, rp.gh_repo_id INTO v_runner, v_gh
      FROM public.project_placements pl
      JOIN public.accounts ac ON ac.id = pl.account_id AND ac.deleted_at IS NULL
      JOIN public.runners rn ON rn.account_id = pl.account_id AND rn.id = pl.runner_id AND rn.revoked_at IS NULL
      JOIN public.repos rp ON rp.account_id = pl.account_id AND rp.id = pl.repo_id
     WHERE pl.account_id = p_account AND pl.repo_id = p_repo;
    IF NOT FOUND OR v_runner <> c.to_runner_id THEN RETURN 'not_placed'; END IF;
    IF (p_job #>> '{job,kind}') IS DISTINCT FROM 'engine_session_start'
       OR (p_job #>> '{job,job_id}') IS DISTINCT FROM p_id::text
       OR (p_job #>> '{job,runner_id}') IS DISTINCT FROM c.to_runner_id::text
       OR jsonb_typeof(p_job #> '{job,repo_gh_id}') IS DISTINCT FROM 'number' OR (p_job #>> '{job,repo_gh_id}') IS DISTINCT FROM v_gh::text
       OR (p_job #>> '{job,setup_id}') IS NOT NULL
       OR jsonb_typeof(p_job #> '{job,args}') IS DISTINCT FROM 'object' OR ((p_job #> '{job,args}') - 'at_sha' - 'resume' - 'operate_epoch' - 'carry') <> '{}'::jsonb
       OR jsonb_typeof(p_job #> '{job,args,at_sha}') IS DISTINCT FROM 'string' OR COALESCE((p_job #>> '{job,args,at_sha}') !~ '^[0-9a-f]{40}$', true)
       OR (p_job #> '{job,args,resume}') IS DISTINCT FROM 'false'::jsonb
       OR jsonb_typeof(p_job #> '{job,args,operate_epoch}') IS DISTINCT FROM 'number' OR COALESCE((p_job #>> '{job,args,operate_epoch}') !~ '^[1-9][0-9]{0,8}$', true)
       OR jsonb_typeof(p_job #> '{job,args,carry}') IS DISTINCT FROM 'object' OR ((p_job #> '{job,args,carry}') - 'id' - 'bytes' - 'chunks' - 'sha256') <> '{}'::jsonb
       OR jsonb_typeof(p_job #> '{job,args,carry,id}') IS DISTINCT FROM 'string' OR (p_job #>> '{job,args,carry,id}') IS DISTINCT FROM c.id::text
       OR jsonb_typeof(p_job #> '{job,args,carry,bytes}') IS DISTINCT FROM 'number' OR (p_job #>> '{job,args,carry,bytes}') IS DISTINCT FROM c.bytes::text
       OR jsonb_typeof(p_job #> '{job,args,carry,chunks}') IS DISTINCT FROM 'number' OR (p_job #>> '{job,args,carry,chunks}') IS DISTINCT FROM c.chunks::text
       OR jsonb_typeof(p_job #> '{job,args,carry,sha256}') IS DISTINCT FROM 'string' OR (p_job #>> '{job,args,carry,sha256}') IS DISTINCT FROM c.sha256 THEN
      RAISE EXCEPTION 'state_carry_start_issue: the signed job does not say what was asked' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT COALESCE((SELECT st.operate_epoch FROM public.engine_bridge_settings st WHERE st.account_id = p_account), 0) INTO v_epoch;
    IF (p_job #>> '{job,args,operate_epoch}') IS DISTINCT FROM v_epoch::text THEN RETURN 'epoch_moved'; END IF;
    IF NOT public.engine_repo_operated(p_account, p_repo) THEN RETURN 'cause_gone'; END IF;
    IF public.engine_plan_ended(p_account) OR NOT public.engine_start_covered(p_account, p_repo) THEN RETURN 'plan'; END IF;
    IF EXISTS (SELECT 1 FROM public.machine_jobs j WHERE j.account_id = p_account AND j.repo_id = p_repo AND j.kind IN ('engine_session_start', 'engine_session_stop') AND j.state IN ('issued', 'delivered'))
       OR EXISTS (SELECT 1 FROM public.machine_jobs j WHERE j.account_id = p_account AND j.repo_id = p_repo AND j.runner_id = c.to_runner_id AND j.kind = 'engine_session_start' AND j.state = 'done' AND j.issued_at >= c.sealed_at) THEN
      RETURN 'busy';
    END IF;
    IF (SELECT count(*) FROM public.machine_jobs j WHERE j.account_id = p_account AND j.repo_id = p_repo AND j.runner_id = c.to_runner_id AND j.kind = 'engine_session_start' AND j.state = 'failed' AND j.issued_at >= c.sealed_at) >= 3 THEN
      UPDATE public.state_carries SET failure_code = 'import_failed' WHERE id = c.id AND account_id = c.account_id;
      DELETE FROM public.state_carry_chunks WHERE account_id = c.account_id AND carry_id = c.id;
      RETURN 'import_failed';
    END IF;
    INSERT INTO public.machine_jobs (id, account_id, runner_id, repo_id, setup_id, kind, job, attempt, issued_at, expires_at)
    VALUES (p_id, p_account, c.to_runner_id, p_repo, NULL, 'engine_session_start', p_job, 1, p_issued_at, p_expires_at);
    INSERT INTO public.audit_log (account_id, actor, action, payload)
    VALUES (p_account, session_user, 'engine_session.started', jsonb_build_object('repo_id', p_repo, 'job_id', p_id, 'cause', 'move_carry', 'resume', false, 'at_sha', p_job #>> '{job,args,at_sha}', 'operate_epoch', v_epoch));
    RETURN 'issued';
  END;
  $f$;

  -- The old machine's claim says its runner cannot carry: the open, unsealed, unfailed carry of its cleanup fails (`runner_update_needed`) and the content goes. The caller is the source machine's own session.
  CREATE FUNCTION public.state_carry_unsupported(p_cleanup uuid) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    rid  uuid := public.machine_job_runner();
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    v_id uuid;
  BEGIN
    UPDATE public.state_carries SET failure_code = 'runner_update_needed'
     WHERE account_id = acct AND cleanup_id = p_cleanup AND from_runner_id = rid AND closed_at IS NULL AND sealed_at IS NULL AND failure_code IS NULL RETURNING id INTO v_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'state_carry_unsupported: no such carry for this runner' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    DELETE FROM public.state_carry_chunks WHERE account_id = acct AND carry_id = v_id;
  END;
  $f$;

  -- 1123's machine_cleanup_issue, re-made: the stop carries the carry's id only while the carry is open, unsealed and has not failed. Nothing else changes.
  CREATE OR REPLACE FUNCTION public.machine_cleanup_issue(p_cleanup uuid, p_id uuid, p_kind text, p_job jsonb, p_issued_at timestamptz, p_expires_at timestamptz)
  RETURNS void
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $g$
  DECLARE
    rid   uuid := public.machine_job_runner();
    acct  uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    c     public.machine_cleanups%ROWTYPE;
    s     public.machine_cleanup_states%ROWTYPE;
    v_gh  bigint;
    v_carry uuid;
    epoch integer;
    j     jsonb := p_job #> '{job}';
    ok    boolean;
  BEGIN
    IF p_cleanup IS NULL OR p_id IS NULL OR p_kind IS NULL OR p_job IS NULL OR p_issued_at IS NULL OR p_expires_at IS NULL OR jsonb_typeof(j) IS DISTINCT FROM 'object'
       OR p_kind NOT IN ('engine_session_stop', 'engine_session_delete') THEN
      RAISE EXCEPTION 'machine_cleanup_issue: invalid argument' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT * INTO c FROM public.machine_cleanups x WHERE x.id = p_cleanup AND x.account_id = acct AND x.runner_id = rid FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'machine_cleanup_issue: no such cleanup for this runner' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    PERFORM public.machine_job_expire(rid);
    SELECT x.id INTO v_carry FROM public.state_carries x WHERE x.account_id = acct AND x.cleanup_id = c.id AND x.closed_at IS NULL AND x.sealed_at IS NULL AND x.failure_code IS NULL;
    SELECT * INTO s FROM public.machine_cleanup_states x WHERE x.id = c.id AND x.account_id = acct;
    IF NOT FOUND OR NOT s.open OR (p_kind = 'engine_session_delete' AND NOT c.delete_sandbox) THEN
      RAISE EXCEPTION 'machine_cleanup_issue: the cleanup is closed or the kind is not in its chain' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF c.reason = 'move' THEN
      ok := public.machine_cleanup_move_due(c.id, p_kind);
    ELSE
      ok := NOT s.live AND (s.newest_state IS NULL OR s.newest_state IN ('expired', 'superseded') OR (s.newest_state = 'failed' AND s.newest_ended_at <= now() - interval '60 minutes'));
      IF NOT ok AND p_kind = 'engine_session_delete' THEN
        -- The chain's second job: the newest stop or delete of the repo on this runner is this claim's stop, still issued, 1 ms earlier.
        ok := EXISTS (
          SELECT 1 FROM public.machine_jobs st
           WHERE st.account_id = acct AND st.repo_id = c.repo_id AND st.runner_id = rid AND st.kind = 'engine_session_stop' AND st.state = 'issued'
             AND st.issued_at >= c.requested_at AND st.issued_at = p_issued_at - interval '1 millisecond'
             AND NOT EXISTS (SELECT 1 FROM public.machine_jobs n WHERE n.account_id = acct AND n.repo_id = c.repo_id AND n.runner_id = rid
                               AND n.kind IN ('engine_session_stop', 'engine_session_delete') AND (n.issued_at, n.id) > (st.issued_at, st.id)));
      END IF;
    END IF;
    IF NOT ok THEN
      RAISE EXCEPTION 'machine_cleanup_issue: the cleanup is not due' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT r.gh_repo_id INTO v_gh FROM public.repos r WHERE r.account_id = acct AND r.id = c.repo_id;
    epoch := COALESCE((SELECT st.operate_epoch FROM public.engine_bridge_settings st WHERE st.account_id = acct), 0);
    IF j ->> 'job_id' IS DISTINCT FROM p_id::text OR j ->> 'kind' IS DISTINCT FROM p_kind OR j ->> 'runner_id' IS DISTINCT FROM rid::text
       OR jsonb_typeof(j -> 'repo_gh_id') IS DISTINCT FROM 'number' OR j ->> 'repo_gh_id' IS DISTINCT FROM v_gh::text
       OR j ? 'setup_id' OR j ->> 'requires_engine' IS DISTINCT FROM 'any'
       OR j ->> 'issued_at' IS NULL OR j ->> 'expires_at' IS NULL OR (j ->> 'issued_at')::timestamptz IS DISTINCT FROM p_issued_at OR (j ->> 'expires_at')::timestamptz IS DISTINCT FROM p_expires_at
       OR p_expires_at <= p_issued_at OR p_expires_at > p_issued_at + interval '30 minutes'
       OR p_issued_at < now() - interval '60 seconds' OR p_issued_at > now() + interval '60 seconds' OR p_issued_at < c.requested_at
       OR jsonb_typeof(j -> 'args') IS DISTINCT FROM 'object'
       OR jsonb_typeof(j #> '{args,operate_epoch}') IS DISTINCT FROM 'number' OR j #>> '{args,operate_epoch}' IS DISTINCT FROM epoch::text
       OR (p_kind = 'engine_session_stop' AND ((j -> 'args') - 'reason' - 'operate_epoch' - 'carry' <> '{}'::jsonb OR j #>> '{args,reason}' IS DISTINCT FROM c.reason
            OR (j #> '{args,carry}') IS DISTINCT FROM (CASE WHEN v_carry IS NULL THEN NULL ELSE jsonb_build_object('id', v_carry) END)))
       OR (p_kind = 'engine_session_delete' AND (j -> 'args') - 'operate_epoch' <> '{}'::jsonb) THEN
      RAISE EXCEPTION 'machine_cleanup_issue: the job does not match the cleanup' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    INSERT INTO public.machine_jobs (id, account_id, runner_id, repo_id, setup_id, kind, job, attempt, issued_at, expires_at)
    VALUES (p_id, acct, rid, c.repo_id, NULL, p_kind, p_job, 1, p_issued_at, p_expires_at);
  END;
  $g$;

  REVOKE ALL ON FUNCTION public.state_carry_starts_due(uuid, uuid, integer) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.state_carry_start_issue(uuid, uuid, uuid, uuid, jsonb, timestamptz, timestamptz) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.state_carry_unsupported(uuid) FROM PUBLIC;
  ALTER FUNCTION public.state_carry_starts_due(uuid, uuid, integer) OWNER TO engine_start_definer;
  ALTER FUNCTION public.state_carry_start_issue(uuid, uuid, uuid, uuid, jsonb, timestamptz, timestamptz) OWNER TO engine_start_definer;
  ALTER FUNCTION public.state_carry_unsupported(uuid) OWNER TO machine_jobs_owner;
  GRANT EXECUTE ON FUNCTION public.state_carry_starts_due(uuid, uuid, integer) TO platform_ops;
  GRANT EXECUTE ON FUNCTION public.state_carry_start_issue(uuid, uuid, uuid, uuid, jsonb, timestamptz, timestamptz) TO platform_ops;
  GRANT EXECUTE ON FUNCTION public.state_carry_unsupported(uuid) TO app_user;

  REVOKE CREATE ON SCHEMA public FROM machine_jobs_owner, engine_start_definer;
  IF NOT super THEN
    REVOKE machine_jobs_owner FROM CURRENT_USER;
    REVOKE engine_start_definer FROM CURRENT_USER;
  END IF;
END
$$;

-- The carries' sweep on the reconcile tick (1123's state_carry_sweep, EXECUTE: platform_ops): expiry after 24 h, a removed source before the seal, the content of failed and closed carries, the 30 day header.
INSERT INTO reconcile_jobs (name, interval_seconds) VALUES ('state_carry_sweep', 300) ON CONFLICT (name) DO NOTHING;
