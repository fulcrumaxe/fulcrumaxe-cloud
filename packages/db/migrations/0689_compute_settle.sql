-- D#2 COMPUTE-SETTLE CS-2a: a run's compute reservation closes with ONE compute ledger row, never a
-- release. This adds what that settle reads and writes:
--   * five agent_runs columns the settle needs even on a fresh instance (the request marker, the
--     session ids, the stop time, the in-VM counters, the "settle still owed" mark);
--   * ledger.compute_basis, saying how the figure was arrived at;
--   * the preview daily cap counted from what was actually recorded.
--
-- Who writes what. Only the runner's login (agent_run_writer) writes the five columns, through the
-- one definer below; app_user keeps its column-scoped metering UPDATE grant and nothing here widens
-- it, so an app_user UPDATE of any of them is 42501. A trigger holds every value once set (the id
-- array is append-only, the settle mark may be cleared) for every role, and refuses a direct
-- platform_ops login. The definer's owner (platform_ops) reads and updates only these five columns.
-- Privilege brackets as in 0685.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

ALTER TABLE agent_runs
  ADD COLUMN sandbox_requested_at  timestamptz NULL,
  ADD COLUMN sandbox_session_ids   text[] NOT NULL DEFAULT '{}',
  ADD COLUMN sandbox_stopped_at    timestamptz NULL,
  ADD COLUMN sandbox_self_measured jsonb NULL CHECK (jsonb_typeof(sandbox_self_measured) = 'object'),
  ADD COLUMN compute_settle_due_at timestamptz NULL;
CREATE INDEX agent_runs_compute_settle_due ON agent_runs (compute_settle_due_at) WHERE compute_settle_due_at IS NOT NULL;

CREATE FUNCTION agent_runs_sandbox_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'agent_runs: platform_ops may not write the sandbox settle columns; use agent_run_sandbox_mark'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (OLD.sandbox_requested_at IS NOT NULL AND NEW.sandbox_requested_at IS DISTINCT FROM OLD.sandbox_requested_at)
     OR (OLD.sandbox_stopped_at IS NOT NULL AND NEW.sandbox_stopped_at IS DISTINCT FROM OLD.sandbox_stopped_at)
     OR (OLD.sandbox_self_measured IS NOT NULL AND NEW.sandbox_self_measured IS DISTINCT FROM OLD.sandbox_self_measured)
     -- The settle mark is set once and then cleared by the settle; it is never moved to another time.
     OR (OLD.compute_settle_due_at IS NOT NULL AND NEW.compute_settle_due_at IS NOT NULL
         AND NEW.compute_settle_due_at IS DISTINCT FROM OLD.compute_settle_due_at)
     -- The id array only grows at the end.
     OR NEW.sandbox_session_ids[1:cardinality(OLD.sandbox_session_ids)] IS DISTINCT FROM OLD.sandbox_session_ids THEN
    RAISE EXCEPTION 'agent_runs: a recorded sandbox settle value is set once (run %)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_runs_sandbox_guard
  BEFORE UPDATE OF sandbox_requested_at, sandbox_session_ids, sandbox_stopped_at, sandbox_self_measured, compute_settle_due_at
  ON agent_runs FOR EACH ROW EXECUTE FUNCTION agent_runs_sandbox_guard();

GRANT SELECT (sandbox_requested_at, sandbox_session_ids, sandbox_stopped_at, sandbox_self_measured, compute_settle_due_at)
  ON agent_runs TO platform_ops;
GRANT UPDATE (sandbox_requested_at, sandbox_session_ids, sandbox_stopped_at, sandbox_self_measured, compute_settle_due_at)
  ON agent_runs TO platform_ops;

-- One definer, every write first-wins: the request marker, one more session id, the stop time with the
-- counters read before it, and (p_due) the settle mark: true sets it, false clears it, null leaves it.
CREATE FUNCTION agent_run_sandbox_mark(
  p_account_id uuid, p_run_id uuid, p_requested boolean, p_session_id text,
  p_stopped boolean, p_self_measured jsonb, p_due boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_account_id IS NULL OR p_account_id IS DISTINCT FROM NULLIF(current_setting('app.account_id', true), '')::uuid THEN
    RAISE EXCEPTION 'agent_run_sandbox_mark: account % is not the caller''s tenant context', p_account_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.agent_runs SET
    sandbox_requested_at  = CASE WHEN p_requested THEN COALESCE(sandbox_requested_at, now()) ELSE sandbox_requested_at END,
    sandbox_session_ids   = CASE WHEN p_session_id IS NOT NULL AND NOT (p_session_id = ANY (sandbox_session_ids))
                                 THEN array_append(sandbox_session_ids, p_session_id) ELSE sandbox_session_ids END,
    sandbox_stopped_at    = CASE WHEN p_stopped THEN COALESCE(sandbox_stopped_at, now()) ELSE sandbox_stopped_at END,
    sandbox_self_measured = COALESCE(sandbox_self_measured, p_self_measured),
    compute_settle_due_at = CASE WHEN p_due IS NULL THEN compute_settle_due_at
                                 WHEN p_due THEN COALESCE(compute_settle_due_at, now()) ELSE NULL END
  WHERE account_id = p_account_id AND id = p_run_id;
END $$;
REVOKE ALL ON FUNCTION agent_run_sandbox_mark(uuid, uuid, boolean, text, boolean, jsonb, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_run_sandbox_mark(uuid, uuid, boolean, text, boolean, jsonb, boolean) TO agent_run_writer;
ALTER FUNCTION agent_run_sandbox_mark(uuid, uuid, boolean, text, boolean, jsonb, boolean) OWNER TO platform_ops;

-- ---------------------------------------------------------------------
-- How a compute figure was arrived at. Only a compute row carries one.
-- ---------------------------------------------------------------------
ALTER TABLE ledger ADD COLUMN compute_basis text
  CONSTRAINT ledger_compute_basis_known CHECK (compute_basis IN ('measured', 'self_measured', 'fallback', 'no_sandbox'))
  CONSTRAINT ledger_compute_basis_kind CHECK (compute_basis IS NULL OR kind = 'compute');

-- ---------------------------------------------------------------------
-- 0685's daily preview compute, counted from what was recorded (C78): an open
-- reservation counts what it holds, a settled one what its ledger row says
-- (a 'no_sandbox' row counts 0), and a row with no ledger row (released, or
-- settled before 0689) counts what it reserved. Same owner, definer, search_path
-- and ACL (CREATE OR REPLACE keeps them). The join needs the reservation's account_id and run_id, which
-- platform_ops could not read (0685 gave it five columns): it gains exactly those two. The row policy
-- (preview compute rows, never a direct platform_ops login) is unchanged, so that login still sees no row.
-- ---------------------------------------------------------------------
GRANT SELECT (account_id, run_id) ON spend_reservations TO platform_ops;
CREATE OR REPLACE FUNCTION preview_daily_compute_usd() RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT COALESCE(SUM(CASE WHEN s.state = 'open' THEN s.usd_reserved ELSE COALESCE(l.usd, s.usd_reserved) END), 0)
    FROM public.spend_reservations s
    LEFT JOIN public.ledger l ON l.account_id = s.account_id AND l.run_id = s.run_id AND l.budget = s.budget
   WHERE s.purpose = 'preview' AND s.budget IN ('foreground_compute', 'background_compute')
     AND s.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
$$;

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
