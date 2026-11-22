-- D#845 ON-8a: the machine job claim path and setup progress.
--
--   1. The closed capability list (the CHECK on runner_capabilities and runner_capabilities_record) takes the six capabilities of the machine work, from 1052's twenty: a hello that declares one must store.
--   2. project_setups.failure_reason (one closed word that refines failure_code, NULL unless a code is set) and the state 'skipped' (a coldstart step the engine left to the cloud; it counts as ok).
--   3. machine_jobs: one signed machine job per row, `id` the signed job_id. A job is issued, delivered to its runner once, and ends done, failed, expired or superseded (by a later attempt of the same setup).
--      The runner reads nothing of the table; the signed bytes leave it only through machine_job_deliver. At most one job is delivered to a runner at a time (a partial unique index).
--   4. Five functions owned by machine_jobs_owner (a new NOLOGIN role that can read no sealed credential), each pinned to the session's account, and, but for the issuer, to the session's runner: machine_job_issue (a tenant session, never a runner),
--      machine_job_pending (what waits for the runner), machine_job_deliver (hands one job over once) and setup_progress_record (the fence and the write of one progress report). A job past its life
--      is moved to expired by the next call of any of them, and its setup fails with job_expired: there is no cron. The two helpers (machine_job_runner, machine_job_expire) are not callable by app_user.
--
-- Numbered 1053 by the Team Lead; it merges after 1052 (#1176, which carries 1051's preflight_v1). Re-check against main right before merging and renumber to stay above its highest.

ALTER TABLE project_setups
  ADD COLUMN failure_reason text,
  ADD CONSTRAINT project_setups_failure_reason_check CHECK (failure_reason IS NULL OR (failure_code IS NOT NULL AND failure_reason ~ '^[a-z][a-z0-9_]{0,31}$')),
  DROP CONSTRAINT project_setups_state_check,
  ADD CONSTRAINT project_setups_state_check CHECK (state IN ('started', 'ok', 'failed', 'skipped'));

CREATE TABLE machine_jobs (
  id          uuid PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  runner_id   uuid NOT NULL,
  repo_id     uuid NOT NULL,
  setup_id    uuid,
  kind        text NOT NULL CONSTRAINT machine_jobs_kind_check CHECK (kind IN ('project_setup', 'engine_update', 'engine_session_start', 'engine_session_stop', 'engine_session_delete', 'project_remove')),
  job         jsonb NOT NULL CONSTRAINT machine_jobs_job_check CHECK (jsonb_typeof(job) = 'object' AND octet_length(job::text) <= 8192),
  attempt     integer NOT NULL DEFAULT 1 CONSTRAINT machine_jobs_attempt_check CHECK (attempt >= 1),
  state       text NOT NULL DEFAULT 'issued' CONSTRAINT machine_jobs_state_check CHECK (state IN ('issued', 'delivered', 'done', 'failed', 'expired', 'superseded')),
  last_seq    integer CONSTRAINT machine_jobs_seq_check CHECK (last_seq >= 0),
  issued_at   timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  delivered_at timestamptz,
  last_progress_at timestamptz,
  UNIQUE (account_id, id),
  FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, repo_id, setup_id) REFERENCES project_setups (account_id, repo_id, id) ON DELETE CASCADE,
  CONSTRAINT machine_jobs_life CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '30 minutes'),
  CONSTRAINT machine_jobs_delivered CHECK ((state = 'issued') = (delivered_at IS NULL) OR state IN ('expired', 'superseded')),
  -- The columns say what the signed bytes say (the ids, the kind, the runner, the setup and the life).
  CONSTRAINT machine_jobs_job_binds CHECK (COALESCE(job #>> '{job,job_id}' = id::text AND job #>> '{job,kind}' = kind AND job #>> '{job,runner_id}' = runner_id::text AND (job #>> '{job,setup_id}') IS NOT DISTINCT FROM setup_id::text
    AND (job #>> '{job,issued_at}')::timestamptz = issued_at AND (job #>> '{job,expires_at}')::timestamptz = expires_at, false))
);
CREATE UNIQUE INDEX machine_jobs_one_delivered ON machine_jobs (account_id, runner_id) WHERE state = 'delivered';
CREATE UNIQUE INDEX machine_jobs_setup_attempt ON machine_jobs (account_id, setup_id, attempt) WHERE setup_id IS NOT NULL;
CREATE INDEX machine_jobs_runner_issued ON machine_jobs (account_id, runner_id, issued_at, id) WHERE state = 'issued';

ALTER TABLE machine_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE machine_jobs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON machine_jobs FROM PUBLIC;
-- app_user reads the row's facts and never the signed bytes or the sequence; it writes nothing (the definers do).
GRANT SELECT (id, account_id, runner_id, repo_id, setup_id, kind, attempt, state, issued_at, expires_at, delivered_at) ON machine_jobs TO app_user;
CREATE POLICY tenant_isolation_select ON machine_jobs FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
    AND (NULLIF(current_setting('app.runner_id', true), '') IS NULL OR runner_id::text = lower(current_setting('app.runner_id', true)))
  );

-- The owner of the runner-session functions: NOLOGIN, a member of nothing, and with nothing but what the functions below read and write (not machine_ops, which reads sealed credential columns).
DO $$
DECLARE
  n text := 'machine_jobs_owner';
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

-- What the machine_jobs_owner functions read and write, by column, in the session's account. accounts: what account_is_active reads, for the session's own account only.
GRANT USAGE ON SCHEMA public TO machine_jobs_owner;
GRANT SELECT (id, deleted_at) ON accounts TO machine_jobs_owner;
CREATE POLICY machine_jobs_owner_use ON accounts FOR SELECT TO machine_jobs_owner USING (id = NULLIF(current_setting('app.account_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE ON machine_jobs TO machine_jobs_owner;
GRANT SELECT (id, account_id, repo_id), UPDATE (state, sub_step, failure_code, failure_reason, failure_at, updated_at) ON project_setups TO machine_jobs_owner;
GRANT SELECT (id, account_id, revoked_at) ON runners TO machine_jobs_owner;
CREATE POLICY machine_jobs_owner_use ON machine_jobs FOR ALL TO machine_jobs_owner
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY machine_jobs_owner_use ON project_setups FOR ALL TO machine_jobs_owner
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY machine_jobs_owner_use ON runners FOR SELECT TO machine_jobs_owner USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

-- ---- ownership: the migration role holds machine_jobs_owner only to hand the functions over (1035's shape) --------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'machine_jobs_owner'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on machine_jobs_owner; cannot ALTER FUNCTION ... OWNER TO machine_jobs_owner';
    END IF;
    GRANT machine_jobs_owner TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO machine_jobs_owner;

-- The runner of the session: a live runner of an active account, named by app.runner_id (set only by the signature-verifying middleware). Invoker rights; not callable by app_user.
CREATE FUNCTION machine_job_runner() RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  raw  text := COALESCE(current_setting('app.runner_id', true), '');
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'machine_job: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT public.account_is_active(acct) OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NOT EXISTS (SELECT 1 FROM public.runners r WHERE r.id = raw::uuid AND r.account_id = acct AND r.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'machine_job: the session is not a live runner of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN raw::uuid;
END;
$$;

-- A job of this runner that is over becomes expired, and its setup fails with the reason: job_expired (never taken, or taken and never reported, by `expires_at`), job_silent (it reported and then sent nothing for 10 minutes)
-- or job_overran (3 hours since delivery, the ceiling on a job that keeps reporting). A job that keeps reporting is not cut off at `expires_at`.
CREATE FUNCTION machine_job_expire(p_runner uuid) RETURNS void
LANGUAGE sql
VOLATILE
SET search_path = pg_catalog, public, pg_temp
AS $$
  WITH ex AS (
    UPDATE public.machine_jobs SET state = 'expired'
     WHERE account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND runner_id = p_runner AND state IN ('issued', 'delivered')
       AND ((last_seq IS NULL AND expires_at <= now()) OR (last_seq IS NOT NULL AND (delivered_at <= now() - interval '3 hours' OR last_progress_at <= now() - interval '10 minutes')))
    RETURNING setup_id, CASE WHEN last_seq IS NULL THEN 'job_expired' WHEN delivered_at <= now() - interval '3 hours' THEN 'job_overran' ELSE 'job_silent' END AS code
  )
  UPDATE public.project_setups s SET state = 'failed', failure_code = ex.code, failure_reason = NULL, failure_at = now(), updated_at = now()
    FROM ex WHERE s.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND s.id = ex.setup_id;
$$;

-- The cloud issues a job: a tenant session, never a runner's. The older jobs of the same setup are superseded and the attempt counts up. The columns are held to the signed bytes by the table's CHECK.
CREATE FUNCTION machine_job_issue(p_id uuid, p_runner uuid, p_repo uuid, p_setup uuid, p_kind text, p_job jsonb, p_issued_at timestamptz, p_expires_at timestamptz)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_attempt integer := 1;
BEGIN
  IF session_user = 'platform_ops' OR acct IS NULL OR NOT public.account_is_active(acct) OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL THEN
    RAISE EXCEPTION 'machine_job_issue: refused' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.runners r WHERE r.id = p_runner AND r.account_id = acct AND r.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'machine_job_issue: no such live runner' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_setup IS NOT NULL THEN
    UPDATE public.machine_jobs SET state = 'superseded' WHERE account_id = acct AND setup_id = p_setup AND state IN ('issued', 'delivered');
    SELECT COALESCE(max(attempt), 0) + 1 INTO v_attempt FROM public.machine_jobs WHERE account_id = acct AND setup_id = p_setup;
  END IF;
  INSERT INTO public.machine_jobs (id, account_id, runner_id, repo_id, setup_id, kind, job, attempt, issued_at, expires_at)
  VALUES (p_id, acct, p_runner, p_repo, p_setup, p_kind, p_job, v_attempt, p_issued_at, p_expires_at);
  RETURN v_attempt;
END;
$$;

-- What waits for the session's runner: its issued jobs that have not expired, oldest first, and nothing while it holds a delivered one.
CREATE FUNCTION machine_job_pending() RETURNS TABLE (o_id uuid, o_kind text, o_requires_engine text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  rid  uuid := public.machine_job_runner();
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
BEGIN
  PERFORM public.machine_job_expire(rid);
  IF EXISTS (SELECT 1 FROM public.machine_jobs j WHERE j.account_id = acct AND j.runner_id = rid AND j.state = 'delivered') THEN RETURN; END IF;
  RETURN QUERY SELECT j.id, j.kind, j.job #>> '{job,requires_engine}' FROM public.machine_jobs j WHERE j.account_id = acct AND j.runner_id = rid AND j.state = 'issued' ORDER BY j.issued_at, j.id LIMIT 20;
END;
$$;

-- Hands one job over, once: the signed bytes of an issued, unexpired job of this runner, and only while the runner holds no delivered one. NULL otherwise.
CREATE FUNCTION machine_job_deliver(p_id uuid) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  rid   uuid := public.machine_job_runner();
  acct  uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  v_job jsonb;
BEGIN
  PERFORM public.machine_job_expire(rid);
  IF EXISTS (SELECT 1 FROM public.machine_jobs j WHERE j.account_id = acct AND j.runner_id = rid AND j.state = 'delivered') THEN RETURN NULL; END IF;
  UPDATE public.machine_jobs j SET state = 'delivered', delivered_at = now()
   WHERE j.id = (SELECT x.id FROM public.machine_jobs x WHERE x.id = p_id AND x.account_id = acct AND x.runner_id = rid AND x.state = 'issued' AND x.expires_at > now() FOR UPDATE SKIP LOCKED)
  RETURNING j.job INTO v_job;
  RETURN v_job;
EXCEPTION WHEN unique_violation THEN
  RETURN NULL;
END;
$$;

-- One progress report. o_result: ok, not_found (no such job of this runner for this setup, and so every foreign id), superseded (a later attempt exists), not_active (the job is not delivered, or has ended or expired)
-- or seq (not above the last one). A failed step ends its job (failed) and so does the kind's last runner step reported ok (done; gh_labels for project_setup, none for the other kinds), which frees the runner's slot. A step that is not failed clears the setup's failure; skipped never stores one (the engine leaves a step to the cloud). The topic of `missing_topic:<id>` becomes the reason.
CREATE FUNCTION setup_progress_record(p_setup uuid, p_job uuid, p_seq integer, p_sub_step text, p_state text, p_code text, p_reason text)
RETURNS TABLE (o_result text, o_repo_id uuid)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  rid    uuid := public.machine_job_runner();
  acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  j      public.machine_jobs%ROWTYPE;
  v_code text := CASE WHEN p_state = 'failed' THEN NULLIF(split_part(p_code, ':', 1), '') END;
  v_reason text;
  v_repo uuid;
BEGIN
  IF p_seq IS NULL OR p_seq < 0 OR p_sub_step IS NULL OR p_sub_step !~ '^[a-z][a-z0-9_]{0,63}$' OR p_state IS NULL OR p_state NOT IN ('started', 'ok', 'failed', 'skipped') OR (p_state = 'failed' AND v_code IS NULL) THEN
    RAISE EXCEPTION 'setup_progress_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_reason := CASE WHEN v_code IS NULL THEN NULL ELSE COALESCE(NULLIF(split_part(p_code, ':', 2), ''), p_reason) END;
  PERFORM public.machine_job_expire(rid);
  SELECT * INTO j FROM public.machine_jobs x WHERE x.id = p_job AND x.account_id = acct AND x.runner_id = rid AND x.setup_id = p_setup FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT 'not_found', NULL::uuid; RETURN; END IF;
  IF j.state = 'superseded' OR EXISTS (SELECT 1 FROM public.machine_jobs n WHERE n.account_id = acct AND n.setup_id = p_setup AND n.attempt > j.attempt) THEN RETURN QUERY SELECT 'superseded', NULL::uuid; RETURN; END IF;
  IF j.state <> 'delivered' THEN RETURN QUERY SELECT 'not_active', NULL::uuid; RETURN; END IF;
  IF p_seq <= COALESCE(j.last_seq, -1) THEN RETURN QUERY SELECT 'seq', NULL::uuid; RETURN; END IF;
  UPDATE public.machine_jobs SET last_seq = p_seq, last_progress_at = now(), state = CASE WHEN p_state = 'failed' THEN 'failed' WHEN p_state = 'ok' AND p_sub_step = (CASE j.kind WHEN 'project_setup' THEN 'gh_labels' END) THEN 'done' ELSE state END WHERE id = j.id AND account_id = acct;
  UPDATE public.project_setups s
     SET sub_step = p_sub_step, state = p_state, failure_code = v_code, failure_reason = v_reason, failure_at = CASE WHEN v_code IS NULL THEN NULL ELSE now() END, updated_at = now()
   WHERE s.account_id = acct AND s.id = p_setup
  RETURNING s.repo_id INTO v_repo;
  RETURN QUERY SELECT 'ok'::text, v_repo;
END;
$$;

REVOKE ALL ON FUNCTION machine_job_runner() FROM PUBLIC;
REVOKE ALL ON FUNCTION machine_job_expire(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION machine_job_issue(uuid, uuid, uuid, uuid, text, jsonb, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION machine_job_pending() FROM PUBLIC;
REVOKE ALL ON FUNCTION machine_job_deliver(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION setup_progress_record(uuid, uuid, integer, text, text, text, text) FROM PUBLIC;
ALTER FUNCTION machine_job_runner() OWNER TO machine_jobs_owner;
ALTER FUNCTION machine_job_expire(uuid) OWNER TO machine_jobs_owner;
ALTER FUNCTION machine_job_issue(uuid, uuid, uuid, uuid, text, jsonb, timestamptz, timestamptz) OWNER TO machine_jobs_owner;
ALTER FUNCTION machine_job_pending() OWNER TO machine_jobs_owner;
ALTER FUNCTION machine_job_deliver(uuid) OWNER TO machine_jobs_owner;
ALTER FUNCTION setup_progress_record(uuid, uuid, integer, text, text, text, text) OWNER TO machine_jobs_owner;
-- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner).
GRANT EXECUTE ON FUNCTION machine_job_issue(uuid, uuid, uuid, uuid, text, jsonb, timestamptz, timestamptz) TO app_user;
GRANT EXECUTE ON FUNCTION machine_job_pending() TO app_user;
GRANT EXECUTE ON FUNCTION machine_job_deliver(uuid) TO app_user;
GRANT EXECUTE ON FUNCTION setup_progress_record(uuid, uuid, integer, text, text, text, text) TO app_user;

REVOKE CREATE ON SCHEMA public FROM machine_jobs_owner;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE machine_jobs_owner FROM CURRENT_USER;
  END IF;
END
$$;

-- ---- the capabilities: a hello that declares one of the six must store -------------------------------------------------------------------------------
-- The closed list and runner_capabilities_record widen by device_register_v1, project_setup_v1, survey_v1, engine_session_v1, machine_login_v1 and repo_token_refresh_v1, from 1052's twenty
-- (heartbeat_inventory_v1 last); everything else of the function is 1052's, verbatim (ownership: runner_capabilities_definer, taken for the replace and dropped).
ALTER TABLE runner_capabilities DROP CONSTRAINT runner_capabilities_values_check;
ALTER TABLE runner_capabilities ADD CONSTRAINT runner_capabilities_values_check
  CHECK (array_ndims(capabilities) IS NULL OR (array_ndims(capabilities) = 1 AND capabilities <@ ARRAY['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1', 'discovery_analyst', 'conflict_facts_v1', 'ordered_facts_v1', 'tip_publish_v1', 'mem_proposal_v1', 'browser_chrome_v1', 'deploy_order_v1', 'browser_playwright_v1', 'overlap_facts_v1', 'engine_bridge_v1', 'sandbox_commands_v1', 'watch_mode_v1', 'kvm_fact_v1', 'preflight_v1', 'heartbeat_inventory_v1', 'device_register_v1', 'project_setup_v1', 'survey_v1', 'engine_session_v1', 'machine_login_v1', 'repo_token_refresh_v1']::text[]));

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'runner_capabilities_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_capabilities_definer; cannot replace runner_capabilities_record';
    END IF;
    EXECUTE 'GRANT runner_capabilities_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION runner_capabilities_record(p_capabilities text[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  raw  text := COALESCE(current_setting('app.runner_id', true), '');
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'runner_capabilities_record: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A live runner of an active account, named by the session: no runner in the session, a revoked one or another account's one writes nothing.
  IF acct IS NULL OR NOT account_is_active(acct) OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR NOT EXISTS (SELECT 1 FROM public.runners r WHERE r.id = raw::uuid AND r.account_id = acct AND r.revoked_at IS NULL) THEN
    RAISE EXCEPTION 'runner_capabilities_record: the session is not a live runner of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Closed codes, each once, a flat list: anything else is refused, not repaired, so what is stored is exactly what was sent.
  IF p_capabilities IS NULL OR (cardinality(p_capabilities) > 0 AND array_ndims(p_capabilities) <> 1)
     OR EXISTS (SELECT 1 FROM unnest(p_capabilities) c WHERE c IS NULL OR c <> ALL (ARRAY['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1', 'discovery_analyst', 'conflict_facts_v1', 'ordered_facts_v1', 'tip_publish_v1', 'mem_proposal_v1', 'browser_chrome_v1', 'deploy_order_v1', 'browser_playwright_v1', 'overlap_facts_v1', 'engine_bridge_v1', 'sandbox_commands_v1', 'watch_mode_v1', 'kvm_fact_v1', 'preflight_v1', 'heartbeat_inventory_v1', 'device_register_v1', 'project_setup_v1', 'survey_v1', 'engine_session_v1', 'machine_login_v1', 'repo_token_refresh_v1']))
     OR (SELECT count(*) <> count(DISTINCT c) FROM unnest(p_capabilities) c) THEN
    RAISE EXCEPTION 'runner_capabilities_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO public.runner_capabilities AS c (runner_id, account_id, capabilities)
  VALUES (raw::uuid, acct, p_capabilities)
  ON CONFLICT (runner_id) DO UPDATE SET capabilities = EXCLUDED.capabilities, reported_at = now();
END;
$$;
REVOKE ALL ON FUNCTION runner_capabilities_record(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_capabilities_record(text[]) TO app_user;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    EXECUTE 'REVOKE runner_capabilities_definer FROM CURRENT_USER';
  END IF;
END
$$;
