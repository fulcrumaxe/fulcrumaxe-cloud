-- D#6 R2b-3 (part i): the database side of a runner's lease. 0711 added the lease columns on agent_runs (runner_id,
-- lease_generation, lease_expires_at) and left every write path closed. This file opens exactly the paths the claim,
-- heartbeat, events and sweeper work need, each as narrow as it can be, and one guard.
--
-- Who owns the definers. C21 section 11: no R2b-3 migration gives platform_ops anything, and no new definer is owned by
-- platform_ops. Every function below is owned by a role of its own, in the shape 0720 gave guard_definer and 0742 gave
-- sandbox_settle_definer:
--
--   runner_lease_definer   NOLOGIN, no members (the migration role holds it only inside this file), a member of nothing.
--                          Column grants only, on what the bodies read and write; a row policy for this role only on each
--                          row-secured table it touches; EXECUTE only for the logins that call it. test-neon-shape names it.
--
-- platform_ops is not touched: it holds no new column privilege and no new policy on agent_runs or runners, and a test
-- diffs its privileges on both tables against the migrations without this file.
--
-- Numbered above the highest migration claimed on the code plane (0753). Re-check against main right before merging (C7 section 4).
--
-- 1. agent_run_runner_claim(account, run, runner, now, lease_seconds) gives a run to a runner. It writes runner_id, the next
--    lease_generation and lease_expires_at = now + lease, and only to a run that is 'running' with no runner yet and a
--    generation of 0, for a runner that is active in the same account, and only when the run is claimable at `now`
--    (claimable_after, below). The caller moves the run pending -> running in the same transaction through the
--    compare-and-set writer first (agent_run_set_status), so a run is claimed once: the second claim finds a runner already
--    there. It answers the new generation, or NULL when nothing was written.
--
-- 2. agent_run_runner_lease(account, run, runner, generation, now, extend_seconds, max_wall_ms) is the fence every write of
--    a runner goes through (heartbeat, events, done). It locks the run row and answers, in this order:
--      unknown      no such run in the account
--      stale        the run belongs to another runner or another generation than the caller's
--      not_running  the run is no longer 'running' (finished, cancelled, failed by the sweeper)
--      revoked      the runner has been revoked
--      expired      lease_expires_at is at or before `now`: a lease is lost AT its end, not when a sweep next runs
--      wall_clock   started_at plus max_wall_ms is at or before `now`
--      ok           and, when extend_seconds is above 0, lease_expires_at is moved to now + extend_seconds
--    Anything but `ok` writes nothing, so an expired lease is never revived. The row lock is held to the end of the caller's
--    transaction, so a sweeper that decides the lease is lost cannot race a heartbeat that extends it.
--
-- 3. runner_claim_throttle(min_interval_ms) lets the runner named by app.runner_id (set only by the signature-verifying
--    middleware, C11) claim at most once per interval. It stamps the runner's row in runner_claim_stamps (and runners.last_seen_at)
--    and answers 0, or answers the milliseconds still to wait and writes nothing. It uses the database clock. EXECUTE for
--    app_user, like the other runner_* functions. The stamp is a table of its own, not a column of runners: platform_ops holds a
--    table-wide grant on runners, which Postgres extends to every new column, so a column there would be a new platform_ops
--    privilege. The table is readable and writable by runner_lease_definer alone.
--
-- 4. agent_run_list_running_runner_runs(limit, max_wall_ms) is the cross-tenant list the sweeper's lease work starts from.
--    agent_run_list_jobless_runner_runs(limit) is the cross-tenant list of its no-job work (C22 section 3): only pending runner
--    runs whose signed job is not written yet, oldest first. 0734's queue lister cannot serve that work: it lists runs with and
--    without a job together, and a run that has its job may wait 72 hours for a runner, so enough of those, in any account,
--    would push every jobless run out of the oldest-50 window and switch the 2-minute retry and the 15-minute failure off for
--    all tenants. This lister reads job_signed only to test it for NULL and never returns it.
--
-- 5. runner_follow_up_run(parent) (C21 section 4, C22 sections 4, 5 and 8) makes the run that follows a runner run which ended
--    `runner_lost` or `usage_limit`. It trusts nothing it is passed: the parent must be a failed runner run of the session's
--    tenant whose last move to `failed` recorded one of those two reasons, and it must have no child yet (a unique index on
--    parent_run_id for runner runs backs that). The child copies the parent's role, repository, work item, spec version,
--    requester and approver, and its exposure record. Its `model` column is not written (it stays NULL, as the parent's is): the
--    model hint is the parent's signed job's, copied verbatim by the dispatch, never raised. For usage_limit it becomes
--    claimable at the reset time the runner reported, held to [now, now + 24 h] (an hour from now when none was reported); for
--    runner_lost it is claimable at once. The allowances are counted over the follow-up chain (the failing parent, then
--    parent_run_id while each step is a follow-up hop, at most 16 runs; a fix round starts a new chain): a second runner_lost
--    makes no child and the answer is `exhausted` with limit_reason runner_lost, and so does the eighth usage_limit (reason
--    usage_limit), because a follow-up is exempt from the daily run limit and so needs this bound. The child is made by
--    agent_run_create, as every run is (0750's halt check, 0642's invariants and the one-live-executor index apply to it); this
--    role has no INSERT on agent_runs. When that create is refused for any reason the definer does not know, the answer is
--    `not_eligible` and the caller's move of the parent to `failed` still commits. The answer is the outcome, the child's id
--    for a created or existing child, the work item, and the limit reached for `exhausted`.
--
-- 6. agent_runs.claimable_after: a pending run is not handed out before this time. Only runner_follow_up_run writes it.
--
-- 7. run_events gains runner_seq and runner_body_sha256: the runner's own sequence number for an event it sent, and the
--    digest of what it sent under that number. (run_id, runner_seq) is unique, so an event sent twice is stored once
--    (ON CONFLICT DO NOTHING) and a second, different body under the same number is recognisable. Only the run-writer
--    login may write either column, as 0698 does for source_line.
--
-- 8. agent_runs_lease_guard (BEFORE INSERT OR UPDATE): the lease columns and claimable_after change only inside this
--    file's definers (current_user runner_lease_definer), from a superuser session (the [pg] suites seed through one), or
--    through the foreign-key action that clears runner_id when a runner row is deleted; lease_generation never goes
--    down; runner_id, once set, only changes to NULL from that action. It applies to every other role, owner included.
--
-- Refusals use fixed SQLSTATEs and messages, never an argument value: 42501 not permitted, 22023 invalid argument.

-- ---- the role ---------------------------------------------------------------------------------------------------
DO $$
DECLARE
  n text := 'runner_lease_definer';
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

-- ---- columns, indexes and the event guard -----------------------------------------------------------------------
-- When each runner last claimed (the throttle). Row-secured and granted to runner_lease_definer only.
CREATE TABLE runner_claim_stamps (
  runner_id      uuid PRIMARY KEY,
  account_id     uuid NOT NULL,
  last_claim_at  timestamptz NOT NULL,
  FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE CASCADE
);
ALTER TABLE runner_claim_stamps ENABLE ROW LEVEL SECURITY;
ALTER TABLE runner_claim_stamps FORCE ROW LEVEL SECURITY;

ALTER TABLE agent_runs ADD COLUMN claimable_after timestamptz;
-- One follow-up per runner run: the definer checks it, and this index decides a race between two callers.
CREATE UNIQUE INDEX agent_runs_runner_follow_up_key ON agent_runs (account_id, parent_run_id)
  WHERE runtime = 'runner' AND parent_run_id IS NOT NULL;

ALTER TABLE run_events
  ADD COLUMN runner_seq         bigint,
  ADD COLUMN runner_body_sha256 text,
  ADD CONSTRAINT run_events_runner_seq_check CHECK (
    (runner_seq IS NULL AND runner_body_sha256 IS NULL)
    OR (runner_seq >= 0 AND runner_body_sha256 ~ '^[0-9a-f]{64}$')
  );
CREATE UNIQUE INDEX run_events_runner_seq_key ON run_events (run_id, runner_seq) WHERE runner_seq IS NOT NULL;

-- Not owned by the definer role, and not SECURITY DEFINER (the rule of 0724): nothing here can drop its own guard.
CREATE FUNCTION run_events_runner_seq_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (NEW.runner_seq IS NOT NULL OR NEW.runner_body_sha256 IS NOT NULL) AND NOT pg_has_role(current_user, 'agent_run_writer', 'MEMBER') THEN
    RAISE EXCEPTION 'run_events.runner_seq is written only by the runner login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER run_events_runner_seq_guard BEFORE INSERT ON run_events
  FOR EACH ROW EXECUTE FUNCTION run_events_runner_seq_guard();

-- ---- what the definers read and write, column by column ---------------------------------------------------------
-- agent_runs: the parent is re-read (21 columns), the jobless lister adds created_at and job_signed (the latter only tested for NULL, never returned), and the child, made by agent_run_create (below), gets its requester's approval and
-- its claimable_after from one UPDATE of two columns; a claim and the fence write four. This role has no INSERT on agent_runs at all:
-- every run is created through agent_run_create, which is where 0750's halt check and 0642's invariants live. runners: the fence
-- and the throttle. run_events: the usage-limit reset time and the runner_lost history. accounts: what the row policies read.
GRANT SELECT (id, account_id, work_item_id, parent_run_id, role, runtime, status, head_sha, execution_mode, dispatch_repo_id,
              dispatch_pr_number, spec_version_id, resolved_exposure, exposure_digest, initiated_by, approved_by,
              runner_id, lease_generation, lease_expires_at, claimable_after, started_at,
              created_at, job_signed)
  ON agent_runs TO runner_lease_definer;
GRANT UPDATE (runner_id, lease_generation, lease_expires_at, updated_at, claimable_after, approved_by) ON agent_runs TO runner_lease_definer;
GRANT SELECT (id, account_id, revoked_at), UPDATE (last_seen_at) ON runners TO runner_lease_definer;
GRANT SELECT (runner_id, account_id, last_claim_at), INSERT (runner_id, account_id, last_claim_at), UPDATE (last_claim_at) ON runner_claim_stamps TO runner_lease_definer;
GRANT SELECT (account_id, run_id, seq, kind, payload) ON run_events TO runner_lease_definer;
GRANT SELECT (id, deleted_at) ON accounts TO runner_lease_definer;
GRANT USAGE ON SCHEMA public TO runner_lease_definer;

-- Row policies for this role only. The lister runs without a tenant, so it may read every run (what it returns is fixed by its
-- body); every update, and every other read, is held to the caller's tenant context and an active account, as 0642 does for
-- platform_ops and 0742 for sandbox_settle_definer.
CREATE POLICY runner_lease_definer_select ON agent_runs FOR SELECT TO runner_lease_definer USING (true);
CREATE POLICY runner_lease_definer_update ON agent_runs FOR UPDATE TO runner_lease_definer
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY runner_lease_definer_select ON runners FOR SELECT TO runner_lease_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_lease_definer_update ON runners FOR UPDATE TO runner_lease_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_lease_definer_select ON runner_claim_stamps FOR SELECT TO runner_lease_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_lease_definer_insert ON runner_claim_stamps FOR INSERT TO runner_lease_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_lease_definer_update ON runner_claim_stamps FOR UPDATE TO runner_lease_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_lease_definer_select ON run_events FOR SELECT TO runner_lease_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_lease_definer_select ON accounts FOR SELECT TO runner_lease_definer USING (true);

-- ---- the lease guard --------------------------------------------------------------------------------------------
CREATE FUNCTION agent_runs_lease_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_changed := NEW.claimable_after IS NOT NULL OR NEW.runner_id IS NOT NULL OR NEW.lease_generation <> 0 OR NEW.lease_expires_at IS NOT NULL;
  ELSE
    v_changed := NEW.runner_id IS DISTINCT FROM OLD.runner_id
              OR NEW.lease_generation IS DISTINCT FROM OLD.lease_generation
              OR NEW.lease_expires_at IS DISTINCT FROM OLD.lease_expires_at
              OR NEW.claimable_after IS DISTINCT FROM OLD.claimable_after;
  END IF;
  IF v_changed
     AND current_user <> 'runner_lease_definer'
     AND NOT COALESCE((SELECT rolsuper FROM pg_roles WHERE rolname = current_user), false)
     -- The foreign-key action that clears runner_id when a runner row is deleted: nested, and nothing else changes.
     AND NOT (TG_OP = 'UPDATE' AND pg_trigger_depth() > 1 AND NEW.runner_id IS NULL AND OLD.runner_id IS NOT NULL
              AND NEW.lease_generation = OLD.lease_generation AND NEW.lease_expires_at IS NOT DISTINCT FROM OLD.lease_expires_at
              AND NEW.claimable_after IS NOT DISTINCT FROM OLD.claimable_after)
  THEN
    RAISE EXCEPTION 'agent_runs: the lease columns and claimable_after are written only by the runner lease definers'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.lease_generation < OLD.lease_generation THEN
      RAISE EXCEPTION 'agent_runs.lease_generation never goes down (run %)', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.runner_id IS NOT NULL AND NEW.runner_id IS DISTINCT FROM OLD.runner_id AND NOT (NEW.runner_id IS NULL AND pg_trigger_depth() > 1) THEN
      RAISE EXCEPTION 'agent_runs.runner_id is write-once (run %)', OLD.id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER agent_runs_lease_guard
  BEFORE INSERT OR UPDATE ON agent_runs
  FOR EACH ROW
  EXECUTE FUNCTION agent_runs_lease_guard();

-- ---- the definers (created by the migration role, handed to runner_lease_definer below) -------------------------
CREATE FUNCTION agent_run_runner_claim(
  p_account_id     uuid,
  p_run_id         uuid,
  p_runner_id      uuid,
  p_now            timestamptz,
  p_lease_seconds  integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_generation integer;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'agent_run_runner_claim: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_account_id IS NULL
     OR p_account_id IS DISTINCT FROM NULLIF(current_setting('app.account_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'agent_run_runner_claim: account % is not the caller''s tenant context', p_account_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_run_id IS NULL OR p_runner_id IS NULL OR p_now IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'agent_run_runner_claim: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.runners r WHERE r.id = p_runner_id AND r.account_id = p_account_id AND r.revoked_at IS NULL) THEN
    RETURN NULL;
  END IF;
  UPDATE public.agent_runs
     SET runner_id = p_runner_id,
         lease_generation = lease_generation + 1,
         lease_expires_at = p_now + make_interval(secs => p_lease_seconds),
         updated_at = now()
   WHERE account_id = p_account_id AND id = p_run_id
     AND status = 'running' AND runtime = 'runner' AND runner_id IS NULL AND lease_generation = 0
     AND (claimable_after IS NULL OR claimable_after <= p_now)
  RETURNING lease_generation INTO v_generation;
  RETURN v_generation;
END;
$$;

CREATE FUNCTION agent_run_runner_lease(
  p_account_id      uuid,
  p_run_id          uuid,
  p_runner_id       uuid,
  p_generation      integer,
  p_now             timestamptz,
  p_extend_seconds  integer,
  p_max_wall_ms     bigint
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  r record;
  v_revoked timestamptz;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'agent_run_runner_lease: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_account_id IS NULL
     OR p_account_id IS DISTINCT FROM NULLIF(current_setting('app.account_id', true), '')::uuid
  THEN
    RAISE EXCEPTION 'agent_run_runner_lease: account % is not the caller''s tenant context', p_account_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_run_id IS NULL OR p_runner_id IS NULL OR p_generation IS NULL OR p_generation < 0 OR p_now IS NULL
     OR p_extend_seconds IS NULL OR p_extend_seconds NOT BETWEEN 0 AND 3600 OR p_max_wall_ms IS NULL OR p_max_wall_ms < 1 THEN
    RAISE EXCEPTION 'agent_run_runner_lease: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.status, a.runner_id, a.lease_generation, a.lease_expires_at, a.started_at
    INTO r
    FROM public.agent_runs a
   WHERE a.account_id = p_account_id AND a.id = p_run_id
     FOR UPDATE;
  IF NOT FOUND THEN RETURN 'unknown'; END IF;
  IF r.runner_id IS DISTINCT FROM p_runner_id OR r.lease_generation <> p_generation THEN RETURN 'stale'; END IF;
  IF r.status <> 'running' THEN RETURN 'not_running'; END IF;
  SELECT x.revoked_at INTO v_revoked FROM public.runners x WHERE x.id = p_runner_id AND x.account_id = p_account_id;
  IF NOT FOUND OR v_revoked IS NOT NULL THEN RETURN 'revoked'; END IF;
  IF r.lease_expires_at IS NULL OR r.lease_expires_at <= p_now THEN RETURN 'expired'; END IF;
  IF r.started_at IS NOT NULL AND r.started_at + make_interval(secs => p_max_wall_ms / 1000.0) <= p_now THEN RETURN 'wall_clock'; END IF;

  IF p_extend_seconds > 0 THEN
    UPDATE public.agent_runs
       SET lease_expires_at = p_now + make_interval(secs => p_extend_seconds), updated_at = now()
     WHERE account_id = p_account_id AND id = p_run_id;
  END IF;
  RETURN 'ok';
END;
$$;

CREATE FUNCTION runner_claim_throttle(p_min_interval_ms integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  raw    text := COALESCE(current_setting('app.runner_id', true), '');
  v_now  timestamptz := clock_timestamp();
  v_last timestamptz;
  v_rows integer;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_claim_throttle: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT account_is_active(acct)
     OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'runner_claim_throttle: the session is not a runner of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_min_interval_ms IS NULL OR p_min_interval_ms NOT BETWEEN 1 AND 3600000 THEN
    RAISE EXCEPTION 'runner_claim_throttle: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.runners x WHERE x.id = raw::uuid AND x.account_id = acct AND x.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'runner_claim_throttle: the session is not a runner of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- One row per runner. The first claim inserts it; a later one moves it only when the interval has passed, so a claim that is
  -- too soon changes nothing. Two first claims at once: the second finds the row (ON CONFLICT) and is judged by the same test.
  INSERT INTO public.runner_claim_stamps AS s (runner_id, account_id, last_claim_at) VALUES (raw::uuid, acct, v_now)
  ON CONFLICT (runner_id) DO UPDATE SET last_claim_at = v_now
   WHERE s.last_claim_at <= v_now - make_interval(secs => p_min_interval_ms / 1000.0);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 1 THEN
    UPDATE public.runners SET last_seen_at = v_now WHERE id = raw::uuid AND account_id = acct;
    RETURN 0;
  END IF;
  SELECT x.last_claim_at INTO v_last FROM public.runner_claim_stamps x WHERE x.runner_id = raw::uuid AND x.account_id = acct;
  RETURN GREATEST(1, ceil(extract(epoch FROM (v_last + make_interval(secs => p_min_interval_ms / 1000.0) - v_now)) * 1000)::integer);
END;
$$;

-- The cross-tenant list the sweeper's lease work starts from. It returns the account, run, runner, generation, lease end and
-- start of runner runs that are 'running', the ones due soonest first (the earlier of the lease end and the start plus
-- max_wall_ms), at most `limit` (1..50). It writes nothing and refuses a direct platform_ops login, as 0734's lister does; the
-- sweeper then settles each run under that run's own tenant through the same fence the routes use.
CREATE FUNCTION agent_run_list_running_runner_runs(p_limit int, p_max_wall_ms bigint)
RETURNS TABLE (account_id uuid, run_id uuid, runner_id uuid, lease_generation int, lease_expires_at timestamptz, started_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'agent_run_list_running_runner_runs: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 OR p_max_wall_ms IS NULL OR p_max_wall_ms < 1 THEN
    RAISE EXCEPTION 'agent_run_list_running_runner_runs: bad argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT a.account_id, a.id, a.runner_id, a.lease_generation, a.lease_expires_at, a.started_at
    FROM public.agent_runs a
   WHERE a.status = 'running' AND a.runtime = 'runner' AND a.runner_id IS NOT NULL
   ORDER BY LEAST(COALESCE(a.lease_expires_at, 'epoch'::timestamptz), COALESCE(a.started_at + make_interval(secs => p_max_wall_ms / 1000.0), 'infinity'::timestamptz)), a.id
   LIMIT p_limit;
END $$;

-- The cross-tenant list of the sweeper's no-job work (C22 section 3): pending runner runs of runner_local repositories whose signed
-- job is not written yet, oldest first, at most `limit` (1..50). Same refusal, limit check and ownership as 0734's queue lister
-- and the running-runs lister above; it writes nothing and returns no job text (job_signed is only tested for NULL).
CREATE FUNCTION agent_run_list_jobless_runner_runs(p_limit int)
RETURNS TABLE (account_id uuid, run_id uuid, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'agent_run_list_jobless_runner_runs: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'agent_run_list_jobless_runner_runs: bad limit' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT a.account_id, a.id, a.created_at
    FROM public.agent_runs a
   WHERE a.status = 'pending' AND a.runtime = 'runner' AND a.execution_mode = 'runner_local' AND a.job_signed IS NULL
   ORDER BY a.created_at, a.id
   LIMIT p_limit;
END $$;

-- The follow-up run (C21 section 4, C22 sections 4, 5 and 8). The outcome is one of: created, exists (the parent already has its
-- child; the id is that child's), exhausted (the chain has used up its allowance: nothing is made, the work item id is given back
-- for the caller to fail, and limit_reason says which allowance: runner_lost after two losses, usage_limit after eight usage limits),
-- halted (the work item is halted, 0750: no run is made and none is owed), not_eligible (anything else: not a failed runner run of
-- this tenant, ended for another reason, or a child that could not be created; the parent's move to `failed` stays in every case).
-- The columns are named apart from agent_runs' so the body's queries stay unambiguous.
--
-- The chain the allowances count is the walk of C22 section 5: the failing parent, then parent_run_id for as long as each step is a
-- follow-up hop (the parent there is a runner run that is `failed` and whose last move to `failed` recorded runner_lost or
-- usage_limit), at most 16 runs. A fix round's parent ended some other way, so the walk stops there and a fix round is a new attempt.
CREATE FUNCTION runner_follow_up_run(p_parent_run_id uuid)
RETURNS TABLE (outcome text, child_id uuid, item_id uuid, limit_reason text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  p        record;
  v_reason text;
  v_lost   integer;
  v_usage  integer;
  v_reset  timestamptz;
  v_text   text;
  v_after  timestamptz;
  v_child  uuid;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_follow_up_run: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_acct IS NULL OR NOT account_is_active(v_acct) THEN
    RAISE EXCEPTION 'runner_follow_up_run: no active tenant context' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_parent_run_id IS NULL THEN
    RAISE EXCEPTION 'runner_follow_up_run: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT a.id, a.work_item_id, a.parent_run_id, a.role, a.runtime, a.status, a.head_sha, a.execution_mode, a.dispatch_repo_id, a.dispatch_pr_number,
         a.spec_version_id, a.resolved_exposure, a.exposure_digest, a.initiated_by, a.approved_by
    INTO p
    FROM public.agent_runs a
   WHERE a.account_id = v_acct AND a.id = p_parent_run_id
     FOR UPDATE;
  IF NOT FOUND OR p.runtime <> 'runner' OR p.status <> 'failed' OR p.resolved_exposure IS NULL OR p.exposure_digest IS NULL THEN
    RETURN QUERY SELECT 'not_eligible'::text, NULL::uuid, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  -- What the parent's last move to `failed` recorded: the only place the reason lives.
  SELECT e.payload->>'failureReason' INTO v_reason
    FROM public.run_events e
   WHERE e.account_id = v_acct AND e.run_id = p.id AND e.kind = 'run.status_changed' AND e.payload->>'to' = 'failed'
   ORDER BY e.seq DESC LIMIT 1;
  IF v_reason IS NULL OR v_reason NOT IN ('runner_lost', 'usage_limit') THEN
    RETURN QUERY SELECT 'not_eligible'::text, NULL::uuid, NULL::uuid, NULL::text;
    RETURN;
  END IF;

  SELECT c.id INTO v_child FROM public.agent_runs c
   WHERE c.account_id = v_acct AND c.parent_run_id = p.id AND c.runtime = 'runner' LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT 'exists'::text, v_child, p.work_item_id, NULL::text;
    RETURN;
  END IF;

  -- The walk (C22 section 5), counted from the failing parent. A step to an ancestor is taken only when that ancestor is itself a
  -- failed runner run whose last move to `failed` recorded one of the two reasons; the first step that is not one ends the walk.
  WITH RECURSIVE chain(run_id, parent_id, reason, depth) AS (
    SELECT p.id, p.parent_run_id, v_reason, 1
    UNION ALL
    SELECT a.id, a.parent_run_id, hop.reason, c.depth + 1
      FROM chain c
      JOIN public.agent_runs a ON a.account_id = v_acct AND a.id = c.parent_id AND a.runtime = 'runner' AND a.status = 'failed'
      CROSS JOIN LATERAL (
        SELECT e.payload->>'failureReason' AS reason
          FROM public.run_events e
         WHERE e.account_id = v_acct AND e.run_id = a.id AND e.kind = 'run.status_changed' AND e.payload->>'to' = 'failed'
         ORDER BY e.seq DESC LIMIT 1
      ) hop
     WHERE c.depth < 16 AND hop.reason IN ('runner_lost', 'usage_limit')
  )
  SELECT count(*) FILTER (WHERE c.reason = 'runner_lost'), count(*) FILTER (WHERE c.reason = 'usage_limit')
    INTO v_lost, v_usage
    FROM chain c;

  IF v_reason = 'runner_lost' THEN
    IF v_lost >= 2 THEN
      RETURN QUERY SELECT 'exhausted'::text, NULL::uuid, p.work_item_id, 'runner_lost'::text;
      RETURN;
    END IF;
    v_after := NULL;
  ELSE
    -- A usage limit follow-up is exempt from the daily limit (C22 section 4), so the chain is bounded here: the eighth usage limit in
    -- one chain makes no child, which allows seven follow-ups of up to 24 hours each.
    IF v_usage >= 8 THEN
      RETURN QUERY SELECT 'exhausted'::text, NULL::uuid, p.work_item_id, 'usage_limit'::text;
      RETURN;
    END IF;
    -- The reset time the runner reported on its usage_limit_reached event, if it sent a well-formed one.
    SELECT e.payload->>'reset_at' INTO v_text
      FROM public.run_events e
     WHERE e.account_id = v_acct AND e.run_id = p.id AND e.kind = 'runner.event' AND e.payload->>'type' = 'usage_limit_reached'
       AND e.payload->>'reset_at' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'
     ORDER BY e.seq DESC LIMIT 1;
    BEGIN
      v_reset := v_text::timestamptz;
    EXCEPTION WHEN others THEN
      v_reset := NULL;
    END;
    v_after := CASE WHEN v_reset IS NULL THEN now() + interval '1 hour'
                    ELSE GREATEST(now(), LEAST(v_reset, now() + interval '24 hours')) END;
  END IF;

  -- Every run is created through agent_run_create (0750's comment): its halt check, its exposure and membership checks and its
  -- one-live-executor index all apply to the child. It runs as platform_ops, so this role needs no INSERT on agent_runs.
  BEGIN
    v_child := public.agent_run_create(
      p_id => NULL, p_account_id => v_acct, p_work_item_id => p.work_item_id, p_parent_run_id => p.id, p_role => p.role,
      p_runtime => 'runner', p_head_sha => p.head_sha, p_execution_mode => p.execution_mode, p_dispatch_repo_id => p.dispatch_repo_id,
      p_dispatch_pr_number => p.dispatch_pr_number, p_spec_version_id => p.spec_version_id, p_resolved_exposure => p.resolved_exposure,
      p_exposure_digest => p.exposure_digest, p_initiated_by => p.initiated_by);
  EXCEPTION
    WHEN SQLSTATE 'HX409' THEN
      -- The work item is halted (0750): no run is made, and none is owed. The move to `failed` stays.
      RETURN QUERY SELECT 'halted'::text, NULL::uuid, p.work_item_id, NULL::text;
      RETURN;
    WHEN unique_violation THEN
      SELECT c.id INTO v_child FROM public.agent_runs c
       WHERE c.account_id = v_acct AND c.parent_run_id = p.id AND c.runtime = 'runner' LIMIT 1;
      IF FOUND THEN
        RETURN QUERY SELECT 'exists'::text, v_child, p.work_item_id, NULL::text;
      ELSE
        -- Another live executor holds the pull request (the one-live-executor index): the work already has its next run.
        RETURN QUERY SELECT 'not_eligible'::text, NULL::uuid, p.work_item_id, NULL::text;
      END IF;
      RETURN;
    WHEN OTHERS THEN
      -- Anything else the create path refuses (the initiator has left the account: 42501; a foreign-key or check violation) must not
      -- undo the caller's move of the parent to `failed`: the sub-block is a savepoint, so the child's partial writes are undone and
      -- the answer is a non-created outcome. A childless failed parent ends the work item through the stage driver.
      RETURN QUERY SELECT 'not_eligible'::text, NULL::uuid, p.work_item_id, NULL::text;
      RETURN;
  END;
  -- The two columns agent_run_create has no argument for. The child is not visible to anyone else before this commits.
  UPDATE public.agent_runs SET approved_by = p.approved_by, claimable_after = v_after WHERE account_id = v_acct AND id = v_child;
  RETURN QUERY SELECT 'created'::text, v_child, p.work_item_id, NULL::text;
END;
$$;

-- ---- ownership brackets -----------------------------------------------------------------------------------------
-- The migration role holds the new role (with ADMIN from creating it) only to hand the functions over, and the role has
-- CREATE on public only for that transfer. It holds platform_ops only to grant EXECUTE on agent_run_create (a function platform_ops
-- owns) to the new role; that is a grant OF one function, and platform_ops itself gains nothing. All are reset at the end.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    GRANT platform_ops TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'runner_lease_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_lease_definer; cannot ALTER FUNCTION ... OWNER TO runner_lease_definer';
    END IF;
    GRANT runner_lease_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO runner_lease_definer;

REVOKE ALL ON FUNCTION agent_runs_lease_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION run_events_runner_seq_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION agent_run_runner_claim(uuid, uuid, uuid, timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION agent_run_runner_lease(uuid, uuid, uuid, integer, timestamptz, integer, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION runner_claim_throttle(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION agent_run_list_running_runner_runs(int, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION agent_run_list_jobless_runner_runs(int) FROM PUBLIC;
REVOKE ALL ON FUNCTION runner_follow_up_run(uuid) FROM PUBLIC;

ALTER FUNCTION agent_run_runner_claim(uuid, uuid, uuid, timestamptz, integer) OWNER TO runner_lease_definer;
ALTER FUNCTION agent_run_runner_lease(uuid, uuid, uuid, integer, timestamptz, integer, bigint) OWNER TO runner_lease_definer;
ALTER FUNCTION runner_claim_throttle(integer) OWNER TO runner_lease_definer;
ALTER FUNCTION agent_run_list_running_runner_runs(int, bigint) OWNER TO runner_lease_definer;
ALTER FUNCTION agent_run_list_jobless_runner_runs(int) OWNER TO runner_lease_definer;
ALTER FUNCTION runner_follow_up_run(uuid) OWNER TO runner_lease_definer;

-- EXECUTE is granted after the transfer: changing an owner rewrites the ACL entries that named the old one.
GRANT EXECUTE ON FUNCTION agent_run_runner_claim(uuid, uuid, uuid, timestamptz, integer) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION agent_run_runner_lease(uuid, uuid, uuid, integer, timestamptz, integer, bigint) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION agent_run_list_running_runner_runs(int, bigint) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION agent_run_list_jobless_runner_runs(int) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION runner_follow_up_run(uuid) TO agent_run_writer;
GRANT EXECUTE ON FUNCTION runner_claim_throttle(integer) TO app_user;
-- The follow-up definer creates the child through agent_run_create, as the run-writer login does.
GRANT EXECUTE ON FUNCTION agent_run_create(uuid, uuid, uuid, uuid, text, text, text, text, uuid, bigint, uuid, jsonb, text, uuid, text, text) TO runner_lease_definer;

REVOKE CREATE ON SCHEMA public FROM runner_lease_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_lease_definer FROM CURRENT_USER;
    GRANT platform_ops TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
