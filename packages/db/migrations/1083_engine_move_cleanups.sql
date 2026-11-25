-- D#845 MC-9b1: a move leaves a `machine_cleanups` request (reason `move`) for the machine the project left, and the old machine's own claim issues its stop and its delete.
--
--   1. machine_cleanups.reason now also allows 'move' (1082's CHECK, widened by name).
--   2. machine_cleanup_move_due (new, owned by machine_jobs_owner, invoker rights, no EXECUTE for app_user): the move rule, in one place that both definers below call. Derived from the rows on every call, never stamped.
--        stop     due at once, and again when the one issued expired or was superseded; not while one is issued or delivered, after one is done, or for 60 minutes after one failed.
--        delete   due only once the project's CURRENT session has reported: an `engine_sessions` row of the repo on the runner the repo is placed on now (not the cleanup's), with last_heartbeat_at at or after the request;
--                 or the project has no placement any more (it was removed before the new session reported, so the old copy has nobody to wait for). Not while one is issued or delivered, after one is done, or for 60 minutes after one failed.
--      A remove request keeps 1082's rule unchanged.
--   3. machine_cleanup_due and machine_cleanup_issue are re-made (CREATE OR REPLACE, 1082's bodies carried forward) to use it for a 'move' request. The stop's signed reason is the request's own ('move').
--   4. machine_cleanup_request_move (new): the move's request, an owner or admin and never a runner, and refused while the repo is placed on that machine (a delete there would wipe the live session).
--   5. What machine_jobs_owner reads for the rule, in the session's account only: three columns of engine_sessions and of project_placements.
--
-- Numbered 1083 by the Team Lead; it merges after 1082. Re-check against main right before merging and renumber to stay above its highest.

ALTER TABLE machine_cleanups DROP CONSTRAINT machine_cleanups_reason_check;
ALTER TABLE machine_cleanups ADD CONSTRAINT machine_cleanups_reason_check CHECK (reason IN ('remove', 'move'));

GRANT SELECT (account_id, repo_id, runner_id, session_kind, last_heartbeat_at) ON engine_sessions TO machine_jobs_owner;
GRANT SELECT (account_id, repo_id, runner_id) ON project_placements TO machine_jobs_owner;
CREATE POLICY machine_jobs_owner_use ON engine_sessions FOR SELECT TO machine_jobs_owner USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY machine_jobs_owner_use ON project_placements FOR SELECT TO machine_jobs_owner USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

DO $$
DECLARE
  super boolean := (SELECT rolsuper FROM pg_roles WHERE rolname = current_user);
BEGIN
  IF (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid = 'public.machine_cleanup_due()'::regprocedure) IS DISTINCT FROM 'machine_jobs_owner' THEN
    RAISE EXCEPTION 'machine_cleanup_due is not owned by machine_jobs_owner; this migration was written for 1082''s owner';
  END IF;
  IF NOT super THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'machine_jobs_owner'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on machine_jobs_owner; cannot re-make the cleanup functions';
    END IF;
    GRANT machine_jobs_owner TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
  GRANT CREATE ON SCHEMA public TO machine_jobs_owner;

  CREATE FUNCTION public.machine_cleanup_move_due(p_cleanup uuid, p_kind text) RETURNS boolean
  LANGUAGE sql
  STABLE
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
    SELECT COALESCE((
      SELECT p_kind IN ('engine_session_stop', 'engine_session_delete')
         AND NOT EXISTS (
               SELECT 1 FROM public.machine_jobs x
                WHERE x.account_id = c.account_id AND x.repo_id = c.repo_id AND x.runner_id = c.runner_id AND x.kind = p_kind AND x.issued_at >= c.requested_at
                  AND (x.state IN ('issued', 'delivered', 'done') OR (x.state = 'failed' AND x.ended_at > now() - interval '60 minutes')))
         AND (p_kind = 'engine_session_stop'
              OR NOT EXISTS (SELECT 1 FROM public.project_placements pl WHERE pl.account_id = c.account_id AND pl.repo_id = c.repo_id)
              OR EXISTS (SELECT 1 FROM public.project_placements pl
                           JOIN public.engine_sessions es ON es.account_id = pl.account_id AND es.repo_id = pl.repo_id AND es.runner_id = pl.runner_id
                          WHERE pl.account_id = c.account_id AND pl.repo_id = c.repo_id AND pl.runner_id <> c.runner_id
                            AND es.session_kind = 'engine' AND es.last_heartbeat_at >= c.requested_at))
        FROM public.machine_cleanups c
       WHERE c.id = p_cleanup AND c.reason = 'move' AND c.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    ), false);
  $f$;

  CREATE OR REPLACE FUNCTION public.machine_cleanup_due()
  RETURNS TABLE (o_cleanup uuid, o_repo uuid, o_gh_repo_id bigint, o_kind text, o_reason text, o_epoch integer)
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    rid   uuid := public.machine_job_runner();
    acct  uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    epoch integer;
  BEGIN
    PERFORM public.machine_job_expire(rid);
    epoch := COALESCE((SELECT st.operate_epoch FROM public.engine_bridge_settings st WHERE st.account_id = acct), 0);
    RETURN QUERY
      SELECT s.id, s.repo_id, r.gh_repo_id, k.kind, s.reason, epoch
        FROM public.machine_cleanup_states s
        JOIN public.repos r ON r.account_id = s.account_id AND r.id = s.repo_id
        CROSS JOIN LATERAL (VALUES (1, 'engine_session_stop'), (2, 'engine_session_delete')) AS k (ord, kind)
       WHERE s.account_id = acct AND s.runner_id = rid AND s.open
         AND (CASE WHEN s.reason = 'move' THEN public.machine_cleanup_move_due(s.id, k.kind)
                   ELSE NOT s.live
                        AND (s.newest_state IS NULL OR s.newest_state IN ('expired', 'superseded') OR (s.newest_state = 'failed' AND s.newest_ended_at <= now() - interval '60 minutes'))
                        AND (k.ord = 1 OR s.delete_sandbox) END)
       ORDER BY s.requested_at, s.id, k.ord
       LIMIT 40;
  END;
  $f$;

  CREATE OR REPLACE FUNCTION public.machine_cleanup_issue(p_cleanup uuid, p_id uuid, p_kind text, p_job jsonb, p_issued_at timestamptz, p_expires_at timestamptz)
  RETURNS void
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    rid   uuid := public.machine_job_runner();
    acct  uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    c     public.machine_cleanups%ROWTYPE;
    s     public.machine_cleanup_states%ROWTYPE;
    v_gh  bigint;
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
       OR (p_kind = 'engine_session_stop' AND ((j -> 'args') - 'reason' - 'operate_epoch' <> '{}'::jsonb OR j #>> '{args,reason}' IS DISTINCT FROM c.reason))
       OR (p_kind = 'engine_session_delete' AND (j -> 'args') - 'operate_epoch' <> '{}'::jsonb) THEN
      RAISE EXCEPTION 'machine_cleanup_issue: the job does not match the cleanup' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    INSERT INTO public.machine_jobs (id, account_id, runner_id, repo_id, setup_id, kind, job, attempt, issued_at, expires_at)
    VALUES (p_id, acct, rid, c.repo_id, NULL, p_kind, p_job, 1, p_issued_at, p_expires_at);
  END;
  $f$;

  -- The move's request: a person (an owner or admin of the session's active account), never a runner, for a machine the project is no longer placed on. A second request for the same repo and machine restarts the chain.
  CREATE FUNCTION public.machine_cleanup_request_move(p_repo uuid, p_runner uuid)
  RETURNS uuid
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
    v_id uuid;
  BEGIN
    IF session_user = 'platform_ops' OR acct IS NULL OR usr IS NULL OR NOT public.account_is_active(acct) OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin')) THEN
      RAISE EXCEPTION 'machine_cleanup_request_move: refused' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_repo IS NULL OR p_runner IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.repos r WHERE r.account_id = acct AND r.id = p_repo)
       OR NOT EXISTS (SELECT 1 FROM public.runners r WHERE r.account_id = acct AND r.id = p_runner AND r.revoked_at IS NULL)
       OR EXISTS (SELECT 1 FROM public.project_placements pl WHERE pl.account_id = acct AND pl.repo_id = p_repo AND pl.runner_id = p_runner) THEN
      RAISE EXCEPTION 'machine_cleanup_request_move: invalid argument' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    INSERT INTO public.machine_cleanups AS c (account_id, repo_id, runner_id, reason, delete_sandbox, requested_by)
    VALUES (acct, p_repo, p_runner, 'move', true, usr)
    ON CONFLICT (account_id, repo_id, runner_id) DO UPDATE SET reason = 'move', delete_sandbox = true, requested_at = now(), requested_by = EXCLUDED.requested_by
    RETURNING c.id INTO v_id;
    RETURN v_id;
  END;
  $f$;

  REVOKE ALL ON FUNCTION public.machine_cleanup_move_due(uuid, text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.machine_cleanup_request_move(uuid, uuid) FROM PUBLIC;
  ALTER FUNCTION public.machine_cleanup_move_due(uuid, text) OWNER TO machine_jobs_owner;
  ALTER FUNCTION public.machine_cleanup_request_move(uuid, uuid) OWNER TO machine_jobs_owner;
  -- EXECUTE after the transfer. The two re-made functions keep their owner and their grants (CREATE OR REPLACE); the rule helper is the definers' alone.
  GRANT EXECUTE ON FUNCTION public.machine_cleanup_request_move(uuid, uuid) TO app_user;

  REVOKE CREATE ON SCHEMA public FROM machine_jobs_owner;
  IF NOT super THEN
    REVOKE machine_jobs_owner FROM CURRENT_USER;
  END IF;
END
$$;
