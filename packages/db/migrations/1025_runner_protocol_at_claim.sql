-- D#6 CHECKFIX-PROTOCOL-AT-CLAIM: record the claiming runner's protocol version on the run, at claim time.
--
-- Why: a check-fix round may widen its file scope from the failed run's check summary, but only when the runner that ran that check wrote the header end marker (protocol 19 and up).
-- Reading the runner's CURRENT protocol leaves a time-of-check gap (CWE-367): a runner that ran the check at 18, then upgraded and said hello at 19, would have its old, forgeable summary trusted.
-- The protocol the runner held WHEN IT CLAIMED the run is what describes the code that ran the check, so it is stored on the run.
--
-- What:
--   1. agent_runs.runner_protocol_version smallint NULL (at least 1 when set). NULL means unknown (every run claimed before this file, or a runner with no hello): a reader treats it as "no".
--   2. agent_run_runner_claim (0805) sets it in the same UPDATE that binds the runner, from the cloud's own `runners.protocol_version` row, never from anything the runner sends. The body is 0805's, word for word, plus that one assignment.
--   3. A guard trigger lets the column change only in the claim (runner_id goes from NULL to set, the value equals the runner's stored one) and only by runner_lease_definer or a superuser; an insert carries NULL.
--   4. Grants: SELECT to app_user (the worker reads it; the column is on AGENT_RUN_COLUMNS, as 0756 requires), UPDATE to runner_lease_definer. platform_ops gains nothing.
--
-- Rollback (expand/contract): the previous deploy never names the column and its claim leaves it NULL; a later migration may drop it.
--
-- Numbered 1025: main's highest is 1022, #966 holds 1023, 1024 is reserved for another change. Re-check against main right before merging.

ALTER TABLE agent_runs ADD COLUMN runner_protocol_version smallint;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_runner_protocol_version_check CHECK (runner_protocol_version IS NULL OR runner_protocol_version >= 1);

GRANT SELECT (runner_protocol_version) ON agent_runs TO app_user;

CREATE OR REPLACE FUNCTION agent_runs_runner_protocol_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.runner_protocol_version IS NOT NULL THEN
      RAISE EXCEPTION 'agent_runs.runner_protocol_version is written by the claim only (run %)', NEW.id USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.runner_protocol_version IS DISTINCT FROM OLD.runner_protocol_version THEN
    IF current_user <> 'runner_lease_definer' AND NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false) THEN
      RAISE EXCEPTION 'agent_runs.runner_protocol_version is written only by the claim (run %)', OLD.id USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.runner_id IS NOT NULL OR OLD.runner_protocol_version IS NOT NULL OR NEW.runner_id IS NULL
       OR NEW.runner_protocol_version IS DISTINCT FROM (SELECT r.protocol_version FROM public.runners r WHERE r.id = NEW.runner_id AND r.account_id = NEW.account_id)
    THEN
      RAISE EXCEPTION 'agent_runs.runner_protocol_version is set once, with the claim, to the runner''s stored protocol (run %)', OLD.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER agent_runs_runner_protocol_guard
  BEFORE INSERT OR UPDATE ON agent_runs
  FOR EACH ROW
  EXECUTE FUNCTION agent_runs_runner_protocol_guard();

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

GRANT UPDATE (runner_protocol_version) ON agent_runs TO runner_lease_definer;

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
         -- D#6 CHECKFIX-PROTOCOL-AT-CLAIM: the protocol the cloud holds for this runner at this moment (its last verified hello), recorded with the claim.
         runner_protocol_version = (SELECT r.protocol_version FROM public.runners r WHERE r.id = p_runner_id AND r.account_id = p_account_id),
         updated_at = now()
   WHERE account_id = p_account_id AND id = p_run_id
     AND status = 'running' AND runtime = 'runner' AND runner_id IS NULL AND lease_generation = 0
     AND (claimable_after IS NULL OR claimable_after <= p_now)
     -- D#599 PL-2b-1: a job in the cross-side shape goes only to a runner whose stored protocol version has reached the job's minimum.
     AND (min_protocol_version IS NULL
          OR min_protocol_version <= COALESCE((SELECT r.protocol_version FROM public.runners r WHERE r.id = p_runner_id AND r.account_id = p_account_id), 0))
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
