-- 0704: the cross-tenant list of runs that are still `running`, for the lost-run sweep. A run whose sandbox was stopped
-- or deleted from outside never reaches its own finalize, so it stays `running` for good; the per-minute sweep has no
-- tenant when it starts (agent_runs is row-secured to one tenant at a time), so it asks this one definer which runs have
-- been running a while, then checks each one's sandbox and settles it under that run's own tenant context.
--
-- Returned: the run's identity (enough to name its sandbox) and when its sandbox was requested for runs with status 'running' whose sandbox was requested at
-- least p_min_age_seconds ago, in random order, at most p_limit (1..50). Random order, not oldest first: a run that is
-- genuinely still going is listed on every tick, and a fixed order would let 50 healthy long runs hide a stuck one behind
-- them. It writes nothing (STABLE) and refuses a direct platform_ops login. EXECUTE is for the runner's login
-- (agent_run_writer) only; app_user gets 42501.
--
-- The owner (platform_ops) gains no privilege: every column it reads was granted by 0619 (account_id, role, status,
-- dispatch_repo_id), 0689 (sandbox_requested_at) and 0691 (dispatch_pr_number), and its read policy on agent_runs (0619) is
-- unconditional, which is why a direct login is refused inside the function. A run that never requested a sandbox has no
-- request time and is never listed (there is no sandbox to lose).
-- Privilege brackets as in 0691.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

CREATE FUNCTION agent_run_list_running(p_limit int, p_min_age_seconds int)
RETURNS TABLE (account_id uuid, run_id uuid, role text, dispatch_repo_id uuid, dispatch_pr_number bigint, sandbox_requested_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'agent_run_list_running: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'agent_run_list_running: bad limit' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_min_age_seconds IS NULL OR p_min_age_seconds < 0 THEN
    RAISE EXCEPTION 'agent_run_list_running: bad age' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT a.account_id, a.id, a.role::text, a.dispatch_repo_id, a.dispatch_pr_number, a.sandbox_requested_at
    FROM public.agent_runs a
   WHERE a.status = 'running'
     AND a.sandbox_requested_at IS NOT NULL
     AND a.sandbox_requested_at <= now() - make_interval(secs => p_min_age_seconds)
   ORDER BY random()
   LIMIT p_limit;
END $$;

REVOKE ALL ON FUNCTION agent_run_list_running(int, int) FROM PUBLIC, CURRENT_USER;
GRANT EXECUTE ON FUNCTION agent_run_list_running(int, int) TO agent_run_writer;
ALTER FUNCTION agent_run_list_running(int, int) OWNER TO platform_ops;
-- The owner holds EXECUTE (as 0694 does for the 0691 lister), so a direct platform_ops login is refused by the check
-- inside the function, which a test pins, and not only by a missing ACL entry.
GRANT EXECUTE ON FUNCTION agent_run_list_running(int, int) TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
