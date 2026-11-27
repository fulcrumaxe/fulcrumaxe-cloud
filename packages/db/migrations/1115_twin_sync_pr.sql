-- D#845 ON-27d3: the sync pull request on a private twin, its merge or close, and the update of an open publish pull request. Five functions of machine_jobs_owner (1053), SECURITY DEFINER, EXECUTE for app_user alone:
--
--   twin_sync_pr_target   What the cloud opens the sync pull request for: a ready twin whose newest sync job is done, whose pushed head the cloud has verified (1111's twin_sync_check) and that has no pull request yet. The repository is the
--                         TWIN's own row's; the branch, the base and the listed paths are the signed job's.
--   twin_sync_pr_record   The pull request's number, in one transaction with clearing sync_head and sync_verified_at (1111 keeps them only until the pull request is recorded). A NULL number says the cloud could not confirm the pull request
--                         is what the job pushed: the twin is refused (`head_unconfirmed`), as 1111's own check does.
--   twin_sync_pr_closed   The App webhook's close of a sync pull request (a delivery of the PRIVATE repository, `p_repo`). Merged: synced_public_sha moves to the public tip the job brought in, whatever the twin's state. Closed unmerged: a ready twin is
--                         refused `sync_closed` (a person decides; the branch stays), any other state is kept (a conflict stays a conflict). Acts only for the branch the newest sync job named and the number recorded, or, while none is recorded,
--                         while the verified head waits for its pull request. A removed twin ignores it.
--   twin_sync_open_pr     The sync pull request a twin still has open, for the one who closes it (read after a removal too).
--   twin_publish_update_issue  1110's issue for a twin whose publish pull request is still open: a job on the SAME branch and the SAME private base, to the new private head, carrying `replaces_head` (the head the cloud recorded) for D#598's
--                         compare-and-swap push. The signed bytes are held to the rows as 1110's are; the branch, base and `replaces_head` come from the open pull request's own job and row, never from the caller.
--
-- It also restates 1110's twin_publish_pr_closed (a fifth argument: the merged head; the four-argument function is dropped) and twin_publish_push_grant (an update job gets no credential once the publish pull request is gone).
--
-- Numbered 1115 by the Team Lead. Re-check against main right before merging and renumber to stay above its highest.

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
      RAISE EXCEPTION 'current_user has no ADMIN option on %; cannot create the twin sync pull request functions', owner_name;
    END IF;
    EXECUTE format('GRANT %I TO CURRENT_USER WITH INHERIT TRUE, SET TRUE', owner_name);
  END IF;
  EXECUTE format('GRANT CREATE ON SCHEMA public TO %I', owner_name);
  EXECUTE format('GRANT UPDATE (sync_pr) ON repo_twins TO %I', owner_name);

  CREATE FUNCTION public.twin_sync_pr_target(p_twin uuid) RETURNS TABLE (o_repo_id uuid, o_owner text, o_name text, o_branch text, o_head text, o_base text, o_public_owner text, o_public_name text, o_tip text, o_synced text, o_paths text[])
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  BEGIN
    IF session_user = 'platform_ops' OR acct IS NULL OR NOT public.account_is_active(acct) OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL
       OR (usr IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin'))) THEN
      RAISE EXCEPTION 'twin_sync_pr_target: refused' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN QUERY
      SELECT r.id, r.gh_owner, r.gh_name, x.job #>> '{job,args,branch}', t.sync_head, x.job #>> '{job,args,private,base}', u.gh_owner, u.gh_name, x.job #>> '{job,args,public,tip}', t.synced_public_sha,
             ARRAY(SELECT jsonb_array_elements_text(x.job #> '{job,args,paths}'))
        FROM public.repo_twins t
        JOIN public.repos r ON r.account_id = t.account_id AND r.id = t.private_repo_id
        JOIN public.repos u ON u.account_id = t.account_id AND u.id = t.public_repo_id
        JOIN LATERAL (SELECT j.job, j.state FROM public.machine_jobs j WHERE j.account_id = t.account_id AND j.kind = 'twin_sync' AND j.repo_id = t.private_repo_id AND j.job #>> '{job,args,twin_id}' = t.id::text ORDER BY j.attempt DESC LIMIT 1) x ON true
       WHERE t.id = p_twin AND t.account_id = acct AND t.state = 'ready' AND t.sync_pr IS NULL AND t.sync_head IS NOT NULL AND t.sync_verified_at IS NOT NULL AND x.state = 'done'
         AND r.gh_owner IS NOT NULL AND r.gh_name IS NOT NULL AND u.gh_owner IS NOT NULL AND u.gh_name IS NOT NULL AND t.synced_public_sha IS NOT NULL;
  END;
  $f$;

  -- o_result: recorded | refused (no number) | not_ready (nothing verified is waiting, or the head is not the verified one) | not_found.
  CREATE FUNCTION public.twin_sync_pr_record(p_twin uuid, p_head text, p_pr integer) RETURNS TABLE (o_result text)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
    t record;
  BEGIN
    IF session_user = 'platform_ops' OR acct IS NULL OR NOT public.account_is_active(acct) OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL
       OR (usr IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin'))) THEN
      RAISE EXCEPTION 'twin_sync_pr_record: refused' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF p_head IS NULL OR p_head !~ '^[0-9a-f]{40}$' OR (p_pr IS NOT NULL AND p_pr < 1) THEN RAISE EXCEPTION 'twin_sync_pr_record: invalid argument' USING ERRCODE = 'invalid_parameter_value'; END IF;
    SELECT x.id, x.state, x.sync_pr, x.sync_head, x.sync_verified_at INTO t FROM public.repo_twins x WHERE x.id = p_twin AND x.account_id = acct FOR UPDATE;
    IF NOT FOUND THEN RETURN QUERY SELECT 'not_found'; RETURN; END IF;
    IF t.state <> 'ready' OR t.sync_pr IS NOT NULL OR t.sync_head IS DISTINCT FROM p_head OR t.sync_verified_at IS NULL THEN RETURN QUERY SELECT 'not_ready'; RETURN; END IF;
    IF p_pr IS NULL THEN
      UPDATE public.repo_twins SET state = 'refused', failure_code = 'head_unconfirmed', failure_reason = NULL, failure_at = now(), sync_head = NULL, sync_verified_at = NULL, updated_at = now() WHERE id = t.id AND account_id = acct;
      RETURN QUERY SELECT 'refused'; RETURN;
    END IF;
    UPDATE public.repo_twins SET sync_pr = p_pr, sync_head = NULL, sync_verified_at = NULL, updated_at = now() WHERE id = t.id AND account_id = acct;
    RETURN QUERY SELECT 'recorded';
  END;
  $f$;

  CREATE FUNCTION public.twin_sync_pr_closed(p_repo uuid, p_pr integer, p_merged boolean, p_head_ref text) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    t record;
    v_tip text;
  BEGIN
    IF acct IS NULL OR p_repo IS NULL OR p_pr IS NULL OR p_pr < 1 OR p_merged IS NULL OR p_head_ref IS NULL OR p_head_ref !~ '^fx/twin-sync-[0-9a-f]{12}$' THEN RETURN 'none'; END IF;
    SELECT x.id, x.state, x.sync_pr, x.sync_head, x.sync_verified_at INTO t FROM public.repo_twins x WHERE x.account_id = acct AND x.private_repo_id = p_repo AND x.state <> 'removed' FOR UPDATE;
    IF NOT FOUND THEN RETURN 'none'; END IF;
    IF NOT (COALESCE(t.sync_pr = p_pr, false) OR (t.sync_pr IS NULL AND t.sync_head IS NOT NULL AND t.sync_verified_at IS NOT NULL)) THEN RETURN 'none'; END IF;
    SELECT x.job #>> '{job,args,public,tip}' INTO v_tip FROM public.machine_jobs x
     WHERE x.account_id = acct AND x.kind = 'twin_sync' AND x.repo_id = p_repo AND x.job #>> '{job,args,twin_id}' = t.id::text AND x.job #>> '{job,args,branch}' = p_head_ref AND x.state IN ('delivered', 'done') ORDER BY x.attempt DESC LIMIT 1;
    IF v_tip IS NULL OR v_tip !~ '^[0-9a-f]{40}$' THEN RETURN 'none'; END IF;
    IF p_merged THEN
      UPDATE public.repo_twins SET synced_public_sha = v_tip, sync_pr = NULL, sync_head = NULL, sync_verified_at = NULL, updated_at = now() WHERE id = t.id AND account_id = acct;
      RETURN 'merged';
    END IF;
    -- A ready twin is refused so the next pass does not make the same sync again; any other state (a conflict, a pause) is kept as it is.
    IF t.state = 'ready' THEN
      UPDATE public.repo_twins SET state = 'refused', failure_code = 'sync_closed', failure_reason = NULL, failure_at = now(), sync_pr = NULL, sync_head = NULL, sync_verified_at = NULL, updated_at = now() WHERE id = t.id AND account_id = acct;
    ELSE
      UPDATE public.repo_twins SET sync_pr = NULL, sync_head = NULL, sync_verified_at = NULL, updated_at = now() WHERE id = t.id AND account_id = acct;
    END IF;
    RETURN 'closed';
  END;
  $f$;

  CREATE FUNCTION public.twin_sync_open_pr(p_twin uuid) RETURNS TABLE (o_repo_id uuid, o_owner text, o_name text, o_pr integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
  BEGIN
    IF session_user = 'platform_ops' OR acct IS NULL OR NOT public.account_is_active(acct) OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL
       OR (usr IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin'))) THEN
      RAISE EXCEPTION 'twin_sync_open_pr: refused' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN QUERY
      SELECT r.id, r.gh_owner, r.gh_name, t.sync_pr FROM public.repo_twins t JOIN public.repos r ON r.account_id = t.account_id AND r.id = t.private_repo_id
       WHERE t.id = p_twin AND t.account_id = acct AND t.sync_pr IS NOT NULL AND r.gh_owner IS NOT NULL AND r.gh_name IS NOT NULL;
  END;
  $f$;

  -- o_result: ok | up_to_date (the newest job already carried this head) | not_found | bad_state | no_open_pr | repo_unnamed | no_setup | not_placed | job_live.
  CREATE FUNCTION public.twin_publish_update_issue(p_twin uuid, p_job uuid, p_env jsonb, p_issued_at timestamptz, p_expires_at timestamptz) RETURNS TABLE (o_result text, o_attempt integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    usr  uuid := NULLIF(current_setting('app.user_id', true), '')::uuid;
    j    jsonb := p_env -> 'job';
    t    record;
    pub  record;
    prv  record;
    prev jsonb;
    v_setup uuid;
    v_runner uuid;
    v_attempt integer;
  BEGIN
    IF session_user = 'platform_ops' OR acct IS NULL OR NOT public.account_is_active(acct) OR NULLIF(current_setting('app.runner_id', true), '') IS NOT NULL
       OR (usr IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.account_members m WHERE m.account_id = acct AND m.user_id = usr AND m.role IN ('owner', 'admin'))) THEN
      RAISE EXCEPTION 'twin_publish_update_issue: refused' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT x.id, x.public_repo_id, x.private_repo_id, x.state, x.published_private_sha, x.publish_pr, x.publish_head, x.overlay_globs, x.install_paths, x.binary_globs, x.identifier_rules_path, x.plan_data_rules_path
      INTO t FROM public.repo_twins x WHERE x.id = p_twin AND x.account_id = acct FOR UPDATE;
    IF NOT FOUND THEN RETURN QUERY SELECT 'not_found', NULL::integer; RETURN; END IF;
    IF t.state <> 'ready' OR t.private_repo_id IS NULL OR t.published_private_sha IS NULL THEN RETURN QUERY SELECT 'bad_state', NULL::integer; RETURN; END IF;
    IF t.publish_pr IS NULL OR t.publish_head IS NULL THEN RETURN QUERY SELECT 'no_open_pr', NULL::integer; RETURN; END IF;
    SELECT r.gh_repo_id::text AS gid, r.gh_owner AS o, r.gh_name AS n INTO pub FROM public.repos r WHERE r.account_id = acct AND r.id = t.public_repo_id;
    SELECT r.gh_repo_id::text AS gid, r.gh_owner AS o, r.gh_name AS n INTO prv FROM public.repos r WHERE r.account_id = acct AND r.id = t.private_repo_id;
    IF pub.o IS NULL OR pub.n IS NULL OR prv.o IS NULL OR prv.n IS NULL THEN RETURN QUERY SELECT 'repo_unnamed', NULL::integer; RETURN; END IF;
    SELECT s.id INTO v_setup FROM public.project_setups s WHERE s.account_id = acct AND s.repo_id = t.private_repo_id ORDER BY s.created_at DESC, s.id LIMIT 1;
    IF v_setup IS NULL THEN RETURN QUERY SELECT 'no_setup', NULL::integer; RETURN; END IF;
    SELECT pl.runner_id INTO v_runner FROM public.project_placements pl JOIN public.runners rn ON rn.account_id = pl.account_id AND rn.id = pl.runner_id AND rn.revoked_at IS NULL WHERE pl.account_id = acct AND pl.repo_id = t.private_repo_id;
    IF v_runner IS NULL THEN RETURN QUERY SELECT 'not_placed', NULL::integer; RETURN; END IF;
    IF EXISTS (SELECT 1 FROM public.machine_jobs x WHERE x.account_id = acct AND x.repo_id = t.private_repo_id AND x.state IN ('issued', 'delivered')) THEN RETURN QUERY SELECT 'job_live', NULL::integer; RETURN; END IF;
    -- The open pull request's own job: the newest finished publish job of this twin. Its branch and base are the update's, and its head is the one to beat.
    SELECT x.job -> 'job' INTO prev FROM public.machine_jobs x
     WHERE x.account_id = acct AND x.kind = 'twin_publish' AND x.repo_id = t.private_repo_id AND x.state = 'done' AND x.job #>> '{job,args,twin_id}' = p_twin::text ORDER BY x.attempt DESC LIMIT 1;
    IF prev IS NULL OR prev #>> '{args,branch}' !~ '^fx/publish-[0-9a-f]{12}$' THEN RETURN QUERY SELECT 'no_open_pr', NULL::integer; RETURN; END IF;
    IF j #>> '{args,private,head}' = prev #>> '{args,private,head}' THEN RETURN QUERY SELECT 'up_to_date', NULL::integer; RETURN; END IF;
    IF j #>> '{kind}' IS DISTINCT FROM 'twin_publish' OR j #>> '{job_id}' IS DISTINCT FROM p_job::text OR j #>> '{runner_id}' IS DISTINCT FROM v_runner::text OR j #>> '{setup_id}' IS DISTINCT FROM v_setup::text
       OR j #>> '{requires_engine}' IS DISTINCT FROM 'any' OR j #>> '{repo_gh_id}' IS DISTINCT FROM prv.gid OR j #>> '{args,twin_id}' IS DISTINCT FROM p_twin::text
       OR j #>> '{args,private,gh_id}' IS DISTINCT FROM prv.gid OR j #>> '{args,private,owner}' IS DISTINCT FROM prv.o OR j #>> '{args,private,name}' IS DISTINCT FROM prv.n
       OR j #>> '{args,public,gh_id}' IS DISTINCT FROM pub.gid OR j #>> '{args,public,owner}' IS DISTINCT FROM pub.o OR j #>> '{args,public,name}' IS DISTINCT FROM pub.n
       OR j #>> '{args,public,tip}' !~ '^[0-9a-f]{40}$' OR j #>> '{args,private,base}' IS DISTINCT FROM prev #>> '{args,private,base}'
       OR j #>> '{args,private,head}' !~ '^[0-9a-f]{40}$' OR j #>> '{args,private,head}' = j #>> '{args,private,base}' OR prv.gid = pub.gid
       OR j #>> '{args,branch}' IS DISTINCT FROM prev #>> '{args,branch}' OR j #>> '{args,replaces_head}' IS DISTINCT FROM t.publish_head
       OR j #> '{args,private_set}' IS DISTINCT FROM jsonb_build_object('overlay_globs', t.overlay_globs, 'install_paths', t.install_paths, 'blob_globs', t.binary_globs, 'identifier_rules_path', t.identifier_rules_path, 'plan_data_rules_path', t.plan_data_rules_path) THEN
      RAISE EXCEPTION 'twin_publish_update_issue: not an update job of this twin' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT COALESCE(max(x.attempt), 0) + 1 INTO v_attempt FROM public.machine_jobs x WHERE x.account_id = acct AND x.setup_id = v_setup;
    INSERT INTO public.machine_jobs (id, account_id, runner_id, repo_id, setup_id, kind, job, attempt, issued_at, expires_at) VALUES (p_job, acct, v_runner, t.private_repo_id, v_setup, 'twin_publish', p_env, v_attempt, p_issued_at, p_expires_at);
    RETURN QUERY SELECT 'ok', v_attempt;
  END;
  $f$;

  -- 1110's twin_publish_pr_closed, restated with the merged pull request's head commit (the webhook's `headSha`). On a merge the anchor is the private head of the job whose PUSHED commit is that head, never "the newest job":
  -- with update-in-place the newest job can be an update that was claimed but has not pushed, and the pull request GitHub merged is still the old head (CWE-362). The pushed commit is the twin's recorded `publish_head`; the job
  -- that pushed it is the newest one of the branch that took the push credential and either finished or has reported `push ok` (seq 3). A merged head that is not the recorded one, or no head at all (an update pushed
  -- while the merge was in flight, or the older head merged after the update pushed), anchors nothing: `published_private_sha` stays where it was and the publish pull request is cleared, so the next publish re-sends the
  -- difference. It never claims more than was merged. The fifth argument is optional (an event without a head is the same case). The four-argument function is dropped so it cannot be called around the fix.
  DROP FUNCTION public.twin_publish_pr_closed(uuid, integer, boolean, text);
  CREATE FUNCTION public.twin_publish_pr_closed(p_repo uuid, p_pr integer, p_merged boolean, p_head_ref text, p_head_sha text DEFAULT NULL) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    t record;
    v_head text;
  BEGIN
    IF acct IS NULL OR p_repo IS NULL OR p_pr IS NULL OR p_pr < 1 OR p_merged IS NULL OR p_head_ref IS NULL OR p_head_ref !~ '^fx/publish-[0-9a-f]{12}$' OR (p_head_sha IS NOT NULL AND p_head_sha !~ '^[0-9a-f]{40}$') THEN RETURN 'none'; END IF;
    SELECT x.id, x.state, x.private_repo_id, x.publish_pr, x.publish_head INTO t FROM public.repo_twins x WHERE x.account_id = acct AND x.public_repo_id = p_repo AND x.state <> 'removed' FOR UPDATE;
    IF NOT FOUND OR t.private_repo_id IS NULL THEN RETURN 'none'; END IF;
    IF NOT (COALESCE(t.publish_pr = p_pr, false) OR (t.publish_pr IS NULL AND t.publish_head IS NOT NULL)) THEN RETURN 'none'; END IF;
    -- 1110's own gate, kept: the twin acts only for a branch one of its publish jobs named.
    IF NOT EXISTS (SELECT 1 FROM public.machine_jobs x WHERE x.account_id = acct AND x.kind = 'twin_publish' AND x.repo_id = t.private_repo_id AND x.job #>> '{job,args,branch}' = p_head_ref AND x.state IN ('delivered', 'done')) THEN RETURN 'none'; END IF;
    IF p_merged AND p_head_sha IS NOT NULL AND p_head_sha = t.publish_head THEN
      SELECT x.job #>> '{job,args,private,head}' INTO v_head FROM public.machine_jobs x
       WHERE x.account_id = acct AND x.kind = 'twin_publish' AND x.repo_id = t.private_repo_id AND x.job #>> '{job,args,branch}' = p_head_ref AND x.push_token_at IS NOT NULL
         AND (x.state = 'done' OR (x.state = 'delivered' AND COALESCE(x.last_seq, -1) >= 3)) ORDER BY x.attempt DESC LIMIT 1;
    END IF;
    IF p_merged THEN
      UPDATE public.repo_twins SET published_private_sha = COALESCE(v_head, published_private_sha), publish_pr = NULL, publish_head = NULL, failure_code = NULL, failure_reason = NULL, failure_at = NULL, updated_at = now() WHERE id = t.id AND account_id = acct;
      RETURN 'merged';
    END IF;
    UPDATE public.repo_twins SET state = CASE WHEN state = 'ready' THEN 'refused' ELSE state END, failure_code = 'publish_closed', failure_reason = NULL, failure_at = now(), publish_pr = NULL, publish_head = NULL, updated_at = now()
     WHERE id = t.id AND account_id = acct;
    RETURN 'closed';
  END;
  $f$;

  -- 1110's twin_publish_push_grant, restated with one fence: an UPDATE job (it carries `replaces_head`) is granted no credential once the twin has no open publish pull request (it merged or closed while the job waited), so it can never push
  -- to the branch of a pull request that is gone (CWE-362). Everything else is 1110's.
  CREATE OR REPLACE FUNCTION public.twin_publish_push_grant(p_setup uuid, p_job uuid) RETURNS TABLE (o_result text, o_repo_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $f$
  DECLARE
    acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
    l record;
  BEGIN
    SELECT * INTO l FROM public.twin_publish_job_lock(p_setup, p_job);
    IF l.o_result <> 'ok' THEN RETURN QUERY SELECT l.o_result, NULL::uuid; RETURN; END IF;
    IF COALESCE(l.o_last_seq, -1) < 2 THEN RETURN QUERY SELECT 'not_ready', NULL::uuid; RETURN; END IF;
    IF l.o_pushed THEN RETURN QUERY SELECT 'already_issued', NULL::uuid; RETURN; END IF;
    IF EXISTS (SELECT 1 FROM public.machine_jobs x WHERE x.id = p_job AND x.account_id = acct AND x.job #>> '{job,args,replaces_head}' IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM public.repo_twins t WHERE t.id = l.o_twin AND t.account_id = acct AND t.publish_pr IS NOT NULL) THEN
      RETURN QUERY SELECT 'superseded', NULL::uuid; RETURN;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.repo_twins t JOIN public.machine_jobs x ON x.id = p_job AND x.account_id = acct
       WHERE t.id = l.o_twin AND t.account_id = acct AND t.published_private_sha = x.job #>> '{job,args,private,base}'
         AND x.job #> '{job,args,private_set}' = jsonb_build_object('overlay_globs', t.overlay_globs, 'install_paths', t.install_paths, 'blob_globs', t.binary_globs, 'identifier_rules_path', t.identifier_rules_path, 'plan_data_rules_path', t.plan_data_rules_path)
    ) THEN
      RETURN QUERY SELECT 'set_changed', NULL::uuid; RETURN;
    END IF;
    UPDATE public.machine_jobs SET push_token_at = now() WHERE id = p_job AND account_id = acct;
    RETURN QUERY SELECT 'ok', l.o_public_repo;
  END;
  $f$;

  REVOKE ALL ON FUNCTION public.twin_sync_pr_target(uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.twin_sync_pr_record(uuid, text, integer) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.twin_sync_pr_closed(uuid, integer, boolean, text) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.twin_sync_open_pr(uuid) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.twin_publish_update_issue(uuid, uuid, jsonb, timestamptz, timestamptz) FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.twin_publish_pr_closed(uuid, integer, boolean, text, text) FROM PUBLIC;
  EXECUTE format('ALTER FUNCTION public.twin_sync_pr_target(uuid) OWNER TO %I', owner_name);
  EXECUTE format('ALTER FUNCTION public.twin_sync_pr_record(uuid, text, integer) OWNER TO %I', owner_name);
  EXECUTE format('ALTER FUNCTION public.twin_sync_pr_closed(uuid, integer, boolean, text) OWNER TO %I', owner_name);
  EXECUTE format('ALTER FUNCTION public.twin_sync_open_pr(uuid) OWNER TO %I', owner_name);
  EXECUTE format('ALTER FUNCTION public.twin_publish_update_issue(uuid, uuid, jsonb, timestamptz, timestamptz) OWNER TO %I', owner_name);
  EXECUTE format('ALTER FUNCTION public.twin_publish_pr_closed(uuid, integer, boolean, text, text) OWNER TO %I', owner_name);
  GRANT EXECUTE ON FUNCTION public.twin_sync_pr_target(uuid) TO app_user;
  GRANT EXECUTE ON FUNCTION public.twin_sync_pr_record(uuid, text, integer) TO app_user;
  GRANT EXECUTE ON FUNCTION public.twin_sync_pr_closed(uuid, integer, boolean, text) TO app_user;
  GRANT EXECUTE ON FUNCTION public.twin_sync_open_pr(uuid) TO app_user;
  GRANT EXECUTE ON FUNCTION public.twin_publish_update_issue(uuid, uuid, jsonb, timestamptz, timestamptz) TO app_user;
  GRANT EXECUTE ON FUNCTION public.twin_publish_pr_closed(uuid, integer, boolean, text, text) TO app_user;

  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', owner_name);
  IF NOT super THEN
    EXECUTE format('REVOKE %I FROM CURRENT_USER', owner_name);
  END IF;
END
$$;
