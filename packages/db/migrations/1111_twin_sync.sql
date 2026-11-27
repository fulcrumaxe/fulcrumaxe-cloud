-- D#845 ON-27d2: the private twin's sync, the public repository's changes coming into the twin as one commit on the twin's tip, pushed to a branch of the twin.
--
--   1. machine_jobs_kind_check takes 'twin_sync' (1110's list, which is 1108's, nothing dropped). The capability CHECK and runner_capabilities_record are 1108's and are not touched: 'twin_v1' is already in both, and a sync needs
--      no capability of its own. repo_twins gains sync_head (the commit the runner pushed, until the cloud has verified it and the sync pull request is recorded or closed) and sync_verified_at (when the cloud verified it).
--   2. twin_sync_issue (the person's session or the reconcile tick's, which has none), twin_sync_job_lock (helper, not callable by app_user), twin_sync_push_grant (once per job, and only while the live private set still equals the
--      signed one: the token is the TWIN's alone), twin_sync_head_record (ends the job), twin_sync_progress_record (the runner's own session), twin_sync_to_verify and twin_sync_check (the cloud's check of what the runner says it
--      pushed). All owned by machine_jobs_owner, SECURITY DEFINER (but the helper), EXECUTE for app_user alone.
--   3. machine_job_expire is 1110's with one change: a quiet twin_sync job fails neither the twin nor its setup; the twin stays ready and the next pass issues again.
--
-- Numbered 1111 by the Team Lead. Re-check against main right before merging and renumber to stay above its highest, and carry any kind or capability a lower migration added.

-- ---- 1. the kind and the columns -------------------------------------------------------------------------------------------------------------------------
ALTER TABLE machine_jobs DROP CONSTRAINT machine_jobs_kind_check;
ALTER TABLE machine_jobs ADD CONSTRAINT machine_jobs_kind_check
  CHECK (kind IN ('project_setup', 'engine_update', 'engine_session_start', 'engine_session_stop', 'engine_session_delete', 'project_remove', 'twin_seed', 'twin_publish', 'twin_sync'));

ALTER TABLE repo_twins ADD COLUMN sync_head text CONSTRAINT repo_twins_sync_head_check CHECK (sync_head ~ '^[0-9a-f]{40}$');
ALTER TABLE repo_twins ADD COLUMN sync_verified_at timestamptz;
ALTER TABLE repo_twins ADD CONSTRAINT repo_twins_sync_verified_check CHECK (sync_verified_at IS NULL OR sync_head IS NOT NULL);

-- ---- 2. grants, then the functions ---------------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
  owner_name text := (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p WHERE p.oid = 'public.twin_publish_issue(uuid, uuid, jsonb, timestamptz, timestamptz)'::regprocedure);
  super boolean := (SELECT rolsuper FROM pg_roles WHERE rolname = current_user);
BEGIN
  IF owner_name IS DISTINCT FROM 'machine_jobs_owner' THEN
    RAISE EXCEPTION 'twin_publish_issue is owned by %, not machine_jobs_owner', owner_name;
  END IF;
  IF NOT super THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = owner_name::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot create the twin sync functions', owner_name;
    END IF;
    EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', owner_name);
  END IF;
  EXECUTE format('GRANT CREATE ON SCHEMA public TO %I', owner_name);
  EXECUTE format('GRANT SELECT (synced_public_sha, sync_pr, sync_head, sync_verified_at) ON repo_twins TO %I', owner_name);
  EXECUTE format('GRANT UPDATE (sync_head, sync_verified_at) ON repo_twins TO %I', owner_name);

  -- The cloud's issue. An owner or admin on a session, or the reconcile tick's session (no person, no runner): never a runner's, never platform_ops's. The signed bytes are held to the rows: the twin's private repository is the job's
  -- home (`repo_gh_id` and `args.private`) and the only repository a token is ever minted for, the public repository is read and a different one, the machine and setup are the twin's own, the branch is named from the public tip,
  -- the paths are 1 to 200 distinct plain repository paths, and the private set is exactly the live one. Nothing else of the twin or its repository may be live, and no sync pull request of ours is open or waiting to be checked.
  -- o_result: ok | in_sync (the signed public tip is the one already synced) | not_found | bad_state (not ready, or never seeded) | sync_open | repo_unnamed | no_setup | not_placed | job_live.
  CREATE FUNCTION public.twin_sync_issue(p_twin uuid, p_job uuid, p_env jsonb, p_issued_at timestamptz, p_expires_at timestamptz) RETURNS TABLE (o_result text, o_attempt integer)
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
    IF session_user = 'platform_ops' OR acct IS NULL OR NOT public.account_is_active(acct) OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL
       OR (usr IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin'))) THEN
      RAISE EXCEPTION 'twin_sync_issue: refused' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT x.id, x.public_repo_id, x.private_repo_id, x.state, x.synced_public_sha, x.sync_pr, x.sync_head, x.overlay_globs, x.install_paths, x.binary_globs, x.identifier_rules_path, x.plan_data_rules_path
      INTO t FROM public.repo_twins x WHERE x.id = p_twin AND x.account_id = acct FOR UPDATE;
    IF NOT FOUND THEN RETURN QUERY SELECT 'not_found', NULL::integer; RETURN; END IF;
    IF t.state <> 'ready' OR t.private_repo_id IS NULL OR t.synced_public_sha IS NULL THEN RETURN QUERY SELECT 'bad_state', NULL::integer; RETURN; END IF;
    IF t.sync_pr IS NOT NULL THEN RETURN QUERY SELECT 'sync_open', NULL::integer; RETURN; END IF;
    SELECT r.gh_repo_id::text AS gid, r.gh_owner AS o, r.gh_name AS n INTO pub FROM public.repos r WHERE r.account_id = acct AND r.id = t.public_repo_id;
    SELECT r.gh_repo_id::text AS gid, r.gh_owner AS o, r.gh_name AS n INTO prv FROM public.repos r WHERE r.account_id = acct AND r.id = t.private_repo_id;
    IF pub.o IS NULL OR pub.n IS NULL OR prv.o IS NULL OR prv.n IS NULL THEN RETURN QUERY SELECT 'repo_unnamed', NULL::integer; RETURN; END IF;
    SELECT s.id INTO v_setup FROM public.project_setups s WHERE s.account_id = acct AND s.repo_id = t.private_repo_id ORDER BY s.created_at DESC, s.id LIMIT 1;
    IF v_setup IS NULL THEN RETURN QUERY SELECT 'no_setup', NULL::integer; RETURN; END IF;
    SELECT pl.runner_id INTO v_runner FROM public.project_placements pl JOIN public.runners rn ON rn.account_id = pl.account_id AND rn.id = pl.runner_id AND rn.revoked_at IS NULL WHERE pl.account_id = acct AND pl.repo_id = t.private_repo_id;
    IF v_runner IS NULL THEN RETURN QUERY SELECT 'not_placed', NULL::integer; RETURN; END IF;
    -- Live: any job of the twin's repository still issued or running, or a finished sync whose pushed head has not been checked or turned into a pull request yet.
    IF EXISTS (SELECT 1 FROM public.machine_jobs x WHERE x.account_id = acct AND x.repo_id = t.private_repo_id AND x.state IN ('issued', 'delivered'))
       OR (t.sync_head IS NOT NULL AND EXISTS (SELECT 1 FROM public.machine_jobs x WHERE x.account_id = acct AND x.repo_id = t.private_repo_id AND x.kind = 'twin_sync' AND x.state = 'done')) THEN
      RETURN QUERY SELECT 'job_live', NULL::integer; RETURN;
    END IF;
    IF j #>> '{kind}' IS DISTINCT FROM 'twin_sync' OR j #>> '{job_id}' IS DISTINCT FROM p_job::text OR j #>> '{runner_id}' IS DISTINCT FROM v_runner::text OR j #>> '{setup_id}' IS DISTINCT FROM v_setup::text
       OR j #>> '{requires_engine}' IS DISTINCT FROM 'any' OR j #>> '{repo_gh_id}' IS DISTINCT FROM prv.gid OR j #>> '{args,twin_id}' IS DISTINCT FROM p_twin::text
       OR j #>> '{args,private,gh_id}' IS DISTINCT FROM prv.gid OR j #>> '{args,private,owner}' IS DISTINCT FROM prv.o OR j #>> '{args,private,name}' IS DISTINCT FROM prv.n
       OR j #>> '{args,public,gh_id}' IS DISTINCT FROM pub.gid OR j #>> '{args,public,owner}' IS DISTINCT FROM pub.o OR j #>> '{args,public,name}' IS DISTINCT FROM pub.n
       OR j #>> '{args,public,tip}' !~ '^[0-9a-f]{40}$' OR j #>> '{args,private,base}' !~ '^[0-9a-f]{40}$' OR prv.gid = pub.gid
       OR j #>> '{args,branch}' IS DISTINCT FROM 'fx/twin-sync-' || substr(j #>> '{args,public,tip}', 1, 12)
       OR j #> '{args,private_set}' IS DISTINCT FROM jsonb_build_object('overlay_globs', t.overlay_globs, 'install_paths', t.install_paths, 'blob_globs', t.binary_globs, 'identifier_rules_path', t.identifier_rules_path, 'plan_data_rules_path', t.plan_data_rules_path)
       -- the paths: 1 to 200, each a string and a plain relative path (no empty, `.`, `..` or `.git` segment, no control character or backslash, at most 1024 characters), none twice
       OR jsonb_typeof(j #> '{args,paths}') IS DISTINCT FROM 'array' OR jsonb_array_length(j #> '{args,paths}') NOT BETWEEN 1 AND 200
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(j #> '{args,paths}') e
                   WHERE jsonb_typeof(e) <> 'string' OR length(e #>> '{}') > 1024 OR (e #>> '{}') !~ '^[^/\\[:cntrl:]]+(/[^/\\[:cntrl:]]+)*$'
                      OR EXISTS (SELECT 1 FROM unnest(string_to_array(e #>> '{}', '/')) s WHERE s IN ('.', '..') OR lower(s) = '.git'))
       OR (SELECT count(DISTINCT e) FROM jsonb_array_elements_text(j #> '{args,paths}') e) <> jsonb_array_length(j #> '{args,paths}') THEN
      RAISE EXCEPTION 'twin_sync_issue: not a twin_sync job of this twin' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF j #>> '{args,public,tip}' = t.synced_public_sha THEN RETURN QUERY SELECT 'in_sync', NULL::integer; RETURN; END IF;
    SELECT COALESCE(max(x.attempt), 0) + 1 INTO v_attempt FROM public.machine_jobs x WHERE x.account_id = acct AND x.setup_id = v_setup;
    INSERT INTO public.machine_jobs (id, account_id, runner_id, repo_id, setup_id, kind, job, attempt, issued_at, expires_at) VALUES (p_job, acct, v_runner, t.private_repo_id, v_setup, 'twin_sync', p_env, v_attempt, p_issued_at, p_expires_at);
    UPDATE public.repo_twins SET sync_head = NULL, sync_verified_at = NULL, updated_at = now() WHERE id = t.id AND account_id = acct;
    RETURN QUERY SELECT 'ok', v_attempt;
  END;
  $f$;

  -- The runner's job, locked: this runner's own delivered, current twin_sync job of this setup, whose twin is still ready and homed on the repository the job names (a paused, refused or removed twin fences the job).
  -- Not callable by app_user (the three functions below call it). o_result: ok | not_found | superseded | not_active (1093's lapse rule).
  CREATE FUNCTION public.twin_sync_job_lock(p_setup uuid, p_job uuid) RETURNS TABLE (o_result text, o_attempt integer, o_last_seq integer, o_twin uuid, o_private_repo uuid, o_pushed boolean)
  LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    j public.machine_jobs%ROWTYPE;
    v_twin uuid;
  BEGIN
    SELECT * INTO j FROM public.machine_jobs x WHERE x.id = p_job AND x.account_id = acct AND x.runner_id = public.machine_job_runner() AND x.setup_id = p_setup AND x.kind = 'twin_sync' FOR UPDATE;
    IF NOT FOUND THEN RETURN QUERY SELECT 'not_found', NULL::integer, NULL::integer, NULL::uuid, NULL::uuid, NULL::boolean; RETURN; END IF;
    SELECT t.id INTO v_twin FROM public.repo_twins t WHERE t.account_id = acct AND t.id::text = j.job #>> '{job,args,twin_id}' AND t.private_repo_id = j.repo_id AND t.state = 'ready';
    IF v_twin IS NULL THEN RETURN QUERY SELECT 'not_found', NULL::integer, NULL::integer, NULL::uuid, NULL::uuid, NULL::boolean; RETURN; END IF;
    IF j.state = 'superseded' OR EXISTS (SELECT 1 FROM public.machine_jobs n WHERE n.account_id = acct AND n.setup_id = p_setup AND n.attempt > j.attempt) THEN RETURN QUERY SELECT 'superseded', NULL::integer, NULL::integer, NULL::uuid, NULL::uuid, NULL::boolean; RETURN; END IF;
    IF j.state <> 'delivered' OR j.delivered_at <= now() - interval '3 hours' OR (j.last_seq IS NULL AND j.expires_at <= now()) OR (j.last_seq IS NOT NULL AND j.last_progress_at <= now() - interval '10 minutes') THEN
      RETURN QUERY SELECT 'not_active', NULL::integer, NULL::integer, NULL::uuid, NULL::uuid, NULL::boolean; RETURN;
    END IF;
    RETURN QUERY SELECT 'ok', j.attempt, j.last_seq, v_twin, j.repo_id, j.push_token_at IS NOT NULL;
  END;
  $f$;

  -- The push credential's fence: once per job, only after the runner reported its fetch (started, ok) and the push step started (seq 2 or later), and only while the twin's private set is still the signed one: a set edited between
  -- the issue and the push mints nothing (`set_changed`). The repository answered is the TWIN's own (the job's home, which the lock held to the twin's row), and never the public one.
  CREATE FUNCTION public.twin_sync_push_grant(p_setup uuid, p_job uuid) RETURNS TABLE (o_result text, o_repo_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    l record;
  BEGIN
    SELECT * INTO l FROM public.twin_sync_job_lock(p_setup, p_job);
    IF l.o_result <> 'ok' THEN RETURN QUERY SELECT l.o_result, NULL::uuid; RETURN; END IF;
    IF COALESCE(l.o_last_seq, -1) < 2 THEN RETURN QUERY SELECT 'not_ready', NULL::uuid; RETURN; END IF;
    IF l.o_pushed THEN RETURN QUERY SELECT 'already_issued', NULL::uuid; RETURN; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.repo_twins t JOIN public.machine_jobs x ON x.id = p_job AND x.account_id = acct
       WHERE t.id = l.o_twin AND t.account_id = acct
         AND x.job #> '{job,args,private_set}' = jsonb_build_object('overlay_globs', t.overlay_globs, 'install_paths', t.install_paths, 'blob_globs', t.binary_globs, 'identifier_rules_path', t.identifier_rules_path, 'plan_data_rules_path', t.plan_data_rules_path)
    ) THEN
      RETURN QUERY SELECT 'set_changed', NULL::uuid; RETURN;
    END IF;
    UPDATE public.machine_jobs SET push_token_at = now() WHERE id = p_job AND account_id = acct;
    RETURN QUERY SELECT 'ok', l.o_private_repo;
  END;
  $f$;

  -- The pushed commit, in the transaction of the `push ok` report (after the report itself): a credential must have been handed out. The cloud keeps the commit until it has verified it on GitHub (twin_sync_to_verify). It ends the job.
  CREATE FUNCTION public.twin_sync_head_record(p_setup uuid, p_job uuid, p_head text) RETURNS boolean
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    l record;
  BEGIN
    IF p_head IS NULL OR p_head !~ '^[0-9a-f]{40}$' THEN RETURN false; END IF;
    SELECT * INTO l FROM public.twin_sync_job_lock(p_setup, p_job);
    IF l.o_result <> 'ok' OR NOT l.o_pushed THEN RETURN false; END IF;
    UPDATE public.repo_twins SET sync_head = p_head, sync_verified_at = NULL, updated_at = now() WHERE id = l.o_twin AND account_id = acct;
    UPDATE public.machine_jobs SET state = 'done', ended_at = now() WHERE id = p_job AND account_id = acct AND state = 'delivered';
    RETURN FOUND;
  END;
  $f$;

  -- One report of the job (1053's rule for a setup, 1108's shape). The steps of a sync are twin_fetch and push; the push's `ok` carries the commit and ends the job `done` (twin_sync_head_record). A failed step ends it `failed` with its code:
  --   no_changes             the public paths already equal the twin's (what the twin published came back): nothing is pushed, the sync anchor moves to the job's public tip, the job is `done`;
  --   a transient code       the twin stays ready, with the code on it; the next pass issues again;
  --   any other code         the twin is `refused` with the code and one reason word.
  CREATE FUNCTION public.twin_sync_progress_record(p_setup uuid, p_job uuid, p_seq integer, p_sub_step text, p_state text, p_code text, p_reason text) RETURNS TABLE (o_result text, o_repo_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    v_code text := CASE WHEN p_state = 'failed' THEN NULLIF(split_part(p_code, ':', 1), '') END;
    v_transient boolean;
    l record;
  BEGIN
    IF p_seq IS NULL OR p_seq < 0 OR p_sub_step IS NULL OR p_sub_step NOT IN ('twin_fetch', 'push') OR p_state IS NULL OR p_state NOT IN ('started', 'ok', 'failed', 'skipped')
       OR (p_state = 'failed') IS DISTINCT FROM (v_code IS NOT NULL)
       OR (v_code IS NOT NULL AND v_code NOT IN ('bad_input', 'private_path_change', 'no_changes', 'sync_unsafe_path', 'public_unavailable', 'public_tip_moved', 'private_tip_moved', 'pairing_changed', 'twin_fetch_failed',
            'twin_too_large', 'branch_exists', 'push_failed', 'kind_unsupported', 'engine_unsupported'))
       OR (p_reason IS NOT NULL AND (v_code IS NULL OR p_reason !~ '^[a-z][a-z0-9_]{0,31}$')) THEN
      RAISE EXCEPTION 'twin_sync_progress_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_transient := v_code IN ('public_unavailable', 'public_tip_moved', 'private_tip_moved', 'pairing_changed', 'twin_fetch_failed', 'push_failed', 'kind_unsupported', 'engine_unsupported');
    SELECT * INTO l FROM public.twin_sync_job_lock(p_setup, p_job);
    IF l.o_result <> 'ok' THEN RETURN QUERY SELECT l.o_result, NULL::uuid; RETURN; END IF;
    IF p_seq <= COALESCE(l.o_last_seq, -1) THEN RETURN QUERY SELECT 'seq', NULL::uuid; RETURN; END IF;
    UPDATE public.machine_jobs SET last_seq = p_seq, last_progress_at = now(),
           state = CASE WHEN v_code = 'no_changes' THEN 'done' WHEN p_state = 'failed' THEN 'failed' ELSE state END,
           ended_at = CASE WHEN p_state = 'failed' THEN now() END
     WHERE id = p_job AND account_id = acct;
    IF v_code = 'no_changes' THEN
      UPDATE public.repo_twins t SET synced_public_sha = x.job #>> '{job,args,public,tip}', sync_head = NULL, sync_verified_at = NULL, failure_code = NULL, failure_reason = NULL, failure_at = NULL, updated_at = now()
        FROM public.machine_jobs x WHERE t.id = l.o_twin AND t.account_id = acct AND x.id = p_job AND x.account_id = acct;
    ELSIF v_code IS NOT NULL THEN
      UPDATE public.repo_twins SET state = CASE WHEN v_transient THEN state ELSE 'refused' END, failure_code = v_code, failure_reason = p_reason, failure_at = now(), updated_at = now() WHERE id = l.o_twin AND account_id = acct;
    END IF;
    RETURN QUERY SELECT 'ok', l.o_private_repo;
  END;
  $f$;

  -- What the cloud must check on GitHub: a twin that is ready and whose newest sync job finished with a pushed head that has not been verified, and no sync pull request recorded. The repository is the TWIN's own row's; the branch and the
  -- base are the signed ones. A caller with a person must be an owner or admin; the tick's session has none.
  CREATE FUNCTION public.twin_sync_to_verify(p_twin uuid) RETURNS TABLE (o_repo_id uuid, o_owner text, o_name text, o_branch text, o_head text, o_base text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  BEGIN
    IF session_user = 'platform_ops' OR acct IS NULL OR NOT public.account_is_active(acct) OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL
       OR (usr IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin'))) THEN
      RAISE EXCEPTION 'twin_sync_to_verify: refused' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN QUERY
      SELECT r.id, r.gh_owner, r.gh_name, x.job #>> '{job,args,branch}', t.sync_head, x.job #>> '{job,args,private,base}'
        FROM public.repo_twins t
        JOIN public.repos r ON r.account_id = t.account_id AND r.id = t.private_repo_id
        JOIN LATERAL (SELECT j.job, j.state FROM public.machine_jobs j WHERE j.account_id = t.account_id AND j.kind = 'twin_sync' AND j.repo_id = t.private_repo_id AND j.job #>> '{job,args,twin_id}' = t.id::text ORDER BY j.attempt DESC LIMIT 1) x ON true
       WHERE t.id = p_twin AND t.account_id = acct AND t.state = 'ready' AND t.sync_pr IS NULL AND t.sync_head IS NOT NULL AND t.sync_verified_at IS NULL AND x.state = 'done'
         AND r.gh_owner IS NOT NULL AND r.gh_name IS NOT NULL;
  END;
  $f$;

  -- The cloud's check of the pushed branch: `p_ok` says GitHub shows the signed branch at exactly the pushed head, with that commit's one parent the signed base. True marks the head verified; false refuses the twin
  -- (`head_unconfirmed`) and forgets the head. A caller as above. o_result: verified | refused | not_ready (nothing is waiting to be checked) | not_found.
  CREATE FUNCTION public.twin_sync_check(p_twin uuid, p_ok boolean) RETURNS TABLE (o_result text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
    t record;
  BEGIN
    IF session_user = 'platform_ops' OR acct IS NULL OR NOT public.account_is_active(acct) OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL
       OR (usr IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin'))) THEN
      RAISE EXCEPTION 'twin_sync_check: refused' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_ok IS NULL THEN RAISE EXCEPTION 'twin_sync_check: invalid argument' USING ERRCODE = 'invalid_parameter_value'; END IF;
    SELECT x.id, x.state, x.private_repo_id, x.sync_pr, x.sync_head, x.sync_verified_at INTO t FROM public.repo_twins x WHERE x.id = p_twin AND x.account_id = acct FOR UPDATE;
    IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'; RETURN; END IF;
    IF t.state <> 'ready' OR t.sync_pr IS NOT NULL OR t.sync_head IS NULL OR t.sync_verified_at IS NOT NULL
       OR (SELECT j.state FROM public.machine_jobs j WHERE j.account_id = acct AND j.kind = 'twin_sync' AND j.repo_id = t.private_repo_id AND j.job #>> '{job,args,twin_id}' = p_twin::text ORDER BY j.attempt DESC LIMIT 1) IS DISTINCT FROM 'done' THEN
      RETURN QUERY SELECT 'not_ready'; RETURN;
    END IF;
    IF NOT p_ok THEN
      UPDATE public.repo_twins SET state = 'refused', failure_code = 'head_unconfirmed', failure_reason = NULL, failure_at = now(), sync_head = NULL, sync_verified_at = NULL, updated_at = now() WHERE id = t.id AND account_id = acct;
      RETURN QUERY SELECT 'refused'; RETURN;
    END IF;
    UPDATE public.repo_twins SET sync_verified_at = now(), failure_code = NULL, failure_reason = NULL, failure_at = NULL, updated_at = now() WHERE id = t.id AND account_id = acct;
    RETURN QUERY SELECT 'verified';
  END;
  $f$;

  REVOKE ALL ON FUNCTION public.twin_sync_issue(uuid, uuid, jsonb, timestamptz, timestamptz) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.twin_sync_job_lock(uuid, uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.twin_sync_push_grant(uuid, uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.twin_sync_head_record(uuid, uuid, text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.twin_sync_progress_record(uuid, uuid, integer, text, text, text, text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.twin_sync_to_verify(uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.twin_sync_check(uuid, boolean) FROM PUBLIC;
  EXECUTE format('ALTER FUNCTION public.twin_sync_issue(uuid, uuid, jsonb, timestamptz, timestamptz) OWNER TO %I', owner_name);
  EXECUTE format('ALTER FUNCTION public.twin_sync_job_lock(uuid, uuid) OWNER TO %I', owner_name);
  EXECUTE format('ALTER FUNCTION public.twin_sync_push_grant(uuid, uuid) OWNER TO %I', owner_name);
  EXECUTE format('ALTER FUNCTION public.twin_sync_head_record(uuid, uuid, text) OWNER TO %I', owner_name);
  EXECUTE format('ALTER FUNCTION public.twin_sync_progress_record(uuid, uuid, integer, text, text, text, text) OWNER TO %I', owner_name);
  EXECUTE format('ALTER FUNCTION public.twin_sync_to_verify(uuid) OWNER TO %I', owner_name);
  EXECUTE format('ALTER FUNCTION public.twin_sync_check(uuid, boolean) OWNER TO %I', owner_name);
  GRANT EXECUTE ON FUNCTION public.twin_sync_issue(uuid, uuid, jsonb, timestamptz, timestamptz) TO app_user;
  GRANT EXECUTE ON FUNCTION public.twin_sync_push_grant(uuid, uuid) TO app_user;
  GRANT EXECUTE ON FUNCTION public.twin_sync_head_record(uuid, uuid, text) TO app_user;
  GRANT EXECUTE ON FUNCTION public.twin_sync_progress_record(uuid, uuid, integer, text, text, text, text) TO app_user;
  GRANT EXECUTE ON FUNCTION public.twin_sync_to_verify(uuid) TO app_user;
  GRANT EXECUTE ON FUNCTION public.twin_sync_check(uuid, boolean) TO app_user;

  -- 1110's machine_job_expire, with one change: a twin_sync job that went quiet is expired and nothing else is touched (the twin stays ready and is issued again; its setup is not the sync's business).
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
      FROM ex WHERE ex.kind NOT IN ('engine_update', 'twin_seed', 'twin_publish', 'twin_sync') AND s.account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND s.id = ex.setup_id;
  $e$;

  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', owner_name);
  IF NOT super THEN
    EXECUTE format('REVOKE %I FROM CURRENT_USER', owner_name);
  END IF;
END
$$;
