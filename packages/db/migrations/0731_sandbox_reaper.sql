-- D#2 SANDBOX-REAPER-1a (C81, amended by C82): the database half of the end-of-item sandbox delete. An executor sandbox
-- (ex-<account>-<repo>-<issue>) is persistent and keeps a snapshot; the reaper's terminal pass deletes it once EVERY work item
-- that shares the name has ended. Nothing calls this in production yet (REAPER-1b adds the cron and the kill switch).
--
--   sandbox_reaper   NOLOGIN, no members. Owns the definers and holds only what their bodies read: column SELECTs on
--                    agent_runs, work_items, run_action_requests and spend_reservations (each with a row policy for this
--                    role only) and SELECT/INSERT/UPDATE on sandbox_reaps.
--   sandbox_reaps    one row per sandbox name: the claim that precedes a provider delete and what came of it. Row security
--                    is forced and its only policy is for sandbox_reaper; app_user and platform_ops hold no privilege on it.
--   definers         EXECUTE for agent_run_writer (the runner login's role) and nobody else, so app_user and a platform_ops
--                    session get 42501: sandbox_reap_candidates_terminal(limit, after), sandbox_reap_claim(name, reason),
--                    sandbox_reap_done(name, state) (writes the audit row) and sandbox_reap_unknown_names(names) (orphans).
--
-- Names come only from run rows (agent_runs.sandbox_name, written once and bound to its run and account by 0706). The claim takes
-- a name but refuses it unless the same rules put it on the list right now; unknown_names only reports. A name is a candidate when:
--   * exactly one account has runs under it;
--   * no run under it is live (anything but a finished status counts as live) and no queued or leased run action targets one of
--     its runs or work items;
--   * the work items sharing it (same account, repo and issue number as a run's dispatch, or linked to one of its runs) exist and
--     are ALL in a terminal stage (this list repeats @fx/core's TERMINAL_WORK_ITEM_STAGES; a test keeps the two equal);
--   * no unexpired claim (10 minutes) and no completed delete newer than its latest run.
-- A name whose compute settle is still owed (compute_settle_due_at set, or an open compute reservation) is listed as
-- 'terminal_unsettled': the pass may STOP a sandbox still running (that lets the settle finish) but never deletes it, and
-- sandbox_reap_claim refuses it, because the settle needs the stopped sandbox to measure it. Settled names are 'terminal'.
-- Privilege brackets as in 0702.
DO $$
DECLARE
  n text := 'sandbox_reaper';
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

CREATE TABLE sandbox_reaps (
  sandbox_name text PRIMARY KEY CHECK (sandbox_name ~ '^(ex|rn)-[A-Za-z0-9._-]{1,200}$'),
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  run_id       uuid NOT NULL,
  reason       text NOT NULL CHECK (reason ~ '^[a-z_]{1,32}$'),
  state        text NOT NULL CHECK (state IN ('claimed', 'deleted', 'skipped')),
  claimed_at   timestamptz NOT NULL DEFAULT now(),
  done_at      timestamptz,
  CONSTRAINT sandbox_reaps_done_iff_finished CHECK ((state = 'claimed') = (done_at IS NULL))
);
ALTER TABLE sandbox_reaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE sandbox_reaps FORCE ROW LEVEL SECURITY;
REVOKE ALL ON sandbox_reaps FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON sandbox_reaps TO sandbox_reaper;
CREATE POLICY sandbox_reaper_all ON sandbox_reaps FOR ALL TO sandbox_reaper USING (true) WITH CHECK (true);

-- The name lookup of the candidate query.
CREATE INDEX agent_runs_sandbox_name_ex ON agent_runs (sandbox_name) WHERE sandbox_name LIKE 'ex-%';

-- What the definers read, column by column. Each table is row-secured, so each gets a SELECT policy for this role only.
GRANT SELECT (id, account_id, work_item_id, status, sandbox_name, dispatch_repo_id, dispatch_pr_number, created_at, compute_settle_due_at)
  ON agent_runs TO sandbox_reaper;
GRANT SELECT (id, account_id, repo_id, gh_number, stage) ON work_items TO sandbox_reaper;
GRANT SELECT (account_id, target_id, state) ON run_action_requests TO sandbox_reaper;
GRANT SELECT (account_id, run_id, state, budget) ON spend_reservations TO sandbox_reaper;
CREATE POLICY sandbox_reaper_select ON agent_runs FOR SELECT TO sandbox_reaper USING (true);
CREATE POLICY sandbox_reaper_select ON work_items FOR SELECT TO sandbox_reaper USING (true);
CREATE POLICY sandbox_reaper_select ON run_action_requests FOR SELECT TO sandbox_reaper USING (true);
CREATE POLICY sandbox_reaper_select ON spend_reservations FOR SELECT TO sandbox_reaper USING (true);

-- Ownership bracket (0702's shape): a non-superuser migrator needs SET on the role for ALTER ... OWNER TO, and the role
-- needs CREATE on public at that instant. The membership is removed again afterwards.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'sandbox_reaper'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on sandbox_reaper; cannot ALTER FUNCTION ... OWNER TO sandbox_reaper';
    END IF;
    GRANT sandbox_reaper TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO sandbox_reaper;
GRANT USAGE ON SCHEMA public TO sandbox_reaper;

CREATE FUNCTION sandbox_reap_terminal_stages() RETURNS text[]
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT ARRAY['merged', 'closed_unmerged', 'closed']::text[] $$;

-- One row per executor sandbox name that some run recorded (optionally one name, or the names after a cursor), with the
-- facts every guard reads. The candidate list and the claim both read this, so they cannot disagree.
CREATE FUNCTION sandbox_reap_ex_state(p_name text, p_after text)
RETURNS TABLE (
  sandbox_name text, account_id uuid, run_id uuid, n_accounts int, has_live boolean, unsettled boolean,
  has_action boolean, n_items int, n_open int, claimed boolean, reaped_since boolean)
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH names AS (
    SELECT r.sandbox_name AS name,
           (array_agg(r.account_id ORDER BY r.created_at DESC, r.id DESC))[1] AS acct,
           (array_agg(r.id ORDER BY r.created_at DESC, r.id DESC))[1] AS run,
           count(DISTINCT r.account_id)::int AS n_accounts,
           max(r.created_at) AS last_run_at,
           bool_or(r.status NOT IN ('refused_spend', 'succeeded', 'failed', 'timed_out', 'killed_spend', 'cancelled')) AS live,
           bool_or(r.compute_settle_due_at IS NOT NULL) AS due
      FROM public.agent_runs r
     WHERE r.sandbox_name LIKE 'ex-%'
       AND (p_name IS NULL OR r.sandbox_name = p_name)
       AND (p_after IS NULL OR r.sandbox_name > p_after)
     GROUP BY r.sandbox_name
  )
  SELECT n.name, n.acct, n.run, n.n_accounts, n.live,
         n.due OR EXISTS (SELECT 1 FROM public.spend_reservations s JOIN public.agent_runs r ON r.id = s.run_id AND r.account_id = s.account_id
                           WHERE r.sandbox_name = n.name AND s.state = 'open' AND s.budget <> 'model'),
         EXISTS (SELECT 1 FROM public.run_action_requests q
                  WHERE q.account_id = n.acct AND q.state IN ('accepted', 'claimed')
                    AND (q.target_id = ANY (it.ids) OR q.target_id IN (SELECT r.id FROM public.agent_runs r WHERE r.sandbox_name = n.name))),
         it.total, it.open_items,
         EXISTS (SELECT 1 FROM public.sandbox_reaps s WHERE s.sandbox_name = n.name AND s.state = 'claimed' AND s.claimed_at > now() - interval '10 minutes'),
         EXISTS (SELECT 1 FROM public.sandbox_reaps s WHERE s.sandbox_name = n.name AND s.state = 'deleted' AND s.done_at >= n.last_run_at)
    FROM names n
    CROSS JOIN LATERAL (
      SELECT COALESCE(array_agg(w.id), '{}'::uuid[]) AS ids,
             count(*)::int AS total,
             (count(*) FILTER (WHERE NOT COALESCE(w.stage = ANY (public.sandbox_reap_terminal_stages()), false)))::int AS open_items
        FROM public.work_items w
       WHERE w.account_id = n.acct
         AND (w.id IN (SELECT r.work_item_id FROM public.agent_runs r WHERE r.sandbox_name = n.name AND r.work_item_id IS NOT NULL)
              OR EXISTS (SELECT 1 FROM public.agent_runs r
                          WHERE r.sandbox_name = n.name AND r.dispatch_repo_id = w.repo_id AND r.dispatch_pr_number = w.gh_number))
    ) it
$$;

CREATE FUNCTION sandbox_reap_candidates_terminal(p_limit int, p_after text DEFAULT NULL)
RETURNS TABLE (account_id uuid, run_id uuid, sandbox_name text, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'sandbox_reap_candidates_terminal: bad limit' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The cursor only bounds the order of the scan; it never selects a name.
  IF p_after IS NOT NULL AND p_after !~ '^ex-[A-Za-z0-9._-]{1,200}$' THEN
    RAISE EXCEPTION 'sandbox_reap_candidates_terminal: bad cursor' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT s.account_id, s.run_id, s.sandbox_name, CASE WHEN s.unsettled THEN 'terminal_unsettled' ELSE 'terminal' END
    FROM public.sandbox_reap_ex_state(NULL, p_after) s
   WHERE s.n_accounts = 1 AND NOT s.has_live AND NOT s.has_action
     AND s.n_items > 0 AND s.n_open = 0 AND NOT s.claimed AND NOT s.reaped_since
   ORDER BY s.sandbox_name
   LIMIT p_limit;
END $$;

-- 'claimed' or the first refusal. The advisory lock is the one REAPER-2 makes agent_run_create take too (Build again).
CREATE FUNCTION sandbox_reap_claim(p_name text, p_reason text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  st record;
BEGIN
  IF p_reason IS DISTINCT FROM 'terminal' THEN
    RAISE EXCEPTION 'sandbox_reap_claim: unsupported reason' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_name IS NULL OR p_name !~ '^ex-[A-Za-z0-9._-]{1,200}$' THEN
    RAISE EXCEPTION 'sandbox_reap_claim: not an executor sandbox name' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('fx-sandbox:' || p_name, 0));
  SELECT * INTO st FROM public.sandbox_reap_ex_state(p_name, NULL);
  IF NOT FOUND OR st.n_accounts <> 1 OR st.n_items = 0 OR st.n_open > 0 THEN RETURN 'refused_not_candidate'; END IF;
  IF st.has_live OR st.has_action THEN RETURN 'refused_live'; END IF;
  IF st.unsettled THEN RETURN 'refused_unsettled'; END IF; -- the settle needs the stopped sandbox: never deleted before it is settled
  IF st.claimed THEN RETURN 'refused_claimed'; END IF;
  IF st.reaped_since THEN RETURN 'refused_done'; END IF;
  INSERT INTO public.sandbox_reaps AS s (sandbox_name, account_id, run_id, reason, state, claimed_at, done_at)
  VALUES (p_name, st.account_id, st.run_id, p_reason, 'claimed', now(), NULL)
  ON CONFLICT (sandbox_name) DO UPDATE
    SET account_id = EXCLUDED.account_id, run_id = EXCLUDED.run_id, reason = EXCLUDED.reason,
        state = 'claimed', claimed_at = now(), done_at = NULL;
  RETURN 'claimed';
END $$;

-- Closes a claim as deleted or skipped. Only a claimed row moves; repeating the same answer is a no-op. A delete writes
-- the audit row under the row's own account.
CREATE FUNCTION sandbox_reap_done(p_name text, p_state text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  c public.sandbox_reaps;
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('deleted', 'skipped') THEN
    RAISE EXCEPTION 'sandbox_reap_done: bad state' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.sandbox_reaps SET state = p_state, done_at = now()
   WHERE sandbox_name = p_name AND state = 'claimed'
  RETURNING * INTO c;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM public.sandbox_reaps WHERE sandbox_name = p_name AND state = p_state) THEN RETURN; END IF;
    RAISE EXCEPTION 'sandbox_reap_done: no claim to close' USING ERRCODE = 'no_data_found';
  END IF;
  IF p_state = 'deleted' THEN
    PERFORM public.audit_write_system(c.account_id, 'sandbox_reaper', 'sandbox.reaped',
      jsonb_build_object('reason', c.reason, 'sandbox_name', c.sandbox_name, 'run_id', c.run_id));
  END IF;
END $$;

-- Of up to 200 listed names, the ones no run row of this database mentions. Reports only; nothing acts on the answer.
CREATE FUNCTION sandbox_reap_unknown_names(p_names text[])
RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_names IS NULL OR cardinality(p_names) > 200
     OR EXISTS (SELECT 1 FROM unnest(p_names) n WHERE n IS NULL OR n !~ '^(ex|rn)-[A-Za-z0-9._-]{1,200}$') THEN
    RAISE EXCEPTION 'sandbox_reap_unknown_names: bad names' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN COALESCE((SELECT array_agg(n ORDER BY n) FROM unnest(p_names) n
                    WHERE NOT EXISTS (SELECT 1 FROM public.agent_runs r WHERE r.sandbox_name = n)), '{}'::text[]);
END $$;

REVOKE ALL ON FUNCTION sandbox_reap_terminal_stages() FROM PUBLIC;
REVOKE ALL ON FUNCTION sandbox_reap_ex_state(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION sandbox_reap_candidates_terminal(int, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION sandbox_reap_claim(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION sandbox_reap_done(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION sandbox_reap_unknown_names(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sandbox_reap_candidates_terminal(int, text) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION sandbox_reap_claim(text, text) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION sandbox_reap_done(text, text) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION sandbox_reap_unknown_names(text[]) TO agent_run_writer;
-- The done definer writes its audit row through the system entry point (0008), which only platform_ops could call. The
-- function is platform_ops's, so a non-superuser migrator grants on it only while it holds platform_ops (0691's bracket).
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT EXECUTE ON FUNCTION audit_write_system(uuid, text, text, jsonb) TO sandbox_reaper;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;

ALTER FUNCTION sandbox_reap_terminal_stages() OWNER TO sandbox_reaper;
ALTER FUNCTION sandbox_reap_ex_state(text, text) OWNER TO sandbox_reaper;
ALTER FUNCTION sandbox_reap_candidates_terminal(int, text) OWNER TO sandbox_reaper;
ALTER FUNCTION sandbox_reap_claim(text, text) OWNER TO sandbox_reaper;
ALTER FUNCTION sandbox_reap_done(text, text) OWNER TO sandbox_reaper;
ALTER FUNCTION sandbox_reap_unknown_names(text[]) OWNER TO sandbox_reaper;

REVOKE CREATE ON SCHEMA public FROM sandbox_reaper;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE sandbox_reaper FROM CURRENT_USER;
  END IF;
END
$$;
