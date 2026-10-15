-- D#600 CX-2: the per-repository size of the prompt's memory slot, the one repository setting the prompt assembler reads.
--
--   repo_context_settings  one row per repository whose people chose a size; the row is the setting, so "reset to the default" is the
--                          absence of a row (the default, 4096 bytes, lives in code beside the maximum). Nothing is stamped: no stale
--                          copy of the default can outlive a change of it. memory_slot_bytes is bounded 1024..8192 by a CHECK.
--
-- A side table, not a column of repos: app_user may write repos (0001) and platform_ops holds writes on it, so a column there would have
-- been writable by any member. This table can be read by the account's members and written by exactly one function.
--
--   repo_context_settings_apply(p_repo, p_bytes)  p_bytes NULL resets (deletes the row); otherwise it sets. Owned by
--                          repo_context_settings_definer (NOLOGIN, a member of nothing, column grants for exactly what the body reads
--                          and writes, a pinned search_path). The caller's membership and role are re-derived from the session
--                          (app.account_id, app.user_id) on every call: only an owner or admin of an active account may change it. A
--                          platform_ops login is refused. EXECUTE goes to app_user alone; platform_ops gains nothing.
--
-- Refusals are fixed messages and never carry an argument value: 'invalid_message' (22023) for a size outside 1024..8192 or a missing
-- repository argument, 42501 for a caller who may not, P0002 for a repository that is not in the account.
--
-- Numbered 0796 (reserved for this PR). It merges after 0792, in number order.

DO $$
DECLARE
  n text := 'repo_context_settings_definer';
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

CREATE TABLE repo_context_settings (
  account_id         uuid NOT NULL,
  repo_id            uuid NOT NULL,
  memory_slot_bytes  integer NOT NULL CHECK (memory_slot_bytes BETWEEN 1024 AND 8192),
  updated_by         uuid NOT NULL REFERENCES users (id),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, repo_id),
  FOREIGN KEY (account_id, repo_id) REFERENCES repos (account_id, id) ON DELETE CASCADE
);

ALTER TABLE repo_context_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE repo_context_settings FORCE ROW LEVEL SECURITY;

-- Readers: the account's own members. They can write nothing.
GRANT SELECT (account_id, repo_id, memory_slot_bytes, updated_by, updated_at) ON repo_context_settings TO app_user;
CREATE POLICY tenant_isolation_select ON repo_context_settings FOR SELECT TO app_user
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid)));

-- The definer role: what the body reads and writes, column by column.
GRANT USAGE ON SCHEMA public TO repo_context_settings_definer;
GRANT SELECT (account_id, repo_id, memory_slot_bytes), INSERT (account_id, repo_id, memory_slot_bytes, updated_by),
      UPDATE (memory_slot_bytes, updated_by, updated_at), DELETE ON repo_context_settings TO repo_context_settings_definer;
GRANT SELECT (id, account_id) ON repos TO repo_context_settings_definer;
GRANT SELECT (account_id, user_id, role) ON account_members TO repo_context_settings_definer;
GRANT SELECT (id, deleted_at) ON accounts TO repo_context_settings_definer;

CREATE POLICY repo_context_settings_definer_select ON repo_context_settings FOR SELECT TO repo_context_settings_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY repo_context_settings_definer_insert ON repo_context_settings FOR INSERT TO repo_context_settings_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY repo_context_settings_definer_update ON repo_context_settings FOR UPDATE TO repo_context_settings_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid) WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY repo_context_settings_definer_delete ON repo_context_settings FOR DELETE TO repo_context_settings_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY repo_context_settings_definer_select ON repos FOR SELECT TO repo_context_settings_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
-- Shows this role only the caller's own membership row, as 0757 and 0783 do.
CREATE POLICY repo_context_settings_definer_select ON account_members FOR SELECT TO repo_context_settings_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY repo_context_settings_definer_select ON accounts FOR SELECT TO repo_context_settings_definer USING (true);

-- The migration role holds the new role (with ADMIN from creating it) only to hand the function over, and the role has CREATE on public
-- only for that transfer; both are reset at the end.
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'repo_context_settings_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on repo_context_settings_definer; cannot ALTER FUNCTION ... OWNER TO repo_context_settings_definer';
    END IF;
    GRANT repo_context_settings_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO repo_context_settings_definer;

CREATE FUNCTION repo_context_settings_apply(p_repo uuid, p_bytes integer)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct   uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  usr    uuid;
  v_role text;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'repo_context_settings_apply: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- The caller's own membership row (the policy shows this role no other); the role is re-derived on every call, never taken from the request.
  SELECT m.user_id, m.role INTO usr, v_role FROM public.account_members m
   WHERE m.account_id = acct AND m.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
  IF acct IS NULL OR NOT account_is_active(acct) OR usr IS NULL OR v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'repo_context_settings_apply: not permitted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_repo IS NULL OR (p_bytes IS NOT NULL AND p_bytes NOT BETWEEN 1024 AND 8192) THEN
    RAISE EXCEPTION 'invalid_message' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM 1 FROM public.repos r WHERE r.id = p_repo AND r.account_id = acct;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'repo_context_settings_apply: no such repository' USING ERRCODE = 'no_data_found';
  END IF;

  IF p_bytes IS NULL THEN
    DELETE FROM public.repo_context_settings s WHERE s.account_id = acct AND s.repo_id = p_repo;
  ELSE
    INSERT INTO public.repo_context_settings AS s (account_id, repo_id, memory_slot_bytes, updated_by)
    VALUES (acct, p_repo, p_bytes, usr)
    ON CONFLICT (account_id, repo_id) DO UPDATE SET memory_slot_bytes = EXCLUDED.memory_slot_bytes, updated_by = usr, updated_at = now();
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION repo_context_settings_apply(uuid, integer) FROM PUBLIC;
ALTER FUNCTION repo_context_settings_apply(uuid, integer) OWNER TO repo_context_settings_definer;
-- EXECUTE is granted after the transfer: changing an owner rewrites the ACL entries that named the old one.
GRANT EXECUTE ON FUNCTION repo_context_settings_apply(uuid, integer) TO app_user;

REVOKE CREATE ON SCHEMA public FROM repo_context_settings_definer;
DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE repo_context_settings_definer FROM CURRENT_USER;
  END IF;
END
$$;
