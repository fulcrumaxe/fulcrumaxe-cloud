-- D#845 ON-13c2: the operate queue. Turning operate on or off, and ticking or unticking a repo while it is on, no longer starts or stops anything inside the request that did it: the change leaves one row per repo in a queue, and the reconcile tick drains it.
--
--   1. engine_operate_queue (account_id, repo_id, operate_epoch, action start/stop, state pending/running/done, enqueued_at, claimed_at, attempts; PK account + repo + epoch + action). No tenant role reads or writes it; only engine_start_definer does.
--   2. engine_operate_queue_enqueue (a trigger function, owned by engine_start_definer): AFTER triggers on engine_bridge_settings (the epoch changed: one row per ticked repo, `start` when operate is now on, else `stop`) and on engine_bridge_repos
--      (a tick adds a `start` at the current epoch while operate is on; an untick adds a `stop`). A second row for the same key is the same row, so two causes of one stop make one stop; a finished row is made pending again.
--   3. engine_operate_queue_claim and engine_operate_queue_finish (EXECUTE: platform_ops only): the claim drops rows of an epoch that is not current, takes the account's queue lock, and moves at most 4 pending rows per account to `running` (SKIP LOCKED;
--      a retried row waits 30 s per attempt, up to 5 min; a `running` row not finished in 10 min is pending again; a row older than 7 days is dropped). Finish ends a row `done`, puts it back for a retry, or releases it untouched.
--   4. engine_operate_on_starts_due: the lister of the `operate_on` start, the twin of 1100's engine_system_starts_due for the cause that is a running queue row rather than a finished install's `start_pending`. A repo whose session was already started after the row was queued (a first start or a person's, delivered or done, not stopped since) is not listed.
--   5. engine_system_start_issue is restated with CREATE OR REPLACE (1100's body, carried forward; the diff is in the PR): `operate_on` now has a cause (the repo's `running` start row at the current epoch), consumes it in the same transaction, and a start also clears
--      `start_pending` whichever cause asked. A row whose repo already has such a started session ends `done` with cause_gone and signs nothing.
--
-- Numbered 1105 by the Team Lead; it builds on 1100 (the role and the issuer), so it merges after it. Re-check against main right before merging and renumber to stay above its highest.

-- ---- 1. the table: tenants have no grant on it ------------------------------------------------------------------------------------------------------
CREATE TABLE engine_operate_queue (
  account_id    uuid NOT NULL,
  repo_id       uuid NOT NULL,
  operate_epoch integer NOT NULL CONSTRAINT engine_operate_queue_epoch_check CHECK (operate_epoch >= 1),
  action        text NOT NULL CONSTRAINT engine_operate_queue_action_check CHECK (action IN ('start', 'stop')),
  state         text NOT NULL DEFAULT 'pending' CONSTRAINT engine_operate_queue_state_check CHECK (state IN ('pending', 'running', 'done')),
  enqueued_at   timestamptz NOT NULL DEFAULT now(),
  claimed_at    timestamptz,
  attempts      integer NOT NULL DEFAULT 0 CONSTRAINT engine_operate_queue_attempts_check CHECK (attempts >= 0),
  PRIMARY KEY (account_id, repo_id, operate_epoch, action),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  CONSTRAINT engine_operate_queue_running_claimed CHECK (state <> 'running' OR claimed_at IS NOT NULL)
);
CREATE INDEX engine_operate_queue_open ON engine_operate_queue (account_id, enqueued_at) WHERE state <> 'done';
ALTER TABLE engine_operate_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE engine_operate_queue FORCE ROW LEVEL SECURITY;

GRANT SELECT ON engine_operate_queue TO engine_start_definer;
GRANT INSERT (account_id, repo_id, operate_epoch, action) ON engine_operate_queue TO engine_start_definer;
GRANT UPDATE (state, enqueued_at, claimed_at, attempts) ON engine_operate_queue TO engine_start_definer;
CREATE POLICY engine_start_definer_select ON engine_operate_queue FOR SELECT TO engine_start_definer USING (true);
CREATE POLICY engine_start_definer_insert ON engine_operate_queue FOR INSERT TO engine_start_definer WITH CHECK (true);
CREATE POLICY engine_start_definer_update ON engine_operate_queue FOR UPDATE TO engine_start_definer USING (true) WITH CHECK (true);
-- The issuer and the lister read when a start was issued, to tell a session brought up after a queue row from one before it (1100 granted the other columns they read; the signed bytes stay unreadable).
GRANT SELECT (issued_at) ON machine_jobs TO engine_start_definer;

DO $$
DECLARE
  super boolean := (SELECT rolsuper FROM pg_roles WHERE rolname = current_user);
BEGIN
  IF NOT super THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'engine_start_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on engine_start_definer; cannot ALTER FUNCTION ... OWNER TO engine_start_definer';
    END IF;
    GRANT engine_start_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
  GRANT CREATE ON SCHEMA public TO engine_start_definer;

  -- ---- 2. the trigger function: one function for both tables' triggers ---------------------------------------------------------------------------
  -- A repo whose row is gone (the cascade that removes a project) is skipped, so a delete never leaves a row that points at nothing.
  CREATE FUNCTION public.engine_operate_queue_enqueue() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    v_epoch integer;
    v_on    boolean;
  BEGIN
    IF TG_TABLE_NAME = 'engine_bridge_settings' THEN
      IF NEW.operate_epoch < 1 THEN RETURN NULL; END IF;
      INSERT INTO public.engine_operate_queue AS q (account_id, repo_id, operate_epoch, action)
      SELECT br.account_id, br.repo_id, NEW.operate_epoch, CASE WHEN NEW.operate_enabled THEN 'start' ELSE 'stop' END
        FROM public.engine_bridge_repos br
        JOIN public.repos r ON r.account_id = br.account_id AND r.id = br.repo_id
       WHERE br.account_id = NEW.account_id
      ON CONFLICT (account_id, repo_id, operate_epoch, action) DO UPDATE SET state = 'pending', attempts = 0, claimed_at = NULL, enqueued_at = now() WHERE q.state = 'done';
      RETURN NULL;
    END IF;
    IF TG_OP = 'INSERT' THEN
      SELECT st.operate_epoch, st.operate_enabled INTO v_epoch, v_on FROM public.engine_bridge_settings st WHERE st.account_id = NEW.account_id;
      IF NOT FOUND OR NOT v_on OR v_epoch < 1 THEN RETURN NULL; END IF;
      INSERT INTO public.engine_operate_queue AS q (account_id, repo_id, operate_epoch, action)
      SELECT NEW.account_id, NEW.repo_id, v_epoch, 'start' WHERE EXISTS (SELECT 1 FROM public.repos r WHERE r.account_id = NEW.account_id AND r.id = NEW.repo_id)
      ON CONFLICT (account_id, repo_id, operate_epoch, action) DO UPDATE SET state = 'pending', attempts = 0, claimed_at = NULL, enqueued_at = now() WHERE q.state = 'done';
      RETURN NULL;
    END IF;
    SELECT st.operate_epoch INTO v_epoch FROM public.engine_bridge_settings st WHERE st.account_id = OLD.account_id;
    IF NOT FOUND OR v_epoch < 1 THEN RETURN NULL; END IF;
    INSERT INTO public.engine_operate_queue AS q (account_id, repo_id, operate_epoch, action)
    SELECT OLD.account_id, OLD.repo_id, v_epoch, 'stop' WHERE EXISTS (SELECT 1 FROM public.repos r WHERE r.account_id = OLD.account_id AND r.id = OLD.repo_id)
    ON CONFLICT (account_id, repo_id, operate_epoch, action) DO UPDATE SET state = 'pending', attempts = 0, claimed_at = NULL, enqueued_at = now() WHERE q.state = 'done';
    RETURN NULL;
  END;
  $f$;

  -- ---- 3. the claim: at most 4 running rows per account ------------------------------------------------------------------------------------------
  -- The account's queue lock serializes two claimers of one account (so the count below cannot be raced past 4); SKIP LOCKED lets claimers of different accounts, and a finisher holding a row, pass each other.
  -- Stops are taken before starts, then the oldest first. A repo narrows the claim to its own rows and needs its account.
  CREATE FUNCTION public.engine_operate_queue_claim(p_account uuid, p_repo uuid, p_limit integer)
  RETURNS TABLE (o_account uuid, o_repo uuid, o_epoch integer, o_action text, o_attempts integer)
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    v_acct uuid;
    v_room integer;
    v_left integer;
    v_n    integer;
  BEGIN
    IF session_user <> 'platform_ops' OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL OR NULLIF(current_setting('app.user_id', true), '') IS NOT NULL THEN
      RAISE EXCEPTION 'engine_operate_queue_claim: refused' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 OR (p_repo IS NOT NULL AND p_account IS NULL) THEN
      RAISE EXCEPTION 'engine_operate_queue_claim: invalid argument' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_left := p_limit;
    FOR v_acct IN SELECT DISTINCT q.account_id FROM public.engine_operate_queue q WHERE q.state <> 'done' AND (p_account IS NULL OR q.account_id = p_account) ORDER BY q.account_id LIMIT 500 LOOP
      EXIT WHEN v_left <= 0;
      PERFORM pg_advisory_xact_lock(hashtextextended('engine_operate_queue:' || v_acct::text, 0));
      -- A row of an epoch that is not the account's now is moot (the switch moved again), and a row a week old is given up on.
      UPDATE public.engine_operate_queue q SET state = 'done'
       WHERE q.account_id = v_acct AND q.state <> 'done'
         AND (q.operate_epoch IS DISTINCT FROM COALESCE((SELECT st.operate_epoch FROM public.engine_bridge_settings st WHERE st.account_id = v_acct), 0) OR q.enqueued_at < now() - interval '7 days');
      -- A drain that died holding a row: it is pending again once it has been running for 10 minutes.
      UPDATE public.engine_operate_queue q SET state = 'pending', attempts = q.attempts + 1 WHERE q.account_id = v_acct AND q.state = 'running' AND q.claimed_at < now() - interval '10 minutes';
      SELECT 4 - count(*)::integer INTO v_room FROM public.engine_operate_queue q WHERE q.account_id = v_acct AND q.state = 'running';
      IF v_room > 0 THEN
        RETURN QUERY
        WITH c AS (
          SELECT q.account_id, q.repo_id, q.operate_epoch, q.action
            FROM public.engine_operate_queue q
           WHERE q.account_id = v_acct AND q.state = 'pending' AND (p_repo IS NULL OR q.repo_id = p_repo)
             AND (q.claimed_at IS NULL OR q.claimed_at + least(q.attempts, 10) * interval '30 seconds' <= now())
           ORDER BY (q.action = 'stop') DESC, q.enqueued_at, q.repo_id
           LIMIT least(v_room, v_left)
             FOR UPDATE OF q SKIP LOCKED
        ), u AS (
          UPDATE public.engine_operate_queue q SET state = 'running', claimed_at = now()
            FROM c WHERE q.account_id = c.account_id AND q.repo_id = c.repo_id AND q.operate_epoch = c.operate_epoch AND q.action = c.action
          RETURNING q.account_id, q.repo_id, q.operate_epoch, q.action, q.attempts
        )
        SELECT u.account_id, u.repo_id, u.operate_epoch, u.action, u.attempts FROM u;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_left := v_left - v_n;
      END IF;
    END LOOP;
    RETURN;
  END;
  $f$;

  -- p_outcome: `done` (the row has been dealt with), `retry` (try again later, after a wait that grows with the attempts) or `release` (untouched: put back with no attempt counted). Only a `running` row moves; false says it was not one.
  CREATE FUNCTION public.engine_operate_queue_finish(p_account uuid, p_repo uuid, p_epoch integer, p_action text, p_outcome text)
  RETURNS boolean
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
  BEGIN
    IF session_user <> 'platform_ops' OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL OR NULLIF(current_setting('app.user_id', true), '') IS NOT NULL THEN
      RAISE EXCEPTION 'engine_operate_queue_finish: refused' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_account IS NULL OR p_repo IS NULL OR p_epoch IS NULL OR p_action IS NULL OR p_outcome IS NULL OR p_action <> ALL (ARRAY['start', 'stop']) OR p_outcome <> ALL (ARRAY['done', 'retry', 'release']) THEN
      RAISE EXCEPTION 'engine_operate_queue_finish: invalid argument' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    UPDATE public.engine_operate_queue q
       SET state = CASE WHEN p_outcome = 'done' THEN 'done' ELSE 'pending' END,
           attempts = q.attempts + CASE WHEN p_outcome = 'retry' THEN 1 ELSE 0 END
     WHERE q.account_id = p_account AND q.repo_id = p_repo AND q.operate_epoch = p_epoch AND q.action = p_action AND q.state = 'running';
    RETURN FOUND;
  END;
  $f$;

  -- ---- 4. the lister of the `operate_on` start -------------------------------------------------------------------------------------------------------
  -- One row per repo with a running `start` queue row at the account's current epoch, whose finished install is placed on a live machine and which is operated. Plan, a start or stop already waiting and every other gate are the issuer's to answer.
  CREATE FUNCTION public.engine_operate_on_starts_due(p_account uuid, p_repo uuid, p_limit integer)
  RETURNS TABLE (o_account uuid, o_repo uuid, o_runner uuid, o_repo_gh_id bigint, o_owner text, o_name text, o_epoch integer, o_resume boolean)
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
  BEGIN
    IF session_user <> 'platform_ops' OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL OR NULLIF(current_setting('app.user_id', true), '') IS NOT NULL THEN
      RAISE EXCEPTION 'engine_operate_on_starts_due: refused' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 OR (p_repo IS NOT NULL AND p_account IS NULL) THEN
      RAISE EXCEPTION 'engine_operate_on_starts_due: invalid argument' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    RETURN QUERY
    SELECT pl.account_id, pl.repo_id, pl.runner_id, rp.gh_repo_id, rp.gh_owner, rp.gh_name, st.operate_epoch,
           (EXISTS (SELECT 1 FROM public.runner_sandboxes s WHERE s.account_id = pl.account_id AND s.runner_id = pl.runner_id AND s.name = 'fx-engine-' || rp.gh_repo_id::text)
            OR EXISTS (SELECT 1 FROM public.machine_jobs j WHERE j.account_id = pl.account_id AND j.repo_id = pl.repo_id AND j.runner_id = pl.runner_id AND j.kind = 'engine_session_start' AND j.state = 'done'))
      FROM public.project_placements pl
      JOIN public.accounts ac ON ac.id = pl.account_id AND ac.deleted_at IS NULL
      JOIN public.runners rn ON rn.account_id = pl.account_id AND rn.id = pl.runner_id AND rn.revoked_at IS NULL
      JOIN public.repos rp ON rp.account_id = pl.account_id AND rp.id = pl.repo_id
      JOIN public.engine_bridge_settings st ON st.account_id = pl.account_id
     WHERE (p_account IS NULL OR pl.account_id = p_account) AND (p_repo IS NULL OR pl.repo_id = p_repo)
       AND EXISTS (SELECT 1 FROM public.engine_operate_queue q WHERE q.account_id = pl.account_id AND q.repo_id = pl.repo_id AND q.operate_epoch = st.operate_epoch AND q.action = 'start' AND q.state = 'running'
                    AND NOT EXISTS (SELECT 1 FROM public.machine_jobs j WHERE j.account_id = pl.account_id AND j.repo_id = pl.repo_id AND j.runner_id = pl.runner_id AND j.kind = 'engine_session_start' AND j.state IN ('delivered', 'done') AND j.issued_at > q.enqueued_at
                                      AND NOT EXISTS (SELECT 1 FROM public.machine_jobs sj WHERE sj.account_id = j.account_id AND sj.repo_id = j.repo_id AND sj.runner_id = j.runner_id AND sj.kind = 'engine_session_stop' AND sj.state IN ('issued', 'delivered', 'done') AND sj.issued_at > j.issued_at)))
       AND EXISTS (SELECT 1 FROM public.project_setups ps WHERE ps.account_id = pl.account_id AND ps.repo_id = pl.repo_id AND ps.phase = 'done')
       AND public.engine_repo_operated(pl.account_id, pl.repo_id) AND st.operate_epoch >= 1
     ORDER BY pl.account_id, pl.repo_id
     LIMIT p_limit;
  END;
  $f$;

  -- ---- 5. the issuer, restated ---------------------------------------------------------------------------------------------------------------------
  -- o_result: issued, not_placed, epoch_moved (the signed epoch is not the one now), cause_gone (the cause is consumed or never was, or the repo is no longer operated), plan (not covered) or busy (a start or stop is waiting).
  -- Anything the signed bytes disagree with raises 22023 and writes nothing.
  CREATE OR REPLACE FUNCTION public.engine_system_start_issue(p_id uuid, p_account uuid, p_repo uuid, p_cause text, p_job jsonb, p_issued_at timestamptz, p_expires_at timestamptz)
  RETURNS text
  LANGUAGE plpgsql
  VOLATILE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    v_runner uuid;
    v_gh     bigint;
    v_epoch  integer;
    v_resume boolean;
  BEGIN
    IF session_user <> 'platform_ops' OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL OR NULLIF(current_setting('app.user_id', true), '') IS NOT NULL THEN
      RAISE EXCEPTION 'engine_system_start_issue: refused' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_id IS NULL OR p_account IS NULL OR p_repo IS NULL OR p_cause IS NULL OR p_cause <> ALL (ARRAY['first_start', 'operate_on']) OR p_job IS NULL OR jsonb_typeof(p_job) <> 'object' OR jsonb_typeof(p_job -> 'job') IS DISTINCT FROM 'object'
       OR p_issued_at IS NULL OR p_expires_at IS NULL THEN
      RAISE EXCEPTION 'engine_system_start_issue: invalid argument' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    -- The repo's session lock (the key the person issuers take), then the account's bridge lock, shared (the key every writer of the switches and ticks takes exclusively): a person's start, an off and this start never interleave.
    PERFORM pg_advisory_xact_lock(hashtextextended('engine_session:' || p_account::text || ':' || p_repo::text, 0));
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('engine_bridge:' || p_account::text, 0));
    SELECT pl.runner_id, rp.gh_repo_id INTO v_runner, v_gh
      FROM public.project_placements pl
      JOIN public.accounts ac ON ac.id = pl.account_id AND ac.deleted_at IS NULL
      JOIN public.runners rn ON rn.account_id = pl.account_id AND rn.id = pl.runner_id AND rn.revoked_at IS NULL
      JOIN public.repos rp ON rp.account_id = pl.account_id AND rp.id = pl.repo_id
     WHERE pl.account_id = p_account AND pl.repo_id = p_repo;
    IF NOT FOUND THEN RETURN 'not_placed'; END IF;
    v_resume := EXISTS (SELECT 1 FROM public.runner_sandboxes s WHERE s.account_id = p_account AND s.runner_id = v_runner AND s.name = 'fx-engine-' || v_gh::text)
                OR EXISTS (SELECT 1 FROM public.machine_jobs j WHERE j.account_id = p_account AND j.repo_id = p_repo AND j.runner_id = v_runner AND j.kind = 'engine_session_start' AND j.state = 'done');
    IF (p_job #>> '{job,kind}') IS DISTINCT FROM 'engine_session_start'
       OR (p_job #>> '{job,job_id}') IS DISTINCT FROM p_id::text
       OR (p_job #>> '{job,runner_id}') IS DISTINCT FROM v_runner::text
       OR (p_job #>> '{job,repo_gh_id}') IS DISTINCT FROM v_gh::text
       OR (p_job #>> '{job,setup_id}') IS NOT NULL
       OR jsonb_typeof(p_job #> '{job,repo_gh_id}') IS DISTINCT FROM 'number' OR jsonb_typeof(p_job #> '{job,args,at_sha}') IS DISTINCT FROM 'string'
       OR jsonb_typeof(p_job #> '{job,args,resume}') IS DISTINCT FROM 'boolean' OR jsonb_typeof(p_job #> '{job,args,operate_epoch}') IS DISTINCT FROM 'number'
       OR COALESCE((p_job #>> '{job,args,at_sha}') !~ '^[0-9a-f]{40}$', true)
       OR (p_job #>> '{job,args,resume}') IS DISTINCT FROM v_resume::text
       OR COALESCE((p_job #>> '{job,args,operate_epoch}') !~ '^[1-9][0-9]{0,8}$', true) THEN
      RAISE EXCEPTION 'engine_system_start_issue: the signed job does not say what was asked' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT COALESCE((SELECT st.operate_epoch FROM public.engine_bridge_settings st WHERE st.account_id = p_account), 0) INTO v_epoch;
    IF (p_job #>> '{job,args,operate_epoch}') IS DISTINCT FROM v_epoch::text THEN RETURN 'epoch_moved'; END IF;
    -- The cause first: a replay finds it consumed and answers cause_gone, whatever the issued start now makes of the other gates. `first_start`'s cause is the finished install's `start_pending`; `operate_on`'s is the queue row of this repo at the current epoch, which must be `running`
    -- (claimed by the drain, not yet consumed).
    IF NOT public.engine_repo_operated(p_account, p_repo)
       OR (p_cause = 'first_start' AND NOT EXISTS (SELECT 1 FROM public.project_setups ps WHERE ps.account_id = p_account AND ps.repo_id = p_repo AND ps.phase = 'done' AND ps.start_pending))
       OR (p_cause = 'operate_on' AND NOT EXISTS (SELECT 1 FROM public.engine_operate_queue q WHERE q.account_id = p_account AND q.repo_id = p_repo AND q.operate_epoch = v_epoch AND q.action = 'start' AND q.state = 'running')) THEN
      RETURN 'cause_gone';
    END IF;
    -- A session this row's own cause already brought up (a first start or a person's start, issued after the row was queued, delivered or finished, and not stopped since) ends the row without a second start.
    IF p_cause = 'operate_on' AND EXISTS (
         SELECT 1 FROM public.engine_operate_queue q JOIN public.machine_jobs j ON j.account_id = q.account_id AND j.repo_id = q.repo_id AND j.runner_id = v_runner AND j.kind = 'engine_session_start' AND j.state IN ('delivered', 'done') AND j.issued_at > q.enqueued_at
          WHERE q.account_id = p_account AND q.repo_id = p_repo AND q.operate_epoch = v_epoch AND q.action = 'start' AND q.state = 'running'
            AND NOT EXISTS (SELECT 1 FROM public.machine_jobs sj WHERE sj.account_id = j.account_id AND sj.repo_id = j.repo_id AND sj.runner_id = j.runner_id AND sj.kind = 'engine_session_stop' AND sj.state IN ('issued', 'delivered', 'done') AND sj.issued_at > j.issued_at)) THEN
      UPDATE public.engine_operate_queue SET state = 'done' WHERE account_id = p_account AND repo_id = p_repo AND operate_epoch = v_epoch AND action = 'start' AND state = 'running';
      RETURN 'cause_gone';
    END IF;
    IF public.engine_plan_ended(p_account) OR NOT public.engine_start_covered(p_account, p_repo) THEN RETURN 'plan'; END IF;
    IF EXISTS (SELECT 1 FROM public.machine_jobs j WHERE j.account_id = p_account AND j.repo_id = p_repo AND j.kind IN ('engine_session_start', 'engine_session_stop') AND j.state IN ('issued', 'delivered')) THEN RETURN 'busy'; END IF;
    -- The start that follows covers both causes: a finished install's `start_pending` is cleared whichever cause asked, so one start is not followed by a second for the same session.
    UPDATE public.project_setups SET start_pending = false WHERE account_id = p_account AND repo_id = p_repo AND phase = 'done' AND start_pending;
    IF p_cause = 'operate_on' THEN
      UPDATE public.engine_operate_queue SET state = 'done' WHERE account_id = p_account AND repo_id = p_repo AND operate_epoch = v_epoch AND action = 'start' AND state = 'running';
    END IF;
    INSERT INTO public.machine_jobs (id, account_id, runner_id, repo_id, setup_id, kind, job, attempt, issued_at, expires_at)
    VALUES (p_id, p_account, v_runner, p_repo, NULL, 'engine_session_start', p_job, 1, p_issued_at, p_expires_at);
    INSERT INTO public.audit_log (account_id, actor, action, payload)
    VALUES (p_account, session_user, 'engine_session.started', jsonb_build_object('repo_id', p_repo, 'job_id', p_id, 'cause', p_cause, 'resume', v_resume, 'at_sha', p_job #>> '{job,args,at_sha}', 'operate_epoch', v_epoch));
    RETURN 'issued';
  END;
  $f$;

  REVOKE ALL ON FUNCTION public.engine_operate_queue_enqueue() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.engine_operate_queue_claim(uuid, uuid, integer) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.engine_operate_queue_finish(uuid, uuid, integer, text, text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.engine_operate_on_starts_due(uuid, uuid, integer) FROM PUBLIC;
  ALTER FUNCTION public.engine_operate_queue_enqueue() OWNER TO engine_start_definer;
  ALTER FUNCTION public.engine_operate_queue_claim(uuid, uuid, integer) OWNER TO engine_start_definer;
  ALTER FUNCTION public.engine_operate_queue_finish(uuid, uuid, integer, text, text) OWNER TO engine_start_definer;
  ALTER FUNCTION public.engine_operate_on_starts_due(uuid, uuid, integer) OWNER TO engine_start_definer;
  -- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner). The trigger function is granted to app_user alone, like 1066's; called outside a trigger it only raises.
  GRANT EXECUTE ON FUNCTION public.engine_operate_queue_enqueue() TO app_user;
  GRANT EXECUTE ON FUNCTION public.engine_operate_queue_claim(uuid, uuid, integer) TO platform_ops;
  GRANT EXECUTE ON FUNCTION public.engine_operate_queue_finish(uuid, uuid, integer, text, text) TO platform_ops;
  GRANT EXECUTE ON FUNCTION public.engine_operate_on_starts_due(uuid, uuid, integer) TO platform_ops;

  -- ---- 6. the triggers --------------------------------------------------------------------------------------------------------------------------
  -- AFTER the BEFORE trigger that sets the epoch (1066), so the row seen here carries the new epoch.
  CREATE TRIGGER engine_bridge_settings_operate_queue_ins AFTER INSERT ON public.engine_bridge_settings
    FOR EACH ROW WHEN (NEW.operate_epoch >= 1) EXECUTE FUNCTION public.engine_operate_queue_enqueue();
  CREATE TRIGGER engine_bridge_settings_operate_queue_upd AFTER UPDATE ON public.engine_bridge_settings
    FOR EACH ROW WHEN (NEW.operate_epoch IS DISTINCT FROM OLD.operate_epoch) EXECUTE FUNCTION public.engine_operate_queue_enqueue();
  CREATE TRIGGER engine_bridge_repos_operate_queue_ins AFTER INSERT ON public.engine_bridge_repos
    FOR EACH ROW EXECUTE FUNCTION public.engine_operate_queue_enqueue();
  CREATE TRIGGER engine_bridge_repos_operate_queue_del AFTER DELETE ON public.engine_bridge_repos
    FOR EACH ROW EXECUTE FUNCTION public.engine_operate_queue_enqueue();

  REVOKE CREATE ON SCHEMA public FROM engine_start_definer;
  IF NOT super THEN
    REVOKE engine_start_definer FROM CURRENT_USER;
  END IF;
END
$$;
