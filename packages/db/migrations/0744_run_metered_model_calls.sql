-- D#221 OM-1: a run records how many model responses the runner metered.
--
-- Why. The outside meter (OM-2) can only call a gateway report "complete" if it knows how many model responses the
-- runner itself counted for the run. That count was held in memory only (the run guard's distinct assistant message
-- ids) and was lost when the run ended.
--
-- 1. agent_runs.metered_model_calls integer NULL, CHECK >= 0. Rows that already exist stay NULL: the figure was never
--    recorded and is not back-filled. NULL means "not recorded" (a run with no terminal write, such as a runner crash)
--    and is never read as 0. 0 means the run ended before any model response was metered.
--
-- 2. agent_run_set_status gains a tenth parameter, p_metered_model_calls, DEFAULT NULL. Every other parameter keeps its
--    meaning and its checks: the legal-edge table, the envelope rule, the tenant-context check, and which columns the
--    SET list touches are the 0642 bodies unchanged. The 9-argument function is dropped so there is one write path, and
--    a call that passes nine arguments still resolves (the new one defaults), so no existing caller changes. The count
--    is accepted only in the call that moves the run to a terminal status. It is the runner's own number: nothing the
--    agent reports reaches it.
--
-- 3. Only the writer role can set it. app_user has no UPDATE on the column (its allowlist from 0642 is unchanged).
--    platform_ops gets UPDATE on exactly this column so the definer body can write it, as 0642 did for the others.
--    A trigger makes it write-once for every role: once non-NULL it cannot change, it can only be set together with the
--    move to a terminal status, and a direct platform_ops session cannot set it at all (session_user, as in 0642's guard).
--
-- Numbering: 0743 is held by an open PR; this is 0744. Re-check before merging.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

ALTER TABLE agent_runs
  ADD COLUMN metered_model_calls integer
    CONSTRAINT agent_runs_metered_model_calls_check CHECK (metered_model_calls >= 0);

GRANT UPDATE (metered_model_calls) ON agent_runs TO platform_ops;

CREATE FUNCTION agent_runs_metered_calls_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_terminal constant text[] :=
    ARRAY['refused_spend', 'succeeded', 'failed', 'timed_out', 'killed_spend', 'cancelled'];
BEGIN
  IF NEW.metered_model_calls IS NOT DISTINCT FROM OLD.metered_model_calls THEN
    RETURN NEW;
  END IF;
  IF OLD.metered_model_calls IS NOT NULL THEN
    RAISE EXCEPTION 'agent_runs.metered_model_calls is write-once (run %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'agent_runs: platform_ops may not set metered_model_calls directly; use agent_run_set_status (run %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.status IS NOT DISTINCT FROM OLD.status
     OR OLD.status = ANY (v_terminal)
     OR NOT (NEW.status = ANY (v_terminal))
  THEN
    RAISE EXCEPTION 'agent_runs: metered_model_calls is set together with the move to a terminal status (run %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_runs_metered_calls_guard
  BEFORE UPDATE ON agent_runs
  FOR EACH ROW
  EXECUTE FUNCTION agent_runs_metered_calls_guard();

GRANT CREATE ON SCHEMA public TO platform_ops;

DROP FUNCTION agent_run_set_status(uuid, uuid, text, text, jsonb, bigint, bigint, numeric, text);

CREATE FUNCTION agent_run_set_status(
  p_account_id          uuid,
  p_run_id              uuid,
  p_from                text,
  p_to                  text,
  p_envelope            jsonb,
  p_tokens_in           bigint,
  p_tokens_out          bigint,
  p_usd                 numeric,
  p_session_id          text,
  p_metered_model_calls integer DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_rows integer;
  v_sets text;
BEGIN
  IF p_account_id IS NULL
     OR p_account_id IS DISTINCT FROM NULLIF(current_setting('app.account_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'agent_run_set_status: account % is not the caller''s tenant context', p_account_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM (VALUES
        ('pending', 'refused_spend'), ('pending', 'running'), ('pending', 'paused'),
        ('pending', 'cancelled'), ('pending', 'timed_out'), ('pending', 'failed'),
        ('running', 'succeeded'), ('running', 'failed'), ('running', 'timed_out'),
        ('running', 'killed_spend'), ('running', 'cancelled'),
        ('paused', 'cancelled')
      ) AS legal (from_status, to_status)
     WHERE legal.from_status = p_from AND legal.to_status = p_to
  ) THEN
    RAISE EXCEPTION 'agent_run_set_status: illegal agent_runs.status transition "%" -> "%"', p_from, p_to
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_envelope IS NOT NULL
     AND p_to NOT IN ('refused_spend', 'succeeded', 'failed', 'timed_out', 'killed_spend', 'cancelled')
  THEN
    RAISE EXCEPTION 'agent_run_set_status: an envelope may only be set together with a terminal status (got "%")', p_to
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_metered_model_calls IS NOT NULL
     AND p_to NOT IN ('refused_spend', 'succeeded', 'failed', 'timed_out', 'killed_spend', 'cancelled')
  THEN
    RAISE EXCEPTION 'agent_run_set_status: a metered model-call count may only be set together with a terminal status (got "%")', p_to
      USING ERRCODE = 'check_violation';
  END IF;

  v_sets := '';
  IF p_envelope IS NOT NULL THEN v_sets := v_sets || ', envelope = $5'; END IF;
  IF p_tokens_in IS NOT NULL THEN v_sets := v_sets || ', tokens_in = $6'; END IF;
  IF p_tokens_out IS NOT NULL THEN v_sets := v_sets || ', tokens_out = $7'; END IF;
  IF p_usd IS NOT NULL THEN v_sets := v_sets || ', usd = $8'; END IF;
  IF p_session_id IS NOT NULL THEN v_sets := v_sets || ', cc_session_id = $9'; END IF;
  IF p_metered_model_calls IS NOT NULL THEN v_sets := v_sets || ', metered_model_calls = $10'; END IF;

  EXECUTE 'UPDATE public.agent_runs SET status = $1, updated_at = now()' || v_sets
       || ' WHERE account_id = $2 AND id = $3 AND status = $4'
    USING p_to, p_account_id, p_run_id, p_from, p_envelope, p_tokens_in, p_tokens_out, p_usd, p_session_id,
          p_metered_model_calls;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION agent_run_set_status(uuid, uuid, text, text, jsonb, bigint, bigint, numeric, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_run_set_status(uuid, uuid, text, text, jsonb, bigint, bigint, numeric, text, integer) TO agent_run_writer;
ALTER FUNCTION agent_run_set_status(uuid, uuid, text, text, jsonb, bigint, bigint, numeric, text, integer) OWNER TO platform_ops;
REVOKE CREATE ON SCHEMA public FROM platform_ops;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
