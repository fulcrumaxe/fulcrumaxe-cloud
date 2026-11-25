-- D#845 ON-15a: the engine update of an installed project (Ruling 98): the table, and the definers that issue the job and guard its push.
--
--   1. engine_updates: one row per update of a project's engine, never a reopened setup. A partial unique index allows one live update per repo (live = phase not done or failed). app_user reads its own account's rows and
--      writes none; only the definers below do.
--   2. engine_update_definer, a NOLOGIN role of its own, owns the functions. It reads and writes what they use, by column and by row policy, and nothing else.
--        engine_update_issue          a person (owner or admin): checks the setup is installed, the machine placed, no live update and that the signed bytes name the newest published release the machine can run
--                                     and that is newer than the installed one; then writes the update and its job (kind engine_update, signed by the caller, attempt = the setup's next).
--        engine_update_push_grant     the push credential's fence, as 1071's: this runner's delivered, current engine_update job, whose update reported the push step started; once per job.
--        engine_update_head_record    the pushed commit, written once, in the transaction of the `push ok` report; it also ends the job (done), so the machine's delivered slot is free and the expiry never fails a finished update.
--        engine_update_progress_record  one report of the job, as 1053's does for a setup; the update, never the installed setup, takes the step.
--   3. machine_job_expire (1066's body) no longer fails the installed setup of an engine_update job; it fails the update instead, which frees the repo for the next one.
-- Numbered 1093 by the Team Lead. Re-check against main right before merging and renumber to stay above its highest.

CREATE TABLE engine_updates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id       uuid NOT NULL,
  setup_id      uuid NOT NULL,
  from_version  text NOT NULL CONSTRAINT engine_updates_from_check CHECK (from_version ~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$'),
  to_version    text NOT NULL CONSTRAINT engine_updates_to_check CHECK (to_version ~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$'),
  phase         text NOT NULL DEFAULT 'push' CONSTRAINT engine_updates_phase_check CHECK (phase IN ('push', 'pr', 'await_merge', 'restart', 'done', 'failed')),
  sub_step      text CONSTRAINT engine_updates_sub_step_check CHECK (sub_step ~ '^[a-z][a-z0-9_]{0,63}$'),
  state         text NOT NULL DEFAULT 'started' CONSTRAINT engine_updates_state_check CHECK (state IN ('started', 'ok', 'failed', 'skipped')),
  failure_code  text CONSTRAINT engine_updates_failure_code_check CHECK (failure_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  failure_at    timestamptz,
  attempt       integer NOT NULL CONSTRAINT engine_updates_attempt_check CHECK (attempt >= 1),
  head_sha      text CONSTRAINT engine_updates_head_check CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  pr            integer CONSTRAINT engine_updates_pr_check CHECK (pr > 0),
  restarted_at  timestamptz,
  created_by    uuid NOT NULL REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, repo_id, setup_id) REFERENCES project_setups (account_id, repo_id, id) ON DELETE CASCADE,
  CONSTRAINT engine_updates_failure_pair CHECK ((failure_code IS NULL) = (failure_at IS NULL))
);
CREATE UNIQUE INDEX engine_updates_one_live ON engine_updates (account_id, repo_id) WHERE phase NOT IN ('done', 'failed');
CREATE INDEX engine_updates_setup ON engine_updates (account_id, setup_id, attempt);
ALTER TABLE engine_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE engine_updates FORCE ROW LEVEL SECURITY;
REVOKE ALL ON engine_updates FROM PUBLIC;
GRANT SELECT ON engine_updates TO app_user;
CREATE POLICY tenant_isolation_select ON engine_updates FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));

DO $$
DECLARE
  n text := 'engine_update_definer';
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  END IF;
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE format('ALTER ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', n);
  ELSIF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = n::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
    RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot ALTER FUNCTION ... OWNER TO %', n, n;
  ELSE
    EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', n);
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = n AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'role % still has a privileged attribute', n;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO engine_update_definer;
GRANT USAGE ON SCHEMA public TO engine_update_definer;

GRANT SELECT (id, deleted_at) ON accounts TO engine_update_definer;
GRANT SELECT (account_id, user_id, role) ON account_members TO engine_update_definer;
GRANT SELECT (id, account_id, repo_id, phase, engine_version) ON project_setups TO engine_update_definer;
GRANT SELECT (id, account_id, gh_repo_id) ON repos TO engine_update_definer;
GRANT SELECT (account_id, repo_id, runner_id) ON project_placements TO engine_update_definer;
GRANT SELECT (id, account_id, revoked_at, protocol_version) ON runners TO engine_update_definer;
GRANT SELECT ON engine_releases TO engine_update_definer;
GRANT SELECT, INSERT, UPDATE ON engine_updates TO engine_update_definer;
GRANT SELECT, INSERT, UPDATE ON machine_jobs TO engine_update_definer;
DO $$
DECLARE
  t text;
  acct text := 'account_id = NULLIF(current_setting(''app.account_id'', true), '''')::uuid';
BEGIN
  FOREACH t IN ARRAY ARRAY['account_members', 'project_setups', 'repos', 'project_placements', 'runners'] LOOP
    EXECUTE format('CREATE POLICY engine_update_definer_select ON %I FOR SELECT TO engine_update_definer USING (%s)', t, acct);
  END LOOP;
  CREATE POLICY engine_update_definer_select ON accounts FOR SELECT TO engine_update_definer USING (id = NULLIF(current_setting('app.account_id', true), '')::uuid);
  CREATE POLICY engine_update_definer_select ON engine_releases FOR SELECT TO engine_update_definer USING (true);
  CREATE POLICY engine_update_definer_use ON engine_updates FOR ALL TO engine_update_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
  CREATE POLICY engine_update_definer_select ON machine_jobs FOR SELECT TO engine_update_definer USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
  CREATE POLICY engine_update_definer_insert ON machine_jobs FOR INSERT TO engine_update_definer WITH CHECK (kind = 'engine_update' AND account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
  CREATE POLICY engine_update_definer_update ON machine_jobs FOR UPDATE TO engine_update_definer
    USING (kind = 'engine_update' AND account_id = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK (kind = 'engine_update' AND account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
END
$$;

-- The runner of the session (as machine_job_runner of 1053, which this role cannot execute): a live runner of an active account, named by app.runner_id.
CREATE FUNCTION engine_update_runner() RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  raw  text := COALESCE(current_setting('app.runner_id', true), '');
BEGIN
  IF session_user = 'platform_ops' OR acct IS NULL OR NOT public.account_is_active(acct) OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NOT EXISTS (SELECT 1 FROM public.runners r WHERE r.id = raw::uuid AND r.account_id = acct AND r.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'engine_update: the session is not a live runner of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN raw::uuid;
END;
$$;

-- Issues the update and its job, for a person. o_result: ok, not_found (no installed setup of this repo), not_placed, not_behind, update_live, setup_changed (the signed bytes name something other than the newest release).
CREATE FUNCTION engine_update_issue(p_id uuid, p_job uuid, p_repo uuid, p_setup uuid, p_env jsonb, p_issued_at timestamptz, p_expires_at timestamptz)
RETURNS TABLE (o_result text, o_attempt integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  v_from text; v_runner uuid; v_proto integer; v_gh text; rel public.engine_releases%ROWTYPE; v_attempt integer;
  j jsonb := p_env -> 'job';
BEGIN
  IF session_user = 'platform_ops' OR acct IS NULL OR usr IS NULL OR NOT public.account_is_active(acct) OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'engine_update_issue: refused' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The key project removal and the engine session start take (projectRemoval.ts, engineSession.ts): a removal and an update of one repo never run side by side.
  PERFORM pg_advisory_xact_lock(hashtextextended('engine_session:' || acct::text || ':' || p_repo::text, 0));
  SELECT s.engine_version, pl.runner_id, rn.protocol_version, r.gh_repo_id::text INTO v_from, v_runner, v_proto, v_gh
    FROM public.project_setups s
    JOIN public.repos r ON r.account_id = s.account_id AND r.id = s.repo_id
    LEFT JOIN public.project_placements pl ON pl.account_id = s.account_id AND pl.repo_id = s.repo_id
    LEFT JOIN public.runners rn ON rn.account_id = pl.account_id AND rn.id = pl.runner_id AND rn.revoked_at IS NULL
   WHERE s.account_id = acct AND s.id = p_setup AND s.repo_id = p_repo AND s.phase = 'done';
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found', NULL::integer; RETURN; END IF;
  IF v_runner IS NULL OR v_proto IS NULL OR j #>> '{runner_id}' IS DISTINCT FROM v_runner::text THEN RETURN QUERY SELECT 'not_placed', NULL::integer; RETURN; END IF;
  IF EXISTS (SELECT 1 FROM public.engine_updates u WHERE u.account_id = acct AND u.repo_id = p_repo AND u.phase NOT IN ('done', 'failed')) THEN RETURN QUERY SELECT 'update_live', NULL::integer; RETURN; END IF;
  SELECT * INTO rel FROM public.engine_releases e
   WHERE e.withdrawn_at IS NULL AND e.min_runner_protocol <= v_proto AND e.version ~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$'
   ORDER BY e.published_at DESC, e.id DESC LIMIT 1;
  IF NOT FOUND OR v_from IS NULL OR v_from !~ '^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$' OR string_to_array(rel.version, '.')::int[] <= string_to_array(v_from, '.')::int[] THEN RETURN QUERY SELECT 'not_behind', NULL::integer; RETURN; END IF;
  IF j #>> '{kind}' IS DISTINCT FROM 'engine_update' OR j #>> '{job_id}' IS DISTINCT FROM p_job::text OR j #>> '{setup_id}' IS DISTINCT FROM p_setup::text OR j #>> '{repo_gh_id}' IS DISTINCT FROM v_gh OR j #>> '{requires_engine}' IS DISTINCT FROM 'any' THEN
    RAISE EXCEPTION 'engine_update_issue: not an engine_update job of this setup' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF j #>> '{args,branch}' IS DISTINCT FROM 'fx/engine-update-' || rel.version OR j #>> '{args,engine,version}' IS DISTINCT FROM rel.version OR j #>> '{args,engine,commit_sha}' IS DISTINCT FROM rel.commit_sha
     OR j #>> '{args,engine,tarball_sha256}' IS DISTINCT FROM rel.tarball_sha256 OR j #>> '{args,engine,tarball_url}' IS DISTINCT FROM 'https://codeload.github.com/fulcrumaxe/fulcrumaxe/tar.gz/' || rel.commit_sha THEN
    RETURN QUERY SELECT 'setup_changed', NULL::integer; RETURN;
  END IF;
  SELECT COALESCE(max(x.attempt), 0) + 1 INTO v_attempt FROM public.machine_jobs x WHERE x.account_id = acct AND x.setup_id = p_setup;
  IF EXISTS (SELECT 1 FROM public.machine_jobs x WHERE x.account_id = acct AND x.setup_id = p_setup AND x.state IN ('issued', 'delivered')) THEN RETURN QUERY SELECT 'update_live', NULL::integer; RETURN; END IF;
  INSERT INTO public.machine_jobs (id, account_id, runner_id, repo_id, setup_id, kind, job, attempt, issued_at, expires_at) VALUES (p_job, acct, v_runner, p_repo, p_setup, 'engine_update', p_env, v_attempt, p_issued_at, p_expires_at);
  INSERT INTO public.engine_updates (id, account_id, repo_id, setup_id, from_version, to_version, attempt, created_by) VALUES (p_id, acct, p_repo, p_setup, v_from, rel.version, v_attempt, usr);
  RETURN QUERY SELECT 'ok', v_attempt;
EXCEPTION WHEN unique_violation THEN
  RETURN QUERY SELECT 'update_live', NULL::integer;
END;
$$;

-- The job of this runner for this setup, locked, as an engine_update job whose update is at this attempt. o_result: ok, not_found, superseded, not_active.
CREATE FUNCTION engine_update_job_lock(p_setup uuid, p_job uuid, p_runner uuid)
RETURNS TABLE (o_result text, o_attempt integer, o_state text, o_last_seq integer, o_repo uuid)
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  j public.machine_jobs%ROWTYPE;
BEGIN
  SELECT * INTO j FROM public.machine_jobs x WHERE x.id = p_job AND x.account_id = acct AND x.runner_id = p_runner AND x.setup_id = p_setup AND x.kind = 'engine_update' FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found', NULL::integer, NULL::text, NULL::integer, NULL::uuid; RETURN; END IF;
  -- A removed (or never installed) project gets no step and no push grant.
  IF NOT EXISTS (SELECT 1 FROM public.project_setups s WHERE s.account_id = acct AND s.id = p_setup AND s.phase = 'done') THEN RETURN QUERY SELECT 'not_found', NULL::integer, NULL::text, NULL::integer, NULL::uuid; RETURN; END IF;
  IF j.state = 'superseded' OR EXISTS (SELECT 1 FROM public.machine_jobs n WHERE n.account_id = acct AND n.setup_id = p_setup AND n.attempt > j.attempt) THEN RETURN QUERY SELECT 'superseded', NULL::integer, NULL::text, NULL::integer, NULL::uuid; RETURN; END IF;
  -- 1053's lapse rule, read here because machine_job_expire is not this role's to run: a job that went quiet or ran over is over.
  IF j.state <> 'delivered' OR j.delivered_at <= now() - interval '3 hours' OR (j.last_seq IS NULL AND j.expires_at <= now()) OR (j.last_seq IS NOT NULL AND j.last_progress_at <= now() - interval '10 minutes') THEN RETURN QUERY SELECT 'not_active', NULL::integer, NULL::text, NULL::integer, NULL::uuid; RETURN; END IF;
  RETURN QUERY SELECT 'ok', j.attempt, j.state, j.last_seq, j.repo_id;
END;
$$;

CREATE FUNCTION engine_update_push_grant(p_setup uuid, p_job uuid) RETURNS TABLE (o_result text, o_repo_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  l record;
BEGIN
  SELECT * INTO l FROM public.engine_update_job_lock(p_setup, p_job, public.engine_update_runner());
  IF l.o_result <> 'ok' THEN RETURN QUERY SELECT l.o_result, NULL::uuid; RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.engine_updates u WHERE u.account_id = acct AND u.setup_id = p_setup AND u.attempt = l.o_attempt AND u.phase = 'push' AND u.sub_step = 'push' AND u.state = 'started') THEN RETURN QUERY SELECT 'not_ready', NULL::uuid; RETURN; END IF;
  IF EXISTS (SELECT 1 FROM public.machine_jobs x WHERE x.id = p_job AND x.account_id = acct AND x.push_token_at IS NOT NULL) THEN RETURN QUERY SELECT 'already_issued', NULL::uuid; RETURN; END IF;
  UPDATE public.machine_jobs SET push_token_at = now() WHERE id = p_job AND account_id = acct;
  RETURN QUERY SELECT 'ok', l.o_repo;
END;
$$;

CREATE FUNCTION engine_update_head_record(p_setup uuid, p_job uuid, p_head text) RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  l record;
BEGIN
  IF p_head IS NULL OR p_head !~ '^[0-9a-f]{40}$' THEN RETURN false; END IF;
  SELECT * INTO l FROM public.engine_update_job_lock(p_setup, p_job, public.engine_update_runner());
  IF l.o_result <> 'ok' THEN RETURN false; END IF;
  UPDATE public.engine_updates u SET head_sha = p_head, updated_at = now()
   WHERE u.account_id = acct AND u.setup_id = p_setup AND u.attempt = l.o_attempt AND u.phase = 'push' AND u.sub_step = 'push' AND u.state = 'ok' AND u.head_sha IS NULL;
  IF NOT FOUND THEN RETURN false; END IF;
  -- The runner's work is over once the head is recorded: end the job in this transaction, so it frees the machine's one delivered slot and machine_job_expire never fails a finished update.
  -- The update stays at phase push, state ok, for the step after it.
  UPDATE public.machine_jobs SET state = 'done', ended_at = now() WHERE id = p_job AND account_id = acct AND state = 'delivered';
  RETURN true;
END;
$$;

-- One report of the job (1053's rule for a setup): a failed step ends the job and the update; the update, not the installed setup, takes the step.
CREATE FUNCTION engine_update_progress_record(p_setup uuid, p_job uuid, p_seq integer, p_sub_step text, p_state text, p_code text, p_reason text) RETURNS TABLE (o_result text, o_repo_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_code text := CASE WHEN p_state = 'failed' THEN NULLIF(split_part(p_code, ':', 1), '') END;
  l record;
BEGIN
  IF p_seq IS NULL OR p_seq < 0 OR p_sub_step IS NULL OR p_sub_step !~ '^[a-z][a-z0-9_]{0,63}$' OR p_state IS NULL OR p_state NOT IN ('started', 'ok', 'failed', 'skipped') OR (p_state = 'failed' AND v_code IS NULL) THEN
    RAISE EXCEPTION 'engine_update_progress_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO l FROM public.engine_update_job_lock(p_setup, p_job, public.engine_update_runner());
  IF l.o_result <> 'ok' THEN RETURN QUERY SELECT l.o_result, NULL::uuid; RETURN; END IF;
  IF p_seq <= COALESCE(l.o_last_seq, -1) THEN RETURN QUERY SELECT 'seq', NULL::uuid; RETURN; END IF;
  UPDATE public.engine_updates u SET sub_step = p_sub_step, state = p_state, failure_code = v_code, failure_at = CASE WHEN v_code IS NULL THEN NULL ELSE now() END,
         phase = CASE WHEN p_state = 'failed' THEN 'failed' ELSE u.phase END, updated_at = now()
   WHERE u.account_id = acct AND u.setup_id = p_setup AND u.attempt = l.o_attempt AND u.phase = 'push';
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_active', NULL::uuid; RETURN; END IF;
  UPDATE public.machine_jobs SET last_seq = p_seq, last_progress_at = now(), state = CASE WHEN p_state = 'failed' THEN 'failed' ELSE state END, ended_at = CASE WHEN p_state = 'failed' THEN now() END WHERE id = p_job AND account_id = acct;
  RETURN QUERY SELECT 'ok', l.o_repo;
END;
$$;

REVOKE ALL ON FUNCTION engine_update_runner() FROM PUBLIC;
REVOKE ALL ON FUNCTION engine_update_job_lock(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION engine_update_issue(uuid, uuid, uuid, uuid, jsonb, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION engine_update_push_grant(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION engine_update_head_record(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION engine_update_progress_record(uuid, uuid, integer, text, text, text, text) FROM PUBLIC;
ALTER FUNCTION engine_update_runner() OWNER TO engine_update_definer;
ALTER FUNCTION engine_update_job_lock(uuid, uuid, uuid) OWNER TO engine_update_definer;
ALTER FUNCTION engine_update_issue(uuid, uuid, uuid, uuid, jsonb, timestamptz, timestamptz) OWNER TO engine_update_definer;
ALTER FUNCTION engine_update_push_grant(uuid, uuid) OWNER TO engine_update_definer;
ALTER FUNCTION engine_update_head_record(uuid, uuid, text) OWNER TO engine_update_definer;
ALTER FUNCTION engine_update_progress_record(uuid, uuid, integer, text, text, text, text) OWNER TO engine_update_definer;
GRANT EXECUTE ON FUNCTION engine_update_issue(uuid, uuid, uuid, uuid, jsonb, timestamptz, timestamptz) TO app_user;
GRANT EXECUTE ON FUNCTION engine_update_push_grant(uuid, uuid) TO app_user;
GRANT EXECUTE ON FUNCTION engine_update_head_record(uuid, uuid, text) TO app_user;
GRANT EXECUTE ON FUNCTION engine_update_progress_record(uuid, uuid, integer, text, text, text, text) TO app_user;
REVOKE CREATE ON SCHEMA public FROM engine_update_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE engine_update_definer FROM CURRENT_USER;
  END IF;
END
$$;

-- ---- machine_job_expire: 1066's body, but an engine_update job never fails the installed setup; it fails its update ---------------------------------------
DO $$
DECLARE
  super boolean := (SELECT rolsuper FROM pg_roles WHERE rolname = current_user);
BEGIN
  IF (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid = 'public.machine_job_expire(uuid)'::regprocedure) IS DISTINCT FROM 'machine_jobs_owner' THEN
    RAISE EXCEPTION 'machine_job_expire is not owned by machine_jobs_owner; this migration was written for 1066''s owner';
  END IF;
  IF NOT super THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'machine_jobs_owner'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on machine_jobs_owner; cannot replace machine_job_expire';
    END IF;
    GRANT machine_jobs_owner TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
  GRANT CREATE ON SCHEMA public TO machine_jobs_owner;
  GRANT SELECT (account_id, setup_id, attempt, phase) ON engine_updates TO machine_jobs_owner;
  GRANT UPDATE (phase, state, failure_code, failure_at, updated_at) ON engine_updates TO machine_jobs_owner;
  CREATE POLICY machine_jobs_owner_use ON engine_updates FOR ALL TO machine_jobs_owner
    USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

  CREATE OR REPLACE FUNCTION public.machine_job_expire(p_runner uuid) RETURNS void
  LANGUAGE sql
  VOLATILE
  SET search_path = pg_catalog, public, pg_temp
  AS $f$
    WITH ex AS (
      UPDATE public.machine_jobs
         SET state = 'expired', ended_at = now(),
             failure_code = CASE WHEN last_seq IS NULL THEN 'job_expired' WHEN delivered_at <= now() - interval '3 hours' THEN 'job_overran' ELSE 'job_silent' END
       WHERE account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND runner_id = p_runner AND state IN ('issued', 'delivered')
         AND ((last_seq IS NULL AND expires_at <= now()) OR (last_seq IS NOT NULL AND (delivered_at <= now() - interval '3 hours' OR last_progress_at <= now() - interval '10 minutes')))
      RETURNING setup_id, kind, attempt, failure_code AS code
    ), up AS (
      UPDATE public.engine_updates u SET phase = 'failed', state = 'failed', failure_code = ex.code, failure_at = now(), updated_at = now()
        FROM ex WHERE ex.kind = 'engine_update' AND u.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND u.setup_id = ex.setup_id AND u.attempt = ex.attempt AND u.phase = 'push'
    )
    UPDATE public.project_setups s SET state = 'failed', failure_code = ex.code, failure_reason = NULL, failure_at = now(), updated_at = now()
      FROM ex WHERE ex.kind <> 'engine_update' AND s.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND s.id = ex.setup_id;
  $f$;

  REVOKE CREATE ON SCHEMA public FROM machine_jobs_owner;
  IF NOT super THEN
    REVOKE machine_jobs_owner FROM CURRENT_USER;
  END IF;
END
$$;
