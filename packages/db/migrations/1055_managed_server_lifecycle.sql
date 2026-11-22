-- D#845 MC-7: server lifecycle, orphans and delete.
--
--  1. Orphans. A server in the person's Hetzner project that carries our label and has no row here is recorded as a row with status 'orphaned' (the sweep never deletes
--     it). It was not made through a create, so it holds no provisioning token: provisioning_token_id may be NULL only while the status is 'orphaned', or 'deleted' (an orphan that was deleted keeps its row as history). Its created_by is the
--     credential's.
--  2. create_action_id: the Hetzner action the create returned, so the status worker can tell when it finished. Written once by the create's last step.
--  3. managed_server_link_runner(token hash, runner id): when a runner registers with a server's token, the same transaction records the runner on the server's row. It
--     sets runner_id only where it is still NULL, only for the caller's own account, only on the row that holds that very token, and only for the runner that redeemed it.
--  4. machine_sweep_credentials(): the account, credential and creator of each connected (status ok) Hetzner credential, for the 6-hourly sweep job. It is owned by its own
--     NOLOGIN role, machine_sweep_lister, which can read six non-sealed columns of the credentials and two of accounts and nothing else; only platform_ops can run it. It returns no sealed column.
--     The job starts one queued sweep per row; the sweep opens the token as that creator, who must still be an owner or admin.
--  5. The reconcile row of that job (21600 s).
-- Numbered 1055: re-check against main right before merging and renumber to stay above its highest.

ALTER TABLE managed_servers ALTER COLUMN provisioning_token_id DROP NOT NULL;
ALTER TABLE managed_servers ADD CONSTRAINT managed_servers_token_unless_orphan CHECK (provisioning_token_id IS NOT NULL OR status IN ('orphaned', 'deleted'));
ALTER TABLE managed_servers ADD COLUMN create_action_id text CHECK (create_action_id ~ '^[0-9]{1,20}$');
GRANT UPDATE (create_action_id) ON managed_servers TO app_user;

GRANT SELECT (runner_id), UPDATE (runner_id) ON managed_servers TO runner_provisioning_definer;
CREATE POLICY runner_provisioning_definer_link ON managed_servers FOR UPDATE TO runner_provisioning_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);

DO $$
DECLARE
  n text := 'machine_sweep_lister';
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
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'runner_provisioning_definer'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_provisioning_definer; cannot ALTER FUNCTION ... OWNER TO runner_provisioning_definer';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = 'machine_sweep_lister'::regrole AND m.member = current_user::regrole AND m.admin_option) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on machine_sweep_lister; cannot ALTER FUNCTION ... OWNER TO machine_sweep_lister';
    END IF;
    GRANT runner_provisioning_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
    GRANT machine_sweep_lister TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;
GRANT CREATE ON SCHEMA public TO runner_provisioning_definer;
GRANT CREATE ON SCHEMA public TO machine_sweep_lister;

CREATE FUNCTION managed_server_link_runner(p_token_sha256 text, p_runner_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  acct uuid := NULLIF(current_setting('app.account_id', true), '')::uuid;
  n integer;
BEGIN
  IF session_user = 'platform_ops' THEN
    RAISE EXCEPTION 'managed_server_link_runner: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR p_runner_id IS NULL OR p_token_sha256 IS NULL OR p_token_sha256 !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'managed_server_link_runner: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.managed_servers s SET runner_id = p_runner_id
   WHERE s.account_id = acct AND s.runner_id IS NULL
     AND s.provisioning_token_id = (SELECT t.id FROM public.runner_provisioning_tokens t WHERE t.token_sha256 = p_token_sha256 AND t.account_id = acct AND t.runner_id = p_runner_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END;
$$;

-- The list of connected credentials needs every account's rows, so it gets its own role instead of a switch on machine_ops: machine_sweep_lister reads these columns
-- and no others (no sealed one), through a policy that names only it, and owns the one function that returns them. No setting, flag or other role is involved.
GRANT USAGE ON SCHEMA public TO machine_sweep_lister;
GRANT SELECT (id, account_id, created_by, provider, status, removed_at) ON machine_provider_credentials TO machine_sweep_lister;
GRANT SELECT (id, deleted_at) ON accounts TO machine_sweep_lister;
CREATE POLICY machine_sweep_lister_select ON machine_provider_credentials FOR SELECT TO machine_sweep_lister USING (true);
CREATE POLICY machine_sweep_lister_select ON accounts FOR SELECT TO machine_sweep_lister USING (true);

CREATE FUNCTION machine_sweep_credentials()
RETURNS TABLE (account_id uuid, credential_id uuid, created_by uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT c.account_id, c.id, c.created_by
    FROM public.machine_provider_credentials c
    JOIN public.accounts a ON a.id = c.account_id AND a.deleted_at IS NULL
   WHERE c.provider = 'hetzner_cloud' AND c.removed_at IS NULL AND c.status = 'ok';
$$;

REVOKE ALL ON FUNCTION managed_server_link_runner(text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION machine_sweep_credentials() FROM PUBLIC;
ALTER FUNCTION managed_server_link_runner(text, uuid) OWNER TO runner_provisioning_definer;
ALTER FUNCTION machine_sweep_credentials() OWNER TO machine_sweep_lister;
GRANT EXECUTE ON FUNCTION managed_server_link_runner(text, uuid) TO app_user;
GRANT EXECUTE ON FUNCTION machine_sweep_credentials() TO platform_ops;
REVOKE CREATE ON SCHEMA public FROM runner_provisioning_definer;
REVOKE CREATE ON SCHEMA public FROM machine_sweep_lister;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_provisioning_definer FROM CURRENT_USER;
    REVOKE machine_sweep_lister FROM CURRENT_USER;
  END IF;
END
$$;

INSERT INTO reconcile_jobs (name, interval_seconds) VALUES ('machine_server_sweep', 21600) ON CONFLICT (name) DO NOTHING;
