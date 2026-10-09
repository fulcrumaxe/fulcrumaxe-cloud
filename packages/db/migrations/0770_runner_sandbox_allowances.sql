-- D#6 R7a (correction C35 section 3.4): the signed, per-repo sandbox allowances a runner job may carry.
--
--   repo_runner_sandbox_allowances      append-only: one row per approval of a repo's allowance set (or per set-aside), newest version
--                                       wins. A row holds the approved entries, the command timeout, the sha256 of the set and who
--                                       approved it. Nothing here is read from the repository: an owner or admin of the account
--                                       uploads the reviewed file in repo settings, and what the cloud stores is what that person sent.
--   repo_runner_sandbox_allowances_write(repo, action, entries, timeout, sha256)
--                                       the one writer. 'approve' appends the next version (an empty set is allowed and is the safe
--                                       direction); 'set_aside' appends a row that ignores the last approved set, which is what
--                                       leaving runner_local does, so a repo that comes back must be approved again (C15 section 4).
--
-- Both write one audit row naming the actor, the repo, the version and the set's sha256, an empty set included (approving an empty
-- set is an explicit act, and the safe one). A repeat that changes nothing (approving the set already in force, setting aside what
-- is already set aside or empty) writes nothing and answers changed = false.
--
-- What this migration does NOT check: the floor (which paths, sockets and domains may never be granted). That list is one constant
-- in runner-protocol, applied by the route before it calls the writer and again by the job issuer before it signs; the runner applies
-- it a third time. The database holds the shape (an array of at most 64 entries, a timeout of 1 to 1800 seconds exactly when the
-- set is not empty) and the append-only rule.
--
-- Who may touch it: platform_ops holds NOTHING on the table and gains nothing anywhere. The function and the rows are owned by a
-- role of its own, runner_allowance_definer, in the shape of 0763's runner_sandbox_status_definer: NOLOGIN, no members (the
-- migration role holds it only inside this file), a member of nothing, column grants for exactly what the body reads and writes, row
-- policies for this role only, a pinned search_path, EXECUTE for app_user alone. app_user may read the table (its tenant policy), a
-- member included; nothing writes it but the function. The job issuer's login reads it through the same app_user grant and policy
-- (it is a member of app_user, as it is for the repos and spec rows it already reads), so it can read it and write nothing.
--
-- Numbered above the highest migration claimed (0768 is another PR's). Re-check against main right before merging (C7 section 4).
--
-- Refusals use fixed SQLSTATEs and messages, never an argument value: 42501 not permitted, P0002 no such repo, 22023 invalid argument.
DO $$
DECLARE
  n text := 'runner_allowance_definer';
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

CREATE TABLE repo_runner_sandbox_allowances (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL,
  repo_id            uuid NOT NULL,
  version            integer NOT NULL CHECK (version >= 1),
  entries            jsonb NOT NULL,
  command_timeout_s  integer,
  set_sha256         text NOT NULL,
  set_aside          boolean NOT NULL DEFAULT false,
  approved_by        uuid NOT NULL REFERENCES users (id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, repo_id, version),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE,
  CONSTRAINT repo_runner_sandbox_allowances_entries_check CHECK (jsonb_typeof(entries) = 'array' AND jsonb_array_length(entries) <= 64),
  CONSTRAINT repo_runner_sandbox_allowances_sha_check CHECK (set_sha256 ~ '^[0-9a-f]{64}$'),
  -- A timeout rides with a set that has entries and with nothing else: an empty set signs nothing, so it has nothing to time.
  CONSTRAINT repo_runner_sandbox_allowances_timeout_check CHECK (
    (jsonb_array_length(entries) = 0 AND command_timeout_s IS NULL)
    OR (jsonb_array_length(entries) > 0 AND command_timeout_s IS NOT NULL AND command_timeout_s BETWEEN 1 AND 1800)
  )
);
ALTER TABLE repo_runner_sandbox_allowances ENABLE ROW LEVEL SECURITY;
ALTER TABLE repo_runner_sandbox_allowances FORCE ROW LEVEL SECURITY;

-- What the body reads and writes, column by column. repos: that the repo is the account's. account_members: the caller's own row.
-- accounts: that the account is active.
GRANT USAGE ON SCHEMA public TO runner_allowance_definer;
GRANT SELECT (account_id, repo_id, version, entries, command_timeout_s, set_sha256, set_aside),
      INSERT (account_id, repo_id, version, entries, command_timeout_s, set_sha256, set_aside, approved_by) ON repo_runner_sandbox_allowances TO runner_allowance_definer;
GRANT SELECT (id, account_id) ON repos TO runner_allowance_definer;
GRANT SELECT (account_id, user_id, role) ON account_members TO runner_allowance_definer;
GRANT SELECT (id, deleted_at) ON accounts TO runner_allowance_definer;
GRANT INSERT (account_id, actor, action, payload, created_at) ON audit_log TO runner_allowance_definer;

-- Read only, for the tenant: the settings screen (any member) and the job issuer. No write for either.
GRANT SELECT (account_id, repo_id, version, entries, command_timeout_s, set_sha256, set_aside, approved_by, created_at) ON repo_runner_sandbox_allowances TO app_user;

CREATE POLICY tenant_isolation_select ON repo_runner_sandbox_allowances FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY runner_allowance_definer_select ON repo_runner_sandbox_allowances FOR SELECT TO runner_allowance_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_allowance_definer_insert ON repo_runner_sandbox_allowances FOR INSERT TO runner_allowance_definer
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND approved_by = NULLIF(current_setting('app.user_id', true), '')::uuid
    AND EXISTS (SELECT 1 FROM account_members m WHERE m.account_id = repo_runner_sandbox_allowances.account_id AND m.user_id = repo_runner_sandbox_allowances.approved_by)
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY runner_allowance_definer_select ON repos FOR SELECT TO runner_allowance_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
-- Shows this role only the caller's own membership row, as 0757 and 0759 do.
CREATE POLICY runner_allowance_definer_select ON account_members FOR SELECT TO runner_allowance_definer
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  );
CREATE POLICY runner_allowance_definer_select ON accounts FOR SELECT TO runner_allowance_definer USING (true);
CREATE POLICY runner_allowance_definer_audit ON audit_log FOR INSERT TO runner_allowance_definer
  WITH CHECK (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND action IN ('repo.runner_sandbox_allowances.approved', 'repo.runner_sandbox_allowances.set_aside')
  );

-- Ownership bracket (0763's shape): a non-superuser migrator needs SET on the role for ALTER ... OWNER TO, and the role has CREATE on
-- public only for that transfer. Both are reset at the end.
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

CREATE FUNCTION repo_runner_sandbox_allowances_write(p_repo_id uuid, p_action text, p_entries jsonb, p_command_timeout_s integer, p_set_sha256 text)
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
       OR (p_command_timeout_s IS NOT NULL AND p_command_timeout_s NOT BETWEEN 1 AND 1800) THEN
      RAISE EXCEPTION 'repo_runner_sandbox_allowances_write: invalid argument' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSIF p_entries IS NOT NULL OR p_command_timeout_s IS NOT NULL OR p_set_sha256 IS NOT NULL THEN
    RAISE EXCEPTION 'repo_runner_sandbox_allowances_write: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM 1 FROM public.repos r WHERE r.id = p_repo_id AND r.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'repo_runner_sandbox_allowances_write: no such repo' USING ERRCODE = 'no_data_found';
  END IF;

  -- One writer per repo, so the next version cannot be raced.
  PERFORM pg_advisory_xact_lock(hashtextextended('runner_sandbox_allowances:' || p_repo_id::text, 0));
  SELECT a.version, a.entries, a.command_timeout_s, a.set_sha256, a.set_aside INTO v_version, v_entries, v_timeout, v_sha, v_aside
    FROM public.repo_runner_sandbox_allowances a WHERE a.account_id = acct AND a.repo_id = p_repo_id
   ORDER BY a.version DESC LIMIT 1;

  IF p_action = 'approve' THEN
    -- The set already in force: nothing to write.
    IF v_version IS NOT NULL AND NOT v_aside AND v_sha = p_set_sha256 THEN
      RETURN QUERY SELECT false, v_version;
      RETURN;
    END IF;
    INSERT INTO public.repo_runner_sandbox_allowances (account_id, repo_id, version, entries, command_timeout_s, set_sha256, set_aside, approved_by)
    VALUES (acct, p_repo_id, COALESCE(v_version, 0) + 1, p_entries, p_command_timeout_s, p_set_sha256, false, usr);
    INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
    VALUES (acct, usr::text, 'repo.runner_sandbox_allowances.approved',
            jsonb_build_object('repo_id', p_repo_id, 'version', COALESCE(v_version, 0) + 1, 'set_sha256', p_set_sha256,
                               'entry_count', jsonb_array_length(p_entries), 'command_timeout_s', p_command_timeout_s,
                               'previous_set_sha256', CASE WHEN v_aside THEN NULL ELSE v_sha END),
            clock_timestamp());
    RETURN QUERY SELECT true, COALESCE(v_version, 0) + 1;
    RETURN;
  END IF;

  -- set_aside: only a set that is in force and has entries is set aside.
  IF v_version IS NULL OR v_aside OR jsonb_array_length(v_entries) = 0 THEN
    RETURN QUERY SELECT false, COALESCE(v_version, 0);
    RETURN;
  END IF;
  INSERT INTO public.repo_runner_sandbox_allowances (account_id, repo_id, version, entries, command_timeout_s, set_sha256, set_aside, approved_by)
  VALUES (acct, p_repo_id, v_version + 1, v_entries, v_timeout, v_sha, true, usr);
  INSERT INTO public.audit_log (account_id, actor, action, payload, created_at)
  VALUES (acct, usr::text, 'repo.runner_sandbox_allowances.set_aside',
          jsonb_build_object('repo_id', p_repo_id, 'version', v_version + 1, 'set_sha256', v_sha), clock_timestamp());
  RETURN QUERY SELECT true, v_version + 1;
END;
$$;

REVOKE ALL ON FUNCTION repo_runner_sandbox_allowances_write(uuid, text, jsonb, integer, text) FROM PUBLIC;
ALTER FUNCTION repo_runner_sandbox_allowances_write(uuid, text, jsonb, integer, text) OWNER TO runner_allowance_definer;
-- EXECUTE after the transfer (a transfer rewrites the ACL entries that named the old owner), to app_user alone.
GRANT EXECUTE ON FUNCTION repo_runner_sandbox_allowances_write(uuid, text, jsonb, integer, text) TO app_user;
REVOKE CREATE ON SCHEMA public FROM runner_allowance_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_allowance_definer FROM CURRENT_USER;
  END IF;
END
$$;
