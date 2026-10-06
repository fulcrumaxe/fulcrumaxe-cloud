-- D#2 H14c-3-2a3 (builds on 0658 and 0682).
-- run_action_claim_due leased what it listed (state 'claimed', a 60 s lease,
-- attempts + 1), so the per-minute sweep used up the claim that the kicked
-- workflow's own run_action_claim needs: the workflow saw NULL, exited as a
-- duplicate, and a lost kick was never performed while attempts climbed.
-- run_action_list_due only LISTS the due ids and writes nothing; the workflow's
-- run_action_claim takes the lease. Exactly-once is unchanged: two sweeps may
-- list one id and start two workflows, but one run_action_claim wins.
-- A new name, not a body swap, so nothing can keep calling the leasing
-- behaviour under the old name; the old function is dropped (no CASCADE).
-- Privilege brackets as in 0682: INHERIT on platform_ops to drop its function,
-- CREATE on schema public for the ownership transfer.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

DROP FUNCTION run_action_claim_due(int, int);

-- STABLE: the database itself refuses a write from this function.
CREATE FUNCTION run_action_list_due(p_min_age_seconds int, p_limit int) RETURNS SETOF uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'run_action_list_due: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_min_age_seconds IS NULL OR p_min_age_seconds < 0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'run_action_list_due: bad age or limit' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The same eligibility as run_action_claim, so a listed id is one a claim can take.
  RETURN QUERY
  SELECT q.id FROM public.run_action_requests q
   WHERE (q.state = 'accepted' AND q.created_at < now() - make_interval(secs => p_min_age_seconds)
          AND (q.not_before IS NULL OR q.not_before <= now()))
      OR (q.state = 'claimed' AND q.claimed_until < now())
   ORDER BY q.created_at, q.id LIMIT p_limit;
END $$;

-- The 0658 ACL: EXECUTE for agent_run_writer only (revoked from the owner first).
REVOKE ALL ON FUNCTION run_action_list_due(int, int) FROM PUBLIC, CURRENT_USER;
GRANT EXECUTE ON FUNCTION run_action_list_due(int, int) TO agent_run_writer;
ALTER FUNCTION run_action_list_due(int, int) OWNER TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
