-- D#519 MQ4-b0: a record of every branch push the platform makes through the gh-proxy, so the merge queue can prove a pull request's commit is the
-- platform's own (it is when a record covers it) instead of trusting a git name, email or unsigned login, any of which a person with push access can set.
--
-- 1. platform_ref_pushes: one append-only row per ref update the proxy forwarded and GitHub answered 200. Who pushed (account, repository, item, run,
--    runtime, start commit) is copied from the run's own row by the function below; nothing the caller says about them is used. created_at is the
--    database clock. app_user may SELECT its own tenant's rows and nothing else: no INSERT, UPDATE or DELETE.
-- 2. record_platform_ref_push(p_sandbox_name, p_run_id, p_ref, p_old, p_new): the proxy's one write. Exactly one key names the run: a sandbox name (the
--    one live run with that name, the 0707/0908 rule) or a runner_verified run id from a ticket the proxy has verified. Anything else is 22023. It
--    records nothing (answers false) for a run that is not live, a role that may not push (plane_publish pushes go to the paired public repository and
--    are left to MQ4-e1), a run with no repository, and a delete (zero new id). A zero old id (the push made the branch) is stored as null.
-- 3. Privileges: a NEW role, platform_push_recorder (NOLOGIN, no members, a member of nothing; the 0908 shape), owns the function. It holds column
--    SELECT on what the body reads of agent_runs, INSERT on the new table, and a row policy of its own on each. EXECUTE goes to run_binding_resolver
--    alone, so the proxy login gains exactly this one function. platform_ops gains nothing.
--
-- Rollback: additive only (a role, a table, a function, grants, policies). If reverted, the proxy stops recording and the reader finds no rows, so every
-- commit reads as foreign (fail closed). Nothing is rewritten or dropped.
--
-- Numbered above the highest migration on the code plane (0953); 0954 and 0955 are held by open changes. Re-check against main right before merging.

DO $$
DECLARE
  n text := 'platform_push_recorder';
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

CREATE TABLE platform_ref_pushes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  repo_id      uuid NOT NULL,
  work_item_id uuid,
  run_id       uuid NOT NULL,
  runtime      text NOT NULL CONSTRAINT platform_ref_pushes_runtime_check CHECK (runtime ~ '^[a-z][a-z_]{0,31}$'),
  ref          text NOT NULL CONSTRAINT platform_ref_pushes_ref_check CHECK (ref ~ '^refs/heads/' AND char_length(ref) <= 255 AND ref !~ '[[:cntrl:]]'),
  -- Null when the push created the branch.
  old_sha      text CONSTRAINT platform_ref_pushes_old_check CHECK (old_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$' AND old_sha !~ '^0+$'),
  new_sha      text NOT NULL CONSTRAINT platform_ref_pushes_new_check CHECK (new_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$' AND new_sha !~ '^0+$'),
  -- The run's recorded start commit; null when it started from the default branch.
  start_sha    text CONSTRAINT platform_ref_pushes_start_check CHECK (start_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE
);
CREATE INDEX platform_ref_pushes_lookup ON platform_ref_pushes (account_id, repo_id, new_sha);

CREATE FUNCTION platform_ref_pushes_clock() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  NEW.created_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION platform_ref_pushes_clock() FROM PUBLIC;
CREATE TRIGGER platform_ref_pushes_clock BEFORE INSERT ON platform_ref_pushes FOR EACH ROW EXECUTE FUNCTION platform_ref_pushes_clock();

ALTER TABLE platform_ref_pushes ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_ref_pushes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform_ref_pushes FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
REVOKE ALL ON platform_ref_pushes FROM PUBLIC;
GRANT SELECT ON platform_ref_pushes TO app_user;

-- ---- what the function reads and writes -----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO platform_push_recorder;
GRANT SELECT (id, account_id, work_item_id, role, status, runtime, execution_mode, sandbox_name, dispatch_repo_id, head_sha) ON agent_runs TO platform_push_recorder;
GRANT INSERT ON platform_ref_pushes TO platform_push_recorder;
CREATE POLICY platform_push_recorder_select ON agent_runs FOR SELECT TO platform_push_recorder USING (true);
CREATE POLICY platform_push_recorder_insert ON platform_ref_pushes FOR INSERT TO platform_push_recorder WITH CHECK (true);

CREATE FUNCTION record_platform_ref_push(p_sandbox_name text, p_run_id uuid, p_ref text, p_old text, p_new text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_run record;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'record_platform_ref_push: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (p_sandbox_name IS NULL) = (p_run_id IS NULL) OR p_sandbox_name = ''
     OR p_ref IS NULL OR p_ref !~ '^refs/heads/' OR char_length(p_ref) > 255 OR p_ref ~ '[[:cntrl:]]'
     OR p_new IS NULL OR p_new !~ '^([0-9a-f]{40}|[0-9a-f]{64})$'
     OR (p_old IS NOT NULL AND p_old !~ '^([0-9a-f]{40}|[0-9a-f]{64})$') THEN
    RAISE EXCEPTION 'record_platform_ref_push: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_new ~ '^0+$' THEN
    RETURN false;
  END IF;

  IF p_sandbox_name IS NOT NULL THEN
    SELECT a.id, a.account_id, a.work_item_id, a.role, a.runtime, a.dispatch_repo_id, a.head_sha INTO v_run
      FROM public.agent_runs a
     WHERE a.sandbox_name = p_sandbox_name AND a.status IN ('pending', 'running', 'paused')
       AND a.runtime <> 'runner' AND coalesce(a.execution_mode, 'sandbox') = 'sandbox'
       AND (SELECT count(*) FROM public.agent_runs b WHERE b.sandbox_name = p_sandbox_name AND b.status IN ('pending', 'running', 'paused')) = 1;
  ELSE
    SELECT a.id, a.account_id, a.work_item_id, a.role, a.runtime, a.dispatch_repo_id, a.head_sha INTO v_run
      FROM public.agent_runs a
     WHERE a.id = p_run_id AND a.status = 'running' AND a.runtime = 'runner' AND a.execution_mode = 'runner_verified';
  END IF;
  IF NOT FOUND OR v_run.dispatch_repo_id IS NULL OR NOT coalesce(v_run.role IN ('executor', 'docs-writer', 'release-manager', 'runbook-writer'), false) THEN
    RETURN false;
  END IF;

  INSERT INTO public.platform_ref_pushes (account_id, repo_id, work_item_id, run_id, runtime, ref, old_sha, new_sha, start_sha)
  VALUES (v_run.account_id, v_run.dispatch_repo_id, v_run.work_item_id, v_run.id, v_run.runtime, p_ref,
          CASE WHEN p_old IS NULL OR p_old ~ '^0+$' THEN NULL ELSE p_old END, p_new,
          CASE WHEN v_run.head_sha ~ '^([0-9a-f]{40}|[0-9a-f]{64})$' THEN v_run.head_sha END);
  RETURN true;
END;
$$;

-- ---- ownership brackets (the shape 0908 used) -----------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'platform_push_recorder'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on platform_push_recorder; cannot ALTER FUNCTION ... OWNER TO platform_push_recorder';
    END IF;
    GRANT platform_push_recorder TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO platform_push_recorder;

REVOKE ALL ON FUNCTION record_platform_ref_push(text, uuid, text, text, text) FROM PUBLIC;
ALTER FUNCTION record_platform_ref_push(text, uuid, text, text, text) OWNER TO platform_push_recorder;
-- EXECUTE is granted after the transfer: changing an owner rewrites the ACL entries that named the old one.
GRANT EXECUTE ON FUNCTION record_platform_ref_push(text, uuid, text, text, text) TO run_binding_resolver;

REVOKE CREATE ON SCHEMA public FROM platform_push_recorder;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE platform_push_recorder FROM CURRENT_USER;
  END IF;
END
$$;
