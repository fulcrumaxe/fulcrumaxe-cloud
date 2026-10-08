-- D#2 SANDBOX-REAPER-1b (C81, amended by C82): the database half of the 1-day safety net and of the inventory, plus the three
-- reconcile_jobs rows the cron drives them with. Two roles, each NOLOGIN and member-less (the 0720 / 0731 shape), each holding
-- only what its definers read or write, with a row policy for that role alone:
--
--   sandbox_ephemeral_reaper   owns sandbox_reap_ephemeral_state(name, after), sandbox_reap_candidates_ephemeral(limit, after) and
--                              sandbox_reap_claim_ephemeral(name). Column SELECTs on agent_runs, spend_reservations and ledger, and
--                              SELECT/INSERT/UPDATE on sandbox_reaps (0731). The done step stays 0731's sandbox_reap_done.
--   sandbox_inventory_writer   owns sandbox_inventory_write(names, states, cap). Column SELECTs on agent_runs, work_items and
--                              run_action_requests, and SELECT/INSERT/DELETE on sandbox_inventory (below).
--
-- Both sets of definers are EXECUTE for agent_run_writer (the runner login's role) and nobody else, so app_user and a platform_ops
-- session get 42501. platform_ops gains no privilege. The sweeps run through the worker (C82), which is the only place the runner
-- login lives.
--
-- The ephemeral pass (C81 criterion 6). A candidate is an rn- name whose every run is finished and ended at least 24 hours ago
-- (ended_at, else updated_at, for a row that predates ended_at). It is listed 'ephemeral' when its compute is SETTLED: every run
-- under the name has a compute ledger row, no settle is still owed (compute_settle_due_at is null) and no non-model reservation is
-- open. Otherwise it is listed 'ephemeral_unsettled': the pass reports it (sandbox_unsettled_stale) and never deletes it, because the
-- settle still needs the stopped sandbox to measure it, and the claim refuses it too. Compute is never free: spend that is not settled
-- is never lost to a delete.
--
-- The inventory (C81 criterion 14). sandbox_inventory is derived: sandbox_inventory_write replaces every row from the provider's list
-- (names and live/stopped states, passed in) joined to the run rows that own each name. It keeps no history. A name no run row owns,
-- or that runs of two accounts claim, belongs to no account; it is counted as an orphan and never written. Nothing here reads a name
-- from a customer: names come from the worker's provider list and are checked against run rows.
--
-- Privilege brackets as in 0731.
DO $$
DECLARE
  n text;
BEGIN
  FOREACH n IN ARRAY ARRAY['sandbox_ephemeral_reaper', 'sandbox_inventory_writer'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
    END IF;
    IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
      EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
      RAISE EXCEPTION 'role % still has a privileged attribute', n;
    END IF;
  END LOOP;
END
$$;

CREATE TABLE sandbox_inventory (
  account_id        uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  live              integer NOT NULL CHECK (live >= 0),
  stopped_executor  integer NOT NULL CHECK (stopped_executor >= 0),
  stopped_ephemeral integer NOT NULL CHECK (stopped_ephemeral >= 0),
  idle_executor     integer NOT NULL CHECK (idle_executor >= 0),
  oldest_idle_at    timestamptz,
  taken_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sandbox_inventory_idle_within_stopped CHECK (idle_executor <= stopped_executor),
  CONSTRAINT sandbox_inventory_oldest_iff_idle CHECK ((oldest_idle_at IS NOT NULL) = (idle_executor > 0))
);
ALTER TABLE sandbox_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_inventory FORCE ROW LEVEL SECURITY;
REVOKE ALL ON sandbox_inventory FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON sandbox_inventory TO sandbox_inventory_writer;
CREATE POLICY sandbox_inventory_writer_all ON sandbox_inventory FOR ALL TO sandbox_inventory_writer USING (true) WITH CHECK (true);

-- The rn- name lookup of the ephemeral list (0731 made the ex- one).
CREATE INDEX agent_runs_sandbox_name_rn ON agent_runs (sandbox_name) WHERE sandbox_name LIKE 'rn-%';

-- What the ephemeral definers read, column by column. Each table is row-secured, so each gets a policy for this role only.
GRANT SELECT (id, account_id, status, sandbox_name, created_at, updated_at, ended_at, compute_settle_due_at)
  ON agent_runs TO sandbox_ephemeral_reaper;
GRANT SELECT (account_id, run_id, state, budget) ON spend_reservations TO sandbox_ephemeral_reaper;
GRANT SELECT (account_id, run_id, kind) ON ledger TO sandbox_ephemeral_reaper;
GRANT SELECT, INSERT, UPDATE ON sandbox_reaps TO sandbox_ephemeral_reaper;
GRANT USAGE ON SCHEMA public TO sandbox_ephemeral_reaper;
CREATE POLICY sandbox_ephemeral_reaper_select ON agent_runs FOR SELECT TO sandbox_ephemeral_reaper USING (true);
CREATE POLICY sandbox_ephemeral_reaper_select ON spend_reservations FOR SELECT TO sandbox_ephemeral_reaper USING (true);
CREATE POLICY sandbox_ephemeral_reaper_select ON ledger FOR SELECT TO sandbox_ephemeral_reaper USING (true);
CREATE POLICY sandbox_ephemeral_reaper_all ON sandbox_reaps FOR ALL TO sandbox_ephemeral_reaper USING (true) WITH CHECK (true);

-- What the inventory definer reads.
GRANT SELECT (id, account_id, work_item_id, status, sandbox_name, dispatch_repo_id, dispatch_pr_number, created_at, updated_at, ended_at)
  ON agent_runs TO sandbox_inventory_writer;
GRANT SELECT (id, account_id, repo_id, gh_number, updated_at) ON work_items TO sandbox_inventory_writer;
GRANT SELECT (account_id, target_id, state) ON run_action_requests TO sandbox_inventory_writer;
GRANT USAGE ON SCHEMA public TO sandbox_inventory_writer;
CREATE POLICY sandbox_inventory_writer_select ON agent_runs FOR SELECT TO sandbox_inventory_writer USING (true);
CREATE POLICY sandbox_inventory_writer_select ON work_items FOR SELECT TO sandbox_inventory_writer USING (true);
CREATE POLICY sandbox_inventory_writer_select ON run_action_requests FOR SELECT TO sandbox_inventory_writer USING (true);

-- Ownership bracket (0702's shape, as 0731 uses it): a non-superuser migrator needs SET on each role for ALTER ... OWNER TO, and
-- each role needs CREATE on public at that instant. The memberships are removed again afterwards.
DO $$
DECLARE
  n text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH n IN ARRAY ARRAY['sandbox_ephemeral_reaper', 'sandbox_inventory_writer'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_auth_members m
        WHERE m.roleid = n::regrole AND m.member = current_user::regrole AND m.admin_option
      ) THEN
        RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot ALTER FUNCTION ... OWNER TO %', n, n;
      END IF;
      EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT FALSE, SET TRUE', n);
    END LOOP;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO sandbox_ephemeral_reaper;
GRANT CREATE ON SCHEMA public TO sandbox_inventory_writer;

-- One row per rn- sandbox name that some run recorded (optionally one name, or the names after a cursor), with the facts every
-- guard reads. The candidate list and the claim both read this, so they cannot disagree. The status list repeats 0731's: a run in
-- any other status is live.
CREATE FUNCTION sandbox_reap_ephemeral_state(p_name text, p_after text)
RETURNS TABLE (
  sandbox_name text, account_id uuid, run_id uuid, n_accounts int, has_live boolean, old_enough boolean, settled boolean,
  claimed boolean, reaped_since boolean)
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH names AS (
    SELECT r.sandbox_name AS name,
           (array_agg(r.account_id ORDER BY r.created_at DESC, r.id DESC))[1] AS acct,
           (array_agg(r.id ORDER BY r.created_at DESC, r.id DESC))[1] AS run,
           count(DISTINCT r.account_id)::int AS n_accounts,
           max(r.created_at) AS last_run_at,
           bool_or(r.status NOT IN ('refused_spend', 'succeeded', 'failed', 'timed_out', 'killed_spend', 'cancelled')) AS live,
           bool_and(COALESCE(r.ended_at, r.updated_at) <= now() - interval '24 hours') AS old_enough,
           -- Settled: every run has its compute ledger row, no settle is owed and no non-model reservation is open.
           bool_and(r.compute_settle_due_at IS NULL
                    AND EXISTS (SELECT 1 FROM public.ledger l WHERE l.account_id = r.account_id AND l.run_id = r.id AND l.kind = 'compute')
                    AND NOT EXISTS (SELECT 1 FROM public.spend_reservations s WHERE s.account_id = r.account_id AND s.run_id = r.id AND s.state = 'open' AND s.budget <> 'model')) AS settled
      FROM public.agent_runs r
     WHERE r.sandbox_name LIKE 'rn-%'
       AND (p_name IS NULL OR r.sandbox_name = p_name)
       AND (p_after IS NULL OR r.sandbox_name > p_after)
     GROUP BY r.sandbox_name
  )
  SELECT n.name, n.acct, n.run, n.n_accounts, n.live, n.old_enough, n.settled,
         EXISTS (SELECT 1 FROM public.sandbox_reaps s WHERE s.sandbox_name = n.name AND s.state = 'claimed' AND s.claimed_at > now() - interval '10 minutes'),
         EXISTS (SELECT 1 FROM public.sandbox_reaps s WHERE s.sandbox_name = n.name AND s.state = 'deleted' AND s.done_at >= n.last_run_at)
    FROM names n
$$;

CREATE FUNCTION sandbox_reap_candidates_ephemeral(p_limit int, p_after text DEFAULT NULL)
RETURNS TABLE (account_id uuid, run_id uuid, sandbox_name text, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'sandbox_reap_candidates_ephemeral: bad limit' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The cursor only bounds the order of the scan; it never selects a name.
  IF p_after IS NOT NULL AND p_after !~ '^rn-[A-Za-z0-9._-]{1,200}$' THEN
    RAISE EXCEPTION 'sandbox_reap_candidates_ephemeral: bad cursor' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT s.account_id, s.run_id, s.sandbox_name, CASE WHEN s.settled THEN 'ephemeral' ELSE 'ephemeral_unsettled' END
    FROM public.sandbox_reap_ephemeral_state(NULL, p_after) s
   WHERE s.n_accounts = 1 AND NOT s.has_live AND s.old_enough AND NOT s.claimed AND NOT s.reaped_since
   ORDER BY s.sandbox_name
   LIMIT p_limit;
END $$;

-- 'claimed' or the first refusal. The advisory lock is the one the executor claim of 0731 takes (the key is the name), so two
-- passes that overlap give each name one winner.
CREATE FUNCTION sandbox_reap_claim_ephemeral(p_name text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  st record;
BEGIN
  IF p_name IS NULL OR p_name !~ '^rn-[A-Za-z0-9._-]{1,200}$' THEN
    RAISE EXCEPTION 'sandbox_reap_claim_ephemeral: not an ephemeral sandbox name' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('fx-sandbox:' || p_name, 0));
  SELECT * INTO st FROM public.sandbox_reap_ephemeral_state(p_name, NULL);
  IF NOT FOUND OR st.n_accounts <> 1 THEN RETURN 'refused_not_candidate'; END IF;
  IF st.has_live THEN RETURN 'refused_live'; END IF;
  IF NOT st.old_enough THEN RETURN 'refused_young'; END IF;
  IF NOT st.settled THEN RETURN 'refused_unsettled'; END IF; -- the settle needs the stopped sandbox: never deleted before it is settled
  IF st.claimed THEN RETURN 'refused_claimed'; END IF;
  IF st.reaped_since THEN RETURN 'refused_done'; END IF;
  INSERT INTO public.sandbox_reaps AS s (sandbox_name, account_id, run_id, reason, state, claimed_at, done_at)
  VALUES (p_name, st.account_id, st.run_id, 'ephemeral', 'claimed', now(), NULL)
  ON CONFLICT (sandbox_name) DO UPDATE
    SET account_id = EXCLUDED.account_id, run_id = EXCLUDED.run_id, reason = EXCLUDED.reason,
        state = 'claimed', claimed_at = now(), done_at = NULL;
  RETURN 'claimed';
END $$;

-- Replaces the whole inventory from the provider's list. p_names and p_states are parallel: a listed name and 'live' or 'stopped'.
-- A name is counted for the account whose run rows own it (exactly one account); any other listed name is an orphan and writes
-- nothing. Executor sandboxes that are stopped, have no live run and no queued or leased run action are idle, and the oldest
-- idle one's last activity (the latest of its runs' updates and its sharing work items' updates) is oldest_idle_at.
-- Returns the number of account rows written, the orphan count and the number of accounts whose idle count is over p_cap.
CREATE FUNCTION sandbox_inventory_write(p_names text[], p_states text[], p_cap int)
RETURNS TABLE (accounts int, orphans int, over_cap int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_accounts int;
  v_orphans int;
  v_over int;
BEGIN
  IF p_names IS NULL OR p_states IS NULL OR cardinality(p_names) > 20000 OR cardinality(p_names) <> cardinality(p_states)
     OR p_cap IS NULL OR p_cap NOT BETWEEN 1 AND 1000
     OR EXISTS (SELECT 1 FROM unnest(p_names) n WHERE n IS NULL OR n !~ '^(ex|rn)-[A-Za-z0-9._-]{1,200}$')
     OR EXISTS (SELECT 1 FROM unnest(p_states) s WHERE s IS NULL OR s NOT IN ('live', 'stopped'))
     OR (SELECT count(DISTINCT n) FROM unnest(p_names) n) <> cardinality(p_names) THEN
    RAISE EXCEPTION 'sandbox_inventory_write: bad input' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('fx-sandbox-inventory', 0));
  DELETE FROM public.sandbox_inventory;
  WITH listed AS (
    SELECT u.name, u.state FROM unnest(p_names, p_states) AS u(name, state)
  ), runs AS (
    SELECT l.name, l.state,
           count(DISTINCT r.account_id)::int AS n_accounts,
           (array_agg(r.account_id ORDER BY r.created_at DESC, r.id DESC) FILTER (WHERE r.id IS NOT NULL))[1] AS acct,
           COALESCE(bool_or(r.status NOT IN ('refused_spend', 'succeeded', 'failed', 'timed_out', 'killed_spend', 'cancelled')), false) AS has_live,
           max(GREATEST(r.created_at, r.updated_at, r.ended_at)) AS run_activity
      FROM listed l LEFT JOIN public.agent_runs r ON r.sandbox_name = l.name
     GROUP BY l.name, l.state
  ), per_name AS (
    SELECT n.name, n.state, n.acct, n.has_live, n.name LIKE 'ex-%' AS is_ex,
           GREATEST(n.run_activity, it.item_activity) AS last_activity,
           EXISTS (SELECT 1 FROM public.run_action_requests q
                    WHERE q.account_id = n.acct AND q.state IN ('accepted', 'claimed')
                      AND (q.target_id = ANY (it.ids) OR q.target_id IN (SELECT r.id FROM public.agent_runs r WHERE r.sandbox_name = n.name))) AS has_action
      FROM runs n
      CROSS JOIN LATERAL (
        SELECT COALESCE(array_agg(w.id), '{}'::uuid[]) AS ids, max(w.updated_at) AS item_activity
          FROM public.work_items w
         WHERE w.account_id = n.acct
           AND (w.id IN (SELECT r.work_item_id FROM public.agent_runs r WHERE r.sandbox_name = n.name AND r.work_item_id IS NOT NULL)
                OR EXISTS (SELECT 1 FROM public.agent_runs r
                            WHERE r.sandbox_name = n.name AND r.dispatch_repo_id = w.repo_id AND r.dispatch_pr_number = w.gh_number))
      ) it
     WHERE n.n_accounts = 1
  )
  INSERT INTO public.sandbox_inventory (account_id, live, stopped_executor, stopped_ephemeral, idle_executor, oldest_idle_at, taken_at)
  SELECT p.acct,
         (count(*) FILTER (WHERE p.state = 'live'))::int,
         (count(*) FILTER (WHERE p.state = 'stopped' AND p.is_ex))::int,
         (count(*) FILTER (WHERE p.state = 'stopped' AND NOT p.is_ex))::int,
         (count(*) FILTER (WHERE p.state = 'stopped' AND p.is_ex AND NOT p.has_live AND NOT p.has_action))::int,
         min(p.last_activity) FILTER (WHERE p.state = 'stopped' AND p.is_ex AND NOT p.has_live AND NOT p.has_action),
         now()
    FROM per_name p
   GROUP BY p.acct;
  GET DIAGNOSTICS v_accounts = ROW_COUNT;
  SELECT count(*)::int INTO v_orphans FROM unnest(p_names) u(name)
   WHERE (SELECT count(DISTINCT r.account_id) FROM public.agent_runs r WHERE r.sandbox_name = u.name) <> 1;
  SELECT count(*)::int INTO v_over FROM public.sandbox_inventory WHERE idle_executor > p_cap;
  RETURN QUERY SELECT v_accounts, v_orphans, v_over;
END $$;

REVOKE ALL ON FUNCTION sandbox_reap_ephemeral_state(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION sandbox_reap_candidates_ephemeral(int, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION sandbox_reap_claim_ephemeral(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION sandbox_inventory_write(text[], text[], int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sandbox_reap_candidates_ephemeral(int, text) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION sandbox_reap_claim_ephemeral(text) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION sandbox_inventory_write(text[], text[], int) TO agent_run_writer;

ALTER FUNCTION sandbox_reap_ephemeral_state(text, text) OWNER TO sandbox_ephemeral_reaper;
ALTER FUNCTION sandbox_reap_candidates_ephemeral(int, text) OWNER TO sandbox_ephemeral_reaper;
ALTER FUNCTION sandbox_reap_claim_ephemeral(text) OWNER TO sandbox_ephemeral_reaper;
ALTER FUNCTION sandbox_inventory_write(text[], text[], int) OWNER TO sandbox_inventory_writer;

REVOKE CREATE ON SCHEMA public FROM sandbox_ephemeral_reaper;
REVOKE CREATE ON SCHEMA public FROM sandbox_inventory_writer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE sandbox_ephemeral_reaper FROM CURRENT_USER;
    REVOKE sandbox_inventory_writer FROM CURRENT_USER;
  END IF;
END
$$;

-- The three jobs the cron drives through the worker. A job with no row here is never due. The terminal pass runs every 15 minutes
-- (the cron moves to 7,22,37,52 * * * * with this); the other two daily. A fresh environment is in dry_run until someone opts in.
INSERT INTO reconcile_jobs (name, interval_seconds) VALUES
  ('sandbox_reap_terminal', 900),
  ('sandbox_reap_ephemeral', 86400),
  ('sandbox_inventory', 86400);
