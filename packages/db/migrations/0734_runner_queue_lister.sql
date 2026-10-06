-- D#6 R2b (correction C12 section 2.9 and section 5, "Sweeper"): the cross-tenant list the runner queue sweep needs.
--
-- A run for a runner_local repo waits in 'pending' until a runner claims it. If none does within 72 hours (the job's own
-- expires_at), the sweeper moves it to 'timed_out' with reason queue_ttl. The sweep starts with no tenant (agent_runs is
-- row-secured to one tenant at a time), so it asks this definer which runner runs are still waiting, oldest first, and
-- then settles each one under that run's own tenant context through the compare-and-set writer. The exact expiry is read
-- from the job there, not here: the signed job carries the task text, and platform_ops (the owner of this function, and
-- the login of the GitHub proxy) is deliberately not allowed to read job_signed (0714).
--
-- Returned: the run's account and id and when it was created, for pending runs whose execution_mode is 'runner_local' and
-- whose runtime is 'runner', oldest first, at most p_limit (1..50). Oldest first on purpose: a job expires 72 hours after
-- it was issued, which is never before the run was created, so the runs that can be expired are always at the front of the
-- list and a long queue of young ones cannot hide them. It writes nothing (STABLE) and refuses a direct platform_ops
-- login. EXECUTE is for the runner's login (agent_run_writer) only; app_user gets 42501.
--
-- The owner gains no privilege on job_signed or on any secret: every column read here was granted by 0619 (account_id,
-- status), 0714 (runtime, execution_mode) or is granted below (created_at, id), none of them secret.
-- Privilege brackets as in 0704.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

GRANT SELECT (id, created_at) ON agent_runs TO platform_ops;

CREATE FUNCTION agent_run_list_pending_runner_runs(p_limit int)
RETURNS TABLE (account_id uuid, run_id uuid, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'agent_run_list_pending_runner_runs: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'agent_run_list_pending_runner_runs: bad limit' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT a.account_id, a.id, a.created_at
    FROM public.agent_runs a
   WHERE a.status = 'pending' AND a.runtime = 'runner' AND a.execution_mode = 'runner_local'
   ORDER BY a.created_at, a.id
   LIMIT p_limit;
END $$;

REVOKE ALL ON FUNCTION agent_run_list_pending_runner_runs(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_run_list_pending_runner_runs(int) TO agent_run_writer;
ALTER FUNCTION agent_run_list_pending_runner_runs(int) OWNER TO platform_ops;
-- As 0704 does: the owner holds EXECUTE so a direct platform_ops login is refused by the check inside the function, which a
-- test pins, and not only by a missing ACL entry.
GRANT EXECUTE ON FUNCTION agent_run_list_pending_runner_runs(int) TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
