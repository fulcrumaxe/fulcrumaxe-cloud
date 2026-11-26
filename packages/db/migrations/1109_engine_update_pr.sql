-- D#845 ON-15c: the engine update's pull request, its watch, the merge, and the restart (Ruling 98). 1093 left an update at phase push, state ok, with the pushed commit recorded; this finishes it.
--
--   1. engine_updates gains pr_claim_at / pr_claim_sha (the lease of the pull request step, as 1072's for a setup) and pr_closed_number / pr_closed_merged (a close or merge that landed before the step recorded the number, as 1073's).
--   2. engine_update_definer (1093) gains what the platform_ops functions below read (repos.gh_owner/gh_name, accounts, engine_updates, done project_setups), each behind a policy that holds only for the platform_ops login, so the
--      tenant functions of 1093 see no more than before; and UPDATE (engine_version) of a done setup, which only engine_update_merged writes.
--        engine_update_pr_claim()                            platform_ops. Takes the oldest due update (phase push, step push ok, head recorded, no pull request) for ten minutes, for that commit; one whose head was recorded more than
--                                                            six hours ago is failed `pr_not_opened` first (it would otherwise hold the repo's one live slot forever). engine_update_pr_pending() says whether any is due, leased or stale.
--        engine_update_pr_record(update, attempt, head, pr)  platform_ops. phase await_merge with the number; or, when a delivery already closed that number, the closed outcome (merged -> engine_update_merged; closed -> failed `pr_closed`).
--        engine_update_pr_fail(update, attempt, head, code)  platform_ops. The step's refusal (update_head_changed, pr_scope_refused, pr_open_failed): the update is failed and the repo is free again.
--        engine_update_pr_closed(repo, pr, merged, head_ref) app_user (the webhook's tenant session), fenced to ^fx/engine-update-<this update's to_version>$ and to the update that has this pull request. Answers finished, failed, recorded or none.
--        engine_update_merged(account, update)               owned by the role, no grant: a merged pull request sets project_setups.engine_version to the update's to_version and the update to phase restart. Called only by the two above.
--   3. engine_start_definer (1100) reads engine_updates (four columns) and ends a restart (phase restart -> done, restarted_at); engine_update_starts_due lists the repos with an update waiting at restart (platform_ops).
--   4. engine_system_start_issue is restated with CREATE OR REPLACE: 1105's body, carried forward, with exactly the cause `engine_update` added (the closed list, its cause test and its consumption; the diff is in the PR). The cause is the repo's
--      update at phase restart with restarted_at NULL, and it is consumed (phase done, restarted_at) in the issuing transaction, so a replay answers cause_gone.
-- machine_job_expire (1093) is not restated: an update that reached this step has its job done, so the expiry has nothing of it to fail.
-- Numbered 1109 by the Team Lead (the rulings say 1094). Re-check against main right before merging and renumber to stay above its highest.

ALTER TABLE engine_updates
  ADD COLUMN pr_claim_at timestamptz,
  ADD COLUMN pr_claim_sha text CONSTRAINT engine_updates_pr_claim_sha_check CHECK (pr_claim_sha IS NULL OR pr_claim_sha ~ '^[0-9a-f]{40}$'),
  ADD COLUMN pr_closed_number integer CONSTRAINT engine_updates_pr_closed_number_check CHECK (pr_closed_number IS NULL OR pr_closed_number > 0),
  ADD COLUMN pr_closed_merged boolean,
  ADD CONSTRAINT engine_updates_pr_closed_pair CHECK ((pr_closed_number IS NULL) = (pr_closed_merged IS NULL));

-- ---- engine_update_definer: the platform_ops reads and the version write ----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'engine_update_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on engine_update_definer; cannot ALTER FUNCTION ... OWNER TO engine_update_definer';
    END IF;
    GRANT engine_update_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO engine_update_definer;

GRANT SELECT (gh_owner, gh_name) ON repos TO engine_update_definer;
GRANT UPDATE (engine_version) ON project_setups TO engine_update_definer;
CREATE POLICY engine_update_definer_ops_select ON accounts FOR SELECT TO engine_update_definer USING (session_user = 'platform_ops');
CREATE POLICY engine_update_definer_ops_select ON repos FOR SELECT TO engine_update_definer USING (session_user = 'platform_ops');
CREATE POLICY engine_update_definer_ops_select ON project_setups FOR SELECT TO engine_update_definer USING (session_user = 'platform_ops' AND phase = 'done');
CREATE POLICY engine_update_definer_ops_select ON engine_updates FOR SELECT TO engine_update_definer USING (session_user = 'platform_ops');
CREATE POLICY engine_update_definer_ops_update ON engine_updates FOR UPDATE TO engine_update_definer
  USING (session_user = 'platform_ops' AND phase = 'push') WITH CHECK (session_user = 'platform_ops' AND phase IN ('push', 'await_merge', 'restart', 'failed'));
-- engine_update_merged writes the version of a done setup, from the webhook's tenant session (a row of its own account) or from the platform_ops step.
CREATE POLICY engine_update_definer_merge ON project_setups FOR UPDATE TO engine_update_definer USING (phase = 'done') WITH CHECK (phase = 'done');

-- A merged pull request: the installed version moves to the update's, and the update waits for its restart. Called by the two functions below, never granted.
CREATE FUNCTION engine_update_merged(p_account uuid, p_update uuid) RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_setup uuid; v_to text;
BEGIN
  UPDATE public.engine_updates u SET phase = 'restart', sub_step = 'pr_merged', state = 'ok', failure_code = NULL, failure_at = NULL, updated_at = now()
   WHERE u.account_id = p_account AND u.id = p_update AND u.phase IN ('push', 'await_merge') AND u.head_sha IS NOT NULL
  RETURNING u.setup_id, u.to_version INTO v_setup, v_to;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.project_setups s SET engine_version = v_to WHERE s.account_id = p_account AND s.id = v_setup AND s.phase = 'done';
  RETURN true;
END;
$$;

-- The webhook's watch (as 1073's setup_install_pr_closed): a pull request of the update branch whose version is this update's, in this repository. (a) the update at await_merge with this number: merged -> restart, closed -> failed
-- `pr_closed`; (b) closed or merged between markReady and the step's record of the number: kept in the two columns for the record to honour.
CREATE FUNCTION engine_update_pr_closed(p_repo uuid, p_pr integer, p_merged boolean, p_head_ref text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_id uuid;
BEGIN
  IF acct IS NULL OR p_repo IS NULL OR p_pr IS NULL OR p_pr < 1 OR p_merged IS NULL OR p_head_ref IS NULL OR p_head_ref !~ '^fx/engine-update-[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$' THEN
    RETURN 'none';
  END IF;
  SELECT u.id INTO v_id FROM public.engine_updates u
   WHERE u.account_id = acct AND u.repo_id = p_repo AND u.phase = 'await_merge' AND u.pr = p_pr AND p_head_ref = 'fx/engine-update-' || u.to_version
   FOR UPDATE;
  IF FOUND THEN
    IF p_merged THEN
      PERFORM public.engine_update_merged(acct, v_id);
      RETURN 'finished';
    END IF;
    UPDATE public.engine_updates u SET phase = 'failed', state = 'failed', failure_code = 'pr_closed', failure_at = now(), updated_at = now() WHERE u.account_id = acct AND u.id = v_id;
    RETURN 'failed';
  END IF;
  SELECT u.id INTO v_id FROM public.engine_updates u
   WHERE u.account_id = acct AND u.repo_id = p_repo AND u.phase = 'push' AND u.sub_step = 'push' AND u.state = 'ok' AND u.head_sha IS NOT NULL AND u.pr IS NULL AND p_head_ref = 'fx/engine-update-' || u.to_version
   FOR UPDATE;
  IF FOUND THEN
    UPDATE public.engine_updates u SET pr_closed_number = p_pr, pr_closed_merged = p_merged WHERE u.account_id = acct AND u.id = v_id;
    RETURN 'recorded';
  END IF;
  RETURN 'none';
END;
$$;

CREATE FUNCTION engine_update_pr_claim()
RETURNS TABLE (o_account uuid, o_update uuid, o_repo uuid, o_attempt integer, o_head text, o_from text, o_to text, o_owner text, o_name text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  s_id uuid; s_account uuid; s_repo uuid; s_attempt integer; s_head text; s_from text; s_to text;
BEGIN
  IF session_user <> 'platform_ops' OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL OR NULLIF(current_setting('app.user_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'engine_update_pr_claim: platform_ops only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.engine_updates x SET phase = 'failed', state = 'failed', failure_code = 'pr_not_opened', failure_at = now(), updated_at = now()
   WHERE x.phase = 'push' AND x.sub_step = 'push' AND x.state = 'ok' AND x.head_sha IS NOT NULL AND x.pr IS NULL AND x.updated_at <= now() - interval '6 hours';
  SELECT x.id, x.account_id, x.repo_id, x.attempt, x.head_sha, x.from_version, x.to_version INTO s_id, s_account, s_repo, s_attempt, s_head, s_from, s_to FROM public.engine_updates x
   WHERE x.phase = 'push' AND x.sub_step = 'push' AND x.state = 'ok' AND x.head_sha IS NOT NULL AND x.pr IS NULL
     AND (x.pr_claim_at IS NULL OR x.pr_claim_sha IS DISTINCT FROM x.head_sha OR x.pr_claim_at < now() - interval '10 minutes')
     AND public.account_is_active(x.account_id)
   ORDER BY x.updated_at, x.id
   LIMIT 1
   FOR UPDATE OF x SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.engine_updates x SET pr_claim_at = now(), pr_claim_sha = s_head WHERE x.account_id = s_account AND x.id = s_id;
  RETURN QUERY SELECT s_account, s_id, s_repo, s_attempt, s_head, s_from, s_to, r.gh_owner, r.gh_name FROM public.repos r WHERE r.account_id = s_account AND r.id = s_repo;
END;
$$;

CREATE FUNCTION engine_update_pr_pending()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF session_user <> 'platform_ops' OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL OR NULLIF(current_setting('app.user_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'engine_update_pr_pending: platform_ops only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN EXISTS (SELECT 1 FROM public.engine_updates x WHERE x.phase = 'push' AND x.sub_step = 'push' AND x.state = 'ok' AND x.head_sha IS NOT NULL AND x.pr IS NULL AND public.account_is_active(x.account_id));
END;
$$;

-- Whether the update still says what the claim saw, under its row lock; false when it does not.
CREATE FUNCTION engine_update_pr_record(p_update uuid, p_attempt integer, p_head text, p_pr integer)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_account uuid; c_num integer; c_merged boolean;
BEGIN
  IF session_user <> 'platform_ops' OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL OR NULLIF(current_setting('app.user_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'engine_update_pr_record: platform_ops only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_update IS NULL OR p_attempt IS NULL OR p_head IS NULL OR p_head !~ '^[0-9a-f]{40}$' OR p_pr IS NULL OR p_pr < 1 THEN
    RAISE EXCEPTION 'engine_update_pr_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT x.account_id, x.pr_closed_number, x.pr_closed_merged INTO v_account, c_num, c_merged FROM public.engine_updates x
   WHERE x.id = p_update AND x.phase = 'push' AND x.sub_step = 'push' AND x.state = 'ok' AND x.attempt = p_attempt AND x.head_sha = p_head AND x.pr IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF c_num IS NOT NULL AND c_num = p_pr AND c_merged THEN
    UPDATE public.engine_updates x SET pr = p_pr WHERE x.account_id = v_account AND x.id = p_update;
    RETURN public.engine_update_merged(v_account, p_update);
  ELSIF c_num IS NOT NULL AND c_num = p_pr THEN
    UPDATE public.engine_updates x SET phase = 'failed', state = 'failed', failure_code = 'pr_closed', failure_at = now(), pr = p_pr, updated_at = now() WHERE x.account_id = v_account AND x.id = p_update;
  ELSE
    UPDATE public.engine_updates x SET phase = 'await_merge', sub_step = 'pr_open', state = 'ok', pr = p_pr, updated_at = now() WHERE x.account_id = v_account AND x.id = p_update;
  END IF;
  RETURN true;
END;
$$;

CREATE FUNCTION engine_update_pr_fail(p_update uuid, p_attempt integer, p_head text, p_code text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF session_user <> 'platform_ops' OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL OR NULLIF(current_setting('app.user_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'engine_update_pr_fail: platform_ops only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_update IS NULL OR p_attempt IS NULL OR p_head IS NULL OR p_head !~ '^[0-9a-f]{40}$' OR p_code IS NULL OR p_code NOT IN ('update_head_changed', 'pr_scope_refused', 'pr_open_failed') THEN
    RAISE EXCEPTION 'engine_update_pr_fail: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.engine_updates x SET phase = 'failed', state = 'failed', failure_code = p_code, failure_at = now(), updated_at = now()
   WHERE x.id = p_update AND x.phase = 'push' AND x.sub_step = 'push' AND x.state = 'ok' AND x.attempt = p_attempt AND x.head_sha = p_head AND x.pr IS NULL;
  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION engine_update_merged(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION engine_update_pr_closed(uuid, integer, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION engine_update_pr_claim() FROM PUBLIC;
REVOKE ALL ON FUNCTION engine_update_pr_pending() FROM PUBLIC;
REVOKE ALL ON FUNCTION engine_update_pr_record(uuid, integer, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION engine_update_pr_fail(uuid, integer, text, text) FROM PUBLIC;
ALTER FUNCTION engine_update_merged(uuid, uuid) OWNER TO engine_update_definer;
ALTER FUNCTION engine_update_pr_closed(uuid, integer, boolean, text) OWNER TO engine_update_definer;
ALTER FUNCTION engine_update_pr_claim() OWNER TO engine_update_definer;
ALTER FUNCTION engine_update_pr_pending() OWNER TO engine_update_definer;
ALTER FUNCTION engine_update_pr_record(uuid, integer, text, integer) OWNER TO engine_update_definer;
ALTER FUNCTION engine_update_pr_fail(uuid, integer, text, text) OWNER TO engine_update_definer;
GRANT EXECUTE ON FUNCTION engine_update_pr_closed(uuid, integer, boolean, text) TO app_user;
GRANT EXECUTE ON FUNCTION engine_update_pr_claim() TO platform_ops;
GRANT EXECUTE ON FUNCTION engine_update_pr_pending() TO platform_ops;
GRANT EXECUTE ON FUNCTION engine_update_pr_record(uuid, integer, text, integer) TO platform_ops;
GRANT EXECUTE ON FUNCTION engine_update_pr_fail(uuid, integer, text, text) TO platform_ops;
REVOKE CREATE ON SCHEMA public FROM engine_update_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE engine_update_definer FROM CURRENT_USER;
  END IF;
END
$$;

-- ---- engine_start_definer: the restart's cause, its lister and the restated issuer -----------------------------------------------------------------------
GRANT SELECT (account_id, repo_id, phase, restarted_at) ON engine_updates TO engine_start_definer;
GRANT UPDATE (phase, restarted_at, updated_at) ON engine_updates TO engine_start_definer;
CREATE POLICY engine_start_definer_select ON engine_updates FOR SELECT TO engine_start_definer USING (true);
CREATE POLICY engine_start_definer_restart ON engine_updates FOR UPDATE TO engine_start_definer USING (phase = 'restart' AND restarted_at IS NULL) WITH CHECK (phase = 'done' AND restarted_at IS NOT NULL);

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

  -- One row per repo whose update merged and waits for its restart, placed on a live machine and operated: the twin of 1105's lister for the cause that is an update at phase restart. Plan, a start or stop already waiting and every other gate are the issuer's.
  CREATE FUNCTION public.engine_update_starts_due(p_account uuid, p_repo uuid, p_limit integer)
  RETURNS TABLE (o_account uuid, o_repo uuid, o_runner uuid, o_repo_gh_id bigint, o_owner text, o_name text, o_epoch integer, o_resume boolean)
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
  BEGIN
    IF session_user <> 'platform_ops' OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL OR NULLIF(current_setting('app.user_id', true), '') IS NOT NULL THEN
      RAISE EXCEPTION 'engine_update_starts_due: refused' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 OR (p_repo IS NOT NULL AND p_account IS NULL) THEN
      RAISE EXCEPTION 'engine_update_starts_due: invalid argument' USING ERRCODE = 'invalid_parameter_value';
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
       AND EXISTS (SELECT 1 FROM public.engine_updates u WHERE u.account_id = pl.account_id AND u.repo_id = pl.repo_id AND u.phase = 'restart' AND u.restarted_at IS NULL)
       AND public.engine_repo_operated(pl.account_id, pl.repo_id) AND st.operate_epoch >= 1
     ORDER BY pl.account_id, pl.repo_id
     LIMIT p_limit;
  END;
  $f$;
  REVOKE ALL ON FUNCTION public.engine_update_starts_due(uuid, uuid, integer) FROM PUBLIC;
  ALTER FUNCTION public.engine_update_starts_due(uuid, uuid, integer) OWNER TO engine_start_definer;
  GRANT EXECUTE ON FUNCTION public.engine_update_starts_due(uuid, uuid, integer) TO platform_ops;

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
    IF p_id IS NULL OR p_account IS NULL OR p_repo IS NULL OR p_cause IS NULL OR p_cause <> ALL (ARRAY['first_start', 'operate_on', 'engine_update']) OR p_job IS NULL OR jsonb_typeof(p_job) <> 'object' OR jsonb_typeof(p_job -> 'job') IS DISTINCT FROM 'object'
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
       OR (p_cause = 'operate_on' AND NOT EXISTS (SELECT 1 FROM public.engine_operate_queue q WHERE q.account_id = p_account AND q.repo_id = p_repo AND q.operate_epoch = v_epoch AND q.action = 'start' AND q.state = 'running'))
       OR (p_cause = 'engine_update' AND NOT EXISTS (SELECT 1 FROM public.engine_updates u WHERE u.account_id = p_account AND u.repo_id = p_repo AND u.phase = 'restart' AND u.restarted_at IS NULL)) THEN
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
    IF p_cause = 'engine_update' THEN
      UPDATE public.engine_updates SET phase = 'done', restarted_at = now(), updated_at = now() WHERE account_id = p_account AND repo_id = p_repo AND phase = 'restart' AND restarted_at IS NULL;
    END IF;
    INSERT INTO public.machine_jobs (id, account_id, runner_id, repo_id, setup_id, kind, job, attempt, issued_at, expires_at)
    VALUES (p_id, p_account, v_runner, p_repo, NULL, 'engine_session_start', p_job, 1, p_issued_at, p_expires_at);
    INSERT INTO public.audit_log (account_id, actor, action, payload)
    VALUES (p_account, session_user, 'engine_session.started', jsonb_build_object('repo_id', p_repo, 'job_id', p_id, 'cause', p_cause, 'resume', v_resume, 'at_sha', p_job #>> '{job,args,at_sha}', 'operate_epoch', v_epoch));
    RETURN 'issued';
  END;
  $f$;

  REVOKE CREATE ON SCHEMA public FROM engine_start_definer;
  IF NOT super THEN
    REVOKE engine_start_definer FROM CURRENT_USER;
  END IF;
END
$$;
