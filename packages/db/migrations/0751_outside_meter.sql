-- D#221 OM-2b: the outside meter's persistence. A run on an ai_gateway connection carries an unguessable report tag
-- (added to its model requests outside the VM); after the run, the gateway's own report for that tag is read back and
-- compared with what the runner metered. This file holds what that needs and nothing the screens show (OM-2c).
--
-- Who writes what. Only the runner's login (agent_run_writer) writes the run columns, through the definers below; app_user
-- keeps its column-scoped metering grant and nothing here widens it, so an app_user UPDATE of any of them is 42501.
-- One trigger holds them for every role: the tag is write-once, a final state is never changed, a direct platform_ops
-- login writes nothing. The definers' owner (platform_ops) reads and updates only these columns. Privilege brackets as in 0689.
--
--   agent_runs      gateway_report_tag  UNIQUE, ^fxr_[a-z2-7]{26}$, NULL when the setting is off or the connection is not entitled
--                   om_*                state (pending|matches|higher|unavailable), reason, read count, next due, last read, flags, figures
--   model_connections outside_meter_entitlement  unknown|yes|no with its time and the key it was set for (derived, resets)
--   ledger          reason              'outside_meter' (true-up) or 'outside_meter_overhead'; each unique per run
--   outside_meter_flag_counts           counts-only, for platform_ops (the needs-owner signal, as run_metering_flag_rate)
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

ALTER TABLE agent_runs
  ADD COLUMN gateway_report_tag text CONSTRAINT agent_runs_gateway_report_tag_shape CHECK (gateway_report_tag ~ '^fxr_[a-z2-7]{26}$'),
  ADD COLUMN om_payer_account_id uuid,
  ADD COLUMN om_connection_id uuid,
  ADD COLUMN om_key_ref text,
  ADD COLUMN om_state text CONSTRAINT agent_runs_om_state_known CHECK (om_state IN ('pending', 'matches', 'higher', 'unavailable')),
  ADD COLUMN om_reason text,
  ADD COLUMN om_reads smallint NOT NULL DEFAULT 0 CONSTRAINT agent_runs_om_reads_range CHECK (om_reads BETWEEN 0 AND 8),
  ADD COLUMN om_finalized_at timestamptz,
  ADD COLUMN om_next_due_at timestamptz,
  ADD COLUMN om_last_cost numeric,
  ADD COLUMN om_last_count integer,
  ADD COLUMN om_read_share_usd numeric NOT NULL DEFAULT 0,
  ADD COLUMN om_flags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN om_gateway_usd numeric,
  ADD COLUMN om_true_up_usd numeric,
  ADD COLUMN om_overhead_usd numeric;
CREATE UNIQUE INDEX agent_runs_gateway_report_tag_unique ON agent_runs (gateway_report_tag) WHERE gateway_report_tag IS NOT NULL;
CREATE INDEX agent_runs_om_due ON agent_runs (om_next_due_at) WHERE om_state = 'pending';

ALTER TABLE model_connections
  ADD COLUMN outside_meter_entitlement text NOT NULL DEFAULT 'unknown' CONSTRAINT model_connections_om_entitlement_known CHECK (outside_meter_entitlement IN ('unknown', 'yes', 'no')),
  ADD COLUMN outside_meter_entitlement_at timestamptz,
  ADD COLUMN outside_meter_key_ref text;

CREATE FUNCTION agent_runs_outside_meter_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (NEW.gateway_report_tag, NEW.om_payer_account_id, NEW.om_connection_id, NEW.om_key_ref, NEW.om_state, NEW.om_reason, NEW.om_reads, NEW.om_finalized_at,
      NEW.om_next_due_at, NEW.om_last_cost, NEW.om_last_count, NEW.om_read_share_usd, NEW.om_flags, NEW.om_gateway_usd, NEW.om_true_up_usd, NEW.om_overhead_usd)
     IS NOT DISTINCT FROM
     (OLD.gateway_report_tag, OLD.om_payer_account_id, OLD.om_connection_id, OLD.om_key_ref, OLD.om_state, OLD.om_reason, OLD.om_reads, OLD.om_finalized_at,
      OLD.om_next_due_at, OLD.om_last_cost, OLD.om_last_count, OLD.om_read_share_usd, OLD.om_flags, OLD.om_gateway_usd, OLD.om_true_up_usd, OLD.om_overhead_usd) THEN
    RETURN NEW;
  END IF;
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'agent_runs: platform_ops may not write the outside-meter columns; use the agent_run_outside_meter definers' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (OLD.gateway_report_tag IS NOT NULL AND NEW.gateway_report_tag IS DISTINCT FROM OLD.gateway_report_tag)
     OR (OLD.om_state IS NOT NULL AND OLD.om_state <> 'pending' AND NEW.om_state IS DISTINCT FROM OLD.om_state)
     OR (OLD.om_state IS NOT NULL AND OLD.om_state <> 'pending' AND (NEW.om_reads, NEW.om_gateway_usd, NEW.om_true_up_usd, NEW.om_overhead_usd) IS DISTINCT FROM (OLD.om_reads, OLD.om_gateway_usd, OLD.om_true_up_usd, OLD.om_overhead_usd)) THEN
    RAISE EXCEPTION 'agent_runs: the report tag is set once and a final outside-meter result is never changed (run %)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_runs_outside_meter_guard BEFORE UPDATE ON agent_runs FOR EACH ROW EXECUTE FUNCTION agent_runs_outside_meter_guard();

GRANT SELECT (gateway_report_tag, om_payer_account_id, om_connection_id, om_key_ref, om_state, om_reason, om_reads, om_finalized_at, om_next_due_at, om_last_cost,
              om_last_count, om_read_share_usd, om_flags, om_gateway_usd, om_true_up_usd, om_overhead_usd, metered_model_calls) ON agent_runs TO platform_ops;
GRANT UPDATE (gateway_report_tag, om_payer_account_id, om_connection_id, om_key_ref, om_state, om_reason, om_reads, om_finalized_at, om_next_due_at, om_last_cost,
              om_last_count, om_read_share_usd, om_flags, om_gateway_usd, om_true_up_usd, om_overhead_usd) ON agent_runs TO platform_ops;
GRANT UPDATE (outside_meter_entitlement, outside_meter_entitlement_at, outside_meter_key_ref) ON model_connections TO platform_ops;

-- The tenant-context check every writer definer starts with.
CREATE FUNCTION outside_meter_assert_tenant(p_account_id uuid, p_who text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_account_id IS NULL OR p_account_id IS DISTINCT FROM NULLIF(current_setting('app.account_id', true), '')::uuid THEN
    RAISE EXCEPTION '%: account % is not the caller''s tenant context', p_who, p_account_id USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

-- At admit: store the tag, first-wins. Returns whether this call stored it.
CREATE FUNCTION agent_run_outside_meter_start(p_account_id uuid, p_run_id uuid, p_tag text, p_payer uuid, p_connection uuid, p_key_ref text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_rows integer;
BEGIN
  PERFORM public.outside_meter_assert_tenant(p_account_id, 'agent_run_outside_meter_start');
  UPDATE public.agent_runs SET gateway_report_tag = p_tag, om_payer_account_id = p_payer, om_connection_id = p_connection, om_key_ref = p_key_ref, om_state = 'pending'
   WHERE account_id = p_account_id AND id = p_run_id AND gateway_report_tag IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END $$;

-- The stored tag of one run (NULL if none). The runner reads it here rather than from agent_runs, so it needs no table-wide
-- SELECT through app_user's grants, which must not cover the tag.
CREATE FUNCTION agent_run_outside_meter_tag(p_account_id uuid, p_run_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_tag text;
BEGIN
  PERFORM public.outside_meter_assert_tenant(p_account_id, 'agent_run_outside_meter_tag');
  SELECT gateway_report_tag INTO v_tag FROM public.agent_runs WHERE account_id = p_account_id AND id = p_run_id;
  RETURN v_tag;
END $$;

-- At finalize: the first read falls due 5 minutes later.
CREATE FUNCTION agent_run_outside_meter_finalize(p_account_id uuid, p_run_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.outside_meter_assert_tenant(p_account_id, 'agent_run_outside_meter_finalize');
  UPDATE public.agent_runs SET om_finalized_at = now(), om_next_due_at = now() + interval '5 minutes'
   WHERE account_id = p_account_id AND id = p_run_id AND gateway_report_tag IS NOT NULL AND om_finalized_at IS NULL;
END $$;

-- One read's result. Only a pending run changes (a final result is history); flags are unioned.
CREATE FUNCTION agent_run_outside_meter_record(
  p_account_id uuid, p_run_id uuid, p_state text, p_reason text, p_reads integer, p_next_due timestamptz,
  p_last_cost numeric, p_last_count integer, p_flags text[], p_read_share numeric, p_gateway_usd numeric, p_true_up numeric, p_overhead numeric)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_rows integer;
BEGIN
  PERFORM public.outside_meter_assert_tenant(p_account_id, 'agent_run_outside_meter_record');
  UPDATE public.agent_runs SET om_state = p_state, om_reason = p_reason, om_reads = p_reads, om_next_due_at = p_next_due, om_last_cost = p_last_cost,
         om_last_count = p_last_count, om_read_share_usd = p_read_share, om_gateway_usd = p_gateway_usd, om_true_up_usd = p_true_up, om_overhead_usd = p_overhead,
         om_flags = ARRAY(SELECT DISTINCT unnest(om_flags || COALESCE(p_flags, '{}')) ORDER BY 1)
   WHERE account_id = p_account_id AND id = p_run_id AND om_state = 'pending';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END $$;

-- Entitlement of one connection, set by a read (200 yes, 403 no) and reset by the sweep (derived, never trusted past its key or 7 days).
CREATE FUNCTION outside_meter_set_entitlement(p_account_id uuid, p_connection_id uuid, p_value text, p_key_ref text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.outside_meter_assert_tenant(p_account_id, 'outside_meter_set_entitlement');
  UPDATE public.model_connections SET outside_meter_entitlement = p_value, outside_meter_entitlement_at = now(), outside_meter_key_ref = p_key_ref
   WHERE account_id = p_account_id AND id = p_connection_id;
END $$;

-- Cross-tenant: runs whose next read is due (or, for a flag that is off, whose 24 h have passed), oldest first, at most p_limit.
CREATE FUNCTION outside_meter_list_due(p_limit int)
RETURNS TABLE (account_id uuid, run_id uuid, tag text, payer_account_id uuid, connection_id uuid, key_ref text, reads smallint, finalized_at timestamptz,
               last_cost numeric, last_count integer, read_share_usd numeric, metered_usd numeric, metered_calls integer, started_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'outside_meter_list_due: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'outside_meter_list_due: bad limit' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT a.account_id, a.id, a.gateway_report_tag, a.om_payer_account_id, a.om_connection_id, a.om_key_ref, a.om_reads, a.om_finalized_at,
         a.om_last_cost, a.om_last_count, a.om_read_share_usd,
         -- what the run was charged for model use (its settled ledger row): the figure the gateway's is compared with
         (SELECT l.usd FROM public.ledger l WHERE l.account_id = a.account_id AND l.run_id = a.id AND l.budget = 'model' AND l.reason IS NULL),
         a.metered_model_calls, a.created_at
    FROM public.agent_runs a
   WHERE a.om_state = 'pending' AND a.om_finalized_at IS NOT NULL AND a.om_next_due_at <= now()
   ORDER BY a.om_next_due_at, a.id LIMIT p_limit;
END $$;

-- How many finalized runs still wait for their outside read (counts only): keeps the cron's marker alive between reads.
CREATE FUNCTION outside_meter_waiting() RETURNS bigint
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'outside_meter_waiting: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN (SELECT count(*) FROM public.agent_runs WHERE om_state = 'pending' AND om_finalized_at IS NOT NULL);
END $$;

-- Counts only; no account, run or figure leaves it. escalated > 0 is the needs-owner signal.
CREATE FUNCTION outside_meter_flag_counts(p_days int)
RETURNS TABLE (runs_checked bigint, disagree bigint, escalated bigint, contract bigint, no_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT count(*), count(*) FILTER (WHERE 'outside_meter_disagree' = ANY (om_flags)), count(*) FILTER (WHERE 'outside_meter_escalate' = ANY (om_flags)),
         count(*) FILTER (WHERE 'outside_meter_contract' = ANY (om_flags)), count(*) FILTER (WHERE 'outside_meter_no_count' = ANY (om_flags))
    FROM public.agent_runs WHERE om_finalized_at >= now() - make_interval(days => p_days);
$$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'agent_run_outside_meter_start(uuid, uuid, text, uuid, uuid, text)', 'agent_run_outside_meter_tag(uuid, uuid)', 'agent_run_outside_meter_finalize(uuid, uuid)',
    'agent_run_outside_meter_record(uuid, uuid, text, text, integer, timestamptz, numeric, integer, text[], numeric, numeric, numeric, numeric)',
    'outside_meter_set_entitlement(uuid, uuid, text, text)', 'outside_meter_list_due(int)', 'outside_meter_waiting()', 'outside_meter_flag_counts(int)', 'outside_meter_assert_tenant(uuid, text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('ALTER FUNCTION %s OWNER TO platform_ops', f);
    IF f LIKE 'outside_meter_flag_counts%' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO platform_ops', f);
    ELSIF f NOT LIKE 'outside_meter_assert_tenant%' THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO agent_run_writer', f); END IF;
  END LOOP;
END
$$;

-- Ledger: a true-up and an overhead line are each unique per run and idempotent. The (account, run, budget) rule of 0629 now
-- covers the rows that carry no reason (every existing row), under the same name.
ALTER TABLE ledger ADD COLUMN reason text CONSTRAINT ledger_reason_known CHECK (reason IN ('outside_meter', 'outside_meter_overhead'));
DO $$
BEGIN
  -- Absent only on a database that has not yet had 0629 applied (an out-of-order upgrade): 0629 then adds it whole.
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ledger_account_run_budget_unique') THEN
    ALTER TABLE ledger DROP CONSTRAINT ledger_account_run_budget_unique;
    CREATE UNIQUE INDEX ledger_account_run_budget_unique ON ledger (account_id, run_id, budget) WHERE reason IS NULL;
  END IF;
END
$$;
CREATE UNIQUE INDEX ledger_account_run_reason_unique ON ledger (account_id, run_id, reason) WHERE reason IS NOT NULL;

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
