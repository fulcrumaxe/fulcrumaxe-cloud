-- D#2 SANDBOX-REAPER-2 (C81 criteria 16-19, section 6; C82): the Build again lock, the 7-day idle rule and the cap of 20.
--
-- 1. The lock. agent_run_create takes pg_advisory_xact_lock(hashtextextended('fx-sandbox:' || <ex- name>, 0)) for an executor run
--    that names a repo and a pull request, and refuses with SQLSTATE FXR01 ('sandbox_reaping') when the name has a 'claimed' row in
--    sandbox_reaps that is less than 10 minutes old. The reaper's claims (0731 sandbox_reap_claim, 0760 sandbox_reap_claim_ephemeral,
--    and sandbox_reap_claim_idle below) take the same lock, then re-check that no run is live and no run action is queued or leased.
--    So a claim and a create on one name have exactly one winner, in either order:
--      * the claim commits first: the create waits on the lock, then reads the claim and raises FXR01 (nothing is written);
--      * the create commits first: the claim waits, then sees a live run and answers 'refused_live'.
--    A claim older than 10 minutes counts as expired, so a reaper that died mid-delete never blocks a build for longer.
--    The name is built the way sandboxNameFor builds it: 'ex-' || account || '-' || repo || '-' || pull request number.
--
--    agent_run_create is re-created with CREATE OR REPLACE, so its owner (platform_ops) and its ACL (agent_run_writer from 0738 and
--    runner_lease_definer from 0754) are the ones it already has; the body is 0738's, plus the lock and the check, and nothing else.
--
--    The check reads sandbox_reaps, which platform_ops (the function's owner) holds nothing on. It goes through ONE boolean definer,
--    sandbox_reap_claimed(name), owned by a NOLOGIN, member-less role of its own, sandbox_claim_guard (0720's guard_definer shape, as
--    0750's work_item_halt_lock): it holds SELECT (sandbox_name, state, claimed_at) on sandbox_reaps and a policy for that role only.
--    EXECUTE goes to platform_ops (agent_run_create is its definer) and to nobody else. platform_ops gets no grant and no policy on
--    sandbox_reaps; it can ask the one question "is this name being reaped right now" and cannot read a row.
--
-- 2. The idle rule and the cap (criteria 18 and 19), in a role of their own, sandbox_idle_reaper (NOLOGIN, member-less, column
--    grants only, a pinned search_path, EXECUTE for agent_run_writer, the runner login's role, and nobody else; platform_ops gains no
--    privilege). It owns sandbox_reap_idle_state(account, cap), sandbox_reap_candidates_idle(limit, after, cap) and
--    sandbox_reap_claim_idle(name, reason, cap). Names come only from run rows (agent_runs.sandbox_name, 0706-bound to its account).
--      * Last activity of a name is the latest of its runs' created_at / updated_at / ended_at and its sharing work items' updated_at.
--        The sharing items are those of the SAME account (a run's work item, or the item with the run's dispatch repo and issue number),
--        so no tenant's action can age or refresh another tenant's name.
--      * A name is in scope when no run under it is live, one account owns it, it holds no unexpired claim, no delete newer than its
--        latest run, and it is NOT covered by the terminal pass (every sharing item terminal). An in-scope name is FREE when no queued
--        or leased run action targets one of its runs or items and no compute settle is owed (the settle needs the stopped sandbox).
--      * reason 'idle': in scope, free, and idle for more than 7 days.
--      * reason 'cap': after the idle rule, an account holds more than p_cap names that are in scope and not idle-deleted (a name held
--        by a queued action still counts: it holds a snapshot). The oldest FREE ones by last activity are listed until it holds p_cap;
--        a name that is not free is skipped and the next-oldest free one takes its place.
--    The claim re-derives the same answer under the lock and refuses unless the name has exactly the reason asked for right now.
--
-- 3. One reconcile_jobs row, sandbox_reap_idle (daily). A fresh environment is in dry_run until someone opts in.
--
-- Privilege brackets as in 0731, 0750 and 0760.
DO $$
DECLARE
  n text;
BEGIN
  FOREACH n IN ARRAY ARRAY['sandbox_idle_reaper', 'sandbox_claim_guard'] LOOP
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

-- What the idle definers read, column by column. Each table is row-secured, so each gets a policy for this role only.
GRANT USAGE ON SCHEMA public TO sandbox_idle_reaper;
GRANT SELECT (id, account_id, work_item_id, status, sandbox_name, dispatch_repo_id, dispatch_pr_number, created_at, updated_at, ended_at, compute_settle_due_at)
  ON agent_runs TO sandbox_idle_reaper;
GRANT SELECT (id, account_id, repo_id, gh_number, stage, updated_at) ON work_items TO sandbox_idle_reaper;
GRANT SELECT (account_id, target_id, state) ON run_action_requests TO sandbox_idle_reaper;
GRANT SELECT (account_id, run_id, state, budget) ON spend_reservations TO sandbox_idle_reaper;
GRANT SELECT, INSERT, UPDATE ON sandbox_reaps TO sandbox_idle_reaper;
CREATE POLICY sandbox_idle_reaper_select ON agent_runs FOR SELECT TO sandbox_idle_reaper USING (true);
CREATE POLICY sandbox_idle_reaper_select ON work_items FOR SELECT TO sandbox_idle_reaper USING (true);
CREATE POLICY sandbox_idle_reaper_select ON run_action_requests FOR SELECT TO sandbox_idle_reaper USING (true);
CREATE POLICY sandbox_idle_reaper_select ON spend_reservations FOR SELECT TO sandbox_idle_reaper USING (true);
CREATE POLICY sandbox_idle_reaper_all ON sandbox_reaps FOR ALL TO sandbox_idle_reaper USING (true) WITH CHECK (true);

-- What the claim guard reads: three columns of sandbox_reaps.
GRANT USAGE ON SCHEMA public TO sandbox_claim_guard;
GRANT SELECT (sandbox_name, state, claimed_at) ON sandbox_reaps TO sandbox_claim_guard;
CREATE POLICY sandbox_claim_guard_select ON sandbox_reaps FOR SELECT TO sandbox_claim_guard USING (true);

-- Ownership bracket (0702's shape, as 0731 and 0760 use it): a non-superuser migrator needs SET on each role for ALTER ... OWNER TO,
-- and each role needs CREATE on public at that instant. The memberships are removed again afterwards.
DO $$
DECLARE
  n text;
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    FOREACH n IN ARRAY ARRAY['sandbox_idle_reaper', 'sandbox_claim_guard'] LOOP
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
GRANT CREATE ON SCHEMA public TO sandbox_idle_reaper;
GRANT CREATE ON SCHEMA public TO sandbox_claim_guard;

-- The one question agent_run_create asks: is this executor sandbox name inside an unexpired reaper claim? (The same 10 minutes as
-- the claims' own expiry.) VOLATILE on purpose: it reads a fresh snapshot after the lock is taken.
CREATE FUNCTION sandbox_reap_claimed(p_name text)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM public.sandbox_reaps s WHERE s.sandbox_name = p_name AND s.state = 'claimed' AND s.claimed_at > now() - interval '10 minutes')
$$;
REVOKE ALL ON FUNCTION sandbox_reap_claimed(text) FROM PUBLIC;
-- The only invoker is agent_run_create, i.e. platform_ops. Granted before the owner change, as 0760 does: a non-superuser migrator
-- holds the new owner without INHERIT, so it could not grant on the function afterwards.
GRANT EXECUTE ON FUNCTION sandbox_reap_claimed(text) TO platform_ops;
ALTER FUNCTION sandbox_reap_claimed(text) OWNER TO sandbox_claim_guard;

-- The idle rule and the cap. One row per executor sandbox name that some run recorded (every account, or the one in p_account), with
-- the facts every guard reads and the reason it is a candidate right now (NULL when it is not). The candidate list and the claim both
-- read this, so they cannot disagree. The status list repeats 0731's: a run in any other status is live. The terminal list repeats
-- @fx/core's TERMINAL_WORK_ITEM_STAGES and 0731's sandbox_reap_terminal_stages (a test keeps the three equal).
CREATE FUNCTION sandbox_reap_idle_state(p_account uuid, p_cap int)
RETURNS TABLE (
  sandbox_name text, account_id uuid, run_id uuid, n_accounts int, has_live boolean, unsettled boolean, has_action boolean,
  covered boolean, claimed boolean, reaped_since boolean, reason text)
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH names AS (
    SELECT r.sandbox_name AS name,
           (array_agg(r.account_id ORDER BY r.created_at DESC, r.id DESC))[1] AS acct,
           (array_agg(r.id ORDER BY r.created_at DESC, r.id DESC))[1] AS run,
           count(DISTINCT r.account_id)::int AS n_accounts,
           max(r.created_at) AS last_run_at,
           max(GREATEST(r.created_at, r.updated_at, r.ended_at)) AS run_activity,
           bool_or(r.status NOT IN ('refused_spend', 'succeeded', 'failed', 'timed_out', 'killed_spend', 'cancelled')) AS live,
           bool_or(r.compute_settle_due_at IS NOT NULL) AS due
      FROM public.agent_runs r
     WHERE r.sandbox_name LIKE 'ex-%'
       AND (p_account IS NULL OR r.sandbox_name LIKE 'ex-' || p_account::text || '-%')
     GROUP BY r.sandbox_name
  ), facts AS (
    SELECT n.name, n.acct, n.run, n.n_accounts,
           -- A run just created has no sandbox name yet (the runner records it once the sandbox exists), so a run of the same account,
           -- repo and pull request that is not finished also makes the name live.
           (n.live OR EXISTS (SELECT 1 FROM public.agent_runs d
                               WHERE d.account_id = n.acct AND d.dispatch_repo_id::text = substr(n.name, 41, 36) AND d.dispatch_pr_number::text = substr(n.name, 78)
                                 AND d.status NOT IN ('refused_spend', 'succeeded', 'failed', 'timed_out', 'killed_spend', 'cancelled'))) AS live,
           GREATEST(n.run_activity, it.item_activity) AS last_activity,
           (it.total > 0 AND it.open_items = 0) AS covered,
           (n.due OR EXISTS (SELECT 1 FROM public.spend_reservations s JOIN public.agent_runs r ON r.id = s.run_id AND r.account_id = s.account_id
                              WHERE r.sandbox_name = n.name AND s.state = 'open' AND s.budget <> 'model')) AS unsettled,
           EXISTS (SELECT 1 FROM public.run_action_requests q
                    WHERE q.account_id = n.acct AND q.state IN ('accepted', 'claimed')
                      AND (q.target_id = ANY (it.ids) OR q.target_id IN (SELECT r.id FROM public.agent_runs r WHERE r.sandbox_name = n.name))) AS has_action,
           EXISTS (SELECT 1 FROM public.sandbox_reaps s WHERE s.sandbox_name = n.name AND s.state = 'claimed' AND s.claimed_at > now() - interval '10 minutes') AS claimed,
           EXISTS (SELECT 1 FROM public.sandbox_reaps s WHERE s.sandbox_name = n.name AND s.state = 'deleted' AND s.done_at >= n.last_run_at) AS reaped_since
      FROM names n
      CROSS JOIN LATERAL (
        SELECT COALESCE(array_agg(w.id), '{}'::uuid[]) AS ids,
               count(*)::int AS total,
               (count(*) FILTER (WHERE NOT COALESCE(w.stage = ANY (ARRAY['merged', 'closed_unmerged', 'closed']::text[]), false)))::int AS open_items,
               max(w.updated_at) AS item_activity
          FROM public.work_items w
         WHERE w.account_id = n.acct
           AND (w.id IN (SELECT r.work_item_id FROM public.agent_runs r WHERE r.sandbox_name = n.name AND r.work_item_id IS NOT NULL)
                OR EXISTS (SELECT 1 FROM public.agent_runs r
                            WHERE r.sandbox_name = n.name AND r.dispatch_repo_id = w.repo_id AND r.dispatch_pr_number = w.gh_number))
      ) it
  ), scoped AS (
    SELECT f.*,
           (NOT f.live AND f.n_accounts = 1 AND NOT f.claimed AND NOT f.reaped_since AND NOT f.covered) AS in_scope,
           (NOT f.has_action AND NOT f.unsettled) AS free
      FROM facts f
  ), marked AS (
    SELECT s.*, (s.in_scope AND s.free AND s.last_activity < now() - interval '7 days') AS idle_hit
      FROM scoped s
  ), pooled AS (
    SELECT m.*,
           (m.in_scope AND NOT m.idle_hit) AS held,
           (m.in_scope AND NOT m.idle_hit AND m.free) AS cap_free
      FROM marked m
  ), ranked AS (
    SELECT p.*,
           count(*) FILTER (WHERE p.held) OVER (PARTITION BY p.acct) AS held_n,
           row_number() OVER (PARTITION BY p.acct, p.cap_free ORDER BY p.last_activity, p.name) AS free_rank
      FROM pooled p
  )
  SELECT r.name, r.acct, r.run, r.n_accounts, r.live, r.unsettled, r.has_action, r.covered, r.claimed, r.reaped_since,
         CASE WHEN r.idle_hit THEN 'idle'
              WHEN r.cap_free AND r.free_rank <= r.held_n - p_cap THEN 'cap'
         END
    FROM ranked r
$$;

CREATE FUNCTION sandbox_reap_candidates_idle(p_limit int, p_after text DEFAULT NULL, p_cap int DEFAULT 20)
RETURNS TABLE (account_id uuid, run_id uuid, sandbox_name text, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'sandbox_reap_candidates_idle: bad limit' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_cap IS NULL OR p_cap NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'sandbox_reap_candidates_idle: bad cap' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The cursor only bounds the order of the scan; it never selects a name.
  IF p_after IS NOT NULL AND p_after !~ '^ex-[A-Za-z0-9._-]{1,200}$' THEN
    RAISE EXCEPTION 'sandbox_reap_candidates_idle: bad cursor' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT s.account_id, s.run_id, s.sandbox_name, s.reason
    FROM public.sandbox_reap_idle_state(NULL, p_cap) s
   WHERE s.reason IS NOT NULL AND (p_after IS NULL OR s.sandbox_name > p_after)
   ORDER BY s.sandbox_name
   LIMIT p_limit;
END $$;

-- 'claimed' or the first refusal. The advisory lock is the one agent_run_create takes (the key is the name): either the create or the
-- claim wins the name, never both.
CREATE FUNCTION sandbox_reap_claim_idle(p_name text, p_reason text, p_cap int DEFAULT 20)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  st record;
BEGIN
  IF p_reason IS NULL OR p_reason NOT IN ('idle', 'cap') THEN
    RAISE EXCEPTION 'sandbox_reap_claim_idle: unsupported reason' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_cap IS NULL OR p_cap NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'sandbox_reap_claim_idle: bad cap' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_name IS NULL OR p_name !~ '^ex-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9]{1,18}$' THEN
    RAISE EXCEPTION 'sandbox_reap_claim_idle: not an executor sandbox name' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('fx-sandbox:' || p_name, 0));
  SELECT * INTO st FROM public.sandbox_reap_idle_state(substr(p_name, 4, 36)::uuid, p_cap) s WHERE s.sandbox_name = p_name;
  IF NOT FOUND OR st.n_accounts <> 1 OR st.covered THEN RETURN 'refused_not_candidate'; END IF;
  IF st.has_live OR st.has_action THEN RETURN 'refused_live'; END IF;
  IF st.unsettled THEN RETURN 'refused_unsettled'; END IF; -- the settle needs the stopped sandbox: never deleted before it is settled
  IF st.claimed THEN RETURN 'refused_claimed'; END IF;
  IF st.reaped_since THEN RETURN 'refused_done'; END IF;
  IF st.reason IS DISTINCT FROM p_reason THEN RETURN 'refused_not_candidate'; END IF;
  INSERT INTO public.sandbox_reaps AS s (sandbox_name, account_id, run_id, reason, state, claimed_at, done_at)
  VALUES (p_name, st.account_id, st.run_id, p_reason, 'claimed', now(), NULL)
  ON CONFLICT (sandbox_name) DO UPDATE
    SET account_id = EXCLUDED.account_id, run_id = EXCLUDED.run_id, reason = EXCLUDED.reason,
        state = 'claimed', claimed_at = now(), done_at = NULL;
  RETURN 'claimed';
END $$;

REVOKE ALL ON FUNCTION sandbox_reap_idle_state(uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION sandbox_reap_candidates_idle(int, text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION sandbox_reap_claim_idle(text, text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sandbox_reap_candidates_idle(int, text, int) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION sandbox_reap_claim_idle(text, text, int) TO agent_run_writer;

ALTER FUNCTION sandbox_reap_idle_state(uuid, int) OWNER TO sandbox_idle_reaper;
ALTER FUNCTION sandbox_reap_candidates_idle(int, text, int) OWNER TO sandbox_idle_reaper;
ALTER FUNCTION sandbox_reap_claim_idle(text, text, int) OWNER TO sandbox_idle_reaper;

REVOKE CREATE ON SCHEMA public FROM sandbox_idle_reaper;
REVOKE CREATE ON SCHEMA public FROM sandbox_claim_guard;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE sandbox_idle_reaper FROM CURRENT_USER;
    REVOKE sandbox_claim_guard FROM CURRENT_USER;
  END IF;
END
$$;

-- The terminal pass's fact function (0731), with one more way for a name to be live. A run that was just created has no
-- sandbox_name yet (agent_run_sandbox_mark records it once the sandbox exists), so a claim that looked only at runs carrying the
-- name could not see it. A run of the same account, repo and pull request that is not finished now makes the name live too (C81
-- section 6: "a run row that exists is live to the reaper from that moment on"). Everything else is 0731's, unchanged; CREATE OR
-- REPLACE keeps the owner (sandbox_reaper) and the ACL (none), and the candidate list and sandbox_reap_claim read it as before.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT sandbox_reaper TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION sandbox_reap_ex_state(p_name text, p_after text)
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
  SELECT n.name, n.acct, n.run, n.n_accounts,
         n.live OR EXISTS (SELECT 1 FROM public.agent_runs d
                            WHERE d.account_id = n.acct AND d.dispatch_repo_id::text = substr(n.name, 41, 36) AND d.dispatch_pr_number::text = substr(n.name, 78)
                              AND d.status NOT IN ('refused_spend', 'succeeded', 'failed', 'timed_out', 'killed_spend', 'cancelled')),
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

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE sandbox_reaper FROM CURRENT_USER;
  END IF;
END
$$;

-- agent_run_create, 0738's body with the lock and the check added. CREATE OR REPLACE keeps its owner and its ACL; a non-superuser
-- migrator replaces a function it does not own only while it holds platform_ops with INHERIT (0738's bracket), which is dropped
-- again to the state 0754 left it in.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION agent_run_create(
  p_id                  uuid,
  p_account_id          uuid,
  p_work_item_id        uuid,
  p_parent_run_id       uuid,
  p_role                text,
  p_runtime             text,
  p_head_sha            text,
  p_execution_mode      text,
  p_dispatch_repo_id    uuid,
  p_dispatch_pr_number  bigint,
  p_spec_version_id     uuid,
  p_resolved_exposure   jsonb,
  p_exposure_digest     text,
  p_initiated_by        uuid DEFAULT NULL,
  p_env_version_id      text DEFAULT NULL,
  p_image_digest        text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_id uuid := COALESCE(p_id, gen_random_uuid());
  v_sandbox_name text;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'agent_run_create: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_account_id IS NULL
     OR p_account_id IS DISTINCT FROM NULLIF(current_setting('app.account_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'agent_run_create: account % is not the caller''s tenant context', p_account_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_resolved_exposure IS NULL OR jsonb_typeof(p_resolved_exposure) IS DISTINCT FROM 'object'
     OR p_exposure_digest IS NULL OR p_exposure_digest !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'agent_run_create: a run needs a resolved exposure and its digest'
      USING ERRCODE = 'not_null_violation';
  END IF;

  IF p_resolved_exposure->>'accountId' IS DISTINCT FROM p_account_id::text THEN
    RAISE EXCEPTION 'agent_run_create: the resolved exposure belongs to a different account'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_initiated_by IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.account_members m
        WHERE m.account_id = p_account_id AND m.user_id = p_initiated_by
     )
  THEN
    RAISE EXCEPTION 'agent_run_create: the user who started the run is not a member of the account'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- The environment record is whole or absent: replay needs both the version and the digest it resolved to.
  IF (p_env_version_id IS NULL) IS DISTINCT FROM (p_image_digest IS NULL) THEN
    RAISE EXCEPTION 'agent_run_create: env_version_id and image_digest are recorded together or not at all'
      USING ERRCODE = 'check_violation';
  END IF;

  -- D#2 SANDBOX-REAPER-2: an executor run reuses the sandbox named for (account, repo, pull request). The lock is held to the end
  -- of this transaction, so a reaper claim on the name either committed before this point (refused here) or waits for this run to
  -- exist (and then refuses itself, because a run row that exists is live).
  IF p_role = 'executor' AND p_dispatch_repo_id IS NOT NULL AND p_dispatch_pr_number IS NOT NULL AND p_dispatch_pr_number > 0 THEN
    v_sandbox_name := 'ex-' || p_account_id::text || '-' || p_dispatch_repo_id::text || '-' || p_dispatch_pr_number::text;
    PERFORM pg_advisory_xact_lock(hashtextextended('fx-sandbox:' || v_sandbox_name, 0));
    IF public.sandbox_reap_claimed(v_sandbox_name) THEN
      RAISE EXCEPTION 'sandbox_reaping' USING ERRCODE = 'FXR01';
    END IF;
  END IF;

  INSERT INTO public.agent_runs
    (id, account_id, work_item_id, parent_run_id, role, runtime, status, head_sha,
     execution_mode, dispatch_repo_id, dispatch_pr_number, spec_version_id,
     resolved_exposure, exposure_digest, initiated_by, env_version_id, image_digest)
  VALUES
    (v_id, p_account_id, p_work_item_id, p_parent_run_id, p_role, p_runtime, 'pending',
     p_head_sha, p_execution_mode, p_dispatch_repo_id, p_dispatch_pr_number, p_spec_version_id,
     p_resolved_exposure, p_exposure_digest, p_initiated_by, p_env_version_id, p_image_digest);
  RETURN v_id;
END;
$$;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;

-- The idle job, run daily through the worker. A job with no row here is never due.
INSERT INTO reconcile_jobs (name, interval_seconds) VALUES ('sandbox_reap_idle', 86400);
