-- D#6 C43-2b (with the resource-aware addendum): a runner says on its claim how many jobs it can hold per class, and the cloud keeps the
-- last figure it declared, so the runner list can show "Busy · 2 of 4" and a waiting run can say why.
--
--   runner_capacity                one row per runner that has claimed since this table existed: whether it declared a capacity
--                                  (`declared`; false is a runner that sent none, which counts as one job in total), and the two class limits
--                                  it declared (light 0..8, heavy 0..4; both null exactly when `declared` is false). A table of its own, not
--                                  columns of runners: platform_ops holds a table-wide SELECT/INSERT/UPDATE/DELETE on runners (0711), and a
--                                  new column would have inherited it (the reason 0754 and 0763 keep their side tables too).
--   runner_capacity_record(light_limit, heavy_limit, limited_by)
--                                  sets the row of the runner named by app.runner_id (which only the signature-verifying runner middleware
--                                  sets). The two limits null records "declared nothing". `limited_by` (memory, cpu, disk, paused or ceiling)
--                                  says why the limits sit low and may be null. An equal figure writes nothing.
--
-- Only the limits are stored. How many jobs a runner holds is always counted from agent_runs, so it cannot go stale.
--
-- Numbered above the highest migration on the code plane (0776). Re-check against main right before merging and renumber to stay above its highest.
--
-- Who may touch it: platform_ops holds NOTHING on the table and gains nothing anywhere. The function and the rows are owned by a role of
-- its own, runner_capacity_definer, in the shape of 0763's runner_sandbox_status_definer: NOLOGIN, no members (the migration role holds
-- it only inside this file), a member of nothing, column-level grants for exactly what the body reads and writes, row policies for this
-- role only, a pinned search_path, EXECUTE for app_user alone. app_user may read the limits for its own tenant; it cannot write them.
DO $$
DECLARE
  n text := 'runner_capacity_definer';
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

CREATE TABLE runner_capacity (
  runner_id    uuid PRIMARY KEY,
  account_id   uuid NOT NULL,
  declared     boolean NOT NULL,
  light_limit  smallint,
  heavy_limit  smallint,
  limited_by   text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, runner_id) REFERENCES runners (account_id, id) ON DELETE CASCADE,
  CONSTRAINT runner_capacity_shape_check CHECK (
    (declared AND light_limit BETWEEN 0 AND 8 AND heavy_limit BETWEEN 0 AND 4)
    OR (NOT declared AND light_limit IS NULL AND heavy_limit IS NULL)
  ),
  CONSTRAINT runner_capacity_limited_by_check CHECK (limited_by IS NULL OR (declared AND limited_by IN ('memory', 'cpu', 'disk', 'paused', 'ceiling')))
);
ALTER TABLE runner_capacity ENABLE ROW LEVEL SECURITY;
ALTER TABLE runner_capacity FORCE ROW LEVEL SECURITY;

GRANT USAGE ON SCHEMA public TO runner_capacity_definer;
GRANT SELECT (runner_id, account_id, declared, light_limit, heavy_limit, limited_by), INSERT (runner_id, account_id, declared, light_limit, heavy_limit, limited_by, updated_at), UPDATE (declared, light_limit, heavy_limit, limited_by, updated_at) ON runner_capacity TO runner_capacity_definer;
GRANT SELECT (id, account_id, revoked_at) ON runners TO runner_capacity_definer;
GRANT SELECT (id, deleted_at) ON accounts TO runner_capacity_definer;
-- The runner list reads the limits under the tenant's own row policy; nothing else, and no write.
GRANT SELECT (runner_id, account_id, declared, light_limit, heavy_limit, limited_by) ON runner_capacity TO app_user;

CREATE POLICY tenant_isolation_select ON runner_capacity FOR SELECT TO app_user
  USING (
    account_id = NULLIF(current_setting('app.account_id', true), '')::uuid
    AND (SELECT account_is_active(NULLIF(current_setting('app.account_id', true), '')::uuid))
  );
CREATE POLICY runner_capacity_definer_select ON runner_capacity FOR SELECT TO runner_capacity_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_capacity_definer_insert ON runner_capacity FOR INSERT TO runner_capacity_definer
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_capacity_definer_update ON runner_capacity FOR UPDATE TO runner_capacity_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid)
  WITH CHECK (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_capacity_definer_select ON runners FOR SELECT TO runner_capacity_definer
  USING (account_id = NULLIF(current_setting('app.account_id', true), '')::uuid);
CREATE POLICY runner_capacity_definer_select ON accounts FOR SELECT TO runner_capacity_definer USING (true);

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.roleid = 'runner_capacity_definer'::regrole AND m.member = current_user::regrole AND m.admin_option
    ) THEN
      RAISE EXCEPTION 'current_user has no ADMIN option on runner_capacity_definer; cannot ALTER FUNCTION ... OWNER TO runner_capacity_definer';
    END IF;
    GRANT runner_capacity_definer TO CURRENT_USER WITH INHERIT TRUE, SET TRUE;
  END IF;
END
$$;

GRANT CREATE ON SCHEMA public TO runner_capacity_definer;

CREATE FUNCTION runner_capacity_record(p_light_limit integer, p_heavy_limit integer, p_limited_by text)
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
    RAISE EXCEPTION 'runner_capacity_record: refused for a platform_ops login' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF acct IS NULL OR NOT account_is_active(acct)
     OR raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'runner_capacity_record: the session is not a runner of an active account' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Both null (declared nothing) or both inside the ceilings; anything else is a caller's bug.
  IF (p_light_limit IS NULL) <> (p_heavy_limit IS NULL)
     OR p_light_limit NOT BETWEEN 0 AND 8 OR p_heavy_limit NOT BETWEEN 0 AND 4
     OR (p_limited_by IS NOT NULL AND (p_light_limit IS NULL OR p_limited_by NOT IN ('memory', 'cpu', 'disk', 'paused', 'ceiling'))) THEN
    RAISE EXCEPTION 'runner_capacity_record: invalid argument' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Only a live runner of this account has a row (a revoked or foreign one is left alone).
  IF NOT EXISTS (SELECT 1 FROM public.runners r WHERE r.id = raw::uuid AND r.account_id = acct AND r.revoked_at IS NULL) THEN
    RETURN;
  END IF;
  -- Only a change is written, so a runner that claims every few seconds with the same answer writes nothing.
  INSERT INTO public.runner_capacity AS c (runner_id, account_id, declared, light_limit, heavy_limit, limited_by)
  VALUES (raw::uuid, acct, p_light_limit IS NOT NULL, p_light_limit, p_heavy_limit, p_limited_by)
  ON CONFLICT (runner_id) DO UPDATE
    SET declared = EXCLUDED.declared, light_limit = EXCLUDED.light_limit, heavy_limit = EXCLUDED.heavy_limit, limited_by = EXCLUDED.limited_by, updated_at = now()
    WHERE (c.declared, c.light_limit, c.heavy_limit, c.limited_by) IS DISTINCT FROM (EXCLUDED.declared, EXCLUDED.light_limit, EXCLUDED.heavy_limit, EXCLUDED.limited_by);
END;
$$;

REVOKE ALL ON FUNCTION runner_capacity_record(integer, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION runner_capacity_record(integer, integer, text) TO app_user;
ALTER FUNCTION runner_capacity_record(integer, integer, text) OWNER TO runner_capacity_definer;
REVOKE CREATE ON SCHEMA public FROM runner_capacity_definer;

DO $$
BEGIN
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    REVOKE runner_capacity_definer FROM CURRENT_USER;
  END IF;
END
$$;
