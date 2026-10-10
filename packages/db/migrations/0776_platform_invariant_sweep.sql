-- D#597 CC-8: the deterministic invariant sweep. Three checks that catch platform defects by rule, never by a model:
--   stage_not_moved      an executor run succeeded with a pull request, yet its item is still in_progress after the grace period
--   no_activity          a finished runner run has no agent.activity row (the caller switches this one on after C42-1 is deployed)
--   usage_not_recorded   the runner reported a usage event with tokens, yet no usage row holds any token for the run
--
-- Each check is one function, one statement: find the hits (indexed), record one alert per (invariant, run) and, when the run has an
-- item, one fixed-code `platform_check` fact on it. A second sweep over the same state finds the alert and writes nothing. Neither row
-- holds free text: an invariant name (CHECK-listed), ids and times. The alert row is ours (no customer policy); the item fact lives in
-- work_item_driver_events, the store the item's readers already use.
--
--   platform_invariant_alerts        one row per (invariant, run). RLS forced; only the definer role below has a policy.
--   platform_invariant_alert_counts  counts per invariant over the last N days (the needs-owner signal; run-writer login only, because
--                                    0765's test pins that no later migration widens what platform_ops may execute)
--   agent_runs_ended_at_recent       the index every check starts from (terminal runs by end time)
--
-- The functions are owned by invariant_sweep_definer (NOLOGIN, no members outside this file's bracket) which holds column SELECT on
-- what the bodies read and INSERT on the two tables they write, with row policies for this role only. EXECUTE goes to the run-writer
-- login the sweeps run as; platform_ops gains nothing.

DO $$
DECLARE
  n text := 'invariant_sweep_definer';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'role % still has a privileged attribute', n;
  END IF;
END
$$;

CREATE TABLE platform_invariant_alerts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invariant    text NOT NULL CONSTRAINT platform_invariant_alerts_invariant_check CHECK (invariant IN ('stage_not_moved', 'no_activity', 'usage_not_recorded')),
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  work_item_id uuid,
  run_id       uuid NOT NULL,
  raised_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invariant, run_id),
  FOREIGN KEY (account_id, run_id) REFERENCES agent_runs (account_id, id) ON DELETE CASCADE
);
CREATE INDEX platform_invariant_alerts_raised ON platform_invariant_alerts (raised_at);
ALTER TABLE platform_invariant_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_invariant_alerts FORCE ROW LEVEL SECURITY;

CREATE INDEX agent_runs_ended_at_recent ON agent_runs (ended_at) WHERE ended_at IS NOT NULL;

-- The item fact: one more kind in the store the stage driver already writes.
ALTER TABLE work_item_driver_events DROP CONSTRAINT work_item_driver_events_kind_check;
ALTER TABLE work_item_driver_events
  ADD CONSTRAINT work_item_driver_events_kind_check CHECK (kind IN (
    'build_refused', 'review_started', 'security_review_required', 'review_verdicts',
    'fix_round_started', 'fix_round_refused', 'fix_pushed_nothing', 'fix_round_failed', 'escalated',
    'review_status', 'merge_gate', 'merged_by_gate', 'stopped', 'pr_head_pushed', 'platform_check'
  ));

GRANT USAGE ON SCHEMA public TO invariant_sweep_definer;
GRANT SELECT (id, account_id, work_item_id, role, runtime, status, ended_at, envelope) ON agent_runs TO invariant_sweep_definer;
GRANT SELECT (id, account_id, stage) ON work_items TO invariant_sweep_definer;
GRANT SELECT (account_id, run_id, kind, payload) ON run_events TO invariant_sweep_definer;
GRANT SELECT (account_id, run_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) ON runner_run_usage TO invariant_sweep_definer;
GRANT SELECT, INSERT ON platform_invariant_alerts TO invariant_sweep_definer;
GRANT INSERT (account_id, work_item_id, kind, code, run_id, dedupe_key) ON work_item_driver_events TO invariant_sweep_definer;
GRANT EXECUTE ON FUNCTION work_item_driver_reasons_ok(text[]) TO invariant_sweep_definer;

CREATE POLICY invariant_sweep_select ON agent_runs FOR SELECT TO invariant_sweep_definer USING (true);
CREATE POLICY invariant_sweep_select ON work_items FOR SELECT TO invariant_sweep_definer USING (true);
CREATE POLICY invariant_sweep_select ON run_events FOR SELECT TO invariant_sweep_definer USING (kind IN ('run.status_changed', 'agent.activity', 'runner.event'));
CREATE POLICY invariant_sweep_select ON runner_run_usage FOR SELECT TO invariant_sweep_definer USING (true);
CREATE POLICY invariant_sweep_all ON platform_invariant_alerts FOR ALL TO invariant_sweep_definer USING (true) WITH CHECK (true);
CREATE POLICY invariant_sweep_insert ON work_item_driver_events FOR INSERT TO invariant_sweep_definer WITH CHECK (kind = 'platform_check');

-- One statement per check. Arguments are clamped, never trusted: at most 200 hits, a grace of 0..1 day, a window of 1 minute..7 days.
-- Shared tail (spelled out in each body so each is one self-contained, EXPLAIN-able statement): insert the alerts the hits do not
-- already have, then the item fact for each new alert; the function answers the NEW alerts only.

CREATE FUNCTION platform_invariant_stage_not_moved(p_limit int, p_grace_s int, p_window_s int)
RETURNS TABLE (account_id uuid, work_item_id uuid, run_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH recent AS MATERIALIZED (
    -- The index range on end time comes first, whatever the table sizes: the join below only ever sees the runs that just ended.
    SELECT r.account_id, r.work_item_id, r.id, r.ended_at, r.envelope
      FROM public.agent_runs r
     WHERE r.ended_at >= now() - make_interval(secs => LEAST(GREATEST(p_window_s, 60), 604800))
       AND r.ended_at <= now() - make_interval(secs => LEAST(GREATEST(p_grace_s, 0), 86400))
       AND r.status = 'succeeded' AND r.role = 'executor'
  ), hits AS (
    SELECT r.account_id, r.work_item_id, r.id AS run_id
      FROM recent r
      JOIN public.work_items w ON w.account_id = r.account_id AND w.id = r.work_item_id
     WHERE w.stage = 'in_progress'
       AND (r.envelope ->> 'pr_number' ~ '^[1-9][0-9]{0,8}$'
            OR (SELECT max(e.payload ->> 'prNumber') FROM public.run_events e WHERE e.run_id = r.id AND e.kind = 'run.status_changed'
                 AND e.payload ->> 'to' = 'succeeded') ~ '^[1-9][0-9]{0,8}$')
       AND NOT EXISTS (SELECT 1 FROM public.agent_runs n WHERE n.account_id = r.account_id AND n.work_item_id = r.work_item_id AND n.status IN ('pending', 'running'))
       AND NOT EXISTS (SELECT 1 FROM public.platform_invariant_alerts a WHERE a.invariant = 'stage_not_moved' AND a.run_id = r.id)
     ORDER BY r.ended_at LIMIT LEAST(GREATEST(p_limit, 1), 200)
  ), new_alerts AS (
    INSERT INTO public.platform_invariant_alerts (invariant, account_id, work_item_id, run_id)
    SELECT 'stage_not_moved', h.account_id, h.work_item_id, h.run_id FROM hits h
    ON CONFLICT (invariant, run_id) DO NOTHING RETURNING platform_invariant_alerts.account_id, platform_invariant_alerts.work_item_id, platform_invariant_alerts.run_id
  ), notes AS (
    INSERT INTO public.work_item_driver_events (account_id, work_item_id, kind, code, run_id, dedupe_key)
    SELECT n.account_id, n.work_item_id, 'platform_check', 'stage_not_moved', n.run_id, 'stage_not_moved:' || n.run_id FROM new_alerts n WHERE n.work_item_id IS NOT NULL
    ON CONFLICT DO NOTHING
  )
  SELECT n.account_id, n.work_item_id, n.run_id FROM new_alerts n
$$;

CREATE FUNCTION platform_invariant_no_activity(p_limit int, p_grace_s int, p_window_s int)
RETURNS TABLE (account_id uuid, work_item_id uuid, run_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH hits AS (
    SELECT r.account_id, r.work_item_id, r.id AS run_id
      FROM public.agent_runs r
     WHERE r.ended_at >= now() - make_interval(secs => LEAST(GREATEST(p_window_s, 60), 604800))
       AND r.ended_at <= now() - make_interval(secs => LEAST(GREATEST(p_grace_s, 0), 86400))
       AND r.runtime = 'runner' AND r.status = 'succeeded'
       AND NOT EXISTS (SELECT 1 FROM public.run_events e WHERE e.run_id = r.id AND e.kind = 'agent.activity')
       AND NOT EXISTS (SELECT 1 FROM public.platform_invariant_alerts a WHERE a.invariant = 'no_activity' AND a.run_id = r.id)
     ORDER BY r.ended_at LIMIT LEAST(GREATEST(p_limit, 1), 200)
  ), new_alerts AS (
    INSERT INTO public.platform_invariant_alerts (invariant, account_id, work_item_id, run_id)
    SELECT 'no_activity', h.account_id, h.work_item_id, h.run_id FROM hits h
    ON CONFLICT (invariant, run_id) DO NOTHING RETURNING platform_invariant_alerts.account_id, platform_invariant_alerts.work_item_id, platform_invariant_alerts.run_id
  ), notes AS (
    INSERT INTO public.work_item_driver_events (account_id, work_item_id, kind, code, run_id, dedupe_key)
    SELECT n.account_id, n.work_item_id, 'platform_check', 'no_activity', n.run_id, 'no_activity:' || n.run_id FROM new_alerts n WHERE n.work_item_id IS NOT NULL
    ON CONFLICT DO NOTHING
  )
  SELECT n.account_id, n.work_item_id, n.run_id FROM new_alerts n
$$;

CREATE FUNCTION platform_invariant_usage_not_recorded(p_limit int, p_grace_s int, p_window_s int)
RETURNS TABLE (account_id uuid, work_item_id uuid, run_id uuid)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH hits AS (
    SELECT r.account_id, r.work_item_id, r.id AS run_id
      FROM public.agent_runs r
     WHERE r.ended_at >= now() - make_interval(secs => LEAST(GREATEST(p_window_s, 60), 604800))
       AND r.ended_at <= now() - make_interval(secs => LEAST(GREATEST(p_grace_s, 0), 86400))
       AND r.runtime = 'runner'
       AND EXISTS (SELECT 1 FROM public.run_events e WHERE e.run_id = r.id AND e.kind = 'runner.event' AND e.payload ->> 'type' = 'usage'
                    AND (CASE WHEN jsonb_typeof(e.payload #> '{usage,input}') = 'number' THEN (e.payload #>> '{usage,input}')::numeric ELSE 0 END
                       + CASE WHEN jsonb_typeof(e.payload #> '{usage,output}') = 'number' THEN (e.payload #>> '{usage,output}')::numeric ELSE 0 END) > 0)
       AND NOT EXISTS (SELECT 1 FROM public.runner_run_usage u WHERE u.account_id = r.account_id AND u.run_id = r.id
                        AND u.input_tokens + u.output_tokens + u.cache_read_tokens + u.cache_write_tokens > 0)
       AND NOT EXISTS (SELECT 1 FROM public.platform_invariant_alerts a WHERE a.invariant = 'usage_not_recorded' AND a.run_id = r.id)
     ORDER BY r.ended_at LIMIT LEAST(GREATEST(p_limit, 1), 200)
  ), new_alerts AS (
    INSERT INTO public.platform_invariant_alerts (invariant, account_id, work_item_id, run_id)
    SELECT 'usage_not_recorded', h.account_id, h.work_item_id, h.run_id FROM hits h
    ON CONFLICT (invariant, run_id) DO NOTHING RETURNING platform_invariant_alerts.account_id, platform_invariant_alerts.work_item_id, platform_invariant_alerts.run_id
  ), notes AS (
    INSERT INTO public.work_item_driver_events (account_id, work_item_id, kind, code, run_id, dedupe_key)
    SELECT n.account_id, n.work_item_id, 'platform_check', 'usage_not_recorded', n.run_id, 'usage_not_recorded:' || n.run_id FROM new_alerts n WHERE n.work_item_id IS NOT NULL
    ON CONFLICT DO NOTHING
  )
  SELECT n.account_id, n.work_item_id, n.run_id FROM new_alerts n
$$;

-- Counts only; no account, run or item leaves it. A nonzero count is the needs-owner signal.
CREATE FUNCTION platform_invariant_alert_counts(p_days int)
RETURNS TABLE (invariant text, alerts bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT a.invariant, count(*) FROM public.platform_invariant_alerts a
   WHERE a.raised_at >= now() - make_interval(days => LEAST(GREATEST(p_days, 1), 365)) GROUP BY a.invariant
$$;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'invariant_sweep_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on invariant_sweep_definer; cannot ALTER FUNCTION ... OWNER TO invariant_sweep_definer';
    END IF;
    GRANT invariant_sweep_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO invariant_sweep_definer;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'platform_invariant_stage_not_moved(int, int, int)', 'platform_invariant_no_activity(int, int, int)',
    'platform_invariant_usage_not_recorded(int, int, int)', 'platform_invariant_alert_counts(int)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('ALTER FUNCTION %s OWNER TO invariant_sweep_definer', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO agent_run_writer', f);
  END LOOP;
END
$$;

REVOKE CREATE ON SCHEMA public FROM invariant_sweep_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE invariant_sweep_definer FROM CURRENT_USER;
  END IF;
END
$$;
