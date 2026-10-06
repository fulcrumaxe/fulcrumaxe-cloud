-- D#2 COMPUTE-SETTLE CS-2b-1: the cross-tenant list of runs whose compute settle is still owed. The per-minute sweep
-- has no tenant when it starts (agent_runs is row-secured to one tenant at a time), so it asks this one definer which
-- runs are due, then settles each under that run's own tenant context.
--
-- Returned: the run's identity (enough to name its sandbox), the stop time and the due mark, for runs whose
-- compute_settle_due_at is set AND which still hold an OPEN compute reservation, oldest due first, at most p_limit
-- (1..50) so a backlog cannot starve an old run. It writes nothing (STABLE) and refuses a direct platform_ops login.
-- EXECUTE is for the runner's login (agent_run_writer) only; app_user gets 42501.
--
-- What the owner (platform_ops) gains to run it, each narrow:
--   * SELECT on agent_runs.dispatch_pr_number (the rest of the columns it reads were granted by 0619/0642/0689);
--   * a row policy on spend_reservations showing it open foreground/background compute rows to any session but a
--     direct platform_ops login (the same shape as 0685's preview policy), so a direct login still sees no row.
-- Privilege brackets as in 0689.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

GRANT SELECT (dispatch_pr_number) ON agent_runs TO platform_ops;
CREATE POLICY platform_ops_open_compute ON spend_reservations FOR SELECT TO platform_ops
  USING (session_user <> 'platform_ops' AND state = 'open' AND budget IN ('foreground_compute', 'background_compute'));

CREATE FUNCTION compute_settle_list_due(p_limit int)
RETURNS TABLE (
  account_id uuid, run_id uuid, role text, dispatch_repo_id uuid, dispatch_pr_number bigint,
  sandbox_stopped_at timestamptz, compute_settle_due_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'compute_settle_list_due: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'compute_settle_list_due: bad limit' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT a.account_id, a.id, a.role::text, a.dispatch_repo_id, a.dispatch_pr_number, a.sandbox_stopped_at, a.compute_settle_due_at
    FROM public.agent_runs a
   WHERE a.compute_settle_due_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.spend_reservations s
                  WHERE s.account_id = a.account_id AND s.run_id = a.id AND s.state = 'open'
                    AND s.budget IN ('foreground_compute', 'background_compute'))
   ORDER BY a.compute_settle_due_at, a.id
   LIMIT p_limit;
END $$;

REVOKE ALL ON FUNCTION compute_settle_list_due(int) FROM PUBLIC, CURRENT_USER;
GRANT EXECUTE ON FUNCTION compute_settle_list_due(int) TO agent_run_writer;
ALTER FUNCTION compute_settle_list_due(int) OWNER TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
