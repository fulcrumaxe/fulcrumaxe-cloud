-- D#6 R4a-6 (correction C16 section 1.3): a runner whose sandbox does not start says so on its claim poll, and the cloud keeps the reason.
--
--   runner_sandbox_status               one row per runner whose sandbox is not working: the reason (one of five closed codes) and when it
--                                       was last reported. No row means the sandbox works. A table of its own, not a column of runners:
--                                       platform_ops holds a table-wide SELECT/INSERT/UPDATE/DELETE on runners (0711), and a new column
--                                       would have inherited it. 0754 kept its claim stamp in a side table for the same reason.
--   runner_sandbox_status_record(reason)  sets (upserts) or, for NULL, clears the row of the runner named by app.runner_id (which only
--                                       the signature-verifying runner middleware sets). An equal reason writes nothing; clearing a
--                                       row that is not there writes nothing.
--
-- Numbered after 0760 on main, and after 0761 and 0762 held by open pull requests; it merges after both (merge-monotonic).
--
-- Who may touch it: platform_ops holds NOTHING on the table and gains nothing anywhere (no table grant, no policy, no function). The
-- function and the rows are owned by a new role of its own, runner_sandbox_status_definer, in the shape of 0757's runner_approval_definer:
-- NOLOGIN, no members (the migration role holds it only inside this file), a member of nothing, column-level grants for exactly what the
-- body reads and writes, row policies for this role only, a pinned search_path, and EXECUTE for app_user alone. app_user may read the
-- reason, column by column and only for its own tenant, for the runner list; it cannot write it.
DO $$
DECLARE
  n text := 'runner_sandbox_status_definer';
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

CREATE TABLE runner_sandbox_status (
  runner_id   uuid PRIMARY KEY,
  account_id  uuid NOT NULL,
  reason      text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE CASCADE,
  CONSTRAINT runner_sandbox_status_reason_check CHECK (
    reason IN ('bwrap_missing', 'socat_missing', 'userns_disabled', 'apparmor_userns_restricted', 'probe_failed_other')
  )
);
ALTER TABLE runner_sandbox_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE runner_sandbox_status FORCE ROW LEVEL SECURITY;

-- What the body reads and writes, column by column. runners: that the session's runner exists in the account and is not revoked.
-- accounts: that the account is active (what account_is_active reads).
GRANT USAGE ON SCHEMA public TO runner_sandbox_status_definer;
GRANT SELECT (runner_id, account_id, reason), INSERT (runner_id, account_id, reason, updated_at), UPDATE (reason, updated_at), DELETE ON runner_sandbox_status TO runner_sandbox_status_definer;
GRANT SELECT (id, account_id, revoked_at) ON runners TO runner_sandbox_status_definer;
GRANT SELECT (id, deleted_at) ON accounts TO runner_sandbox_status_definer;
-- The runner list reads the reason under the tenant's own row policy; nothing else, and no write.
GRANT SELECT (runner_id, account_id, reason) ON runner_sandbox_status TO app_user;

CREATE POLICY tenant_isolation_select ON runner_sandbox_status FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY runner_sandbox_status_definer_select ON runner_sandbox_status FOR SELECT TO runner_sandbox_status_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_sandbox_status_definer_insert ON runner_sandbox_status FOR INSERT TO runner_sandbox_status_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_sandbox_status_definer_update ON runner_sandbox_status FOR UPDATE TO runner_sandbox_status_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_sandbox_status_definer_delete ON runner_sandbox_status FOR DELETE TO runner_sandbox_status_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_sandbox_status_definer_select ON runners FOR SELECT TO runner_sandbox_status_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_sandbox_status_definer_select ON accounts FOR SELECT TO runner_sandbox_status_definer USING (true);

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'runner_sandbox_status_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_sandbox_status_definer; cannot ALTER FUNCTION ... OWNER TO runner_sandbox_status_definer';
    END IF;
    GRANT runner_sandbox_status_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

GRANT CREATE ON SCHEMA public TO runner_sandbox_status_definer;

CREATE FUNCTION runner_sandbox_status_record(p_reason text)
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
    RAISE EXCEPTION 'runner_sandbox_status_record: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT account_is_active(acct)
     OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'runner_sandbox_status_record: the session is not a runner of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_reason IS NOT NULL
     AND p_reason NOT IN ('bwrap_missing', 'socat_missing', 'userns_disabled', 'apparmor_userns_restricted', 'probe_failed_other') THEN
    RAISE EXCEPTION 'runner_sandbox_status_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Only a live runner of this account has a row (a revoked or foreign one is left alone).
  IF NOT EXISTS (SELECT 1 FROM public.runners r WHERE r.id = raw::uuid AND r.account_id = acct AND r.revoked_at IS NULL) THEN
    RETURN;
  END IF;
  IF p_reason IS NULL THEN
    DELETE FROM public.runner_sandbox_status WHERE runner_id = raw::uuid AND account_id = acct;
  ELSE
    -- Only a change is written, so a runner that polls every few seconds with the same answer writes nothing.
    INSERT INTO public.runner_sandbox_status AS s (runner_id, account_id, reason) VALUES (raw::uuid, acct, p_reason)
    ON CONFLICT (runner_id) DO UPDATE SET reason = EXCLUDED.reason, updated_at = now() WHERE s.reason IS DISTINCT FROM EXCLUDED.reason;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION runner_sandbox_status_record(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_sandbox_status_record(text) TO app_user;
ALTER FUNCTION runner_sandbox_status_record(text) OWNER TO runner_sandbox_status_definer;
REVOKE CREATE ON SCHEMA public FROM runner_sandbox_status_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_sandbox_status_definer FROM CURRENT_USER;
  END IF;
END
$$;
