-- D#845 ON-8f2a: the install step after a setup's push (Ruling 83): the cloud opens the install pull request, or, in direct mode, finishes, from a level-triggered reconcile job.
--
--   1. project_setups.install_pr_claim_at / install_pr_claim_sha: the lease of that job. A pass takes a due setup (phase install, the push step ok, its pushed commit recorded, no pull request yet) for ten minutes, for that
--      commit; an overlapping pass skips it, a pass that died lets it go after the ten minutes, and a new attempt (a new commit) is due at once. They are the job's own columns: nothing else reads them.
--   2. setup_install_definer, a NOLOGIN role of its own, owns four functions that only platform_ops can run (the reconcile login). It reads the columns below and writes nothing else:
--        project_setups  id, account_id, repo_id, created_by, phase, sub_step, state, attempt, engine_version, install_head_sha, install_pr, the two claim columns, updated_at (select);
--                        phase, sub_step, state, install_pr, failure_code, failure_reason, failure_at, the two claim columns, updated_at (update)
--        machine_jobs    id, account_id, setup_id, kind, attempt, state, job (select), state (update)
--        repos           id, account_id, gh_owner, gh_name (select)
--        accounts        id, deleted_at (select; account_is_active reads them)
--      A setup whose push was recorded more than six hours ago is no longer due (a person's Retry issues the next attempt), so a runner that never came back cannot keep the reconciler awake.
--      The signed job's bytes are read inside the definer, and only mode, base_sha and the branch of its arguments leave it.
--        setup_install_pr_claim()     takes the oldest due setup (one), returns what the pull request step needs; none when nothing is due.
--        setup_install_pr_pending()   whether any setup is due or leased (the reconcile gate's reason to connect again).
--        setup_install_pr_record(setup, attempt, head, pr)   the step's success. With a pull request number: phase await_merge, the number stored, the job done. With NULL (direct mode, the job's own mode): phase finish.
--        setup_install_pr_fail(setup, attempt, head, code)   the step's refusal, one of three closed codes: the setup is failed (the person's Retry issues the next attempt) and the job failed.
--      Each record or fail re-reads the row under its lock and changes nothing unless the setup still says exactly what the claim saw (the same attempt, the same pushed commit, no pull request yet).
--   3. The reconcile row of the job (900 s; the marker the push report sets makes the next tick run it).
-- Numbered 1072 by the Team Lead. Re-check against main right before merging and renumber to stay above its highest.

ALTER TABLE project_setups
  ADD COLUMN install_pr_claim_at timestamptz,
  ADD COLUMN install_pr_claim_sha text CONSTRAINT project_setups_install_pr_claim_sha_check CHECK (install_pr_claim_sha IS NULL OR install_pr_claim_sha ~ '^[0-9a-f]{40}$');

DO $$
DECLARE
  n text := 'setup_install_definer';
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

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'setup_install_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on setup_install_definer; cannot ALTER FUNCTION ... OWNER TO setup_install_definer';
    END IF;
    GRANT setup_install_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO setup_install_definer;
GRANT USAGE ON SCHEMA public TO setup_install_definer;

GRANT SELECT (id, account_id, repo_id, created_by, phase, sub_step, state, attempt, engine_version, install_head_sha, install_pr, install_pr_claim_at, install_pr_claim_sha, updated_at) ON project_setups TO setup_install_definer;
GRANT UPDATE (phase, sub_step, state, install_pr, failure_code, failure_reason, failure_at, install_pr_claim_at, install_pr_claim_sha, updated_at) ON project_setups TO setup_install_definer;
GRANT SELECT (id, account_id, setup_id, kind, attempt, state, job) ON machine_jobs TO setup_install_definer;
GRANT UPDATE (state) ON machine_jobs TO setup_install_definer;
GRANT SELECT (id, account_id, gh_owner, gh_name) ON repos TO setup_install_definer;
-- account_is_active() reads these two columns as its caller (the same grant and policy the other definers hold).
GRANT SELECT (id, deleted_at) ON accounts TO setup_install_definer;
CREATE POLICY setup_install_definer_select ON accounts FOR SELECT TO setup_install_definer USING (true);

CREATE POLICY setup_install_definer_select ON project_setups FOR SELECT TO setup_install_definer USING (phase IN ('install', 'await_merge', 'finish'));
CREATE POLICY setup_install_definer_update ON project_setups FOR UPDATE TO setup_install_definer USING (phase = 'install') WITH CHECK (phase IN ('install', 'await_merge', 'finish'));
CREATE POLICY setup_install_definer_select ON machine_jobs FOR SELECT TO setup_install_definer USING (kind = 'project_setup');
CREATE POLICY setup_install_definer_update ON machine_jobs FOR UPDATE TO setup_install_definer USING (kind = 'project_setup' AND state = 'delivered') WITH CHECK (kind = 'project_setup' AND state IN ('done', 'failed'));
CREATE POLICY setup_install_definer_select ON repos FOR SELECT TO setup_install_definer USING (true);

-- The oldest due setup, leased. A setup is due while the runner's push is recorded and nothing since has changed it: phase install, the push step ok, the commit recorded, no pull request, and the attempt's own job still the
-- runner's delivered one. The lease is taken in the same statement, so two passes never hold the same setup for the same commit.
CREATE FUNCTION setup_install_pr_claim()
RETURNS TABLE (o_account uuid, o_setup uuid, o_repo uuid, o_user uuid, o_attempt integer, o_mode text, o_base text, o_branch text, o_head text, o_version text, o_owner text, o_name text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  s_id uuid; s_account uuid; s_repo uuid; s_user uuid; s_attempt integer; s_head text; s_version text;
BEGIN
  IF session_user <> 'platform_ops' THEN
    RAISE EXCEPTION 'setup_install_pr_claim: platform_ops only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT x.id, x.account_id, x.repo_id, x.created_by, x.attempt, x.install_head_sha, x.engine_version INTO s_id, s_account, s_repo, s_user, s_attempt, s_head, s_version FROM public.project_setups x
   WHERE x.phase = 'install' AND x.sub_step = 'push' AND x.state = 'ok' AND x.install_head_sha IS NOT NULL AND x.install_pr IS NULL
     AND (x.install_pr_claim_at IS NULL OR x.install_pr_claim_sha IS DISTINCT FROM x.install_head_sha OR x.install_pr_claim_at < now() - interval '10 minutes')
     AND x.updated_at > now() - interval '6 hours' AND public.account_is_active(x.account_id)
     AND EXISTS (SELECT 1 FROM public.machine_jobs j WHERE j.account_id = x.account_id AND j.setup_id = x.id AND j.attempt = x.attempt AND j.kind = 'project_setup' AND j.state = 'delivered')
   ORDER BY x.updated_at, x.id
   LIMIT 1
   FOR UPDATE OF x SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.project_setups x SET install_pr_claim_at = now(), install_pr_claim_sha = s_head WHERE x.account_id = s_account AND x.id = s_id;
  RETURN QUERY
    SELECT s_account, s_id, s_repo, s_user, s_attempt,
           j.job #>> '{job,args,mode}', j.job #>> '{job,args,base_sha}', j.job #>> '{job,args,branch}', s_head, s_version, r.gh_owner, r.gh_name
      FROM public.machine_jobs j JOIN public.repos r ON r.account_id = s_account AND r.id = s_repo
     WHERE j.account_id = s_account AND j.setup_id = s_id AND j.attempt = s_attempt AND j.kind = 'project_setup';
END;
$$;

CREATE FUNCTION setup_install_pr_pending()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF session_user <> 'platform_ops' THEN
    RAISE EXCEPTION 'setup_install_pr_pending: platform_ops only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.project_setups x
     WHERE x.phase = 'install' AND x.sub_step = 'push' AND x.state = 'ok' AND x.install_head_sha IS NOT NULL AND x.install_pr IS NULL AND x.updated_at > now() - interval '6 hours' AND public.account_is_active(x.account_id)
       AND EXISTS (SELECT 1 FROM public.machine_jobs j WHERE j.account_id = x.account_id AND j.setup_id = x.id AND j.attempt = x.attempt AND j.kind = 'project_setup' AND j.state = 'delivered')
  );
END;
$$;

-- Whether the setup still says what the claim saw, under its row lock; null when it does not. The job of that attempt is locked with it.
CREATE FUNCTION setup_install_pr_record(p_setup uuid, p_attempt integer, p_head text, p_pr integer)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  s_account uuid; j_id uuid; j_job jsonb;
  v_direct boolean;
BEGIN
  IF session_user <> 'platform_ops' THEN
    RAISE EXCEPTION 'setup_install_pr_record: platform_ops only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_setup IS NULL OR p_attempt IS NULL OR p_head IS NULL OR p_head !~ '^[0-9a-f]{40}$' OR (p_pr IS NOT NULL AND p_pr < 1) THEN
    RAISE EXCEPTION 'setup_install_pr_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT x.account_id INTO s_account FROM public.project_setups x WHERE x.id = p_setup AND x.phase = 'install' AND x.sub_step = 'push' AND x.state = 'ok' AND x.attempt = p_attempt AND x.install_head_sha = p_head AND x.install_pr IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT x.id, x.job INTO j_id, j_job FROM public.machine_jobs x WHERE x.account_id = s_account AND x.setup_id = p_setup AND x.attempt = p_attempt AND x.kind = 'project_setup' AND x.state = 'delivered' FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  v_direct := j_job #>> '{job,args,mode}' = 'direct';
  -- a pull request number goes with a pull request job and none with a direct one
  IF (p_pr IS NULL) IS DISTINCT FROM v_direct THEN RETURN false; END IF;
  UPDATE public.machine_jobs x SET state = 'done' WHERE x.account_id = s_account AND x.id = j_id;
  IF v_direct THEN
    UPDATE public.project_setups x SET phase = 'finish', failure_code = NULL, failure_reason = NULL, failure_at = NULL, updated_at = now() WHERE x.account_id = s_account AND x.id = p_setup;
  ELSE
    UPDATE public.project_setups x SET phase = 'await_merge', sub_step = 'pr_open', state = 'ok', install_pr = p_pr, failure_code = NULL, failure_reason = NULL, failure_at = NULL, updated_at = now() WHERE x.account_id = s_account AND x.id = p_setup;
  END IF;
  RETURN true;
END;
$$;

CREATE FUNCTION setup_install_pr_fail(p_setup uuid, p_attempt integer, p_head text, p_code text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  s_account uuid;
BEGIN
  IF session_user <> 'platform_ops' THEN
    RAISE EXCEPTION 'setup_install_pr_fail: platform_ops only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_setup IS NULL OR p_attempt IS NULL OR p_head IS NULL OR p_head !~ '^[0-9a-f]{40}$' OR p_code IS NULL OR p_code NOT IN ('install_head_changed', 'pr_scope_refused', 'pr_open_failed') THEN
    RAISE EXCEPTION 'setup_install_pr_fail: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT x.account_id INTO s_account FROM public.project_setups x WHERE x.id = p_setup AND x.phase = 'install' AND x.sub_step = 'push' AND x.state = 'ok' AND x.attempt = p_attempt AND x.install_head_sha = p_head AND x.install_pr IS NULL FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE public.machine_jobs x SET state = 'failed' WHERE x.account_id = s_account AND x.setup_id = p_setup AND x.attempt = p_attempt AND x.kind = 'project_setup' AND x.state = 'delivered';
  UPDATE public.project_setups x SET sub_step = 'pr_open', state = 'failed', failure_code = p_code, failure_reason = NULL, failure_at = now(), updated_at = now() WHERE x.account_id = s_account AND x.id = p_setup;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION setup_install_pr_claim() FROM PUBLIC;
REVOKE ALL ON FUNCTION setup_install_pr_pending() FROM PUBLIC;
REVOKE ALL ON FUNCTION setup_install_pr_record(uuid, integer, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION setup_install_pr_fail(uuid, integer, text, text) FROM PUBLIC;
ALTER FUNCTION setup_install_pr_claim() OWNER TO setup_install_definer;
ALTER FUNCTION setup_install_pr_pending() OWNER TO setup_install_definer;
ALTER FUNCTION setup_install_pr_record(uuid, integer, text, integer) OWNER TO setup_install_definer;
ALTER FUNCTION setup_install_pr_fail(uuid, integer, text, text) OWNER TO setup_install_definer;
GRANT EXECUTE ON FUNCTION setup_install_pr_claim() TO platform_ops;
GRANT EXECUTE ON FUNCTION setup_install_pr_pending() TO platform_ops;
GRANT EXECUTE ON FUNCTION setup_install_pr_record(uuid, integer, text, integer) TO platform_ops;
GRANT EXECUTE ON FUNCTION setup_install_pr_fail(uuid, integer, text, text) TO platform_ops;
REVOKE CREATE ON SCHEMA public FROM setup_install_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE setup_install_definer FROM CURRENT_USER;
  END IF;
END
$$;

INSERT INTO reconcile_jobs (name, interval_seconds) VALUES ('setup_install_pr', 900) ON CONFLICT (name) DO NOTHING;
