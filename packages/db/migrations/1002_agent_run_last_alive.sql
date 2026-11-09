-- D#6 RUN-WATCHDOG-DURABLE: a liveness stamp and the run's resolved limits, stored on the run, so a durable check can end a run whose
-- starting process is gone without guessing from run_events or from platform ceilings.
--
-- Why. A hosted run's silence and run-time limits live in timers of the process that started it. When that invocation ends, the
-- lost-run sweep (the compute-settle cron) is what is left to enforce them. The events a run writes are a poor sign of life:
-- agent.activity is capped per run, agent.output is capped, file edits are not recorded and a metered rise writes nothing, so a
-- healthy long run can look silent, and a run that never emits an event leaves nothing to compare. This adds a nullable
-- agent_runs.last_alive_at that the runner stamps (throttled, at most once a minute per run, on any metered rise or stream line;
-- uncapped because it is one column, overwritten in place), and stores the run's own limits once, first-wins, with the first stamp
-- (at dispatch, before any event): its silence limit, and the longest it can run with every extension taken.
--
-- Who writes them. Only agent_run_alive_mark, a definer owned by sandbox_settle_definer (the role that already owns the other
-- runner marks on this table) and executable by agent_run_writer only. The caller's tenant context must be the run's account. It
-- touches only a run that is pending or running, and writes the stamp at most once per 60 seconds per run whatever the caller
-- does (the throttle is in the statement, not only in the runner). Nobody else holds UPDATE on the columns: platform_ops and
-- app_user get nothing, so a direct login cannot keep a stuck run looking alive. The runner's login may read them (the durable
-- check does). Privilege brackets as in 0742 and 0872.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'sandbox_settle_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on sandbox_settle_definer; cannot create agent_run_alive_mark';
    END IF;
    GRANT sandbox_settle_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO sandbox_settle_definer;

ALTER TABLE agent_runs
  ADD COLUMN last_alive_at    timestamptz NULL,
  ADD COLUMN silence_limit_ms integer NULL CHECK (silence_limit_ms BETWEEN 60000 AND 1800000),
  ADD COLUMN run_limit_ms     bigint NULL CHECK (run_limit_ms BETWEEN 60000 AND 14400000);

GRANT SELECT (last_alive_at, silence_limit_ms, run_limit_ms) ON agent_runs TO agent_run_writer;
GRANT SELECT (last_alive_at, silence_limit_ms, run_limit_ms), UPDATE (last_alive_at, silence_limit_ms, run_limit_ms)
  ON agent_runs TO sandbox_settle_definer;

-- True when something was written: the stamp (at most once a minute per run), or the limits (once, while still unset). A run that
-- is not pending or running, or does not exist, writes nothing. Limits are first-wins and bounded by the column checks.
CREATE FUNCTION agent_run_alive_mark(p_account_id uuid, p_run_id uuid, p_silence_ms integer DEFAULT NULL, p_run_ms bigint DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_rows integer;
BEGIN
  IF p_account_id IS NULL OR p_account_id IS DISTINCT FROM NULLIF(current_setting('app.account_id', true), '')::uuid THEN
    RAISE EXCEPTION 'agent_run_alive_mark: account % is not the caller''s tenant context', p_account_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.agent_runs
     SET last_alive_at = CASE WHEN last_alive_at IS NULL OR last_alive_at <= now() - interval '60 seconds' THEN now() ELSE last_alive_at END,
         silence_limit_ms = COALESCE(silence_limit_ms, p_silence_ms),
         run_limit_ms = COALESCE(run_limit_ms, p_run_ms)
   WHERE account_id = p_account_id AND id = p_run_id AND status IN ('pending', 'running')
     AND (last_alive_at IS NULL OR last_alive_at <= now() - interval '60 seconds'
          OR (silence_limit_ms IS NULL AND p_silence_ms IS NOT NULL) OR (run_limit_ms IS NULL AND p_run_ms IS NOT NULL));
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END $$;
REVOKE ALL ON FUNCTION agent_run_alive_mark(uuid, uuid, integer, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_run_alive_mark(uuid, uuid, integer, bigint) TO agent_run_writer;
ALTER FUNCTION agent_run_alive_mark(uuid, uuid, integer, bigint) OWNER TO sandbox_settle_definer;

REVOKE CREATE ON SCHEMA public FROM sandbox_settle_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE sandbox_settle_definer FROM CURRENT_USER;
  END IF;
END
$$;
