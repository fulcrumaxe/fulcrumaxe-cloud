-- D#2 COMPUTE-SETTLE backoff: a run whose settle keeps throwing is listed again first on every tick, so enough of them
-- can fill the tick's batch and time budget and starve newer due runs. This records each failed settle and holds the
-- run out of the list until a retry time that doubles per failure.
--
-- compute_settle_due_at is set once (0689's guard), so the backoff has columns of its own:
--   * compute_settle_failures: how many settles of this run have thrown (a run still waiting for figures is not one);
--   * compute_settle_retry_at: when the run may be listed again; NULL = now.
-- Neither is writable by app_user (column-scoped UPDATE grants never named them: an UPDATE gets 42501). Only the
-- runner's login (agent_run_writer) records a failure, through the one definer below.
--
-- The ladder is 1, 2, 4, 8, 16, 32 minutes, then 60 minutes for the seventh failure and every one after it.
-- A run is never dropped from the list: it only waits.
-- Privilege brackets as in 0689.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

ALTER TABLE agent_runs
  ADD COLUMN compute_settle_failures int NOT NULL DEFAULT 0,
  ADD COLUMN compute_settle_retry_at timestamptz NULL;

GRANT SELECT (compute_settle_failures, compute_settle_retry_at) ON agent_runs TO platform_ops;
GRANT UPDATE (compute_settle_failures, compute_settle_retry_at) ON agent_runs TO platform_ops;

CREATE FUNCTION agent_run_settle_failed(p_account_id uuid, p_run_id uuid)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_failures int;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'agent_run_settle_failed: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_account_id IS NULL OR p_account_id IS DISTINCT FROM NULLIF(current_setting('app.account_id', true), '')::uuid THEN
    RAISE EXCEPTION 'agent_run_settle_failed: account % is not the caller''s tenant context', p_account_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The wait before the next try is 2^(failures so far) minutes, capped at 60 (the exponent is capped too, so it cannot overflow).
  UPDATE public.agent_runs SET
    compute_settle_failures = compute_settle_failures + 1,
    compute_settle_retry_at = now() + interval '1 minute' * least(power(2, least(compute_settle_failures, 10)), 60)
  WHERE account_id = p_account_id AND id = p_run_id
  RETURNING compute_settle_failures INTO v_failures;
  RETURN COALESCE(v_failures, 0);
END $$;
REVOKE ALL ON FUNCTION agent_run_settle_failed(uuid, uuid) FROM PUBLIC, CURRENT_USER;
GRANT EXECUTE ON FUNCTION agent_run_settle_failed(uuid, uuid) TO agent_run_writer;
ALTER FUNCTION agent_run_settle_failed(uuid, uuid) OWNER TO platform_ops;

-- 0691's lister, unchanged but for the retry filter (same signature, owner and ACL). The function exists and
-- platform_ops owns it, but 0691 revoked the creator's own EXECUTE before the transfer, so the owner holds none; a
-- non-superuser migrator's replace needs it, so the owner's EXECUTE is restored first (a direct platform_ops login is
-- still refused inside the function, and the ACL's other entries are unchanged).
GRANT EXECUTE ON FUNCTION compute_settle_list_due(int) TO platform_ops;
CREATE OR REPLACE FUNCTION compute_settle_list_due(p_limit int)
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
     AND (a.compute_settle_retry_at IS NULL OR a.compute_settle_retry_at <= now())
     AND EXISTS (SELECT 1 FROM public.spend_reservations s
                  WHERE s.account_id = a.account_id AND s.run_id = a.id AND s.state = 'open'
                    AND s.budget IN ('foreground_compute', 'background_compute'))
   ORDER BY a.compute_settle_due_at, a.id
   LIMIT p_limit;
END $$;

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
