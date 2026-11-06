-- D#601 MEM-5b: the per-file state of a repository's CLAUDE.md / AGENTS.md import, and the durable "this file is due" mark.
--
-- A connect, or a push to the default branch whose changed paths name one of the two files, sets due_at (the webhook makes no GitHub call). The
-- existing setup-request-check sweep lists the rows whose time has come, takes each under a five-minute lease, reads the file outside the database,
-- imports it as memory proposals, and writes the outcome here in one statement. One row per repo and file; it goes with the repository.
--
--   due_at         NULL while nothing is due; a failure that may pass backs off by moving it, one that will not pass clears it until a push or connect
--   file_sha       the blob sha of the file at the last successful import, NULL if the file was absent
--   source_commit  the default-branch commit that import read
--   truncated      the last import read only the first 32 KiB (the Memory screens say so)
--   last_error     closed code of the last failed read or import, NULL after a success
--
-- app_user reads and inserts its own account's rows and updates the state columns, and cannot delete. The cross-account list the sweep starts from
-- is repo_instruction_list_due, owned by the existing setup_request_lister role (0874) and executable by the run-writer login alone; it sees
-- no sha, commit or error. Expand-only. Numbered above the highest migration on the code plane; re-checked right before merge.

CREATE TABLE repo_instruction_files (
  repo_id        uuid NOT NULL,
  path           text NOT NULL CONSTRAINT repo_instruction_files_path_check CHECK (path IN ('CLAUDE.md', 'AGENTS.md')),
  account_id     uuid NOT NULL,
  due_at         timestamptz,
  file_sha       text CONSTRAINT repo_instruction_files_sha_check CHECK (file_sha IS NULL OR file_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  source_commit  text CONSTRAINT repo_instruction_files_commit_check CHECK (source_commit IS NULL OR source_commit ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  truncated      boolean NOT NULL DEFAULT false,
  last_error     text CONSTRAINT repo_instruction_files_error_check CHECK (last_error IS NULL OR last_error IN (
    'repo_not_connected', 'app_permission_missing', 'token_not_read_only', 'github_unavailable', 'rate_limited_by_github', 'plan_file_too_large',
    'request_refused', 'request_budget_exceeded', 'repo_unready', 'import_failed')),
  error_streak   integer NOT NULL DEFAULT 0 CONSTRAINT repo_instruction_files_streak_check CHECK (error_streak >= 0),
  checked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_id, path),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE
);
CREATE INDEX idx_repo_instruction_files_due ON repo_instruction_files (due_at) INCLUDE (account_id, repo_id, path) WHERE due_at IS NOT NULL;

ALTER TABLE repo_instruction_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE repo_instruction_files FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON repo_instruction_files TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  )
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
GRANT SELECT, INSERT ON repo_instruction_files TO app_user;
GRANT UPDATE (due_at, file_sha, source_commit, truncated, last_error, error_streak, checked_at) ON repo_instruction_files TO app_user;

GRANT SELECT (repo_id, path, account_id, due_at) ON repo_instruction_files TO setup_request_lister;
CREATE POLICY setup_request_lister_select ON repo_instruction_files FOR SELECT TO setup_request_lister USING (due_at IS NOT NULL);

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'setup_request_lister'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on setup_request_lister; cannot ALTER FUNCTION ... OWNER TO setup_request_lister';
    END IF;
    GRANT setup_request_lister TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

GRANT CREATE ON SCHEMA public TO setup_request_lister;

-- Every file with a due_at (due now or later), earliest first: the sweep runs the ones whose time has come and asks for the next tick at the earliest of the rest.
CREATE FUNCTION repo_instruction_list_due(p_limit int)
RETURNS TABLE (account_id uuid, repo_id uuid, path text, due_at timestamptz, due_now boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'repo_instruction_list_due: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'repo_instruction_list_due: bad argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT c.account_id, c.repo_id, c.path, c.due_at, c.due_at <= now()
    FROM public.repo_instruction_files c
    JOIN public.accounts a ON a.id = c.account_id AND a.deleted_at IS NULL
   WHERE c.due_at IS NOT NULL
   ORDER BY c.due_at, c.repo_id, c.path
   LIMIT p_limit;
END $$;

REVOKE ALL ON FUNCTION repo_instruction_list_due(int) FROM PUBLIC;
ALTER FUNCTION repo_instruction_list_due(int) OWNER TO setup_request_lister;
GRANT EXECUTE ON FUNCTION repo_instruction_list_due(int) TO agent_run_writer;
REVOKE CREATE ON SCHEMA public FROM setup_request_lister;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE setup_request_lister FROM CURRENT_USER;
  END IF;
END
$$;
