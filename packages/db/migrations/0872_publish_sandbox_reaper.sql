-- D#598 P1f-5r: the reaper and the bookkeeping learn the publish sandbox. A publish sandbox is named "pp-<publish attempt row id>"
-- (plane_push_attempts.id, 0831). Until now every reaper definer, the inventory writer, the sandbox_reaps name check and the runner's
-- name mark knew only "ex-" and "rn-" names, so a "pp-" name was refused at the first listing (sandbox_reap_unknown_names raises on it).
-- This file widens each of them to "pp-", and adds the one lookup the widening needs. LISTABLE_PREFIXES (packages/runner/src/sandboxPort.ts)
-- gains "pp-" in the same change, so the list and the SQL can never be live apart.
--
--   widened (same signatures, CREATE OR REPLACE, so owner, ACL and pinned search_path stay):
--     agent_run_sandbox_mark (0706)                    accepts a "pp-<uuid>" name; any other shape is still refused
--     sandbox_reap_unknown_names (0731)                accepts "pp-" names
--     sandbox_reaps.sandbox_name check (0731)          allows "pp-" names
--     sandbox_reap_ephemeral_state / _candidates_ephemeral / _claim_ephemeral (0760)
--                                                      the 1-day net covers a "pp-" name recorded by a run row, with the same guards
--                                                      (every run finished, 24 hours old, compute settled, one account, no unexpired claim)
--     sandbox_inventory_write (0760)                   accepts "pp-" names (counted as stopped ephemeral, never executor, never idle)
--
--   new: sandbox_reap_publish_status(account, name). The run-row lookups cannot say whether a publish sandbox is live: its name comes from
--   the attempt row, not from a run row, and a leaked one (the attempt rolled back, or never written) has no run row at all. This definer
--   answers from the attempt row, for the account the caller names:
--     'live'     the attempt is unfinished and its run is live (or it is under an hour old and has no run yet), or a live run of that
--                account records the name
--     'terminal' the attempt is finished, or its run is gone or finished
--     'orphan'   no attempt row, and no live run of the account and no run of another account records the name
--     'refused'  the attempt, or a run recording the name, belongs to another account: nothing about it is revealed beyond that word
--   The sweep deletes only on 'terminal' or 'orphan'. Liveness is derived on every call from the rows; nothing is stamped.
--   The definer belongs to a new NOLOGIN, member-less role, sandbox_publish_reaper, that reads only the columns the body reads, each
--   with a row policy for that role alone. EXECUTE: agent_run_writer (the runner login's role) and nobody else.
--
-- Revert. The migration is additive in effect: a wider name check and one new function. Reverting the deploy leaves "pp-" unlisted again
-- (the TypeScript list is part of the deploy) and nothing in the database creates a "pp-" sandbox, so the wider SQL is inert. There is no
-- down file, as for every migration here. To take the change out by hand, in this order: (1) DELETE the 'pp-' rows of sandbox_reaps (or
-- migrate them away), then drop and re-add its sandbox_name check with '^(ex|rn)-...'; (2) re-run the bodies of 0706 (agent_run_sandbox_mark),
-- 0731 (sandbox_reap_unknown_names) and 0760 (the three ephemeral functions and sandbox_inventory_write) as CREATE OR REPLACE, inside the same
-- owner brackets this file uses (the migrator holds each owner role and gives it CREATE on public only for the replace); (3) DROP FUNCTION
-- sandbox_reap_publish_status(uuid, text); DROP INDEX agent_runs_sandbox_name_pp; DROP POLICY sandbox_publish_reaper_select ON agent_runs and
-- ON plane_push_attempts; REVOKE the column SELECTs on both tables and USAGE on public from sandbox_publish_reaper; DROP ROLE
-- sandbox_publish_reaper. No setting is added: the existing reaper mode switch (sandbox_reap_settings, 0762) governs the pass, and a fresh
-- environment stays in dry_run.
--
-- Numbered 0872: 0871 is held for another change. Re-check against main's highest right before merging; migrations merge in number order.
-- Privilege brackets as in 0742, 0760 and 0868: the migrator holds each owner role (with ADMIN from creating it) only for the replace.

DO $$
DECLARE
  n text := 'sandbox_publish_reaper';
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

GRANT USAGE ON SCHEMA public TO sandbox_publish_reaper;
GRANT SELECT (id, account_id, status, sandbox_name) ON agent_runs TO sandbox_publish_reaper;
GRANT SELECT (id, account_id, run_id, finished_at, created_at) ON plane_push_attempts TO sandbox_publish_reaper;
CREATE POLICY sandbox_publish_reaper_select ON agent_runs FOR SELECT TO sandbox_publish_reaper USING (true);
CREATE POLICY sandbox_publish_reaper_select ON plane_push_attempts FOR SELECT TO sandbox_publish_reaper USING (true);

-- The pattern a publish name must have; the sandbox_reaps check is widened here (the table is the migrator's).
ALTER TABLE sandbox_reaps DROP CONSTRAINT sandbox_reaps_sandbox_name_check;
ALTER TABLE sandbox_reaps ADD CONSTRAINT sandbox_reaps_sandbox_name_check CHECK (sandbox_name ~ '^(ex|rn|pp)-[A-Za-z0-9._-]{1,200}$');

-- The name lookup of the pp- names a run row does not explain (the index of the ephemeral list's third prefix).
CREATE INDEX agent_runs_sandbox_name_pp ON agent_runs (sandbox_name) WHERE sandbox_name LIKE 'pp-%';

-- Ownership brackets: the migrator holds each current owner (and the new one) while it replaces or creates, and each owner has CREATE on
-- public only for that. All are reset at the end.
DO $$
DECLARE
  n text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH n IN ARRAY ARRAY['sandbox_settle_definer', 'sandbox_reaper', 'sandbox_ephemeral_reaper', 'sandbox_inventory_writer', 'sandbox_publish_reaper'] LOOP
      IF NOT EXISTS (
        SELECT 1 FROM pg_auth_members m
        WHERE m.roleid = n::regrole AND m.member = current_user::regrole AND m.admin_option
      ) THEN
        RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot replace or create its functions', n;
      END IF;
      EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', n);
    END LOOP;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO sandbox_settle_definer, sandbox_reaper, sandbox_ephemeral_reaper, sandbox_inventory_writer, sandbox_publish_reaper;

-- 'live', 'terminal', 'orphan' or 'refused' for the publish sandbox p_name, as the account p_account_id sees it (see the header).
CREATE FUNCTION sandbox_reap_publish_status(p_account_id uuid, p_name text)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_id uuid;
  v_found boolean;
  v_att_account uuid;
  v_att_run uuid;
  v_att_finished timestamptz;
  v_att_created timestamptz;
  v_other int;
  v_run_live boolean;
  v_att_run_live boolean;
BEGIN
  IF p_account_id IS NULL OR p_name IS NULL OR p_name !~ '^pp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'sandbox_reap_publish_status: not a publish sandbox name' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_id := substr(p_name, 4)::uuid;
  SELECT t.account_id, t.run_id, t.finished_at, t.created_at INTO v_att_account, v_att_run, v_att_finished, v_att_created
    FROM public.plane_push_attempts t WHERE t.id = v_id;
  v_found := FOUND;
  IF v_found AND v_att_account <> p_account_id THEN RETURN 'refused'; END IF;
  SELECT count(DISTINCT r.account_id) FILTER (WHERE r.account_id <> p_account_id)::int,
         COALESCE(bool_or(r.status NOT IN ('refused_spend', 'succeeded', 'failed', 'timed_out', 'killed_spend', 'cancelled')) FILTER (WHERE r.account_id = p_account_id), false)
    INTO v_other, v_run_live
    FROM public.agent_runs r WHERE r.sandbox_name = p_name;
  IF v_other > 0 THEN RETURN 'refused'; END IF;
  IF v_run_live THEN RETURN 'live'; END IF;
  IF NOT v_found THEN RETURN 'orphan'; END IF;
  IF v_att_finished IS NOT NULL THEN RETURN 'terminal'; END IF;
  -- Unfinished: live while its run is live, or while it is young and has no run yet (the row is written before the run and the sandbox).
  IF v_att_run IS NULL THEN
    RETURN CASE WHEN v_att_created > now() - interval '1 hour' THEN 'live' ELSE 'terminal' END;
  END IF;
  SELECT COALESCE(bool_or(r.status NOT IN ('refused_spend', 'succeeded', 'failed', 'timed_out', 'killed_spend', 'cancelled')), false) INTO v_att_run_live
    FROM public.agent_runs r WHERE r.account_id = p_account_id AND r.id = v_att_run;
  RETURN CASE WHEN v_att_run_live THEN 'live' ELSE 'terminal' END;
END $$;
REVOKE ALL ON FUNCTION sandbox_reap_publish_status(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sandbox_reap_publish_status(uuid, text) TO agent_run_writer;
ALTER FUNCTION sandbox_reap_publish_status(uuid, text) OWNER TO sandbox_publish_reaper;

-- ---- the widened definers (bodies are the earlier files', with the name patterns widened and nothing else) ----

CREATE OR REPLACE FUNCTION agent_run_sandbox_mark(
  p_account_id uuid, p_run_id uuid, p_requested boolean, p_session_id text,
  p_stopped boolean, p_self_measured jsonb, p_due boolean, p_sandbox_name text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_account_id IS NULL OR p_account_id IS DISTINCT FROM NULLIF(current_setting('app.account_id', true), '')::uuid THEN
    RAISE EXCEPTION 'agent_run_sandbox_mark: account % is not the caller''s tenant context', p_account_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_sandbox_name IS NOT NULL AND p_sandbox_name !~ '^(ex|rn|pp)-[A-Za-z0-9._-]{1,200}$' THEN
    RAISE EXCEPTION 'agent_run_sandbox_mark: the sandbox name has an unexpected shape' USING ERRCODE = 'check_violation';
  END IF;
  -- The name is bound to the run, as packages/runner/src/sandboxNaming.ts builds it: a non-executor name is
  -- "rn-<role length>-<role>-<run id>", an executor name is "ex-<account id>-<repo id>-<pr number>". So even the
  -- runner's own login cannot record a name that belongs to another run or another tenant.
  IF p_sandbox_name LIKE 'rn-%' AND NOT (p_sandbox_name ~ '^rn-[0-9]{1,3}-.+-[0-9a-f-]{36}$'
                                         AND right(p_sandbox_name, 37) = '-' || p_run_id::text) THEN
    RAISE EXCEPTION 'agent_run_sandbox_mark: the sandbox name does not end with this run''s id' USING ERRCODE = 'check_violation';
  END IF;
  IF p_sandbox_name LIKE 'ex-%' AND NOT (p_sandbox_name ~ '^ex-[0-9a-f-]{36}-[0-9a-f-]{36}-[0-9]{1,18}$'
                                         AND substr(p_sandbox_name, 4, 36) = p_account_id::text) THEN
    RAISE EXCEPTION 'agent_run_sandbox_mark: the sandbox name does not embed this account' USING ERRCODE = 'check_violation';
  END IF;
  -- A publish sandbox is "pp-<attempt row id>" (a uuid). The attempt, not the run, names it, so the shape is all that is checked here.
  IF p_sandbox_name LIKE 'pp-%' AND p_sandbox_name !~ '^pp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'agent_run_sandbox_mark: the sandbox name is not a publish attempt name' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.agent_runs SET
    sandbox_requested_at  = CASE WHEN p_requested THEN COALESCE(sandbox_requested_at, now()) ELSE sandbox_requested_at END,
    sandbox_session_ids   = CASE WHEN p_session_id IS NOT NULL AND NOT (p_session_id = ANY (sandbox_session_ids))
                                 THEN array_append(sandbox_session_ids, p_session_id) ELSE sandbox_session_ids END,
    sandbox_stopped_at    = CASE WHEN p_stopped THEN COALESCE(sandbox_stopped_at, now()) ELSE sandbox_stopped_at END,
    sandbox_self_measured = COALESCE(sandbox_self_measured, p_self_measured),
    compute_settle_due_at = CASE WHEN p_due IS NULL THEN compute_settle_due_at
                                 WHEN p_due THEN COALESCE(compute_settle_due_at, now()) ELSE NULL END,
    sandbox_name          = COALESCE(sandbox_name, p_sandbox_name)
  WHERE account_id = p_account_id AND id = p_run_id;
END $$;

CREATE OR REPLACE FUNCTION sandbox_reap_unknown_names(p_names text[])
RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_names IS NULL OR cardinality(p_names) > 200
     OR EXISTS (SELECT 1 FROM unnest(p_names) n WHERE n IS NULL OR n !~ '^(ex|rn|pp)-[A-Za-z0-9._-]{1,200}$') THEN
    RAISE EXCEPTION 'sandbox_reap_unknown_names: bad names' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN COALESCE((SELECT array_agg(n ORDER BY n) FROM unnest(p_names) n
                    WHERE NOT EXISTS (SELECT 1 FROM public.agent_runs r WHERE r.sandbox_name = n)), '{}'::text[]);
END $$;

CREATE OR REPLACE FUNCTION sandbox_reap_ephemeral_state(p_name text, p_after text)
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
     WHERE (r.sandbox_name LIKE 'rn-%' OR r.sandbox_name LIKE 'pp-%')
       AND (p_name IS NULL OR r.sandbox_name = p_name)
       AND (p_after IS NULL OR r.sandbox_name > p_after)
     GROUP BY r.sandbox_name
  )
  SELECT n.name, n.acct, n.run, n.n_accounts, n.live, n.old_enough, n.settled,
         EXISTS (SELECT 1 FROM public.sandbox_reaps s WHERE s.sandbox_name = n.name AND s.state = 'claimed' AND s.claimed_at > now() - interval '10 minutes'),
         EXISTS (SELECT 1 FROM public.sandbox_reaps s WHERE s.sandbox_name = n.name AND s.state = 'deleted' AND s.done_at >= n.last_run_at)
    FROM names n
$$;

CREATE OR REPLACE FUNCTION sandbox_reap_candidates_ephemeral(p_limit int, p_after text DEFAULT NULL)
RETURNS TABLE (account_id uuid, run_id uuid, sandbox_name text, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'sandbox_reap_candidates_ephemeral: bad limit' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The cursor only bounds the order of the scan; it never selects a name.
  IF p_after IS NOT NULL AND p_after !~ '^(rn|pp)-[A-Za-z0-9._-]{1,200}$' THEN
    RAISE EXCEPTION 'sandbox_reap_candidates_ephemeral: bad cursor' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT s.account_id, s.run_id, s.sandbox_name, CASE WHEN s.settled THEN 'ephemeral' ELSE 'ephemeral_unsettled' END
    FROM public.sandbox_reap_ephemeral_state(NULL, p_after) s
   WHERE s.n_accounts = 1 AND NOT s.has_live AND s.old_enough AND NOT s.claimed AND NOT s.reaped_since
   ORDER BY s.sandbox_name
   LIMIT p_limit;
END $$;

CREATE OR REPLACE FUNCTION sandbox_reap_claim_ephemeral(p_name text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  st record;
BEGIN
  IF p_name IS NULL OR p_name !~ '^(rn|pp)-[A-Za-z0-9._-]{1,200}$' THEN
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

CREATE OR REPLACE FUNCTION sandbox_inventory_write(p_names text[], p_states text[], p_cap int)
RETURNS TABLE (accounts int, orphans int, over_cap int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_accounts int;
  v_orphans int;
  v_over int;
BEGIN
  IF p_names IS NULL OR p_states IS NULL OR cardinality(p_names) > 20000 OR cardinality(p_names) <> cardinality(p_states)
     OR p_cap IS NULL OR p_cap NOT BETWEEN 1 AND 1000
     OR EXISTS (SELECT 1 FROM unnest(p_names) n WHERE n IS NULL OR n !~ '^(ex|rn|pp)-[A-Za-z0-9._-]{1,200}$')
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


REVOKE CREATE ON SCHEMA public FROM sandbox_settle_definer, sandbox_reaper, sandbox_ephemeral_reaper, sandbox_inventory_writer, sandbox_publish_reaper;
DO $$
DECLARE
  n text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH n IN ARRAY ARRAY['sandbox_settle_definer', 'sandbox_reaper', 'sandbox_ephemeral_reaper', 'sandbox_inventory_writer', 'sandbox_publish_reaper'] LOOP
      EXECUTE format('REVOKE %I FROM CURRENT_USER', n);
    END LOOP;
  END IF;
END
$$;
