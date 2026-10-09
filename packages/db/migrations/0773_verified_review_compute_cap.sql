-- D#6 R5b-2b-i (correction C38 section 1, C40): the monthly cap on our sandbox compute for the reviews of cloud-verified pull requests.
--
-- verified_review_compute_capped(account) is true once the account's compute ledger rows for those reviews, in the current UTC month, reach the
-- figure written below. The figure is a constant in this function and never an argument (C28 section 3.4). Only 'compute' ledger rows count:
-- the customer's own model tokens are 'model' rows and never move the total. A review run is a run of one of the four reviewer roles with
-- execution_mode 'runner_verified' and runtime 'production' (0772). The month is read from the database clock, so it resets by itself at
-- 00:00 UTC on the 1st and nothing is stamped. The function runs with the caller's rights, so row security shows it only the caller's tenant.
--
-- Numbered by the Team Lead (0773), above 0772 (R5b-2a). Re-check against main right before merging.

CREATE FUNCTION verified_review_compute_capped(p_account_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT COALESCE(SUM(l.usd), 0) >= 5
    FROM public.ledger l
    JOIN public.agent_runs ar ON ar.account_id = l.account_id AND ar.id = l.run_id
   WHERE l.account_id = p_account_id
     AND l.kind = 'compute'
     AND ar.execution_mode = 'runner_verified' AND ar.runtime = 'production'
     AND ar.role IN ('code-reviewer', 'security-reviewer', 'acceptance-tester', 'debater')
     AND l.created_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
$$;

REVOKE ALL ON FUNCTION verified_review_compute_capped(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION verified_review_compute_capped(uuid) TO app_user;
