-- D#845 ON-27b: the private twin's seed, the first copy of a public repo's default branch into its empty private repository.
--
--   1. machine_jobs_kind_check takes 'twin_seed' (1053's list, nothing dropped). A twin_seed job is bound to the twin's own repository and setup, and rides 1053's claim and 1071's progress and push-token routes, with its own definers
--      chosen by the job's kind (the same way 1093 chose an engine_update's).
--   2. runner_capabilities_values_check and runner_capabilities_record take 'twin_v1' (1096's list, nothing dropped, 'twin_v1' last). Everything else of the function is 1096's, which is 1053's.
--   3. twin_seed_issue (a person: owner or admin), twin_seed_job_lock (helper, not callable by app_user), twin_seed_push_grant, twin_seed_head_record, twin_seed_progress_record (the runner's own session) and twin_seed_check (the cloud's
--      check once the seed's job is done). All are owned by machine_jobs_owner, SECURITY DEFINER (but the helper), EXECUTE for app_user alone. machine_job_expire is 1093's with one change: a quiet twin_seed job fails its twin, not the setup.
--
-- Numbered 1108 by the Team Lead. The rulings call it 1080, which is taken. Re-check against main right before merging and renumber to stay above its highest, and carry any capability or kind a lower migration added.

-- ---- 1. the kind -----------------------------------------------------------------------------------------------------------------------------------
ALTER TABLE machine_jobs DROP CONSTRAINT machine_jobs_kind_check;
ALTER TABLE machine_jobs ADD CONSTRAINT machine_jobs_kind_check
  CHECK (kind IN ('project_setup', 'engine_update', 'engine_session_start', 'engine_session_stop', 'engine_session_delete', 'project_remove', 'twin_seed'));

-- ---- the capability: a hello that declares 'twin_v1' must store ---------------------------------------------------------------------------
-- ownership: runner_capabilities_definer, taken for the replace and dropped (1053's bracket).
ALTER TABLE runner_capabilities DROP CONSTRAINT runner_capabilities_values_check;
ALTER TABLE runner_capabilities ADD CONSTRAINT runner_capabilities_values_check
  CHECK (array_ndims(capabilities) IS NULL OR (array_ndims(capabilities) = 1 AND capabilities <@ ARRAY['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1', 'discovery_analyst', 'conflict_facts_v1', 'ordered_facts_v1', 'tip_publish_v1', 'mem_proposal_v1', 'browser_chrome_v1', 'deploy_order_v1', 'browser_playwright_v1', 'overlap_facts_v1', 'engine_bridge_v1', 'sandbox_commands_v1', 'watch_mode_v1', 'kvm_fact_v1', 'preflight_v1', 'heartbeat_inventory_v1', 'device_register_v1', 'project_setup_v1', 'survey_v1', 'engine_session_v1', 'machine_login_v1', 'repo_token_refresh_v1', 'engine_lease_v1', 'survey_public_v1', 'twin_v1']::text[]));

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
     OR EXISTS (SELECT 1 FROM unnest(p_capabilities) c WHERE c IS NULL OR c <> ALL (ARRAY['proposal_verifier', 'wake_v1', 'plane_merge_v1', 'memory_limit_v1', 'plane_merge_queue_v1', 'discovery_analyst', 'conflict_facts_v1', 'ordered_facts_v1', 'tip_publish_v1', 'mem_proposal_v1', 'browser_chrome_v1', 'deploy_order_v1', 'browser_playwright_v1', 'overlap_facts_v1', 'engine_bridge_v1', 'sandbox_commands_v1', 'watch_mode_v1', 'kvm_fact_v1', 'preflight_v1', 'heartbeat_inventory_v1', 'device_register_v1', 'project_setup_v1', 'survey_v1', 'engine_session_v1', 'machine_login_v1', 'repo_token_refresh_v1', 'engine_lease_v1', 'survey_public_v1', 'twin_v1']))
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

-- ---- 3. the twin's seed: grants, then the functions --------------------------------------------------------------------------------------------------
-- Owner: machine_jobs_owner (1053), as 1071 and 1082 did. It gets what the functions below read and write on the twin and its two repositories, by column and by row policy for the session's account.
-- ALTER TABLE ... is done by the migration role; the functions are created and handed over inside the bracket of 1071.
DO $$
DECLARE
  owner_name text := (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid = 'public.setup_progress_record(uuid, uuid, integer, text, text, text, text)'::regprocedure);
  super boolean := (SELECT rolsuper FROM pg_roles WHERE rolname = current_user);
BEGIN
  IF owner_name IS DISTINCT FROM 'machine_jobs_owner' THEN
    RAISE EXCEPTION 'setup_progress_record is owned by %, not machine_jobs_owner', owner_name;
  END IF;
  IF NOT super THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = owner_name::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot create the twin seed functions', owner_name;
    END IF;
    EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', owner_name);
  END IF;
  EXECUTE format('GRANT CREATE ON SCHEMA public TO %I', owner_name);
  EXECUTE format('GRANT SELECT (gh_owner, gh_name) ON repos TO %I', owner_name);
  EXECUTE format('GRANT SELECT (id, account_id, public_repo_id, private_repo_id, state, published_private_sha) ON repo_twins TO %I', owner_name);
  EXECUTE format('GRANT UPDATE (state, published_private_sha, synced_public_sha, failure_code, failure_reason, failure_at, updated_at) ON repo_twins TO %I', owner_name);
  EXECUTE format('CREATE POLICY machine_jobs_owner_use ON repo_twins FOR ALL TO %I USING (account_id = NULLIF(current_setting(''app.account_id'', true), '''')::uuid) WITH CHECK (account_id = NULLIF(current_setting(''app.account_id'', true), '''')::uuid)', owner_name);

  -- The person's issue (the same gate as engine_update_issue): an owner or admin of the session's active account, never a runner's or platform_ops's session. The signed bytes are held to the rows: the twin is the
  -- job's one target (`repo_gh_id` and `args.private` are the twin's repository; a job naming the public repository for either is refused), the setup and the machine are the twin's own, and nothing else may be live.
  -- o_result: ok | not_found | bad_state (not seeding or failed, or already seeded) | repo_unnamed | no_setup | not_placed | job_live.
  CREATE FUNCTION public.twin_seed_issue(p_twin uuid, p_job uuid, p_env jsonb, p_issued_at timestamptz, p_expires_at timestamptz) RETURNS TABLE (o_result text, o_attempt integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
    j    jsonb := p_env -> 'job';
    t    record;
    pub  record;
    prv  record;
    v_setup uuid;
    v_runner uuid;
    v_attempt integer;
  BEGIN
    IF session_user = 'platform_ops' OR acct IS NULL OR usr IS NULL OR NOT public.account_is_active(acct) OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin')) THEN
      RAISE EXCEPTION 'twin_seed_issue: refused' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT x.id, x.public_repo_id, x.private_repo_id, x.state, x.published_private_sha INTO t FROM public.repo_twins x WHERE x.id = p_twin AND x.account_id = acct FOR UPDATE;
    IF NOT FOUND THEN RETURN QUERY SELECT 'not_found', NULL::integer; RETURN; END IF;
    IF t.state NOT IN ('seeding', 'failed') OR t.private_repo_id IS NULL OR t.published_private_sha IS NOT NULL THEN RETURN QUERY SELECT 'bad_state', NULL::integer; RETURN; END IF;
    SELECT r.gh_repo_id::text AS gid, r.gh_owner AS o, r.gh_name AS n INTO pub FROM public.repos r WHERE r.account_id = acct AND r.id = t.public_repo_id;
    SELECT r.gh_repo_id::text AS gid, r.gh_owner AS o, r.gh_name AS n INTO prv FROM public.repos r WHERE r.account_id = acct AND r.id = t.private_repo_id;
    IF pub.o IS NULL OR pub.n IS NULL OR prv.o IS NULL OR prv.n IS NULL THEN RETURN QUERY SELECT 'repo_unnamed', NULL::integer; RETURN; END IF;
    -- The twin's own live setup (the machine step made it) and the live machine it is placed on.
    SELECT s.id INTO v_setup FROM public.project_setups s WHERE s.account_id = acct AND s.repo_id = t.private_repo_id AND s.phase = 'survey';
    IF v_setup IS NULL THEN RETURN QUERY SELECT 'no_setup', NULL::integer; RETURN; END IF;
    SELECT pl.runner_id INTO v_runner FROM public.project_placements pl JOIN public.runners rn ON rn.account_id = pl.account_id AND rn.id = pl.runner_id AND rn.revoked_at IS NULL WHERE pl.account_id = acct AND pl.repo_id = t.private_repo_id;
    IF v_runner IS NULL THEN RETURN QUERY SELECT 'not_placed', NULL::integer; RETURN; END IF;
    -- Live: still issued or running, or finished and waiting for the cloud's check (a second copy would find the twin not empty).
    IF EXISTS (SELECT 1 FROM public.machine_jobs x WHERE x.account_id = acct AND x.setup_id = v_setup AND (x.state IN ('issued', 'delivered') OR (x.kind = 'twin_seed' AND x.state = 'done' AND t.state = 'seeding'))) THEN RETURN QUERY SELECT 'job_live', NULL::integer; RETURN; END IF;
    IF j #>> '{kind}' IS DISTINCT FROM 'twin_seed' OR j #>> '{job_id}' IS DISTINCT FROM p_job::text OR j #>> '{runner_id}' IS DISTINCT FROM v_runner::text OR j #>> '{setup_id}' IS DISTINCT FROM v_setup::text
       OR j #>> '{requires_engine}' IS DISTINCT FROM 'any' OR j #>> '{repo_gh_id}' IS DISTINCT FROM prv.gid OR j #>> '{args,twin_id}' IS DISTINCT FROM p_twin::text
       OR j #>> '{args,private,gh_id}' IS DISTINCT FROM prv.gid OR j #>> '{args,private,owner}' IS DISTINCT FROM prv.o OR j #>> '{args,private,name}' IS DISTINCT FROM prv.n
       OR j #>> '{args,public,gh_id}' IS DISTINCT FROM pub.gid OR j #>> '{args,public,owner}' IS DISTINCT FROM pub.o OR j #>> '{args,public,name}' IS DISTINCT FROM pub.n
       OR j #>> '{args,public,head_sha}' !~ '^[0-9a-f]{40}$' OR prv.gid = pub.gid THEN
      RAISE EXCEPTION 'twin_seed_issue: not a twin_seed job of this twin' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT COALESCE(max(x.attempt), 0) + 1 INTO v_attempt FROM public.machine_jobs x WHERE x.account_id = acct AND x.setup_id = v_setup;
    INSERT INTO public.machine_jobs (id, account_id, runner_id, repo_id, setup_id, kind, job, attempt, issued_at, expires_at) VALUES (p_job, acct, v_runner, t.private_repo_id, v_setup, 'twin_seed', p_env, v_attempt, p_issued_at, p_expires_at);
    UPDATE public.repo_twins SET state = 'seeding', failure_code = NULL, failure_reason = NULL, failure_at = NULL, updated_at = now() WHERE id = t.id AND account_id = acct;
    RETURN QUERY SELECT 'ok', v_attempt;
  END;
  $f$;

  -- The runner's job, locked: this runner's own delivered, current twin_seed job of this setup, whose twin is still seeding the repository the job names. Not callable by app_user (the three functions below call it).
  -- o_result: ok | not_found | superseded | not_active (1093's lapse rule).
  CREATE FUNCTION public.twin_seed_job_lock(p_setup uuid, p_job uuid) RETURNS TABLE (o_result text, o_attempt integer, o_last_seq integer, o_repo uuid, o_twin uuid, o_pushed boolean)
  LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    j public.machine_jobs%ROWTYPE;
    v_twin uuid;
  BEGIN
    SELECT * INTO j FROM public.machine_jobs x WHERE x.id = p_job AND x.account_id = acct AND x.runner_id = public.machine_job_runner() AND x.setup_id = p_setup AND x.kind = 'twin_seed' FOR UPDATE;
    IF NOT FOUND THEN RETURN QUERY SELECT 'not_found', NULL::integer, NULL::integer, NULL::uuid, NULL::uuid, NULL::boolean; RETURN; END IF;
    SELECT t.id INTO v_twin FROM public.repo_twins t WHERE t.account_id = acct AND t.id::text = j.job #>> '{job,args,twin_id}' AND t.private_repo_id = j.repo_id AND t.state = 'seeding';
    IF v_twin IS NULL OR NOT EXISTS (SELECT 1 FROM public.project_setups s WHERE s.account_id = acct AND s.id = p_setup AND s.phase = 'survey') THEN RETURN QUERY SELECT 'not_found', NULL::integer, NULL::integer, NULL::uuid, NULL::uuid, NULL::boolean; RETURN; END IF;
    IF j.state = 'superseded' OR EXISTS (SELECT 1 FROM public.machine_jobs n WHERE n.account_id = acct AND n.setup_id = p_setup AND n.attempt > j.attempt) THEN RETURN QUERY SELECT 'superseded', NULL::integer, NULL::integer, NULL::uuid, NULL::uuid, NULL::boolean; RETURN; END IF;
    IF j.state <> 'delivered' OR j.delivered_at <= now() - interval '3 hours' OR (j.last_seq IS NULL AND j.expires_at <= now()) OR (j.last_seq IS NOT NULL AND j.last_progress_at <= now() - interval '10 minutes') THEN
      RETURN QUERY SELECT 'not_active', NULL::integer, NULL::integer, NULL::uuid, NULL::uuid, NULL::boolean; RETURN;
    END IF;
    RETURN QUERY SELECT 'ok', j.attempt, j.last_seq, j.repo_id, v_twin, j.push_token_at IS NOT NULL;
  END;
  $f$;

  -- The push credential's fence (1071's, for a twin): once per job, only after the runner reported its fetch (started, ok) and the push step started, so seq 2 or later. The repository is the job's own, which is the twin's.
  CREATE FUNCTION public.twin_seed_push_grant(p_setup uuid, p_job uuid) RETURNS TABLE (o_result text, o_repo_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    l record;
  BEGIN
    SELECT * INTO l FROM public.twin_seed_job_lock(p_setup, p_job);
    IF l.o_result <> 'ok' THEN RETURN QUERY SELECT l.o_result, NULL::uuid; RETURN; END IF;
    IF COALESCE(l.o_last_seq, -1) < 2 THEN RETURN QUERY SELECT 'not_ready', NULL::uuid; RETURN; END IF;
    IF l.o_pushed THEN RETURN QUERY SELECT 'already_issued', NULL::uuid; RETURN; END IF;
    UPDATE public.machine_jobs SET push_token_at = now() WHERE id = p_job AND account_id = acct;
    RETURN QUERY SELECT 'ok', l.o_repo;
  END;
  $f$;

  -- The pushed commit, in the transaction of the `push ok` report: it must be the commit the job signed (the seed pushes exactly that one) and a credential must have been handed out. It ends the job.
  CREATE FUNCTION public.twin_seed_head_record(p_setup uuid, p_job uuid, p_head text) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    l record;
  BEGIN
    IF p_head IS NULL OR p_head !~ '^[0-9a-f]{40}$' THEN RETURN false; END IF;
    SELECT * INTO l FROM public.twin_seed_job_lock(p_setup, p_job);
    IF l.o_result <> 'ok' OR NOT l.o_pushed THEN RETURN false; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.machine_jobs x WHERE x.id = p_job AND x.account_id = acct AND x.job #>> '{job,args,public,head_sha}' = p_head) THEN RETURN false; END IF;
    UPDATE public.machine_jobs SET state = 'done', ended_at = now() WHERE id = p_job AND account_id = acct AND state = 'delivered';
    RETURN FOUND;
  END;
  $f$;

  -- One report of the job (1053's rule for a setup, 1093's shape): the twin, never the setup, takes a failure. A failed step ends the job and fails the twin with its code (the card says why); the code is one of the seed's own.
  CREATE FUNCTION public.twin_seed_progress_record(p_setup uuid, p_job uuid, p_seq integer, p_sub_step text, p_state text, p_code text, p_reason text) RETURNS TABLE (o_result text, o_repo_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    v_code text := CASE WHEN p_state = 'failed' THEN NULLIF(split_part(p_code, ':', 1), '') END;
    l record;
  BEGIN
    IF p_seq IS NULL OR p_seq < 0 OR p_sub_step IS NULL OR p_sub_step !~ '^[a-z][a-z0-9_]{0,63}$' OR p_state IS NULL OR p_state NOT IN ('started', 'ok', 'failed', 'skipped')
       OR (p_state = 'failed') IS DISTINCT FROM (v_code IS NOT NULL)
       OR (v_code IS NOT NULL AND v_code NOT IN ('twin_head_moved', 'twin_too_large', 'twin_not_empty', 'twin_fetch_failed', 'push_failed', 'kind_unsupported', 'engine_unsupported'))
       OR (p_reason IS NOT NULL AND (v_code IS NULL OR p_reason !~ '^[a-z][a-z0-9_]{0,31}$')) THEN
      RAISE EXCEPTION 'twin_seed_progress_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT * INTO l FROM public.twin_seed_job_lock(p_setup, p_job);
    IF l.o_result <> 'ok' THEN RETURN QUERY SELECT l.o_result, NULL::uuid; RETURN; END IF;
    IF p_seq <= COALESCE(l.o_last_seq, -1) THEN RETURN QUERY SELECT 'seq', NULL::uuid; RETURN; END IF;
    UPDATE public.machine_jobs SET last_seq = p_seq, last_progress_at = now(), state = CASE WHEN p_state = 'failed' THEN 'failed' ELSE state END, ended_at = CASE WHEN p_state = 'failed' THEN now() END WHERE id = p_job AND account_id = acct;
    IF p_state = 'failed' THEN
      UPDATE public.repo_twins SET state = 'failed', failure_code = v_code, failure_reason = p_reason, failure_at = now(), updated_at = now() WHERE id = l.o_twin AND account_id = acct;
    END IF;
    RETURN QUERY SELECT 'ok', l.o_repo;
  END;
  $f$;

  -- The cloud's check of the seed (4.2): the caller read the twin's default-branch tip through the App and passes it (NULL when the branch has none). A finished seed job of this twin whose signed head equals the tip makes the twin
  -- ready, with both anchors at that head; any other tip fails the twin and the seed is not trusted. A caller with a person must be an owner or admin; the repo sync's and the reconcile tick's sessions have none.
  -- o_result: ready | failed | not_found | not_ready (the twin is not seeding, or no seed job of it has finished).
  CREATE FUNCTION public.twin_seed_check(p_twin uuid, p_tip text) RETURNS TABLE (o_result text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
    t    record;
    v_head text;
    v_state text;
  BEGIN
    IF session_user = 'platform_ops' OR acct IS NULL OR NOT public.account_is_active(acct) OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL
       OR (usr IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin'))) THEN
      RAISE EXCEPTION 'twin_seed_check: refused' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_tip IS NOT NULL AND p_tip !~ '^[0-9a-f]{40}$' THEN RAISE EXCEPTION 'twin_seed_check: invalid argument' USING ERRCODE = 'invalid_parameter_value'; END IF;
    SELECT x.id, x.public_repo_id, x.private_repo_id, x.state, x.published_private_sha INTO t FROM public.repo_twins x WHERE x.id = p_twin AND x.account_id = acct FOR UPDATE;
    IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'; RETURN; END IF;
    IF t.state <> 'seeding' OR t.private_repo_id IS NULL THEN RETURN QUERY SELECT 'not_ready'; RETURN; END IF;
    SELECT x.job #>> '{job,args,public,head_sha}', x.state INTO v_head, v_state FROM public.machine_jobs x
     WHERE x.account_id = acct AND x.kind = 'twin_seed' AND x.repo_id = t.private_repo_id AND x.job #>> '{job,args,twin_id}' = p_twin::text ORDER BY x.attempt DESC LIMIT 1;
    IF v_head IS NULL OR v_state <> 'done' THEN RETURN QUERY SELECT 'not_ready'; RETURN; END IF;
    IF p_tip = v_head THEN
      UPDATE public.repo_twins SET state = 'ready', published_private_sha = v_head, synced_public_sha = v_head, failure_code = NULL, failure_reason = NULL, failure_at = NULL, updated_at = now() WHERE id = t.id AND account_id = acct;
      RETURN QUERY SELECT 'ready'; RETURN;
    END IF;
    UPDATE public.repo_twins SET state = 'failed', failure_code = CASE WHEN p_tip IS NULL THEN 'push_failed' ELSE 'twin_head_moved' END, failure_at = now(), updated_at = now() WHERE id = t.id AND account_id = acct;
    RETURN QUERY SELECT 'failed';
  END;
  $f$;

  REVOKE ALL ON FUNCTION public.twin_seed_issue(uuid, uuid, jsonb, timestamptz, timestamptz) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.twin_seed_job_lock(uuid, uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.twin_seed_push_grant(uuid, uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.twin_seed_head_record(uuid, uuid, text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.twin_seed_progress_record(uuid, uuid, integer, text, text, text, text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.twin_seed_check(uuid, text) FROM PUBLIC;
  EXECUTE format('ALTER FUNCTION public.twin_seed_issue(uuid, uuid, jsonb, timestamptz, timestamptz) OWNER TO %I', owner_name);
  EXECUTE format('ALTER FUNCTION public.twin_seed_job_lock(uuid, uuid) OWNER TO %I', owner_name);
  EXECUTE format('ALTER FUNCTION public.twin_seed_push_grant(uuid, uuid) OWNER TO %I', owner_name);
  EXECUTE format('ALTER FUNCTION public.twin_seed_head_record(uuid, uuid, text) OWNER TO %I', owner_name);
  EXECUTE format('ALTER FUNCTION public.twin_seed_progress_record(uuid, uuid, integer, text, text, text, text) OWNER TO %I', owner_name);
  EXECUTE format('ALTER FUNCTION public.twin_seed_check(uuid, text) OWNER TO %I', owner_name);
  GRANT EXECUTE ON FUNCTION public.twin_seed_issue(uuid, uuid, jsonb, timestamptz, timestamptz) TO app_user;
  GRANT EXECUTE ON FUNCTION public.twin_seed_push_grant(uuid, uuid) TO app_user;
  GRANT EXECUTE ON FUNCTION public.twin_seed_head_record(uuid, uuid, text) TO app_user;
  GRANT EXECUTE ON FUNCTION public.twin_seed_progress_record(uuid, uuid, integer, text, text, text, text) TO app_user;
  GRANT EXECUTE ON FUNCTION public.twin_seed_check(uuid, text) TO app_user;

  -- 1093's machine_job_expire, with one change: a twin_seed job that went quiet fails its twin (with job_expired, job_silent or job_overran), never the twin's setup, which is still waiting for its survey.
  CREATE OR REPLACE FUNCTION public.machine_job_expire(p_runner uuid) RETURNS void
  LANGUAGE sql
  VOLATILE
  SET search_path = pg_catalog, public, pg_temp
  AS $e$
    WITH ex AS (
      UPDATE public.machine_jobs
         SET state = 'expired', ended_at = now(),
             failure_code = CASE WHEN last_seq IS NULL THEN 'job_expired' WHEN delivered_at <= now() - interval '3 hours' THEN 'job_overran' ELSE 'job_silent' END
       WHERE account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND runner_id = p_runner AND state IN ('issued', 'delivered')
         AND ((last_seq IS NULL AND expires_at <= now()) OR (last_seq IS NOT NULL AND (delivered_at <= now() - interval '3 hours' OR last_progress_at <= now() - interval '10 minutes')))
      RETURNING setup_id, kind, attempt, repo_id, failure_code AS code
    ), up AS (
      UPDATE public.engine_updates u SET phase = 'failed', state = 'failed', failure_code = ex.code, failure_at = now(), updated_at = now()
        FROM ex WHERE ex.kind = 'engine_update' AND u.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND u.setup_id = ex.setup_id AND u.attempt = ex.attempt AND u.phase = 'push'
    ), tw AS (
      UPDATE public.repo_twins w SET state = 'failed', failure_code = ex.code, failure_reason = NULL, failure_at = now(), updated_at = now()
        FROM ex WHERE ex.kind = 'twin_seed' AND w.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND w.private_repo_id = ex.repo_id AND w.state = 'seeding'
    )
    UPDATE public.project_setups s SET state = 'failed', failure_code = ex.code, failure_reason = NULL, failure_at = now(), updated_at = now()
      FROM ex WHERE ex.kind NOT IN ('engine_update', 'twin_seed') AND s.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND s.id = ex.setup_id;
  $e$;

  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', owner_name);
  IF NOT super THEN
    EXECUTE format('REVOKE %I FROM CURRENT_USER', owner_name);
  END IF;
END
$$;
