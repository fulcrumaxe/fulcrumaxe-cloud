-- D#6 R-CHK-1 (correction C47): the repo's approved check, stored beside its sandbox allowances.
--
-- A check is the one command a runner is told to run after the agent's last turn: an argument vector, whether it runs inside the job's dev shell, and its own
-- time cap (60 to 10800 seconds, apart from the 1800 second per-command cap). It belongs to the same owner or admin approval as the allowance set, so it is three
-- more columns on repo_runner_sandbox_allowances (0770), all null or all set, and the one writer gains three arguments. Append-only as before: removing a check is
-- approving a set without one, which is a new version. Setting the allowances aside (leaving runner_local) sets the check aside with them, since they are one row.
--
--   check_argv text[]        1 to 16 elements, each 1 to 256 printable ASCII characters (runner_check_argv_ok, below). A vector, never a shell string.
--   check_dev_shell boolean  run it inside the dev shell the job prepared.
--   check_timeout_s integer  60 to 10800.
--
-- The writer keeps its name and gains check_argv, check_dev_shell and check_timeout_s with DEFAULT NULL, so the previous deploy's five-argument call still
-- resolves (to a set without a check) while a rolling deploy is under way. The old five-argument signature is dropped: leaving both would make that call ambiguous.
-- The floor for the command itself is not a list of programs: an owner or admin approves it knowing what it is, the Repos app shows it as written, and only the
-- shape is enforced here and again in runner-protocol and by the runner.
--
-- Second change: agent_runs_runner_columns_guard (0805) refuses a first job write that carries a check but a minimum protocol below 8, in the same way it refuses
-- the cross-side shape with none. The claim definer already refuses a runner below a run's minimum (0805), so a job with a check cannot reach an older runner even if
-- the issuer forgot the minimum. Everything else in the guard is word for word the 0805 body.
--
-- Grants: runner_allowance_definer gains SELECT and INSERT on the three columns (six column grants, 34 in all) and EXECUTE on the shape function; app_user gains SELECT
-- on the columns (the settings screen and the job issuer read them). platform_ops gains NOTHING. The function runs as the caller, owns no table and is not a definer.
--
-- Numbered above the highest migration claimed (0884, 0885 and 0886 are other PRs'). Re-check against main right before merging.
ALTER TABLE repo_runner_sandbox_allowances
  ADD COLUMN check_argv text[],
  ADD COLUMN check_dev_shell boolean,
  ADD COLUMN check_timeout_s integer;

CREATE FUNCTION runner_check_argv_ok(p_argv text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_argv IS NOT NULL AND array_ndims(p_argv) = 1 AND cardinality(p_argv) BETWEEN 1 AND 16
     AND NOT EXISTS (SELECT 1 FROM unnest(p_argv) a WHERE a IS NULL OR char_length(a) NOT BETWEEN 1 AND 256 OR a !~ '^[ -~]+$')
$$;
REVOKE ALL ON FUNCTION runner_check_argv_ok(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_check_argv_ok(text[]) TO runner_allowance_definer;

ALTER TABLE repo_runner_sandbox_allowances ADD CONSTRAINT repo_runner_sandbox_allowances_check_check CHECK (
  (check_argv IS NULL AND check_dev_shell IS NULL AND check_timeout_s IS NULL)
  OR (runner_check_argv_ok(check_argv) AND check_dev_shell IS NOT NULL AND check_timeout_s IS NOT NULL AND check_timeout_s BETWEEN 60 AND 10800)
);

GRANT SELECT (check_argv, check_dev_shell, check_timeout_s), INSERT (check_argv, check_dev_shell, check_timeout_s) ON repo_runner_sandbox_allowances TO runner_allowance_definer;
GRANT SELECT (check_argv, check_dev_shell, check_timeout_s) ON repo_runner_sandbox_allowances TO app_user;

-- ---- the guard: a job with a check needs a minimum protocol ---------------------------------------------------------
CREATE OR REPLACE FUNCTION agent_runs_runner_columns_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF session_user = 'platform_ops' AND NEW.job_signed IS DISTINCT FROM OLD.job_signed THEN
    RAISE EXCEPTION 'agent_runs: platform_ops may not write job_signed; use agent_run_set_runner_job'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW.initiated_by IS DISTINCT FROM OLD.initiated_by THEN
    RAISE EXCEPTION 'agent_runs.initiated_by is written at insert only (run %)', OLD.id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.job_signed IS NOT NULL AND NEW.job_signed IS DISTINCT FROM OLD.job_signed THEN
    RAISE EXCEPTION 'agent_runs.job_signed is write-once (run %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  -- D#599 PL-2b-1: the job's lowest runner protocol is set with the job and never again.
  IF OLD.job_signed IS NULL AND NEW.job_signed IS NOT NULL THEN
    NEW.min_protocol_version := NULLIF(current_setting('fx.job_min_protocol', true), '')::integer;
    -- Defence in depth: a first write in the cross-side shape (a null session id, or a pull request number) with no minimum would be open to every runner.
    IF NEW.min_protocol_version IS NULL
       AND jsonb_typeof(NEW.job_signed #> '{job,continues}') = 'object'
       AND (jsonb_typeof(NEW.job_signed #> '{job,continues,session_id}') = 'null' OR (NEW.job_signed #> '{job,continues}') ? 'pr_number')
    THEN
      RAISE EXCEPTION 'agent_runs.job_signed in the cross-side shape needs a minimum protocol version (run %)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    -- D#6 R-CHK-1: the same for a job that carries the repo's approved check. Protocol 8 is the first whose runner can be given one (CHECK_JOB_MIN_PROTOCOL).
    IF jsonb_typeof(NEW.job_signed #> '{job,check}') = 'object' AND COALESCE(NEW.min_protocol_version, 0) < 8 THEN
      RAISE EXCEPTION 'agent_runs.job_signed with a check needs a minimum protocol version of 8 (run %)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.min_protocol_version IS DISTINCT FROM OLD.min_protocol_version THEN
    RAISE EXCEPTION 'agent_runs.min_protocol_version is written with the job and never changed (run %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- ---- the writer: three more arguments --------------------------------------------------------------------------------
-- Ownership bracket (0770's shape): a non-superuser migrator needs SET on the role for ALTER ... OWNER TO, and the role has CREATE on public only for that
-- transfer. Both are reset at the end.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'runner_allowance_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_allowance_definer; cannot ALTER FUNCTION ... OWNER TO runner_allowance_definer';
    END IF;
    GRANT runner_allowance_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO runner_allowance_definer;

DROP FUNCTION repo_runner_sandbox_allowances_write(uuid, text, jsonb, integer, text);

CREATE FUNCTION repo_runner_sandbox_allowances_write(
  p_repo_id uuid, p_action text, p_entries jsonb, p_command_timeout_s integer, p_set_sha256 text,
  p_check_argv text[] DEFAULT NULL, p_check_dev_shell boolean DEFAULT NULL, p_check_timeout_s integer DEFAULT NULL
)
RETURNS TABLE (changed boolean, set_version integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct       uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr        uuid;
  v_role     text;
  v_version  integer;
  v_entries  jsonb;
  v_timeout  integer;
  v_sha      text;
  v_aside    boolean;
  v_argv     text[];
  v_dev      boolean;
  v_ctimeout integer;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'repo_runner_sandbox_allowances_write: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'repo_runner_sandbox_allowances_write: caller is not an owner or admin of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_repo_id IS NULL OR p_action IS NULL OR p_action NOT IN ('approve', 'set_aside') THEN
    RAISE EXCEPTION 'repo_runner_sandbox_allowances_write: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_action = 'approve' THEN
    IF p_entries IS NULL OR jsonb_typeof(p_entries) IS DISTINCT FROM 'array' OR jsonb_array_length(p_entries) > 64
       OR p_set_sha256 IS NULL OR p_set_sha256 !~ '^[0-9a-f]{64}$'
       OR (jsonb_array_length(p_entries) = 0) IS DISTINCT FROM (p_command_timeout_s IS NULL)
       OR (p_command_timeout_s IS NOT NULL AND p_command_timeout_s NOT BETWEEN 1 AND 1800)
       -- The check is all or nothing, and holds the shape the table's CHECK holds.
       OR (p_check_argv IS NULL) IS DISTINCT FROM (p_check_dev_shell IS NULL) OR (p_check_argv IS NULL) IS DISTINCT FROM (p_check_timeout_s IS NULL)
       OR (p_check_argv IS NOT NULL AND (NOT runner_check_argv_ok(p_check_argv) OR p_check_timeout_s NOT BETWEEN 60 AND 10800)) THEN
      RAISE EXCEPTION 'repo_runner_sandbox_allowances_write: invalid argument' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSIF p_entries IS NOT NULL OR p_command_timeout_s IS NOT NULL OR p_set_sha256 IS NOT NULL
        OR p_check_argv IS NOT NULL OR p_check_dev_shell IS NOT NULL OR p_check_timeout_s IS NOT NULL THEN
    RAISE EXCEPTION 'repo_runner_sandbox_allowances_write: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM 1 FROM public.repos r WHERE r.id = p_repo_id AND r.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'repo_runner_sandbox_allowances_write: no such repo' USING ERRCODE = 'no_data_found';
  END IF;

  -- One writer per repo, so the next version cannot be raced.
  PERFORM pg_advisory_xact_lock(hashtextextended('runner_sandbox_allowances:' || p_repo_id::text, 0));
  SELECT a.version, a.entries, a.command_timeout_s, a.set_sha256, a.set_aside, a.check_argv, a.check_dev_shell, a.check_timeout_s
    INTO v_version, v_entries, v_timeout, v_sha, v_aside, v_argv, v_dev, v_ctimeout
    FROM public.repo_runner_sandbox_allowances a WHERE a.account_id = acct AND a.repo_id = p_repo_id
   ORDER BY a.version DESC LIMIT 1;

  IF p_action = 'approve' THEN
    -- The set already in force (its hash covers the check): nothing to write.
    IF v_version IS NOT NULL AND NOT v_aside AND v_sha = p_set_sha256 THEN
      RETURN QUERY SELECT false, v_version;
      RETURN;
    END IF;
    INSERT INTO public.repo_runner_sandbox_allowances (account_id, repo_id, version, entries, command_timeout_s, set_sha256, set_aside, approved_by, check_argv, check_dev_shell, check_timeout_s)
    VALUES (acct, p_repo_id, COALESCE(v_version, 0) + 1, p_entries, p_command_timeout_s, p_set_sha256, false, usr, p_check_argv, p_check_dev_shell, p_check_timeout_s);
    INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
    VALUES (acct, usr::text, 'repo.runner_sandbox_allowances.approved',
            jsonb_build_object('repo_id', p_repo_id, 'version', COALESCE(v_version, 0) + 1, 'set_sha256', p_set_sha256,
                               'entry_count', jsonb_array_length(p_entries), 'command_timeout_s', p_command_timeout_s,
                               'previous_set_sha256', CASE WHEN v_aside THEN NULL ELSE v_sha END)
            -- The command an admin approved is on the audit record, not only the hash: it is what a customer's machine is told to run. A set with no check
            -- writes the payload it always did.
            || CASE WHEN p_check_argv IS NULL THEN '{}'::jsonb
                    ELSE jsonb_build_object('check', jsonb_build_object('argv', to_jsonb(p_check_argv), 'dev_shell', p_check_dev_shell, 'timeout_s', p_check_timeout_s)) END,
            clock_timestamp());
    RETURN QUERY SELECT true, COALESCE(v_version, 0) + 1;
    RETURN;
  END IF;

  -- set_aside: only a set that is in force and has entries or a check is set aside.
  IF v_version IS NULL OR v_aside OR (jsonb_array_length(v_entries) = 0 AND v_argv IS NULL) THEN
    RETURN QUERY SELECT false, COALESCE(v_version, 0);
    RETURN;
  END IF;
  INSERT INTO public.repo_runner_sandbox_allowances (account_id, repo_id, version, entries, command_timeout_s, set_sha256, set_aside, approved_by, check_argv, check_dev_shell, check_timeout_s)
  VALUES (acct, p_repo_id, v_version + 1, v_entries, v_timeout, v_sha, true, usr, v_argv, v_dev, v_ctimeout);
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, 'repo.runner_sandbox_allowances.set_aside',
          jsonb_build_object('repo_id', p_repo_id, 'version', v_version + 1, 'set_sha256', v_sha), clock_timestamp());
  RETURN QUERY SELECT true, v_version + 1;
END;
$$;

REVOKE ALL ON FUNCTION repo_runner_sandbox_allowances_write(uuid, text, jsonb, integer, text, text[], boolean, integer) FROM PUBLIC;
ALTER FUNCTION repo_runner_sandbox_allowances_write(uuid, text, jsonb, integer, text, text[], boolean, integer) OWNER TO runner_allowance_definer;
-- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner), to app_user alone.
GRANT EXECUTE ON FUNCTION repo_runner_sandbox_allowances_write(uuid, text, jsonb, integer, text, text[], boolean, integer) TO app_user;
REVOKE CREATE ON SCHEMA public FROM runner_allowance_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_allowance_definer FROM CURRENT_USER;
  END IF;
END
$$;
