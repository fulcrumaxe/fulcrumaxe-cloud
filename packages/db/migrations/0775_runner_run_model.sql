-- D#6 C42-5: a runner run records its model when a runner takes it, so its usage can be priced.
--
-- Why. agent_run_create has no model parameter, and no other path wrote agent_runs.model for a run on the customer's own machine. The
-- runner_usage_add definer (0768) stamps the usage row's model from that column, so every runner run's usage row had model NULL and
-- runner_usage_price was never called: the item showed an API-equivalent figure of 0 for a run that spent real tokens.
--
-- 1. agent_run_runner_claim (0754) now also copies the model hint of the run's own signed job onto the run, in the same UPDATE that gives
--    the run to the runner, when the column is still empty and the hint is one of the three ids agent_runs.model admits. The hint comes
--    from the job the cloud itself built and signed (job_signed -> job -> model_hint), never from the runner. A usage event can only follow a
--    claim, so the model is always there before the first token is added. Nothing else in the function changes. The claim's definer role,
--    runner_lease_definer, already reads job_signed; it gains SELECT and UPDATE on exactly this one column. platform_ops gains nothing.
--
-- 2. Runs that already exist are not back-filled: both tables force row security, so a migration role without a tenant context cannot
--    write them. Their usage stays "not priced" and is not invented; only runs claimed after this file carry a model.
--
-- Numbered above the highest migration on the code plane (0774). Re-check against main right before merging.

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'runner_lease_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_lease_definer; cannot replace its functions';
    END IF;
    GRANT runner_lease_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

GRANT SELECT (model), UPDATE (model) ON agent_runs TO runner_lease_definer;

CREATE OR REPLACE FUNCTION agent_run_runner_claim(
  p_account_id     uuid,
  p_run_id         uuid,
  p_runner_id      uuid,
  p_now            timestamptz,
  p_lease_seconds  integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_generation integer;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'agent_run_runner_claim: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_account_id IS NULL
     OR p_account_id IS DISTINCT FROM NULLIF(current_setting('app.account_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'agent_run_runner_claim: account % is not the caller''s tenant context', p_account_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_run_id IS NULL OR p_runner_id IS NULL OR p_now IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'agent_run_runner_claim: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.runners r WHERE r.id = p_runner_id AND r.account_id = p_account_id AND r.revoked_at IS NULL) THEN
    RETURN NULL;
  END IF;
  UPDATE public.agent_runs
     SET runner_id = p_runner_id,
         lease_generation = lease_generation + 1,
         lease_expires_at = p_now + make_interval(secs => p_lease_seconds),
         model = COALESCE(model, CASE WHEN job_signed #>> '{job,model_hint}' IN ('haiku-4.5', 'sonnet-5', 'opus-5') THEN job_signed #>> '{job,model_hint}' END),
         updated_at = now()
   WHERE account_id = p_account_id AND id = p_run_id
     AND status = 'running' AND runtime = 'runner' AND runner_id IS NULL AND lease_generation = 0
     AND (claimable_after IS NULL OR claimable_after <= p_now)
  RETURNING lease_generation INTO v_generation;
  RETURN v_generation;
END;
$$;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_lease_definer FROM CURRENT_USER;
  END IF;
END
$$;
