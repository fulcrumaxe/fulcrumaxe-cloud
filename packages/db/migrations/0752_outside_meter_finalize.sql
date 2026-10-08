-- D#221 OM-2b2: every terminal path finalizes the outside meter, with a backstop.
--
-- 1. A trigger starts the clock of a tagged run in the statement that makes it terminal, T = the terminal timestamp written with it
--    (agent_runs.ended_at, 0610), now() if none. The trigger and agent_run_outside_meter_finalize apply the same rule (spelled out in
--    both, so no standalone function has to be executable by PUBLIC); the clock is write-once, so the runner's own call is a no-op
--    on a row the trigger already started.
-- 2. outside_meter_list_unfinalized + agent_run_outside_meter_late_finalize: a tagged run that is terminal, still has no om_finalized_at, and ended more than
--    10 minutes ago is finalized with T = its end time, and gets the flag outside_meter_late_finalize. This covers a path that
--    forgets the call and a runner that died after the terminal write. Cross-tenant like outside_meter_list_due.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_ops;

-- The definers read the status and its timestamp (the 0751 grant covers only the outside-meter columns).
GRANT SELECT (status, ended_at) ON agent_runs TO platform_ops;

-- The one rule for when a run's outside check starts and at what time: a tagged run that is terminal and not yet started starts
-- at its end time (now() if none), and its first read is due five minutes later. NULL start = nothing to do (untagged, not
-- terminal, or already started: the clock is write-once). It is spelled out in the finalize function and in the trigger function
-- below, because the trigger runs as whichever role writes agent_runs, so a shared helper would have to be executable by PUBLIC.

CREATE OR REPLACE FUNCTION agent_run_outside_meter_finalize(p_account_id uuid, p_run_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.outside_meter_assert_tenant(p_account_id, 'agent_run_outside_meter_finalize');
  UPDATE public.agent_runs a SET om_finalized_at = COALESCE(a.ended_at, now()),
         om_next_due_at = COALESCE(a.ended_at, now()) + interval '5 minutes'
   WHERE a.account_id = p_account_id AND a.id = p_run_id
     AND a.gateway_report_tag IS NOT NULL AND a.om_finalized_at IS NULL
     AND a.status IN ('refused_spend', 'succeeded', 'failed', 'timed_out', 'killed_spend', 'cancelled');
END $$;

-- The database is the one place every terminal path goes through: a tagged run that becomes terminal starts its clock in the
-- same statement, at the terminal timestamp written with it. Named to run after the 0610 stamp trigger (which writes ended_at).
CREATE FUNCTION agent_runs_outside_meter_start_clock() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.gateway_report_tag IS NOT NULL AND NEW.om_finalized_at IS NULL
     AND NEW.status IN ('refused_spend', 'succeeded', 'failed', 'timed_out', 'killed_spend', 'cancelled') THEN
    NEW.om_finalized_at := COALESCE(NEW.ended_at, now());
    NEW.om_next_due_at := NEW.om_finalized_at + interval '5 minutes';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_runs_zz_outside_meter_start_clock BEFORE INSERT OR UPDATE OF status ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION agent_runs_outside_meter_start_clock();

-- Cross-tenant read (a tenant-scoped write cannot see across tenants: the update policy is per account, as for the other definers).
CREATE FUNCTION outside_meter_list_unfinalized(p_limit int)
RETURNS TABLE (account_id uuid, run_id uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'outside_meter_list_unfinalized: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'outside_meter_list_unfinalized: bad limit' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT a.account_id, a.id FROM public.agent_runs a
   WHERE a.gateway_report_tag IS NOT NULL AND a.om_state = 'pending' AND a.om_finalized_at IS NULL
     AND a.status IN ('refused_spend', 'succeeded', 'failed', 'timed_out', 'killed_spend', 'cancelled')
     AND a.ended_at IS NOT NULL AND a.ended_at < now() - interval '10 minutes'
   ORDER BY a.ended_at LIMIT p_limit;
END $$;

-- One run, in its tenant's context: T is its end time, and the flag says a path missed it.
CREATE FUNCTION agent_run_outside_meter_late_finalize(p_account_id uuid, p_run_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_rows integer;
BEGIN
  PERFORM public.outside_meter_assert_tenant(p_account_id, 'agent_run_outside_meter_late_finalize');
  UPDATE public.agent_runs SET om_finalized_at = ended_at, om_next_due_at = ended_at + interval '5 minutes',
         om_flags = ARRAY(SELECT DISTINCT unnest(om_flags || ARRAY['outside_meter_late_finalize']) ORDER BY 1)
   WHERE account_id = p_account_id AND id = p_run_id AND gateway_report_tag IS NOT NULL AND om_state = 'pending' AND om_finalized_at IS NULL
     AND status IN ('refused_spend', 'succeeded', 'failed', 'timed_out', 'killed_spend', 'cancelled')
     AND ended_at IS NOT NULL AND ended_at < now() - interval '10 minutes';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['outside_meter_list_unfinalized(int)', 'agent_run_outside_meter_late_finalize(uuid, uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('ALTER FUNCTION %s OWNER TO platform_ops', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO agent_run_writer', f);
  END LOOP;
END
$$;

-- The trigger function stays SECURITY INVOKER: it runs as whichever role updates agent_runs and reads no table (the clock is pure),
-- so it needs no extra privilege, and a definer trigger function would break the definers-owned-by-platform_ops rule. The trigger
-- function loses PUBLIC execute (EXECUTE is checked at CREATE
-- TRIGGER, not when the trigger fires, so firing is unaffected).
REVOKE ALL ON FUNCTION agent_runs_outside_meter_start_clock() FROM PUBLIC;

-- 3. Every flag the outside meter raises is counted (0751 counted five). escalated also covers the two ends that go to the owner.
DROP FUNCTION outside_meter_flag_counts(int);
CREATE FUNCTION outside_meter_flag_counts(p_days int)
RETURNS TABLE (runs_checked bigint, disagree bigint, escalated bigint, contract bigint, no_count bigint,
               unavailable bigint, bad_request bigint, late_finalize bigint, floor_unmet bigint, trueup_held bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT count(*), count(*) FILTER (WHERE 'outside_meter_disagree' = ANY (om_flags)),
         count(*) FILTER (WHERE om_flags && ARRAY['outside_meter_escalate', 'outside_meter_floor_unmet', 'outside_meter_trueup_held']),
         count(*) FILTER (WHERE 'outside_meter_contract' = ANY (om_flags)), count(*) FILTER (WHERE 'outside_meter_no_count' = ANY (om_flags)),
         count(*) FILTER (WHERE 'outside_meter_unavailable' = ANY (om_flags)), count(*) FILTER (WHERE 'outside_meter_bad_request' = ANY (om_flags)),
         count(*) FILTER (WHERE 'outside_meter_late_finalize' = ANY (om_flags)), count(*) FILTER (WHERE 'outside_meter_floor_unmet' = ANY (om_flags)),
         count(*) FILTER (WHERE 'outside_meter_trueup_held' = ANY (om_flags))
    FROM public.agent_runs WHERE om_finalized_at >= now() - make_interval(days => p_days);
$$;
REVOKE ALL ON FUNCTION outside_meter_flag_counts(int) FROM PUBLIC;
ALTER FUNCTION outside_meter_flag_counts(int) OWNER TO platform_ops;
GRANT EXECUTE ON FUNCTION outside_meter_flag_counts(int) TO platform_ops;

REVOKE CREATE ON SCHEMA public FROM platform_ops;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
