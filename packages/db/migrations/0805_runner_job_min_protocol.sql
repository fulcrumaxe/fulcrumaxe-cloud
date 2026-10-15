-- D#599 PL-2b-1: a runner job can carry the lowest protocol version of a runner that may claim it.
--
-- Why: a job in the cross-side shape (a null session id, or a pull request number in `continues`) does not parse on a runner that predates it,
-- and a runner parses a claim reply strictly, so one such job would fail the whole reply. Compatibility is a cloud-side gate (ruling R-599-HO1):
-- the claim query skips a job whose `min_protocol_version` is above the claiming runner's stored `runners.protocol_version`. NULL means any runner,
-- which is every job written before this file and every job that is not in the new shape. The gate is derived from stored rows at claim time and
-- stamps nothing on a runner: an updated runner's next hello lifts it.
--
-- What:
--   1. agent_runs.min_protocol_version integer NULL, at least 1 when set. app_user may read it (the claim runs on a member of app_user); the column is
--      on AGENT_RUN_COLUMNS in packages/core/src/tenancy/scopedAccess.ts, as 0756 requires.
--   2. agent_runs_runner_columns_guard (0714) copies the transaction-local value `fx.job_min_protocol` into the column, in the same UPDATE that first
--      sets job_signed (which only agent_run_set_runner_job can do), and refuses any other change of the column. So the value is written exactly once,
--      together with the job, and by no one else. The issuer sets the value in the transaction that calls the definer and clears it after.
--
--   3. agent_run_runner_claim (0775) enforces the gate in the database too (end of this file), and the guard refuses a first job write in the cross-side
--      shape that carries no minimum.
--
-- No function is added; the guard and agent_run_runner_claim are replaced. The only grants are SELECT on the two columns the claim reads, to its own role
-- runner_lease_definer, and SELECT on the new column to app_user: platform_ops gains NOTHING (a test diffs what it holds against the migrations without this file). The definer keeps its three arguments, so the previous deploy keeps writing jobs through it unchanged, with NULL.
--
-- Rollback (docs/ops/runbooks/rollback.md, expand/contract): nothing here is removed by a rollback. The previous deploy never reads the column and
-- never sets the value; jobs already queued with a version stay gated and expire through the queue TTL. A later migration may drop the column.
--
-- Numbered above the highest migration on the code plane. Re-check against main right before merging and renumber to stay above it.

ALTER TABLE agent_runs ADD COLUMN min_protocol_version integer;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_min_protocol_version_check CHECK (min_protocol_version IS NULL OR min_protocol_version >= 1);

GRANT SELECT (min_protocol_version) ON agent_runs TO app_user;

-- The guard of 0714 with one more rule. The first three rules are unchanged, word for word.
CREATE OR REPLACE FUNCTION agent_runs_runner_columns_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF session_user = 'platform_ops' AND NEW.job_signed IS DISTINCT FROM OLD.job_signed THEN
    RAISE EXCEPTION 'agent_runs: platform_ops may not write job_signed; use agent_run_set_runner_job'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.initiated_by IS DISTINCT FROM OLD.initiated_by THEN
    RAISE EXCEPTION 'agent_runs.initiated_by is written at insert only (run %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.job_signed IS NOT NULL AND NEW.job_signed IS DISTINCT FROM OLD.job_signed THEN
    RAISE EXCEPTION 'agent_runs.job_signed is write-once (run %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- D#599 PL-2b-1: the job's lowest runner protocol is set with the job and never again.
  IF OLD.job_signed IS NULL AND NEW.job_signed IS NOT NULL THEN
    NEW.min_protocol_version := NULLIF(current_setting('fx.job_min_protocol', true), '')::integer;
    -- Defence in depth: a first write in the cross-side shape (a null session id, or a pull request number) with no minimum would be open to every runner.
    IF NEW.min_protocol_version IS NULL
       AND jsonb_typeof(NEW.job_signed #> '{job,continues}') = 'object'
       AND (jsonb_typeof(NEW.job_signed #> '{job,continues,session_id}') = 'null' OR (NEW.job_signed #> '{job,continues}') ? 'pr_number')
    THEN
      RAISE EXCEPTION 'agent_runs.job_signed in the cross-side shape needs a minimum protocol version (run %)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.min_protocol_version IS DISTINCT FROM OLD.min_protocol_version THEN
    RAISE EXCEPTION 'agent_runs.min_protocol_version is written with the job and never changed (run %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ---- the claim definer enforces the gate itself --------------------------------------------------------------------
-- The TypeScript candidate query already skips a gated job for an old runner, but the database is the line that holds: agent_run_runner_claim (0775)
-- now reads the runner's stored protocol version and the run's minimum itself, and gives the run to a runner below it to no one (it answers NULL, as
-- for any run it cannot claim). A runner that has not said hello (no stored version) counts as below every gate. Everything else in the function is
-- word for word the 0775 body. runner_lease_definer, the definer's role, gains SELECT on exactly these two columns; platform_ops gains nothing.
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

GRANT SELECT (min_protocol_version) ON agent_runs TO runner_lease_definer;
GRANT SELECT (protocol_version) ON runners TO runner_lease_definer;

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
