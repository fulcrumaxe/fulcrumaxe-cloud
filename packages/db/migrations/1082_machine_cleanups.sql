-- D#845 ON-16a1: removing a project. machine_cleanups holds one request per repo and machine to stop the engine there (and delete its sandbox when ticked); the machine's own
-- claim issues the jobs, so an offline machine gets them when it comes back. Open is derived from the job rows on every read (machine_cleanup_states), never stamped. Four
-- definers owned by machine_jobs_owner: due and issue (a runner session only), request and supersede_starts (an owner or admin, never a runner; the second takes back the repo's undelivered starts). app_user writes nothing to the table itself.
-- `reason` is a closed list; a later migration widens the CHECK by name. Numbered 1082 by the Team Lead; never renumbered.

CREATE TABLE machine_cleanups (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id        uuid NOT NULL,
  runner_id      uuid NOT NULL,
  reason         text NOT NULL CONSTRAINT machine_cleanups_reason_check CHECK (reason IN ('remove')),
  delete_sandbox boolean NOT NULL,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  requested_by   uuid NOT NULL REFERENCES users (id),
  UNIQUE (account_id, id),
  -- One request per repo and machine: a later removal upserts it, which restarts the chain.
  CONSTRAINT machine_cleanups_one_per_pair UNIQUE (account_id, repo_id, runner_id),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE CASCADE
);

ALTER TABLE machine_cleanups ENABLE ROW LEVEL SECURITY;
ALTER TABLE machine_cleanups FORCE ROW LEVEL SECURITY;
REVOKE ALL ON machine_cleanups FROM PUBLIC;
-- A tenant read for app_user (a runner session sees only its own runner's rows); every write goes through the definers.
GRANT SELECT ON machine_cleanups TO app_user;
CREATE POLICY tenant_isolation_select ON machine_cleanups FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND (NULLIF(current_setting('app.runner_id', true), '') IS NULL OR runner_id::text = lower(current_setting('app.runner_id', true)))
  );

-- The derivation. Invoker rights, so each reader sees only what its own policies show it (app_user: the account, and in a runner session that runner only).
-- A chain job is a stop or delete of the request's repo on the request's runner issued at or after `requested_at`. `newest_*` is the newest chain job.
CREATE VIEW machine_cleanup_states WITH (security_invoker = true) AS
  SELECT c.id, c.account_id, c.repo_id, c.runner_id, c.reason, c.delete_sandbox, c.requested_at,
         f.final_kind,
         (rn.revoked_at IS NOT NULL) AS revoked,
         COALESCE(j.final_done, false) AS final_done,
         COALESCE(j.final_failures, 0) AS final_failures,
         COALESCE(j.live, false) AS live,
         (rn.revoked_at IS NULL AND NOT COALESCE(j.final_done, false) AND COALESCE(j.final_failures, 0) < 3) AS open,
         n.state AS newest_state,
         n.ended_at AS newest_ended_at,
         lf.failure_code AS last_failure_code
    FROM machine_cleanups c
    JOIN runners rn ON rn.account_id = c.account_id AND rn.id = c.runner_id
    CROSS JOIN LATERAL (SELECT CASE WHEN c.delete_sandbox THEN 'engine_session_delete' ELSE 'engine_session_stop' END AS final_kind) f
    LEFT JOIN LATERAL (
      SELECT bool_or(x.kind = f.final_kind AND x.state = 'done') AS final_done,
             count(*) FILTER (WHERE x.kind = f.final_kind AND x.state = 'failed') AS final_failures,
             bool_or(x.state IN ('issued', 'delivered')) AS live
        FROM machine_jobs x
       WHERE x.account_id = c.account_id AND x.repo_id = c.repo_id AND x.runner_id = c.runner_id
         AND x.kind IN ('engine_session_stop', 'engine_session_delete') AND x.issued_at >= c.requested_at
    ) j ON true
    LEFT JOIN LATERAL (
      SELECT x.state, x.ended_at FROM machine_jobs x
       WHERE x.account_id = c.account_id AND x.repo_id = c.repo_id AND x.runner_id = c.runner_id
         AND x.kind IN ('engine_session_stop', 'engine_session_delete') AND x.issued_at >= c.requested_at
       ORDER BY x.issued_at DESC, x.id DESC LIMIT 1
    ) n ON true
    LEFT JOIN LATERAL (
      SELECT x.failure_code FROM machine_jobs x
       WHERE x.account_id = c.account_id AND x.repo_id = c.repo_id AND x.runner_id = c.runner_id
         AND x.kind = f.final_kind AND x.state = 'failed' AND x.issued_at >= c.requested_at
       ORDER BY x.issued_at DESC, x.id DESC LIMIT 1
    ) lf ON true;

REVOKE ALL ON machine_cleanup_states FROM PUBLIC;
GRANT SELECT ON machine_cleanup_states TO app_user;

-- ---- what machine_jobs_owner reads and writes for the three functions, in the session's account only ------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON machine_cleanups TO machine_jobs_owner;
GRANT SELECT ON machine_cleanup_states TO machine_jobs_owner;
GRANT SELECT (id, account_id, gh_repo_id) ON repos TO machine_jobs_owner;
GRANT SELECT (account_id, operate_epoch) ON engine_bridge_settings TO machine_jobs_owner;
CREATE POLICY machine_jobs_owner_use ON machine_cleanups FOR ALL TO machine_jobs_owner
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY machine_jobs_owner_use ON repos FOR SELECT TO machine_jobs_owner USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY machine_jobs_owner_use ON engine_bridge_settings FOR SELECT TO machine_jobs_owner USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- ---- the functions: created by the migration role holding machine_jobs_owner for the hand-over (1066's shape) ---------------------------------------
DO $$
DECLARE
  super boolean := (SELECT rolsuper FROM pg_roles WHERE rolname = current_user);
BEGIN
  IF (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid = 'public.machine_job_runner()'::regprocedure) IS DISTINCT FROM 'machine_jobs_owner' THEN
    RAISE EXCEPTION 'machine_job_runner is not owned by machine_jobs_owner; this migration was written for 1053''s owner';
  END IF;
  IF NOT super THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'machine_jobs_owner'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on machine_jobs_owner; cannot hand the cleanup functions over';
    END IF;
    GRANT machine_jobs_owner TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
  GRANT CREATE ON SCHEMA public TO machine_jobs_owner;

  -- What to sign now for the session's runner, one row per job, in issue order (each request's stop before its delete). A request is due when it is open, none of its chain jobs is
  -- issued or delivered, and either none was issued yet, the newest ended expired or superseded, or the newest ended failed at least 60 minutes ago. o_epoch is the account's operate epoch now.
  CREATE FUNCTION public.machine_cleanup_due()
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
       WHERE s.account_id = acct AND s.runner_id = rid AND s.open AND NOT s.live
         AND (s.newest_state IS NULL OR s.newest_state IN ('expired', 'superseded') OR (s.newest_state = 'failed' AND s.newest_ended_at <= now() - interval '60 minutes'))
         AND (k.ord = 1 OR s.delete_sandbox)
       ORDER BY s.requested_at, s.id, k.ord
       LIMIT 40;
  END;
  $f$;

  -- One signed job of a due request, from the runner's own claim. The request row is held FOR UPDATE, so two claims cannot both issue it. A stop needs the request to be due; a delete needs it
  -- to be due too, or to be the second job of the chain this claim just issued: the newest stop or delete of the repo on this runner is a stop still `issued` exactly 1 ms before it.
  -- The signed bytes are held to the request; any mismatch is invalid_parameter_value and nothing is written.
  CREATE FUNCTION public.machine_cleanup_issue(p_cleanup uuid, p_id uuid, p_kind text, p_job jsonb, p_issued_at timestamptz, p_expires_at timestamptz)
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
    IF NOT ok THEN
      RAISE EXCEPTION 'machine_cleanup_issue: the cleanup is not due' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT r.gh_repo_id INTO v_gh FROM public.repos r WHERE r.account_id = acct AND r.id = c.repo_id;
    epoch := COALESCE((SELECT st.operate_epoch FROM public.engine_bridge_settings st WHERE st.account_id = acct), 0);
    -- The signed bytes say exactly this job: its id and kind, this runner, the request's repo, no setup, any engine, the request's own stop reason, the epoch now, a life of at most 30 minutes, issued within 60 s of now
    -- and not before the request (a job from before it would not count as its chain, so the request would never close).
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

  -- The removal's request: a person (an owner or admin of the session's active account), never a runner. A second request for the same repo and machine restarts the chain.
  CREATE FUNCTION public.machine_cleanup_request(p_repo uuid, p_runner uuid, p_delete boolean)
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
      RAISE EXCEPTION 'machine_cleanup_request: refused' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_repo IS NULL OR p_runner IS NULL OR p_delete IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.repos r WHERE r.account_id = acct AND r.id = p_repo)
       OR NOT EXISTS (SELECT 1 FROM public.runners r WHERE r.account_id = acct AND r.id = p_runner AND r.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'machine_cleanup_request: invalid argument' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    INSERT INTO public.machine_cleanups AS c (account_id, repo_id, runner_id, reason, delete_sandbox, requested_by)
    VALUES (acct, p_repo, p_runner, 'remove', p_delete, usr)
    ON CONFLICT (account_id, repo_id, runner_id) DO UPDATE SET reason = EXCLUDED.reason, delete_sandbox = EXCLUDED.delete_sandbox, requested_at = now(), requested_by = EXCLUDED.requested_by
    RETURNING c.id INTO v_id;
    RETURN v_id;
  END;
  $f$;

  -- Ruling 92.1: a removal also takes back every start of the repo on that machine that the machine has not been handed yet (`issued`), so it can never start the engine after the removal. A start already `delivered`
  -- is the machine's: the cleanup chain's stop and delete are issued after it. Same caller as the request (an owner or admin, never a runner); only the session's account, the one repo and the one machine.
  CREATE FUNCTION public.machine_cleanup_supersede_starts(p_repo uuid, p_runner uuid)
  RETURNS integer
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
    n integer;
  BEGIN
    IF session_user = 'platform_ops' OR acct IS NULL OR usr IS NULL OR NOT public.account_is_active(acct) OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin')) THEN
      RAISE EXCEPTION 'machine_cleanup_supersede_starts: refused' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_repo IS NULL OR p_runner IS NULL
       OR NOT EXISTS (SELECT 1 FROM public.repos r WHERE r.account_id = acct AND r.id = p_repo)
       OR NOT EXISTS (SELECT 1 FROM public.runners r WHERE r.account_id = acct AND r.id = p_runner) THEN
      RAISE EXCEPTION 'machine_cleanup_supersede_starts: invalid argument' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    UPDATE public.machine_jobs SET state = 'superseded', ended_at = now()
     WHERE account_id = acct AND repo_id = p_repo AND runner_id = p_runner AND kind = 'engine_session_start' AND state = 'issued';
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
  END;
  $f$;

  REVOKE ALL ON FUNCTION public.machine_cleanup_due() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.machine_cleanup_issue(uuid, uuid, text, jsonb, timestamptz, timestamptz) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.machine_cleanup_request(uuid, uuid, boolean) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.machine_cleanup_supersede_starts(uuid, uuid) FROM PUBLIC;
  ALTER FUNCTION public.machine_cleanup_due() OWNER TO machine_jobs_owner;
  ALTER FUNCTION public.machine_cleanup_issue(uuid, uuid, text, jsonb, timestamptz, timestamptz) OWNER TO machine_jobs_owner;
  ALTER FUNCTION public.machine_cleanup_request(uuid, uuid, boolean) OWNER TO machine_jobs_owner;
  ALTER FUNCTION public.machine_cleanup_supersede_starts(uuid, uuid) OWNER TO machine_jobs_owner;
  -- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner).
  GRANT EXECUTE ON FUNCTION public.machine_cleanup_due() TO app_user;
  GRANT EXECUTE ON FUNCTION public.machine_cleanup_issue(uuid, uuid, text, jsonb, timestamptz, timestamptz) TO app_user;
  GRANT EXECUTE ON FUNCTION public.machine_cleanup_request(uuid, uuid, boolean) TO app_user;
  GRANT EXECUTE ON FUNCTION public.machine_cleanup_supersede_starts(uuid, uuid) TO app_user;

  REVOKE CREATE ON SCHEMA public FROM machine_jobs_owner;
  IF NOT super THEN
    REVOKE machine_jobs_owner FROM CURRENT_USER;
  END IF;
END
$$;
